import type { Actor, MessageBlock } from "@rakazo/contracts";
import { isReminderRinging, REMINDER_CLIENT_NONCE_PREFIX, reminderBlock } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

export type RingingReminder = {
  botId: string;
  botName: string;
  botColor: string;
  reminderId: string;
  text: string;
  details?: string;
  ringsAt: string;
};

/**
 * Reminders ringing the user right now, for the phone and desktop to show over everything. Unlike
 * a call, the text is the point, so it is shown on the lock screen too.
 */
export async function listRingingReminders(
  prisma: PrismaClient,
  actor: Actor,
  now = Date.now(),
): Promise<RingingReminder[]> {
  const messages = await prisma.message.findMany({
    where: {
      role: "bot",
      clientNonce: { startsWith: REMINDER_CLIENT_NONCE_PREFIX },
      blocks: { path: ["0", "status"], equals: "ringing" },
      thread: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        groupId: null,
        externalConversationId: null,
        bot: { userId: actor.userId, archivedAt: null },
      },
    },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: {
      blocks: true,
      thread: { select: { botId: true, bot: { select: { name: true, color: true } } } },
    },
  });
  return messages.flatMap((message) => {
    const block = reminderBlock(message.blocks as MessageBlock[]);
    const botId = message.thread.botId;
    const botName = message.thread.bot?.name;
    if (!block || !botId || !botName || !isReminderRinging(block, now)) return [];
    return [
      {
        botId,
        botName,
        botColor: message.thread.bot?.color ?? "",
        reminderId: block.reminderId,
        text: block.text,
        ...(block.details ? { details: block.details } : {}),
        ringsAt: block.ringsAt,
      },
    ];
  });
}
