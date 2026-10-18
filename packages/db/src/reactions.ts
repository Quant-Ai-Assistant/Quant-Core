import type { MessageBlock, MessageReaction } from "@rakazo/contracts";
import { messageReaction } from "@rakazo/core";
import type { Prisma } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";

export type SetMessageReactionInput = {
  spaceId: string;
  threadId: string;
  /** The bot the events are filed under: the reacting bot, or the thread's bot for the user. */
  eventBotId: string;
  parentId: string;
  /** The user, or the bot (by id) that reacts. Each keeps at most one reaction per message. */
  reactor: { role: "user" } | { role: "bot"; botId: string; runId: string };
  /** Null removes the reactor's reaction. */
  reaction: MessageReaction | null;
  clientNonce?: string;
};

/**
 * Replaces the reactor's reaction on a message. A reaction is an emoji-only reply,
 * so history keeps it in order and the next turn reads its target.
 * Returns the new reaction message, if any, and the last event to notify.
 */
export async function setMessageReactionInTransaction(
  tx: Prisma.TransactionClient,
  input: SetMessageReactionInput,
) {
  const { reactor } = input;
  const replies = await tx.message.findMany({
    where: {
      threadId: input.threadId,
      replyToMessageId: input.parentId,
      role: reactor.role,
      ...(reactor.role === "bot" ? { botId: reactor.botId } : {}),
    },
    select: { id: true, role: true, blocks: true, replyToMessageId: true },
  });
  const previous = replies.filter((reply) =>
    messageReaction({ ...reply, blocks: reply.blocks as MessageBlock[] }),
  );
  const unchanged = previous.find(
    (reply) =>
      messageReaction({ ...reply, blocks: reply.blocks as MessageBlock[] }) === input.reaction,
  );
  if (unchanged && previous.length === 1) return { message: null, eventSeq: null };

  let eventSeq: number | null = null;
  const runId = reactor.role === "bot" ? reactor.runId : undefined;
  if (previous.length > 0) {
    const removedMessageIds = previous.map((reply) => reply.id);
    await tx.message.deleteMany({ where: { id: { in: removedMessageIds } } });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.eventBotId,
      type: "thread.message.reaction",
      runId,
      payload: { messageId: input.parentId, removedMessageIds },
    });
    eventSeq = event.seq;
  }
  if (!input.reaction) return { message: null, eventSeq };

  const blocks: MessageBlock[] = [{ kind: "text", text: input.reaction }];
  const message = await createThreadMessageInTransaction(tx, {
    threadId: input.threadId,
    role: reactor.role,
    blocks,
    botId: reactor.role === "bot" ? reactor.botId : undefined,
    runId,
    replyToMessageId: input.parentId,
    clientNonce: input.clientNonce,
    // A reaction is glanceable beneath its message; it never raises the unread dot.
    markUnread: false,
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.eventBotId,
    type: "thread.message.created",
    runId,
    payload: {
      messageId: message.id,
      role: reactor.role,
      blocks,
      replyToMessageId: input.parentId,
    },
  });
  return { message, eventSeq: event.seq };
}
