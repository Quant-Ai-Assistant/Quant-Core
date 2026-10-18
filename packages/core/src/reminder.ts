import type { MessageBlock } from "@rakazo/contracts";

/** How long one ring lasts before it counts as unanswered. */
export const REMINDER_RING_MS = 60_000;
/** "In 5 minutes", and the pause before an unanswered reminder rings again. */
export const REMINDER_SNOOZE_MS = 5 * 60_000;
/** Unanswered rings in a row before the reminder counts as missed. */
export const REMINDER_MAX_RINGS = 3;

export const REMINDER_CLIENT_NONCE_PREFIX = "reminder:";

export type ReminderBlock = Extract<MessageBlock, { kind: "reminder" }>;

/** The reminder message's idempotency key; the server finds the reminder by it. */
export function reminderClientNonce(reminderId: string): string {
  if (reminderId.includes(":")) throw new Error(`reminderId must not contain ":": ${reminderId}`);
  return `${REMINDER_CLIENT_NONCE_PREFIX}${reminderId}`;
}

export function reminderBlock(
  blocks: readonly MessageBlock[] | null | undefined,
): ReminderBlock | undefined {
  const block = blocks?.[0];
  return block?.kind === "reminder" ? block : undefined;
}

export function newReminderBlock(input: {
  reminderId: string;
  text: string;
  details?: string;
  now: number;
}): ReminderBlock {
  return {
    kind: "reminder",
    reminderId: input.reminderId,
    text: input.text,
    ...(input.details ? { details: input.details } : {}),
    status: "ringing",
    ringsAt: new Date(input.now).toISOString(),
    rings: 1,
  };
}

/** Whether the reminder is on the user's screens right now. */
export function isReminderRinging(block: ReminderBlock, now = Date.now()): boolean {
  return block.status === "ringing" && now < Date.parse(block.ringsAt) + REMINDER_RING_MS;
}

/** When the reminder next moves on by itself, or null once it is settled. */
export function nextReminderTick(block: ReminderBlock): Date | null {
  if (block.status === "ringing") return new Date(Date.parse(block.ringsAt) + REMINDER_RING_MS);
  if (block.status === "snoozed") return new Date(Date.parse(block.ringsAt));
  return null;
}

/**
 * Where the reminder goes on the user's answer or on its own timer, or null when nothing changes.
 * The user's snooze starts the count of unanswered rings over; ringing out adds to it.
 */
export function advanceReminder(
  block: ReminderBlock,
  event: "done" | "snooze" | "tick",
  now = Date.now(),
): ReminderBlock | null {
  const later = new Date(now + REMINDER_SNOOZE_MS).toISOString();
  if (event === "done") {
    return block.status === "ringing" || block.status === "snoozed"
      ? { ...block, status: "done" }
      : null;
  }
  if (event === "snooze") {
    return block.status === "ringing"
      ? { ...block, status: "snoozed", ringsAt: later, rings: 0 }
      : null;
  }
  const due = nextReminderTick(block);
  if (!due || now < due.getTime()) return null;
  if (block.status === "snoozed") {
    return {
      ...block,
      status: "ringing",
      ringsAt: new Date(now).toISOString(),
      rings: block.rings + 1,
    };
  }
  return block.rings >= REMINDER_MAX_RINGS
    ? { ...block, status: "missed" }
    : { ...block, status: "snoozed", ringsAt: later };
}
