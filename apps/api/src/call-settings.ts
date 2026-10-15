import { ORPCError } from "@orpc/server";
import type { SecretStore, VoiceProvider } from "@rakazo/adapter-kit";
import { createVoiceProvider, validateConnectedModelChoice } from "@rakazo/adapters";
import type { Actor, CallSettings, ThinkingLevel } from "@rakazo/contracts";
import { LIVE_CALL_VOICE_PROVIDER } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { voiceContext } from "./voice.js";

export type CallSettingsDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
  voiceProvider?: (kind: string) => VoiceProvider;
};

type CallSettingsRow = {
  secretId: string | null;
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
};

export function toCallSettings(row: CallSettingsRow | null): CallSettings {
  return {
    connected: Boolean(row?.secretId),
    modelProvider: row?.modelProvider ?? null,
    modelId: row?.modelId ?? null,
    thinkingLevel: (row?.thinkingLevel as ThinkingLevel | null) ?? null,
  };
}

export async function loadCallSettings(
  deps: Pick<CallSettingsDeps, "prisma">,
  actor: Actor,
): Promise<CallSettings> {
  return toCallSettings(
    await deps.prisma.userCallSettings.findUnique({ where: { userId: actor.userId } }),
  );
}

/** The OpenAI key calls use, or null when calls are not set up. */
export async function loadCallKey(deps: CallSettingsDeps, actor: Actor): Promise<string | null> {
  const row = await deps.prisma.userCallSettings.findUnique({
    where: { userId: actor.userId },
    select: { secret: { select: { id: true, ciphertext: true } } },
  });
  if (!row?.secret) return null;
  return deps.secrets.load(row.secret.ciphertext, row.secret.id);
}

export async function connectCallKey(
  deps: CallSettingsDeps,
  actor: Actor,
  input: { apiKey: string; signal?: AbortSignal },
): Promise<CallSettings> {
  const apiKey = input.apiKey.trim();
  const provider = (deps.voiceProvider ?? createVoiceProvider)(LIVE_CALL_VOICE_PROVIDER);
  const verified = await provider.verify(apiKey, voiceContext(actor, input.signal));
  if (!verified.ok) {
    throw new ORPCError("BAD_REQUEST", { message: verified.message ?? "That key was rejected." });
  }
  const stored = await deps.secrets.put(apiKey, voiceContext(actor, input.signal));
  const row = await deps.prisma.$transaction(async (tx) => {
    const previous = await tx.userCallSettings.findUnique({
      where: { userId: actor.userId },
      select: { secretId: true },
    });
    const secret = await tx.secret.create({
      data: {
        id: stored.id,
        userId: actor.userId,
        spaceId: null,
        kind: "call",
        ciphertext: stored.ciphertext,
      },
    });
    const next = await tx.userCallSettings.upsert({
      where: { userId: actor.userId },
      create: { userId: actor.userId, secretId: secret.id },
      update: { secretId: secret.id },
    });
    if (previous?.secretId) {
      await tx.secret.deleteMany({ where: { id: previous.secretId, userId: actor.userId } });
    }
    return next;
  });
  return toCallSettings(row);
}

/** Drops the call key; calls stop being offered. The model choice is kept for a reconnect. */
export async function disconnectCallKey(
  deps: Pick<CallSettingsDeps, "prisma">,
  actor: Actor,
): Promise<CallSettings> {
  const row = await deps.prisma.$transaction(async (tx) => {
    const previous = await tx.userCallSettings.findUnique({ where: { userId: actor.userId } });
    if (!previous?.secretId) return previous;
    const next = await tx.userCallSettings.update({
      where: { userId: actor.userId },
      data: { secretId: null },
    });
    await tx.secret.deleteMany({ where: { id: previous.secretId, userId: actor.userId } });
    return next;
  });
  return toCallSettings(row);
}

export async function setCallModel(
  deps: Pick<CallSettingsDeps, "prisma">,
  actor: Actor,
  input: {
    modelProvider: string | null;
    modelId: string | null;
    thinkingLevel: ThinkingLevel | null;
  },
): Promise<CallSettings> {
  if (Boolean(input.modelProvider) !== Boolean(input.modelId)) {
    throw new ORPCError("BAD_REQUEST", { message: "Choose a model." });
  }
  if (input.modelProvider && input.modelId) {
    const message = await validateConnectedModelChoice(
      deps.prisma,
      actor,
      input.modelProvider,
      input.modelId,
    );
    if (message) throw new ORPCError("BAD_REQUEST", { message });
  }
  const model = {
    modelProvider: input.modelProvider,
    modelId: input.modelId,
    thinkingLevel: input.modelProvider ? input.thinkingLevel : null,
  };
  const row = await deps.prisma.userCallSettings.upsert({
    where: { userId: actor.userId },
    create: { userId: actor.userId, ...model },
    update: model,
  });
  return toCallSettings(row);
}

/**
 * The model tasks from a call run on, when the user chose one and it is still connected.
 * Otherwise the bot's own model runs them.
 */
export async function callModelPin(
  deps: Pick<CallSettingsDeps, "prisma">,
  actor: Actor,
): Promise<{ modelProvider: string; modelId: string; thinkingLevel: string | null } | null> {
  const row = await deps.prisma.userCallSettings.findUnique({
    where: { userId: actor.userId },
    select: { modelProvider: true, modelId: true, thinkingLevel: true },
  });
  if (!row?.modelProvider || !row.modelId) return null;
  const invalid = await validateConnectedModelChoice(
    deps.prisma,
    actor,
    row.modelProvider,
    row.modelId,
  );
  if (invalid) return null;
  return {
    modelProvider: row.modelProvider,
    modelId: row.modelId,
    thinkingLevel: row.thinkingLevel,
  };
}
