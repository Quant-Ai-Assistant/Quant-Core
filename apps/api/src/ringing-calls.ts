import type { Actor } from "@rakazo/contracts";
import { CALL_REQUEST_RING_MS, ringingCall } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

/**
 * Bots ringing the caller right now, for a phone that rings in the background. Only who is
 * calling: the reason stays in the app, like on a lock screen.
 */
export async function listRingingCalls(
  prisma: PrismaClient,
  actor: Actor,
  now = Date.now(),
): Promise<
  Array<{ botId: string; botName: string; botColor: string; callId: string; expiresAt: string }>
> {
  const requests = await prisma.message.findMany({
    where: {
      createdAt: { gt: new Date(now - CALL_REQUEST_RING_MS) },
      role: "bot",
      clientNonce: { startsWith: "call:", endsWith: ":request" },
      thread: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        groupId: null,
        externalConversationId: null,
        bot: { userId: actor.userId, archivedAt: null },
      },
    },
    orderBy: { seq: "desc" },
    distinct: ["threadId"],
    select: {
      role: true,
      blocks: true,
      thread: { select: { botId: true, bot: { select: { name: true, color: true } } } },
    },
  });
  return requests.flatMap((request) => {
    const call = ringingCall([request], now);
    const botId = request.thread.botId;
    const botName = request.thread.bot?.name;
    const botColor = request.thread.bot?.color ?? "";
    if (!call || !botId || !botName) return [];
    return [{ botId, botName, botColor, callId: call.callId, expiresAt: call.expiresAt }];
  });
}
