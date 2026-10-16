import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RunDockerOptions } from "./docker-cli.js";
import { limaConfig, type VirtualDesktopDeps, VirtualDesktopEngine } from "./virtual-desktop.js";

const ROOT = "/app/vm";
const LIMACTL = path.join(ROOT, "lima-2.2.0", "bin", "limactl");
const INSTANCE_CONFIG = path.join(ROOT, "h", "quant", "lima.yaml");

function engine(overrides: Partial<VirtualDesktopDeps> = {}) {
  const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  const deps: VirtualDesktopDeps = {
    platform: "darwin",
    arch: "arm64",
    root: ROOT,
    dataDir: "/app/server/data",
    computerImage: "ghcr.io/example/computer:latest",
    env: { HOME: "/Users/me", DOCKER_HOST: "tcp://elsewhere:2375" },
    fetch: async () => new Response("not lima"),
    run: async (command: string, args: string[], options: RunDockerOptions) => {
      calls.push({ command, args, env: options.env });
      return { code: 0, stdout: "", stderr: "" };
    },
    extract: async () => undefined,
    exists: () => false,
    ...overrides,
  };
  return { engine: new VirtualDesktopEngine(deps), calls };
}

describe("VirtualDesktopEngine", () => {
  it("has no engine off macOS", async () => {
    const { engine: linux } = engine({ platform: "linux" });
    expect(linux.state().phase).toBe("unsupported");
    expect(linux.socketPath()).toBeNull();
    await expect(linux.install()).resolves.toMatchObject({ phase: "unsupported" });
  });

  it("offers the download until Lima and its VM are in place", () => {
    const { engine: mac } = engine();
    expect(mac.state()).toMatchObject({ phase: "absent", percent: null });
    expect(mac.socketPath()).toBe(path.join(ROOT, "h", "quant", "sock", "docker.sock"));
  });

  it("refuses a download whose checksum does not match", async () => {
    const { engine: mac, calls } = engine();
    await expect(mac.install()).resolves.toMatchObject({ phase: "error" });
    expect(calls).toEqual([]);
  });

  it("starts an installed VM and pulls the desktop image into it", async () => {
    const exists = (file: string) => file === LIMACTL || file === INSTANCE_CONFIG;
    const { engine: mac, calls } = engine({ exists });
    await expect(mac.start()).resolves.toMatchObject({ phase: "ready" });
    expect(calls.map((call) => call.args)).toEqual([
      ["start", "--tty=false", "quant"],
      ["shell", "--workdir=/", "quant", "docker", "pull", "ghcr.io/example/computer:latest"],
    ]);
    expect(calls[0]!.command).toBe(LIMACTL);
    expect(calls[0]!.env.LIMA_HOME).toBe(path.join(ROOT, "h"));
    // The user's own Docker settings never reach limactl.
    expect(calls[0]!.env).not.toHaveProperty("DOCKER_HOST");
  });

  it("reports a VM that does not start", async () => {
    const exists = (file: string) => file === LIMACTL || file === INSTANCE_CONFIG;
    const { engine: mac } = engine({
      exists,
      run: async () => ({ code: 1, stdout: "", stderr: "boom" }),
    });
    await expect(mac.start()).resolves.toMatchObject({ phase: "error" });
  });
});

describe("limaConfig", () => {
  it("shares only the server's data folder, writable, and forwards Docker's socket", () => {
    const config = JSON.parse(limaConfig("/app/server/data"));
    expect(config.vmType).toBe("vz");
    expect(config.mounts).toEqual([{ location: "/app/server/data", writable: true }]);
    expect(config.portForwards).toEqual([
      { guestSocket: "/var/run/docker.sock", hostSocket: "{{.Dir}}/sock/docker.sock" },
    ]);
  });
});
