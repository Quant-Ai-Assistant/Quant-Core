import type { PrismaClient } from "./client.js";

/** Whether the user connected the OpenAI key calls need. */
export async function hasCallKey(
  prisma: Pick<PrismaClient, "userCallSettings">,
  userId: string,
): Promise<boolean> {
  const settings = await prisma.userCallSettings.findFirst({
    where: { userId, secretId: { not: null } },
    select: { userId: true },
  });
  return Boolean(settings);
}
