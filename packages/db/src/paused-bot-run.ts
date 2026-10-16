import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma } from "./client.js";
import { appendEventInTransaction } from "./events.js";

/**
 * Cancel a run that was about to start for a bot that is turned off, the way a user stop
 * would. Returns the run.cancelled event's seq, or null when the run already moved on or
 * its bot was turned back on.
 */
export async function cancelPausedBotRun(
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<number | null> {
  const run = await tx.run.findUnique({
    where: { id: runId },
    select: { id: true, spaceId: true, threadId: true, botId: true, taskId: true },
  });
  if (!run) return null;
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${run.threadId} FOR UPDATE`;
  const current = await tx.run.findFirst({
    where: {
      id: runId,
      status: { in: [...ACTIVE_RUN_STATUSES] },
      bot: { pausedAt: { not: null } },
    },
    select: { id: true },
  });
  if (!current) return null;
  await cancelRunsInTransaction(tx, [run], new Date());
  await tx.steeringMessage.deleteMany({
    where: { botId: run.botId, message: { threadId: run.threadId } },
  });
  await tx.event.deleteMany({ where: { runId, type: "thread.progress" } });
  const event = await appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "run.cancelled",
    runId,
    payload: {},
  });
  return event.seq;
}
