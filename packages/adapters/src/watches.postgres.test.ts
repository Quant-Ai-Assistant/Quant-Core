import { randomUUID } from "node:crypto";
import type { BackgroundJob, ProcessEvent, SandboxProvider } from "@rakazo/adapter-kit";
import { createDb } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { checkCommandWatch, createWatchFromTool, fireBotWatches } from "./watches.js";

const postgres =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

function jobs() {
  return {
    enqueue: vi.fn(async (_job: BackgroundJob) => undefined),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(),
  };
}

function sandboxExiting(codes: number[]) {
  return {
    execute: vi.fn(async function* (): AsyncIterable<ProcessEvent> {
      yield { type: "stdout", data: "ready\n" };
      yield { type: "exit", code: codes.shift() ?? 1 };
    }),
    keepAlive: vi.fn(async () => undefined),
  } as unknown as SandboxProvider & { execute: ReturnType<typeof vi.fn> };
}

postgres("watches (PostgreSQL)", () => {
  it("wakes the watcher once per burst of updates and only when a check passes", async () => {
    const { prisma, pool } = createDb(process.env.DATABASE_URL!);
    const id = `watch-test-${randomUUID()}`;
    const userId = `${id}-user`;
    const spaceId = `${id}-space`;
    const organizationId = `${id}-org`;
    try {
      await prisma.user.create({
        data: { id: userId, name: "Watch tester", email: `${id}@rakazo.test` },
      });
      await prisma.organization.create({
        data: { id: organizationId, name: "Watch tests", slug: id, createdAt: new Date() },
      });
      await prisma.space.create({ data: { id: spaceId, organizationId, name: "Watch tests" } });
      const computer = await prisma.computer.create({
        data: {
          spaceId,
          userId,
          scope: "dedicated",
          scopeKey: `${id}-scope`,
          homeKey: `${id}-home`,
          kind: "docker",
          providerRef: `${id}-ref`,
          state: "running",
        },
      });
      const [watcher, worker] = await Promise.all(
        ["Lead", "Builder"].map((name) =>
          prisma.bot.create({
            data: {
              spaceId,
              userId,
              name,
              color: "ink",
              computerId: computer.id,
              thread: { create: { spaceId, userId } },
            },
            include: { thread: true },
          }),
        ),
      );
      const queue = jobs();
      const deps = { prisma, jobs: queue };
      const scope = { spaceId, botId: watcher!.id, userId, threadId: watcher!.thread!.id };

      const botWatch = await createWatchFromTool(deps, {
        ...scope,
        args: { name: "milestones", goal: "Report each milestone", confirm_name: "Builder" },
      });
      expect(botWatch).toMatchObject({ ok: true, watching: "Builder" });
      const workerRun = { spaceId, userId, botId: worker!.id, trigger: "user" };
      await fireBotWatches(deps, {
        run: workerRun,
        botName: "Builder",
        event: "update",
        text: "Tests pass",
      });
      await fireBotWatches(deps, {
        run: workerRun,
        botName: "Builder",
        event: "finished",
        text: "PR opened",
      });
      // A turn the watch itself started never fires watches.
      await fireBotWatches(deps, {
        run: { ...workerRun, trigger: "watch" },
        botName: "Builder",
        event: "update",
        text: "Loop",
      });
      const wakes = await prisma.run.findMany({
        where: { botId: watcher!.id, trigger: "watch" },
        include: { task: true },
      });
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.task.prompt).toContain("Tests pass");
      expect(wakes[0]!.task.prompt).toContain('event="finished"');
      expect(wakes[0]!.task.prompt).toContain("PR opened");
      expect(wakes[0]!.task.prompt).not.toContain("Loop");
      expect(queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: "run.continue", payload: { runId: wakes[0]!.id } }),
      );

      // Once the first wake has started, the next update queues a new one.
      await prisma.run.update({ where: { id: wakes[0]!.id }, data: { status: "running" } });
      await fireBotWatches(deps, {
        run: workerRun,
        botName: "Builder",
        event: "update",
        text: "Deployed",
      });
      expect(await prisma.run.count({ where: { botId: watcher!.id, trigger: "watch" } })).toBe(2);

      const commandWatch = await createWatchFromTool(deps, {
        ...scope,
        args: { name: "zip", goal: "Unpack it", command: "test -f a.zip", intervalSeconds: 5 },
      });
      if (!("watchId" in commandWatch)) throw new Error("command watch was not created");
      const sandbox = sandboxExiting([1, 0]);
      await checkCommandWatch({ ...deps, sandbox }, commandWatch.watchId);
      const pending = await prisma.watch.findUniqueOrThrow({ where: { id: commandWatch.watchId } });
      expect(pending.active).toBe(true);
      expect(await prisma.run.count({ where: { watchId: commandWatch.watchId } })).toBe(0);

      await checkCommandWatch({ ...deps, sandbox }, commandWatch.watchId);
      const passed = await prisma.watch.findUniqueOrThrow({ where: { id: commandWatch.watchId } });
      expect(passed).toMatchObject({ active: false, nextCheckAt: null, fireCount: 1 });
      const commandWake = await prisma.run.findFirstOrThrow({
        where: { watchId: commandWatch.watchId },
        include: { task: true },
      });
      expect(commandWake.task.prompt).toContain("The check `test -f a.zip` passed.");
      expect(sandbox.execute).toHaveBeenCalledTimes(2);

      // A stale job for a fired watch does nothing.
      await checkCommandWatch({ ...deps, sandbox }, commandWatch.watchId);
      expect(sandbox.execute).toHaveBeenCalledTimes(2);

      const expiring = await createWatchFromTool(deps, {
        ...scope,
        args: { goal: "Wait for it", command: "false" },
      });
      if (!("watchId" in expiring)) throw new Error("expiring watch was not created");
      await prisma.watch.update({
        where: { id: expiring.watchId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      await checkCommandWatch({ ...deps, sandbox }, expiring.watchId);
      const expiredWake = await prisma.run.findFirstOrThrow({
        where: { watchId: expiring.watchId },
        include: { task: true },
      });
      expect(expiredWake.task.prompt).toContain("never passed");
    } finally {
      await prisma.space.deleteMany({ where: { id: spaceId } });
      await prisma.computer.deleteMany({ where: { spaceId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await pool.end();
    }
  });
});
