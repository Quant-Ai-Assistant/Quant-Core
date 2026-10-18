import { describe, expect, it, vi } from "vitest";
import type { SettleReminderDeps } from "./reminders";
import { isReminderStillRinging, settleReminder } from "./reminders";

function deps(space = "space-a"): SettleReminderDeps {
  return {
    selectedSpaceId: () => space,
    selectSpace: vi.fn(async () => true),
    settle: vi.fn(async () => ({ ok: true })),
    dismiss: vi.fn(async () => {}),
  };
}

describe("reminders on the phone", () => {
  it("answers in the reminder's space and stops the ringing here", async () => {
    const d = deps();
    await settleReminder(
      { botId: "bot", reminderId: "r1", spaceId: "space-b", action: "snooze" },
      d,
    );
    expect(d.selectSpace).toHaveBeenCalledWith("space-b");
    expect(d.settle).toHaveBeenCalledWith({ botId: "bot", reminderId: "r1", action: "snooze" });
    expect(d.dismiss).toHaveBeenCalledWith("r1");
  });

  it("keeps ringing when the server did not take the answer", async () => {
    const d = deps();
    vi.mocked(d.settle).mockRejectedValue(new Error("offline"));
    await expect(
      settleReminder({ botId: "bot", reminderId: "r1", action: "done" }, d),
    ).rejects.toThrow("offline");
    expect(d.dismiss).not.toHaveBeenCalled();
    expect(d.selectSpace).not.toHaveBeenCalled();
  });

  it("refuses a link without a usable reminder id", async () => {
    await expect(
      settleReminder({ botId: "bot", reminderId: "", action: "done" }, deps()),
    ).rejects.toThrow();
  });

  it("knows when the reminder stopped ringing elsewhere", async () => {
    const ringing = [{ reminderId: "r1" }] as never;
    await expect(isReminderStillRinging("r1", async () => ringing)).resolves.toBe(true);
    await expect(isReminderStillRinging("r2", async () => ringing)).resolves.toBe(false);
  });
});
