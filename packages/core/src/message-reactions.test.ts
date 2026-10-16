import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  messageReaction,
  projectMessageReactions,
  withoutRemovedReactions,
} from "./message-reactions.js";

const message = (id: string, text: string, replyToMessageId?: string) => ({
  id,
  role: "user",
  blocks: [{ kind: "text", text }] as MessageBlock[],
  replyToMessageId,
});

describe("reaction conversation presentation", () => {
  it("counts reactions per emoji and marks the user's own", () => {
    const parent = message("parent", "Hello");
    const messages = [
      parent,
      message("one", "❤️", parent.id),
      { ...message("two", "👍", parent.id), role: "bot", botId: "bot-2" },
      { ...message("three", "❤️", parent.id), role: "bot", botId: "bot-1" },
    ];
    const result = projectMessageReactions(messages);
    expect(result.visibleMessages).toEqual([parent]);
    expect(result.reactions.get(parent.id)).toEqual([
      { emoji: "❤️", count: 2, mine: true, botIds: ["bot-1"] },
      { emoji: "👍", count: 1, mine: false, botIds: ["bot-2"] },
    ]);
    expect(messages).toHaveLength(4);
  });
  it("shows a bot's reaction to the user's message beneath it", () => {
    const parent = message("parent", "Remind me in two hours");
    const reaction = { ...message("like", "👍", parent.id), role: "bot", botId: "bot-1" };
    const result = projectMessageReactions([parent, reaction]);
    expect(result.visibleMessages).toEqual([parent]);
    expect(result.reactions.get(parent.id)).toEqual([
      { emoji: "👍", count: 1, mine: false, botIds: ["bot-1"] },
    ]);
  });
  it("keeps replies visible when their parent is outside the loaded page", () => {
    const reply = message("reply", "❤️", "old-parent");
    expect(projectMessageReactions([reply]).visibleMessages).toEqual([reply]);
  });
  it("does not collapse ordinary replies, standalone emoji, or system messages", () => {
    expect(messageReaction(message("one", "❤️"))).toBeNull();
    expect(messageReaction(message("two", "❤️ thank you", "parent"))).toBeNull();
    expect(messageReaction({ ...message("three", "❤️", "parent"), role: "system" })).toBeNull();
  });
});

describe("reaction removal events", () => {
  it("drops only the removed reaction messages", () => {
    const messages = [message("parent", "Hi"), message("like", "👍", "parent")];
    expect(withoutRemovedReactions(messages, { removedMessageIds: ["like"] })).toEqual([
      messages[0],
    ]);
    expect(withoutRemovedReactions(messages, {})).toEqual(messages);
  });
});
