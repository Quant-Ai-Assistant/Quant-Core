import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerAction, ComputerElement, ComputerObservation } from "@rakazo/adapter-kit";
import { computerObservation } from "./computer-support.js";
import { MAC_SCREEN_DRIVER } from "./mac-screen-driver.js";

/** Long edge of observation images. Larger displays are scaled down to it. */
export const MAC_SCREEN_MAX_EDGE = 1568;
/** Long edge of the frames people watch in the screen panel. */
export const MAC_FRAME_MAX_EDGE = 1280;
const DRIVER_TIMEOUT_MS = 30_000;
const MAX_SETTLE_MS = 5_000;

const PERMISSION_ERRORS: Record<string, string> = {
  "permission:screen":
    "Quant cannot see this Mac yet: it needs Screen Recording permission. Ask the user to allow Quant in System Settings › Privacy & Security › Screen Recording and reopen Quant. Until then, use the shell.",
  "permission:accessibility":
    "Quant cannot control this Mac yet: it needs Accessibility permission. Ask the user to allow Quant in System Settings › Privacy & Security › Accessibility. Until then, use the shell.",
};

interface DriverElement {
  id: number;
  role: string;
  subrole?: string;
  label?: string;
  value?: string;
  secure?: boolean;
  disabled?: boolean;
  focused?: boolean;
  rect: { x: number; y: number; w: number; h: number };
  path: number[];
}

interface DriverObservation {
  width: number;
  height: number;
  cursor: { x: number; y: number };
  application: { pid: number; name?: string; bundleId?: string };
  windowTitle?: string;
  elements: DriverElement[];
}

interface ElementTarget {
  id: number;
  pid: number;
  path: number[];
  role: string;
  label?: string;
}

export type MacScreenDriverRunner = (
  request: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

/** One display serves every bot on this Mac, so screen work runs one call at a time. */
let screenTurn: Promise<unknown> = Promise.resolve();

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = screenTurn.then(work, work);
  screenTurn = next.catch(() => undefined);
  return next;
}

/** The host Mac's own display, keyboard and mouse, with Accessibility elements. */
export class MacScreen {
  /** Elements of each computer's last observation, so bots sharing this Mac keep their own ids. */
  private targets = new Map<string, Map<number, ElementTarget>>();

  constructor(private readonly runDriver: MacScreenDriverRunner = runOsascriptDriver) {}

  observe(computerId: string, signal?: AbortSignal): Promise<ComputerObservation> {
    return exclusive(() => this.capture(computerId, signal));
  }

  act(
    computerId: string,
    actions: readonly ComputerAction[],
    options: { observe: boolean; settleMs?: number },
    signal?: AbortSignal,
  ): Promise<{ completed: number; observation?: ComputerObservation }> {
    return exclusive(async () => {
      const elements: Record<string, ElementTarget> = {};
      for (const action of actions) {
        if (action.kind !== "element") continue;
        const target = this.targets.get(computerId)?.get(action.element);
        if (!target) {
          throw new Error(`element ${action.element} is not on the last screen; observe again`);
        }
        elements[String(action.element)] = target;
      }
      const result = await this.runDriver(
        { op: "act", maxEdge: MAC_SCREEN_MAX_EDGE, actions, elements },
        signal,
      );
      const completed = Number(result.completed ?? 0);
      if (typeof result.error === "string") {
        throw new Error(
          `${permissionMessage(result.error)} (completed ${completed} of ${actions.length} actions)`,
        );
      }
      if (!options.observe) return { completed };
      const settleMs = Math.min(Math.max(options.settleMs ?? 350, 0), MAX_SETTLE_MS);
      if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
      return { completed, observation: await this.capture(computerId, signal) };
    });
  }

  /**
   * A plain picture of the display with the pointer, for people watching. It skips the
   * Accessibility walk and the screen turn, so watching never slows a bot down.
   */
  async frame(signal?: AbortSignal): Promise<Uint8Array> {
    const directory = await mkdtemp(path.join(tmpdir(), "quant-frame-"));
    try {
      const capture = path.join(directory, "capture.jpg");
      const output = path.join(directory, "frame.jpg");
      await runTool("/usr/sbin/screencapture", ["-x", "-C", "-m", "-t", "jpg", capture], signal);
      await runTool(
        "/usr/bin/sips",
        ["-Z", String(MAC_FRAME_MAX_EDGE), "-s", "formatOptions", "70", capture, "--out", output],
        signal,
      );
      return new Uint8Array(await readFile(output));
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async capture(computerId: string, signal?: AbortSignal): Promise<ComputerObservation> {
    const directory = await mkdtemp(path.join(tmpdir(), "quant-screen-"));
    try {
      const outputPath = path.join(directory, "screen.jpg");
      const result = (await this.runDriver(
        {
          op: "observe",
          capturePath: path.join(directory, "capture.png"),
          outputPath,
          maxEdge: MAC_SCREEN_MAX_EDGE,
          marks: true,
        },
        signal,
      )) as unknown as DriverObservation;
      const image = new Uint8Array(await readFile(outputPath));
      this.targets.set(
        computerId,
        new Map(
          result.elements.map((element) => [
            element.id,
            {
              id: element.id,
              pid: result.application.pid,
              path: element.path,
              role: element.role,
              ...(element.label === undefined ? {} : { label: element.label }),
            },
          ]),
        ),
      );
      const appName = result.application.name ?? result.application.bundleId ?? "application";
      return computerObservation(image, {
        mimeType: "image/jpeg",
        width: result.width,
        height: result.height,
        cursor: result.cursor,
        activeWindow: {
          id: result.application.bundleId ?? String(result.application.pid),
          title: result.windowTitle ? `${appName} — ${result.windowTitle}` : appName,
        },
        elements: result.elements.map(toComputerElement),
      });
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function toComputerElement(element: DriverElement): ComputerElement {
  return {
    id: element.id,
    role: readableRole(element.role),
    ...(element.label === undefined ? {} : { label: element.label }),
    ...(element.value === undefined ? {} : { value: element.value }),
    x: element.rect.x,
    y: element.rect.y,
    width: element.rect.w,
    height: element.rect.h,
    ...(element.disabled ? { disabled: true } : {}),
    ...(element.focused ? { focused: true } : {}),
    ...(element.secure ? { secure: true } : {}),
  };
}

/** "AXPopUpButton" → "pop up button". */
export function readableRole(role: string): string {
  return role
    .replace(/^AX/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function permissionMessage(error: string): string {
  return PERMISSION_ERRORS[error] ?? error;
}

function runTool(file: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "ignore", signal });
    const timer = setTimeout(() => child.kill("SIGKILL"), DRIVER_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(PERMISSION_ERRORS["permission:screen"]));
    });
  });
}

/** Runs the driver with `osascript`, reading the script from stdin. */
export function runOsascriptDriver(
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-", JSON.stringify(request)], {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), DRIVER_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        reject(new Error(stderr.trim() || `screen driver exited with code ${code}`));
        return;
      }
      if (typeof parsed.error === "string" && parsed.completed === undefined) {
        reject(new Error(permissionMessage(parsed.error)));
        return;
      }
      resolve(parsed);
    });
    child.stdin.end(MAC_SCREEN_DRIVER);
  });
}
