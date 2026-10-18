/** The shape the server accepts for a reminder id. */
const REMINDER_ID = /^[^:]{1,200}$/;

export type RingingReminder = {
  botId: string;
  botName: string;
  botColor: string;
  reminderId: string;
  text: string;
  details?: string;
  ringsAt: string;
};

export type SettleReminderDeps = {
  selectedSpaceId: () => string | null;
  selectSpace: (spaceId: string) => Promise<unknown>;
  settle: (input: {
    botId: string;
    reminderId: string;
    action: "done" | "snooze";
  }) => Promise<unknown>;
  dismiss: (reminderId: string) => Promise<void>;
};

/** Marks the reminder done or snoozes it in its space; the other devices go quiet on the server's word. */
export async function settleReminder(
  input: { botId: string; reminderId: string; spaceId?: string; action: "done" | "snooze" },
  deps: SettleReminderDeps,
): Promise<void> {
  if (!input.botId || !REMINDER_ID.test(input.reminderId)) {
    throw new Error("This reminder is no longer ringing.");
  }
  if (input.spaceId && input.spaceId !== deps.selectedSpaceId()) {
    await deps.selectSpace(input.spaceId);
  }
  await deps.settle({ botId: input.botId, reminderId: input.reminderId, action: input.action });
  await deps.dismiss(input.reminderId).catch(() => undefined);
}

/** Whether a reminder is still ringing for this user, for the screen to close when it stops. */
export async function isReminderStillRinging(
  reminderId: string,
  list: () => Promise<RingingReminder[]>,
): Promise<boolean> {
  return (await list()).some((reminder) => reminder.reminderId === reminderId);
}
