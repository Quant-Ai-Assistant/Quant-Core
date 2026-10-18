import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createWatchFromTool, fireBotWatches, resolveWatchInput } from "./watches.js";

function jobs() {
  return { enqueue: vi.fn(async () => undefined), cancel: vi.fn(), close: vi.fn() };
}

describe("resolveWatchInput", () => {
  it("watches exactly one thing", () => {
    expect(resolveWatchInput({ goal: "milestones" })).toMatchObject({ ok: false });
    expect(
      resolveWatchInput({ goal: "milestones", bot_id: "b2", command: "test -f a" }),
    ).toMatchObject({ ok: false });
  });

  it("requires a goal", () => {
    expect(resolveWatchInput({ bot_id: "b2" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("goal"),
    });
  });

  it("defaults a bot watch to one day and a command watch to a 10 second check", () => {
    expect(resolveWatchInput({ goal: "Report milestones", confirm_name: "Builder" })).toEqual({
      ok: true,
      name: "Report milestones",
      goal: "Report milestones",
      bot: { botId: undefined, name: "Builder" },
      expiresInMinutes: 1440,
    });
    expect(
      resolveWatchInput({ name: "zip", goal: "Unpack it", command: "test -f ~/a.zip" }),
    ).toEqual({
      ok: true,
      name: "zip",
      goal: "Unpack it",
      command: { command: "test -f ~/a.zip", intervalSeconds: 10 },
      expiresInMinutes: 1440,
    });
  });

  it("bounds the check interval and the expiry", () => {
    for (const intervalSeconds of [1, 4, 3601, 2.5]) {
      expect(resolveWatchInput({ goal: "g", command: "true", intervalSeconds })).toMatchObject({
        ok: false,
      });
    }
    for (const expiresInMinutes of [0, 10_081, "soon"]) {
      expect(resolveWatchInput({ goal: "g", bot_id: "b2", expiresInMinutes })).toMatchObject({
        ok: false,
      });
    }
  });
});

describe("createWatchFromTool", () => {
  const input = { spaceId: "s1", botId: "b1", userId: "u1", threadId: "t1" };

  it("refuses to watch itself", async () => {
    const prisma = {
      watch: { count: vi.fn(async () => 0), create: vi.fn() },
      bot: { findMany: vi.fn(async () => [{ id: "b1", name: "Me" }]) },
    };
    const result = await createWatchFromTool(
      { prisma: prisma as unknown as PrismaClient, jobs: jobs() },
      { ...input, args: { goal: "g", bot_id: "b1" } },
    );
    expect(result).toEqual({ error: "a bot cannot watch itself" });
    expect(prisma.watch.create).not.toHaveBeenCalled();
  });

  it("queues the first check of a command watch", async () => {
    const queue = jobs();
    const prisma = {
      watch: {
        count: vi.fn(async () => 0),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "w1",
          ...data,
        })),
      },
    };
    const result = await createWatchFromTool(
      { prisma: prisma as unknown as PrismaClient, jobs: queue },
      { ...input, args: { goal: "Unpack it", command: "test -f a.zip", intervalSeconds: 5 } },
    );
    expect(result).toMatchObject({ ok: true, watchId: "w1", command: "test -f a.zip" });
    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "watch.check", payload: { watchId: "w1" } }),
    );
  });

  it("caps active watches per bot", async () => {
    const prisma = { watch: { count: vi.fn(async () => 20), create: vi.fn() } };
    const result = await createWatchFromTool(
      { prisma: prisma as unknown as PrismaClient, jobs: jobs() },
      { ...input, args: { goal: "g", command: "true" } },
    );
    expect(result).toHaveProperty("error");
    expect(prisma.watch.create).not.toHaveBeenCalled();
  });
});

describe("fireBotWatches", () => {
  const run = { spaceId: "s1", userId: "u1", botId: "b2", trigger: "user", sourceMessageId: null };

  it("never fires from a turn a watch started, or for an empty update", async () => {
    const prisma = { watch: { findMany: vi.fn(async () => []) } };
    const deps = { prisma: prisma as unknown as PrismaClient, jobs: jobs() };
    await fireBotWatches(deps, {
      run: { ...run, trigger: "watch" },
      botName: "B",
      event: "update",
      text: "Tests pass",
    });
    await fireBotWatches(deps, { run, botName: "B", event: "update", text: "  " });
    expect(prisma.watch.findMany).not.toHaveBeenCalled();
  });

  it("skips the finished turn of a bot the watcher delegated to, which reports back anyway", async () => {
    const watch = {
      id: "w1",
      spaceId: "s1",
      botId: "b1",
      userId: "u1",
      threadId: "t1",
      name: "n",
      goal: "g",
    };
    const prisma = {
      watch: { findMany: vi.fn(async () => [watch]) },
      message: {
        findUnique: vi.fn(async () => ({
          blocks: [
            { kind: "bot_message_received", fromBotId: "b1", fromBotName: "A", text: "do", hop: 1 },
          ],
          replyTo: null,
        })),
      },
      $transaction: vi.fn(),
    };
    await fireBotWatches(
      { prisma: prisma as unknown as PrismaClient, jobs: jobs() },
      {
        run: { ...run, trigger: "bot_message", sourceMessageId: "m1" },
        botName: "B",
        event: "finished",
        text: "All done",
      },
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not throw when the watch lookup fails", async () => {
    const prisma = {
      watch: {
        findMany: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
    };
    await expect(
      fireBotWatches(
        { prisma: prisma as unknown as PrismaClient, jobs: jobs() },
        { run, botName: "B", event: "update", text: "x" },
      ),
    ).resolves.toBeUndefined();
  });
});
