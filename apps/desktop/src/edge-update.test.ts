import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildInfo, EdgeDeps } from "./edge-update.js";
import { activeBuild, EdgeUpdater } from "./edge-update.js";

const own: BuildInfo = { sha: "a".repeat(40), committedAt: "2026-10-15T10:00:00Z", compat: "k1" };
const next: BuildInfo = { sha: "b".repeat(40), committedAt: "2026-10-16T10:00:00Z", compat: "k1" };

let dir: string;
let paths: { root: string; bundledServer: string };
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "edge-"));
  paths = { root: path.join(dir, "edge"), bundledServer: path.join(dir, "bundled") };
  await mkdir(path.join(paths.bundledServer, "app", "node_modules"), { recursive: true });
  await writeFile(path.join(paths.bundledServer, "app", "package.json"), "{}");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function unpacked(build: BuildInfo) {
  const root = path.join(paths.root, build.sha);
  await mkdir(path.join(root, "server", "app"), { recursive: true });
  await mkdir(path.join(root, "web"), { recursive: true });
  await writeFile(path.join(root, "server", "app", "api.mjs"), "");
  await writeFile(path.join(root, "build-info.json"), JSON.stringify(build));
  await writeFile(path.join(paths.root, "current.json"), JSON.stringify({ sha: build.sha }));
}

describe("builds from main on the desktop", () => {
  it("runs a newer build from main that fits this app, and the app's own files otherwise", async () => {
    expect(await activeBuild(paths, own)).toEqual({ build: own, serverDir: null, webRoot: null });
    await unpacked(next);
    expect(await activeBuild(paths, own)).toEqual({
      build: next,
      serverDir: path.join(paths.root, next.sha, "server"),
      webRoot: path.join(paths.root, next.sha, "web"),
    });
    // A full release newer than the build from main wins.
    const release = { ...own, committedAt: "2026-10-17T10:00:00Z" };
    expect((await activeBuild(paths, release))?.serverDir).toBeNull();
    // Different native parts: wait for the full release.
    expect((await activeBuild(paths, { ...own, compat: "k2" }))?.serverDir).toBeNull();
  });

  it("offers a newer build only when it fits this app", async () => {
    const manifest = { ...next, asset: "desktop-edge.tar.gz", size: 1, sha256: "x" };
    const deps: EdgeDeps = {
      fetch: vi.fn(async () => Response.json(manifest)),
      extract: vi.fn(),
      relaunch: vi.fn(),
      now: () => "now",
    };
    const updater = new EdgeUpdater(paths, own, deps);
    expect(await updater.check()).toMatchObject({ phase: "available", available: "bbbbbbb" });
    const other = new EdgeUpdater(paths, { ...own, compat: "k2" }, deps);
    expect(await other.check()).toMatchObject({ phase: "idle", problem: "needs-release" });
    const same = new EdgeUpdater(paths, next, deps);
    expect(await same.check()).toMatchObject({ phase: "idle", available: null });
  });

  it("installs a verified download over the app's native modules and restarts", async () => {
    const archive = Buffer.from("archive");
    const manifest = {
      ...next,
      asset: "desktop-edge.tar.gz",
      size: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex"),
    };
    const deps: EdgeDeps = {
      fetch: vi.fn(async (url: string) =>
        url.endsWith(".json") ? Response.json(manifest) : new Response(archive),
      ),
      extract: vi.fn(async (_archive: string, into: string) => {
        await mkdir(path.join(into, "server", "app"), { recursive: true });
        await mkdir(path.join(into, "web"), { recursive: true });
        await writeFile(path.join(into, "server", "app", "api.mjs"), "");
        await writeFile(path.join(into, "build-info.json"), JSON.stringify(next));
      }),
      relaunch: vi.fn(),
      now: () => "now",
    };
    const updater = new EdgeUpdater(paths, own, deps);
    await updater.check();
    expect(await updater.apply()).toMatchObject({ phase: "restarting" });
    expect(deps.relaunch).toHaveBeenCalled();
    const app = path.join(paths.root, next.sha, "server", "app");
    expect(existsSync(path.join(app, "node_modules"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(paths.root, "current.json"), "utf8"))).toEqual({
      sha: next.sha,
    });
    expect((await activeBuild(paths, own))?.build).toEqual(next);
  });

  it("refuses a download that does not match its checksum", async () => {
    const manifest = { ...next, asset: "desktop-edge.tar.gz", size: 7, sha256: "0".repeat(64) };
    const deps: EdgeDeps = {
      fetch: vi.fn(async (url: string) =>
        url.endsWith(".json") ? Response.json(manifest) : new Response("archive"),
      ),
      extract: vi.fn(),
      relaunch: vi.fn(),
      now: () => "now",
    };
    const updater = new EdgeUpdater(paths, own, deps);
    await updater.check();
    expect(await updater.apply()).toMatchObject({ phase: "error", problem: "failed" });
    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.relaunch).not.toHaveBeenCalled();
  });
});
