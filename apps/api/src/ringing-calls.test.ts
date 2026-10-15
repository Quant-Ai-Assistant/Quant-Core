import { describe, expect, it, vi } from "vitest";
import { listRingingCalls } from "./ringing-calls.js";

const actor = { userId: "user", spaceId: "space" } as never;
const now = Date.parse("2026-10-15T12:00:00Z");

function request(status: string, expiresAt: string, callId = "call-1") {
  return {
    role: "bot",
    blocks: [{ kind: "call_request", callId, status, expiresAt, reason: "Secret", opening: "Hi" }],
    thread: { botId: "bot", bot: { name: "Ada", color: "#123456" } },
  };
}

describe("ringing calls", () => {
  it("lists who is calling, scoped to the caller's own bot chats, without the reason", async () => {
    const findMany = vi.fn(async () => [
      request("ringing", "2026-10-15T12:00:30Z"),
      request("answered", "2026-10-15T12:00:30Z", "call-2"),
      request("ringing", "2026-10-15T11:59:59Z", "call-3"),
    ]);
    const calls = await listRingingCalls({ message: { findMany } } as never, actor, now);
    expect(calls).toEqual([
      {
        botId: "bot",
        botName: "Ada",
        botColor: "#123456",
        callId: "call-1",
        expiresAt: "2026-10-15T12:00:30Z",
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          thread: expect.objectContaining({
            spaceId: "space",
            userId: "user",
            groupId: null,
            externalConversationId: null,
          }),
        }),
      }),
    );
  });
});
