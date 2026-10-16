import { type MessageBlock, type MessageReaction, MessageReactionSchema } from "@rakazo/contracts";

type ReactionMessage = {
  id: string;
  role: string;
  blocks: MessageBlock[];
  botId?: string | null;
  replyToMessageId?: string | null;
};

/** One emoji on a message, with who put it there. */
export type MessageReactionSummary = {
  emoji: MessageReaction;
  count: number;
  /** The user reacted with this emoji, so choosing it again removes it. */
  mine: boolean;
  /** Bots that reacted with this emoji, in the order they did. */
  botIds: string[];
};

/**
 * Emoji-only replies are reactions, displayed compactly beneath their target.
 * The user's come from the composer's reaction picker, a bot's from its react tool.
 */
export function messageReaction(
  message: Pick<ReactionMessage, "role" | "blocks" | "replyToMessageId">,
): MessageReaction | null {
  if (message.role !== "user" && message.role !== "bot") return null;
  if (!message.replyToMessageId || message.blocks.length !== 1) return null;
  const block = message.blocks[0];
  return block?.kind === "text" ? (MessageReactionSchema.safeParse(block.text).data ?? null) : null;
}

export function projectMessageReactions<Message extends ReactionMessage>(
  messages: readonly Message[],
) {
  const parents = new Map(messages.map((message) => [message.id, message]));
  const reactions = new Map<string, MessageReactionSummary[]>();
  const visibleMessages = messages.filter((message) => {
    const emoji = messageReaction(message);
    const parentId = message.replyToMessageId;
    const parent = parentId ? parents.get(parentId) : undefined;
    // Keep an ordinary reply bubble when the parent is outside the loaded page, so it can be opened.
    if (!emoji || !parentId || !parent || messageReaction(parent) || parentId === message.id)
      return true;
    const summaries = reactions.get(parentId) ?? [];
    let summary = summaries.find((candidate) => candidate.emoji === emoji);
    if (!summary) {
      summary = { emoji, count: 0, mine: false, botIds: [] };
      summaries.push(summary);
    }
    summary.count += 1;
    if (message.role === "user") summary.mine = true;
    else if (message.botId && !summary.botIds.includes(message.botId))
      summary.botIds.push(message.botId);
    reactions.set(parentId, summaries);
    return false;
  });
  return { visibleMessages, reactions };
}

/** Drops the reaction messages a `thread.message.reaction` event says were removed or replaced. */
export function withoutRemovedReactions<Message extends { id: string }>(
  messages: readonly Message[],
  payload: Record<string, unknown> | undefined,
): Message[] {
  const removed = payload?.removedMessageIds;
  if (!Array.isArray(removed) || removed.length === 0) return [...messages];
  const ids = new Set(removed.filter((id): id is string => typeof id === "string"));
  return messages.filter((message) => !ids.has(message.id));
}
