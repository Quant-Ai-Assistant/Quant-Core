import { describe, expect, it, vi } from "vitest";
import type { MobileBot, MobileMessage } from "./api";

vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
vi.mock("./api", () => ({
  copyableMobileMessageText: (message: MobileMessage) =>
    message.blocks.map((block) => ("text" in block ? String(block.text) : "")).join(""),
}));

const { assistantReply, assistantSupported, pickAssistantBot } = await import("./assistant");

function bot(id: string, archivedAt: string | null = null) {
  return { id, name: id, archivedAt } as unknown as MobileBot;
}

function message(role: MobileMessage["role"], text: string, clientNonce?: string): MobileMessage {
  return { id: text, role, clientNonce, blocks: [{ kind: "text", text }] } as MobileMessage;
}

describe("assistant", () => {
  it("is off where the native module is missing", () => {
    expect(assistantSupported()).toBe(false);
  });

  it("keeps the chosen bot while it is active, else takes the first", () => {
    const bots = [bot("a"), bot("b"), bot("old", "2026-10-01")];
    expect(pickAssistantBot(bots, "b")?.id).toBe("b");
    expect(pickAssistantBot(bots, "old")?.id).toBe("a");
    expect(pickAssistantBot(bots, null)?.id).toBe("a");
    expect(pickAssistantBot([], null)).toBeNull();
  });

  it("shows only the bot's replies after the message this sheet sent", () => {
    const messages = [
      message("bot", "earlier answer"),
      message("user", "what is on my screen?", "nonce-1"),
      message("bot", "A map of Gomel."),
      message("bot", "Want directions?"),
    ];
    expect(assistantReply(messages, "nonce-1")).toBe("A map of Gomel.\n\nWant directions?");
    expect(assistantReply(messages, null)).toBe("");
    expect(assistantReply(messages, "unknown")).toBe("");
  });
});
