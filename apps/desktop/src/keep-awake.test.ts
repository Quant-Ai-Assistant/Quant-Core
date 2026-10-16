import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeepAwake, readKeepAwake, writeKeepAwake } from "./keep-awake.js";

function fakeBlocker() {
  const active = new Set<number>();
  let next = 1;
  return {
    active,
    start: () => {
      const id = next++;
      active.add(id);
      return id;
    },
    stop: (id: number) => {
      active.delete(id);
    },
  };
}

describe("KeepAwake", () => {
  it("holds one display-sleep blocker while on", () => {
    const blocker = fakeBlocker();
    const keepAwake = new KeepAwake(blocker);
    keepAwake.set(true);
    keepAwake.set(true);
    expect(keepAwake.on()).toBe(true);
    expect(blocker.active.size).toBe(1);
    keepAwake.set(false);
    expect(keepAwake.on()).toBe(false);
    expect(blocker.active.size).toBe(0);
  });
});

describe("keep-awake preference", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("is off until saved, then survives a restart", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "quant-keep-awake-"));
    expect(await readKeepAwake(dir)).toBe(false);
    await writeKeepAwake(dir, true);
    expect(await readKeepAwake(dir)).toBe(true);
    await writeKeepAwake(dir, false);
    expect(await readKeepAwake(dir)).toBe(false);
  });

  it("reads a damaged file as off", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "quant-keep-awake-"));
    await writeFile(path.join(dir, "keep-awake.json"), "{");
    expect(await readKeepAwake(dir)).toBe(false);
  });
});
