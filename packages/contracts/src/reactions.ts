import * as z from "zod";

export const MESSAGE_REACTIONS = ["👍", "👎", "❤️", "🔥", "😂", "🙏", "🎉", "😮"] as const;
export const MessageReactionSchema = z.enum(MESSAGE_REACTIONS);
export type MessageReaction = z.infer<typeof MessageReactionSchema>;

/**
 * Reactions that answer the bot's latest message (yes or no), so they start a turn.
 * The rest are only seen on the bot's next turn.
 */
export const ANSWERING_REACTIONS: ReadonlySet<MessageReaction> = new Set(["👍", "👎"]);
