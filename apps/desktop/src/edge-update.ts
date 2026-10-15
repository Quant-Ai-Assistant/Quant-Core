import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DesktopEdgeManifest, DesktopEdgeState } from "@rakazo/contracts";
import { EDGE_DOWNLOAD_URL } from "@rakazo/contracts/edge-download";

/**
 * Fast updates from main: the web app and the bundled server's JavaScript, swapped in without a
 * new installer. The installed app keeps its native parts (Electron, Postgres, native modules),
 * so a build only applies when its compatibility key matches them. A newer full release always
 * wins over an older build from main.
 */

export type BuildInfo = { sha: string; committedAt: string; compat: string };

export type EdgePaths = {
  /** `<userData>/edge`: one unpacked build and `current.json` naming it. */
  root: string;
  /** The installed app's own server folder, whose native modules a build from main reuses. */
  bundledServer: string;
};

export type ActiveBuild = { build: BuildInfo; serverDir: string | null; webRoot: string | null };

const CURRENT = "current.json";

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function newer(a: BuildInfo, b: BuildInfo): boolean {
  return Date.parse(a.committedAt) > Date.parse(b.committedAt);
}

/**
 * What this launch runs: the unpacked build from main when it fits this app and is newer than
 * the app itself, otherwise the app's own files (null folders).
 */
export async function activeBuild(
  paths: EdgePaths,
  own: BuildInfo | null,
): Promise<ActiveBuild | null> {
  if (!own) return null;
  const current = await readJson<{ sha?: string }>(path.join(paths.root, CURRENT));
  const dir =
    current?.sha && /^[a-f0-9]{7,40}$/.test(current.sha)
      ? path.join(paths.root, current.sha)
      : null;
  const build = dir ? await readJson<BuildInfo>(path.join(dir, "build-info.json")) : null;
  if (!dir || !build || build.compat !== own.compat || !newer(build, own)) {
    return { build: own, serverDir: null, webRoot: null };
  }
  if (
    !existsSync(path.join(dir, "server", "app", "api.mjs")) ||
    !existsSync(path.join(dir, "web"))
  ) {
    return { build: own, serverDir: null, webRoot: null };
  }
  return { build, serverDir: path.join(dir, "server"), webRoot: path.join(dir, "web") };
}

export type EdgeDeps = {
  fetch: (url: string) => Promise<Response>;
  /** Unpacks a .tar.gz into a folder. */
  extract: (archive: string, into: string) => Promise<void>;
  /** Quits and starts the app again on the new files. */
  relaunch: () => void;
  now: () => string;
};

const run = promisify(execFile);

export const systemExtract: EdgeDeps["extract"] = async (archive, into) => {
  // tar ships with macOS, Linux and Windows 10 and later.
  await run("tar", ["-xzf", archive, "-C", into]);
};

export class EdgeUpdater {
  private current: DesktopEdgeState;
  private manifest: DesktopEdgeManifest | null = null;
  private busy: Promise<DesktopEdgeState> | null = null;

  constructor(
    private readonly paths: EdgePaths,
    private readonly running: BuildInfo | null,
    private readonly deps: EdgeDeps,
  ) {
    this.current = {
      phase: running ? "idle" : "unsupported",
      current: running ? running.sha.slice(0, 7) : null,
      available: null,
      problem: null,
    };
  }

  state(): DesktopEdgeState {
    return this.current;
  }

  check(): Promise<DesktopEdgeState> {
    this.busy ??= this.runCheck().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  apply(): Promise<DesktopEdgeState> {
    this.busy ??= this.runApply().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private set(next: Partial<DesktopEdgeState>) {
    this.current = { ...this.current, ...next };
  }

  private async runCheck(): Promise<DesktopEdgeState> {
    if (!this.running || this.current.phase === "applying") return this.current;
    this.set({ phase: "checking", problem: null });
    try {
      const res = await this.deps.fetch(`${EDGE_DOWNLOAD_URL}/desktop-edge.json`);
      if (res.status === 404) {
        this.set({ phase: "idle", available: null, checkedAt: this.deps.now() });
        return this.current;
      }
      if (!res.ok) throw new Error(`edge manifest ${res.status}`);
      const manifest = (await res.json()) as DesktopEdgeManifest;
      if (manifest.compat !== this.running.compat) {
        this.manifest = null;
        this.set({
          phase: "idle",
          available: null,
          problem: "needs-release",
          checkedAt: this.deps.now(),
        });
        return this.current;
      }
      const isNewer = manifest.sha !== this.running.sha && newer(manifest, this.running);
      this.manifest = isNewer ? manifest : null;
      this.set({
        phase: isNewer ? "available" : "idle",
        available: isNewer ? manifest.sha.slice(0, 7) : null,
        checkedAt: this.deps.now(),
      });
    } catch {
      this.set({ phase: "error", problem: "offline" });
    }
    return this.current;
  }

  private async runApply(): Promise<DesktopEdgeState> {
    const manifest = this.manifest;
    if (!manifest || this.current.phase !== "available") return this.current;
    this.set({ phase: "applying", problem: null });
    const target = path.join(this.paths.root, manifest.sha);
    const partial = `${target}.partial`;
    const archive = path.join(this.paths.root, `${manifest.sha}.tar.gz`);
    try {
      await mkdir(this.paths.root, { recursive: true });
      const res = await this.deps.fetch(`${EDGE_DOWNLOAD_URL}/${manifest.asset}`);
      if (!res.ok) throw new Error(`edge download ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== manifest.size || digest !== manifest.sha256) {
        throw new Error("The download did not match its checksum.");
      }
      await writeFile(archive, bytes);
      await rm(partial, { recursive: true, force: true });
      await mkdir(partial, { recursive: true });
      await this.deps.extract(archive, partial);
      const info = await readJson<BuildInfo>(path.join(partial, "build-info.json"));
      if (info?.sha !== manifest.sha || info.compat !== this.running?.compat) {
        throw new Error("The download is not the build it claimed to be.");
      }
      // The new JavaScript loads the installed native modules and Postgres in place.
      const app = path.join(partial, "server", "app");
      await symlink(
        path.join(this.paths.bundledServer, "app", "node_modules"),
        path.join(app, "node_modules"),
        "junction",
      );
      await copyFile(
        path.join(this.paths.bundledServer, "app", "package.json"),
        path.join(app, "package.json"),
      );
      await rm(target, { recursive: true, force: true });
      await rename(partial, target);
      await writeFile(
        path.join(this.paths.root, CURRENT),
        `${JSON.stringify({ sha: manifest.sha })}\n`,
      );
      await pruneOtherBuilds(this.paths.root, manifest.sha);
      this.set({ phase: "restarting" });
      this.deps.relaunch();
    } catch (error) {
      await rm(partial, { recursive: true, force: true }).catch(() => undefined);
      this.set({ phase: "error", problem: "failed" });
    } finally {
      await rm(archive, { force: true }).catch(() => undefined);
    }
    return this.current;
  }
}

/** Keeps only the build just installed: older builds from main are never run again. */
async function pruneOtherBuilds(root: string, keep: string) {
  for (const name of await readdir(root)) {
    if (name === keep || name === CURRENT) continue;
    await rm(path.join(root, name), { recursive: true, force: true });
  }
}

/** Drops a build from main that a newer full release replaced, so it does not linger on disk. */
export async function forgetStaleBuild(paths: EdgePaths, active: ActiveBuild | null) {
  if (active?.serverDir) return;
  if (!existsSync(paths.root)) return;
  await rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
}
