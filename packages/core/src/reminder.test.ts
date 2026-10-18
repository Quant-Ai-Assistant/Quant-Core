import { describe, expect, it } from "vitest";
import {
  advanceReminder,
  isReminderRinging,
  newReminderBlock,
  nextReminderTick,
  REMINDER_MAX_RINGS,
  REMINDER_RING_MS,
  REMINDER_SNOOZE_MS,
  reminderClientNonce,
} from "./reminder.js";

const NOW = Date.parse("2026-10-18T14:30:00Z");
const ringing = newReminderBlock({ reminderId: "r1", text: "Call the bank", now: NOW });

describe("reminders", () => {
  it("rings from the moment it is created until the ring runs out", () => {
    expect(isReminderRinging(ringing, NOW)).toBe(true);
    expect(isReminderRinging(ringing, NOW + REMINDER_RING_MS)).toBe(false);
    expect(nextReminderTick(ringing)?.getTime()).toBe(NOW + REMINDER_RING_MS);
  });

  it("comes back five minutes after a snooze and counts unanswered rings from there", () => {
    const snoozed = advanceReminder(ringing, "snooze", NOW + 1_000);
    expect(snoozed).toMatchObject({ status: "snoozed", rings: 0 });
    expect(isReminderRinging(snoozed!, NOW + 2_000)).toBe(false);
    expect(advanceReminder(snoozed!, "tick", NOW + 2_000)).toBeNull();
    const again = advanceReminder(snoozed!, "tick", NOW + 1_000 + REMINDER_SNOOZE_MS);
    expect(again).toMatchObject({ status: "ringing", rings: 1 });
  });

  it("rings again after going unanswered, then gives up as missed", () => {
    let block = ringing;
    let now = NOW;
    for (let ring = 1; ring < REMINDER_MAX_RINGS; ring++) {
      now += REMINDER_RING_MS;
      block = advanceReminder(block, "tick", now)!;
      expect(block.status).toBe("snoozed");
      now += REMINDER_SNOOZE_MS;
      block = advanceReminder(block, "tick", now)!;
      expect(block).toMatchObject({ status: "ringing", rings: ring + 1 });
    }
    expect(advanceReminder(block, "tick", now + REMINDER_RING_MS)?.status).toBe("missed");
  });

  it("settles once: done stays done, and a snooze needs a ringing reminder", () => {
    const done = advanceReminder(ringing, "done", NOW)!;
    expect(done.status).toBe("done");
    expect(advanceReminder(done, "done", NOW)).toBeNull();
    expect(advanceReminder(done, "snooze", NOW)).toBeNull();
    expect(advanceReminder(done, "tick", NOW + REMINDER_SNOOZE_MS)).toBeNull();
    expect(nextReminderTick(done)).toBeNull();
  });

  it("keys the message by the reminder id", () => {
    expect(reminderClientNonce("r1")).toBe("reminder:r1");
    expect(() => reminderClientNonce("a:b")).toThrow();
  });
});
