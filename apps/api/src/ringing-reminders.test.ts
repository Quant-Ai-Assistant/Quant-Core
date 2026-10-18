import type { Actor } from "@rakazo/contracts";
import { REMINDER_RING_MS } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { listRingingReminders } from "./ringing-reminders.js";

const NOW = Date.parse("2026-10-18T14:30:00Z");
const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;

function row(reminderId: string, ringsAt: number, details?: string) {
  return {
    blocks: [
      {
        kind: "reminder",
        reminderId,
        text: `Do ${reminderId}`,
        ...(details ? { details } : {}),
        status: "ringing",
        ringsAt: new Date(ringsAt).toISOString(),
        rings: 1,
      },
    ],
    thread: { botId: "bot-1", bot: { name: "Nova", color: "blue" } },
  };
}

describe("ringing reminders", () => {
  it("lists the user's reminders ringing now, with their text for the lock screen", async () => {
    const findMany = vi.fn(async () => [
      row("now", NOW - 1_000, "They close at four."),
      row("rang-out", NOW - REMINDER_RING_MS - 1),
    ]);
    const prisma = { message: { findMany } } as unknown as PrismaClient;
    await expect(listRingingReminders(prisma, actor, NOW)).resolves.toEqual([
      {
        botId: "bot-1",
        botName: "Nova",
        botColor: "blue",
        reminderId: "now",
        text: "Do now",
        details: "They close at four.",
        ringsAt: new Date(NOW - 1_000).toISOString(),
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          thread: expect.objectContaining({ spaceId: "space-1", userId: "user-1", groupId: null }),
        }),
      }),
    );
  });
});
