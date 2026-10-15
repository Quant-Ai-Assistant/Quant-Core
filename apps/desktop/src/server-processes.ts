import { spawn } from "node:child_process";

/** A long-running part of the local server (the API or the worker). */
export interface ServerProcess {
  /** Resolves with the exit code once the process is gone, for any reason. */
  exited: Promise<number>;
  /** Asks the process to finish, and kills it when it has not after `graceMs`. */
  stop(graceMs?: number): Promise<void>;
}

export interface LaunchOptions {
  cwd: string;
  env: Record<string, string>;
  /** Receives each complete stdout or stderr line. */
  onLine?: (line: string) => void;
}

export type LaunchProcess = (
  command: string,
  args: string[],
  options: LaunchOptions,
) => ServerProcess;

const DEFAULT_GRACE_MS = 5_000;

export const launchProcess: LaunchProcess = (command, args, options) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream?.on("data", (chunk: Buffer) => {
      const parts = (pending + chunk.toString("utf8")).split("\n");
      pending = parts.pop() ?? "";
      for (const part of parts) if (part.trim() !== "") options.onLine?.(part.trimEnd());
    });
  }
  const exited = new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  return {
    exited,
    stop: async (graceMs = DEFAULT_GRACE_MS) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
      await exited;
      clearTimeout(timer);
    },
  };
};
