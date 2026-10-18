import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { reminderTickJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { ReminderBlock } from "@rakazo/core";
import {
  advanceReminder,
  newReminderBlock,
  nextReminderTick,
  REMINDER_CLIENT_NONCE_PREFIX,
  reminderBlock,
  reminderClientNonce,
} from "@rakazo/core";
import type { Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import { appendEventInTransaction, createThreadMessageInTransaction } from "@rakazo/db";

const TEXT_MAX = 120;
const DETAILS_MAX = 400;

type ReminderDeps = {
  prisma: PrismaClient;
  events: Pick<ThreadEvents, "notify">;
  jobs: JobPublisher;
};

/** Rings the user's devices with a reminder they mark done or snooze, like an alarm. */
export async function remindUser(
  deps: ReminderDeps,
  run: { id: string; spaceId: string; userId: string; threadId: string; botId: string },
  input: { text: string; details?: string },
  now = Date.now(),
): Promise<{ error: string } | { ok: true; status: "ringing" }> {
  const text = input.text.trim().slice(0, TEXT_MAX);
  const details = input.details?.trim().slice(0, DETAILS_MAX) || undefined;
  if (!text) return { error: "text is required." };
  const block = newReminderBlock({ reminderId: randomUUID(), text, details, now });
  const blocks: MessageBlock[] = [block];
  const result = await deps.prisma.$transaction(
    async (tx): Promise<{ error: string } | { eventSeq: number }> => {
      const target = await tx.thread.findFirst({
        where: {
          id: run.threadId,
          spaceId: run.spaceId,
          userId: run.userId,
          botId: run.botId,
          groupId: null,
          externalConversationId: null,
          bot: { userId: run.userId, spaceId: run.spaceId, archivedAt: null },
        },
        select: { id: true },
      });
      if (!target) return { error: "Reminders ring from the bot's own one-to-one chat only." };
      const message = await createThreadMessageInTransaction(tx, {
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        role: "bot",
        blocks,
        clientNonce: reminderClientNonce(block.reminderId),
        markUnread: true,
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: run.spaceId,
        threadId: run.threadId,
        botId: run.botId,
        runId: run.id,
        type: "thread.message.created",
        payload: { messageId: message.id, role: "bot", blocks },
      });
      return { eventSeq: event.seq };
    },
  );
  if ("error" in result) return result;
  await deps.events.notify(run.threadId, result.eventSeq).catch(() => undefined);
  await scheduleTick(deps, run.threadId, block);
  return { ok: true, status: "ringing" };
}

/**
 * Moves the reminder on by the user's answer or its own timer and tells the thread. Returns the
 * updated block, or null when the reminder is unknown or the move does not apply, so two devices
 * answering at once, or an answer racing the timer, settle exactly once.
 */
export async function advanceReminderMessage(
  deps: ReminderDeps,
  input: { threadId: string; reminderId: string; event: "done" | "snooze" | "tick" },
  now = Date.now(),
): Promise<ReminderBlock | null> {
  const result = await deps.prisma.$transaction(async (tx) => {
    // Match clearThread: thread first, then messages.
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const message = await tx.message.findUnique({
      where: {
        threadId_clientNonce: {
          threadId: input.threadId,
          clientNonce: reminderClientNonce(input.reminderId),
        },
      },
      select: { id: true, blocks: true, botId: true, thread: { select: { spaceId: true } } },
    });
    if (!message?.botId) return null;
    const before = Array.isArray(message.blocks) ? (message.blocks as MessageBlock[]) : [];
    const block = reminderBlock(before);
    const next = block && advanceReminder(block, input.event, now);
    if (!next) return null;
    const blocks = [next, ...before.slice(1)];
    // Compare-and-set on the stored blocks: a concurrent move leaves this one a no-op.
    const updated = await tx.message.updateMany({
      where: { id: message.id, blocks: { equals: message.blocks as Prisma.InputJsonValue } },
      data: { blocks: blocks as Prisma.InputJsonValue },
    });
    if (updated.count !== 1) return null;
    const event = await appendEventInTransaction(tx, {
      spaceId: message.thread.spaceId,
      threadId: input.threadId,
      botId: message.botId,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    return { next, eventSeq: event.seq };
  });
  if (!result) return null;
  await deps.events.notify(input.threadId, result.eventSeq).catch(() => undefined);
  await scheduleTick(deps, input.threadId, result.next);
  return result.next;
}

async function scheduleTick(
  deps: Pick<ReminderDeps, "jobs">,
  threadId: string,
  block: ReminderBlock,
) {
  const at = nextReminderTick(block);
  // The reconciler restores a lost tick, so a failed enqueue only delays the next ring.
  if (at)
    await deps.jobs.enqueue(reminderTickJob(threadId, block.reminderId, at)).catch(() => undefined);
}

/** Restore timers after a process interruption between persistence and enqueue. */
export async function reconcileReminders(deps: { prisma: PrismaClient; jobs: JobPublisher }) {
  const messages = await deps.prisma.message.findMany({
    where: {
      role: "bot",
      clientNonce: { startsWith: REMINDER_CLIENT_NONCE_PREFIX },
      OR: [
        { blocks: { path: ["0", "status"], equals: "ringing" } },
        { blocks: { path: ["0", "status"], equals: "snoozed" } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { threadId: true, blocks: true },
  });
  for (const message of messages) {
    const block = reminderBlock(message.blocks as MessageBlock[]);
    const at = block && nextReminderTick(block);
    if (block && at)
      await deps.jobs.enqueue(reminderTickJob(message.threadId, block.reminderId, at));
  }
}
