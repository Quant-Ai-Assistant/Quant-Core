import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopVirtualDesktopState } from "@rakazo/contracts";
import type { RunDocker } from "./docker-cli.js";

/**
 * Lima runs a small Linux VM on macOS's own Virtualization.framework. The app downloads one
 * pinned release into its own folder, so a virtual desktop needs neither Docker nor Homebrew.
 */
export const LIMA_VERSION = "2.2.0";
const LIMA_ARCHIVES: Record<string, { file: string; sha256: string }> = {
  arm64: {
    file: `lima-${LIMA_VERSION}-Darwin-arm64.tar.gz`,
    sha256: "bbdef91774885a0d05f7b048c4eb89ae2bcf3a0c252ae7ca7934e63df76d93c3",
  },
  x64: {
    file: `lima-${LIMA_VERSION}-Darwin-x86_64.tar.gz`,
    sha256: "0d6f99c19f6e4bc3c92730c4c29d929e6927f0cb0a0ba1a84383367135a8ff31",
  },
};
export const VIRTUAL_DESKTOP_INSTANCE = "quant";
/** Lima, the Ubuntu image, Docker inside it and the desktop image, roughly. */
export const VIRTUAL_DESKTOP_DOWNLOAD_BYTES = 2_100_000_000;

const CREATE_TIMEOUT_MS = 60_000;
/** The first start downloads Ubuntu and installs Docker in it. */
const START_TIMEOUT_MS = 20 * 60_000;
const PULL_TIMEOUT_MS = 30 * 60_000;
const STOP_TIMEOUT_MS = 60_000;

const INSTALL_FAILED = "Could not set up the virtual desktop. Check your connection and retry.";
const START_FAILED = "Could not start the virtual desktop. Retry.";

export interface VirtualDesktopDeps {
  platform: string;
  arch: string;
  /** The app's own folder for Lima and its VM; kept short for Lima's socket paths. */
  root: string;
  /** The server's data folder, shared into the VM at the same path for bots' homes. */
  dataDir: string;
  computerImage: string;
  env: NodeJS.ProcessEnv;
  fetch: (url: string) => Promise<Response>;
  run: RunDocker;
  extract: (archive: string, into: string) => Promise<void>;
  exists?: (file: string) => boolean;
  onLine?: (line: string) => void;
}

/** The Lima VM that hosts every bot's virtual desktop on a Mac without Docker. */
export class VirtualDesktopEngine {
  private current: DesktopVirtualDesktopState;
  private busy: Promise<DesktopVirtualDesktopState> | null = null;

  constructor(private readonly deps: VirtualDesktopDeps) {
    this.current = {
      phase: this.supported() ? (this.installed() ? "preparing" : "absent") : "unsupported",
      percent: null,
      downloadBytes: VIRTUAL_DESKTOP_DOWNLOAD_BYTES,
      message: null,
    };
  }

  state(): DesktopVirtualDesktopState {
    return this.current;
  }

  supported(): boolean {
    return this.deps.platform === "darwin" && this.deps.arch in LIMA_ARCHIVES;
  }

  /** Where the VM's Docker answers on this Mac; null where there is no engine. */
  socketPath(): string | null {
    if (!this.supported()) return null;
    return path.join(this.limaHome(), VIRTUAL_DESKTOP_INSTANCE, "sock", "docker.sock");
  }

  installed(): boolean {
    const exists = this.deps.exists ?? existsSync;
    return (
      exists(this.limactl()) &&
      exists(path.join(this.limaHome(), VIRTUAL_DESKTOP_INSTANCE, "lima.yaml"))
    );
  }

  /** Downloads Lima, creates the VM and starts it; a second call joins the first. */
  install(): Promise<DesktopVirtualDesktopState> {
    if (!this.supported()) return Promise.resolve(this.current);
    this.busy ??= this.installNow().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  /** Starts an installed VM, as the app does on launch. */
  start(): Promise<DesktopVirtualDesktopState> {
    if (!this.supported() || !this.installed()) return Promise.resolve(this.current);
    this.busy ??= this.startNow().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  async stop(): Promise<void> {
    if (!this.installed()) return;
    await this.lima(["stop", VIRTUAL_DESKTOP_INSTANCE], STOP_TIMEOUT_MS).catch(() => undefined);
  }

  private async installNow(): Promise<DesktopVirtualDesktopState> {
    try {
      if (!(this.deps.exists ?? existsSync)(this.limactl())) await this.downloadLima();
      this.set({ phase: "preparing", percent: null });
      if (!this.installed()) {
        const config = path.join(this.deps.root, "quant.yaml");
        await writeFile(config, limaConfig(this.deps.dataDir));
        const created = await this.lima(
          ["create", "--tty=false", `--name=${VIRTUAL_DESKTOP_INSTANCE}`, config],
          CREATE_TIMEOUT_MS,
        );
        if (created.code !== 0) return this.fail(INSTALL_FAILED);
      }
    } catch (error) {
      this.deps.onLine?.(`virtual desktop install: ${String(error)}`);
      return this.fail(INSTALL_FAILED);
    }
    return this.startNow();
  }

  private async startNow(): Promise<DesktopVirtualDesktopState> {
    this.set({ phase: "preparing", percent: null });
    const started = await this.lima(
      ["start", "--tty=false", VIRTUAL_DESKTOP_INSTANCE],
      START_TIMEOUT_MS,
    );
    if (started.code !== 0) return this.fail(START_FAILED);
    // Pulled here once, so a bot's first switch does not wait on a large download.
    const pulled = await this.lima(
      ["shell", "--workdir=/", VIRTUAL_DESKTOP_INSTANCE, "docker", "pull", this.deps.computerImage],
      PULL_TIMEOUT_MS,
    );
    if (pulled.code !== 0) return this.fail(INSTALL_FAILED);
    return this.set({ phase: "ready", percent: null, message: null });
  }

  private async downloadLima() {
    const archive = LIMA_ARCHIVES[this.deps.arch];
    if (!archive) throw new Error("unsupported architecture");
    this.set({ phase: "downloading", percent: 0, message: null });
    const url = `https://github.com/lima-vm/lima/releases/download/v${LIMA_VERSION}/${archive.file}`;
    const response = await this.deps.fetch(url);
    if (!response.ok || !response.body) throw new Error(`download failed: ${response.status}`);
    const total = Number(response.headers.get("content-length")) || 0;
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (total > 0) this.set({ percent: Math.min(99, Math.round((received / total) * 100)) });
    }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== archive.sha256) {
      throw new Error("checksum mismatch");
    }
    const into = this.limaDir();
    await rm(into, { recursive: true, force: true });
    await mkdir(into, { recursive: true });
    const file = path.join(this.deps.root, archive.file);
    await writeFile(file, bytes);
    try {
      await this.deps.extract(file, into);
    } finally {
      await rm(file, { force: true });
    }
  }

  private lima(args: string[], timeoutMs: number) {
    return this.deps.run(this.limactl(), args, {
      cwd: this.deps.root,
      env: { ...limaEnv(this.deps.env), LIMA_HOME: this.limaHome() },
      timeoutMs,
      onLine: this.deps.onLine,
    });
  }

  private fail(message: string) {
    return this.set({ phase: "error", percent: null, message });
  }

  private set(next: Partial<DesktopVirtualDesktopState>) {
    this.current = { ...this.current, ...next };
    return this.current;
  }

  private limaDir() {
    return path.join(this.deps.root, `lima-${LIMA_VERSION}`);
  }

  private limactl() {
    return path.join(this.limaDir(), "bin", "limactl");
  }

  private limaHome() {
    return path.join(this.deps.root, "h");
  }
}

/** Only what limactl needs; it must not inherit a DOCKER_HOST or a Lima home of the user's. */
function limaEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const { HOME, TMPDIR, USER, LANG } = env;
  const values = { HOME, TMPDIR, USER, LANG, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

/**
 * Lima's docker-rootful template with one writable mount: the server's data folder, where bots'
 * homes live. JSON is valid YAML, so the config needs no YAML library.
 */
export function limaConfig(dataDir: string): string {
  return JSON.stringify(
    {
      minimumLimaVersion: "2.0.0",
      vmType: "vz",
      base: ["template:_images/ubuntu-lts"],
      mounts: [{ location: dataDir, writable: true }],
      containerd: { system: false, user: false },
      provision: [
        {
          mode: "system",
          script: [
            "#!/bin/bash",
            "set -eux -o pipefail",
            "command -v docker >/dev/null 2>&1 && exit 0",
            "export DEBIAN_FRONTEND=noninteractive",
            "curl -fsSL https://get.docker.com | sh",
          ].join("\n"),
        },
        {
          mode: "yq",
          path: "/etc/systemd/system/docker.socket.d/override.conf",
          format: "ini",
          expression: '.Socket.SocketUser="{{.User}}"',
        },
      ],
      probes: [
        {
          script: [
            "#!/bin/bash",
            "set -eux -o pipefail",
            'timeout 30s bash -c "until command -v docker >/dev/null 2>&1; do sleep 3; done"',
            'timeout 30s bash -c "until pgrep dockerd; do sleep 3; done"',
          ].join("\n"),
          hint: 'See "/var/log/cloud-init-output.log" in the guest',
        },
      ],
      portForwards: [
        { guestSocket: "/var/run/docker.sock", hostSocket: "{{.Dir}}/sock/docker.sock" },
      ],
    },
    null,
    2,
  );
}
