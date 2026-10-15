import { describe, expect, it, vi } from "vitest";
import { awaitRunReply, finishLiveCall, liveCallInstructions } from "./live-call.js";

describe("live call", () => {
  it("gives the voice model the bot's character, language and when to hand work back", () => {
    const text = liveCallInstructions({
      botName: "Ada",
      title: "Research assistant",
      description: "",
      instructions: "Call me Lex.",
      language: "ru",
    });
    expect(text).toContain("You are Ada, Research assistant.");
    expect(text).toContain("Call me Lex.");
    expect(text).toContain("Speak ru");
    expect(text).toContain("Interruption policy:");
    expect(text).toContain("Delegation policy:");
  });

  it("waits for the run to stop, then reads the bot's reply after the request", async () => {
    const statuses = ["running", "running", "completed"];
    const prisma = {
      run: { findUnique: vi.fn(async () => ({ status: statuses.shift() ?? "completed" })) },
      message: {
        findMany: vi.fn(async () => [
          { blocks: [{ kind: "text", text: "Booked for 7." }] },
          { blocks: [{ kind: "text", text: "Anything else?" }] },
        ]),
      },
    };
    vi.useFakeTimers();
    const reply = awaitRunReply({ prisma: prisma as never }, "run_1", 10);
    await vi.runAllTimersAsync();
    expect(await reply).toBe("Booked for 7.\nAnything else?");
    vi.useRealTimers();
    expect(prisma.run.findUnique).toHaveBeenCalledTimes(3);
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: "run_1", role: "bot", seq: { gt: 10 } } }),
    );
  });

  it("has nothing to wait for when this process never attached to the call", async () => {
    await expect(
      finishLiveCall({ userId: "u", spaceId: "s" } as never, "call_1"),
    ).resolves.toBeUndefined();
  });
});
