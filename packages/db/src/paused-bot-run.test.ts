import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import { cancelPausedBotRun } from "./paused-bot-run.js";

function fakeTx(options: { stillPaused: boolean }) {
  return {
    $queryRaw: vi.fn(),
    run: {
      findUnique: vi
        .fn()
        .mockResolvedValueOnce({
          id: "run-1",
          spaceId: "space-1",
          threadId: "thread-1",
          botId: "bot-1",
          taskId: "task-1",
        })
        // The event append re-reads the run to check it is cancelled.
        .mockResolvedValue({ status: "cancelled" }),
      findFirst: vi.fn().mockResolvedValue(options.stillPaused ? { id: "run-1" } : null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    attempt: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    task: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    steeringMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    thread: { update: vi.fn().mockResolvedValue({ nextEventSeq: 7 }) },
    event: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

describe("cancelPausedBotRun", () => {
  it("cancels the run of a bot that is off and tells the thread", async () => {
    const tx = fakeTx({ stillPaused: true });

    const seq = await cancelPausedBotRun(tx as unknown as Prisma.TransactionClient, "run-1");

    expect(seq).toBe(6);
    expect(tx.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "run-1", bot: { pausedAt: { not: null } } }),
      }),
    );
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["run-1"] } },
        data: expect.objectContaining({ status: "cancelled" }),
      }),
    );
    expect(tx.event.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "run.cancelled", runId: "run-1" }),
    });
  });

  it("leaves the run alone once the bot is back on", async () => {
    const tx = fakeTx({ stillPaused: false });

    const seq = await cancelPausedBotRun(tx as unknown as Prisma.TransactionClient, "run-1");

    expect(seq).toBeNull();
    expect(tx.run.updateMany).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
  });
});
