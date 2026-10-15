import type * as Adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";

const validateConnectedModelChoice = vi.hoisted(() =>
  vi.fn(async () => undefined as string | undefined),
);
vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  validateConnectedModelChoice,
}));

import { callModelPin, connectCallKey, setCallModel, toCallSettings } from "./call-settings.js";

const actor = { userId: "user-1", spaceId: "space-1" } as Actor;

function prismaWith(row: Record<string, unknown> | null) {
  const tx = {
    userCallSettings: {
      findUnique: vi.fn(async () => row),
      upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => ({
        ...row,
        ...update,
      })),
    },
    secret: {
      create: vi.fn(async ({ data }: { data: { id: string } }) => ({ id: data.id })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  return {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
}

describe("call settings", () => {
  it("reports a key without revealing it", () => {
    expect(
      toCallSettings({ secretId: "s", modelProvider: null, modelId: null, thinkingLevel: null }),
    ).toEqual({ connected: true, modelProvider: null, modelId: null, thinkingLevel: null });
    expect(toCallSettings(null).connected).toBe(false);
  });

  it("verifies a new key, then replaces the old secret with it", async () => {
    const prisma = prismaWith({ userId: "user-1", secretId: "old-secret" });
    const verify = vi.fn(async () => ({ ok: true as const }));
    const settings = await connectCallKey(
      {
        prisma: prisma as unknown as PrismaClient,
        secrets: {
          put: vi.fn(async () => ({ id: "new-secret", ciphertext: "x" })),
          load: vi.fn(),
        } as never,
        voiceProvider: () => ({ verify }) as never,
      },
      actor,
      { apiKey: " sk-test-key " },
    );
    expect(verify).toHaveBeenCalledWith("sk-test-key", expect.anything());
    expect(prisma.userCallSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { secretId: "new-secret" } }),
    );
    expect(prisma.secret.deleteMany).toHaveBeenCalledWith({
      where: { id: "old-secret", userId: "user-1" },
    });
    expect(settings.connected).toBe(true);
  });

  it("rejects a key the provider refuses", async () => {
    const prisma = prismaWith(null);
    await expect(
      connectCallKey(
        {
          prisma: prisma as unknown as PrismaClient,
          secrets: { put: vi.fn(), load: vi.fn() } as never,
          voiceProvider: () =>
            ({
              verify: async () => ({ ok: false, message: "OpenAI rejected that key." }),
            }) as never,
        },
        actor,
        { apiKey: "sk-bad-key" },
      ),
    ).rejects.toThrow("OpenAI rejected that key.");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("saves only a connected model, and drops the effort with the model", async () => {
    const prisma = prismaWith({ userId: "user-1", secretId: "s" });
    validateConnectedModelChoice.mockResolvedValueOnce("Connect that model provider first");
    await expect(
      setCallModel({ prisma: prisma as unknown as PrismaClient }, actor, {
        modelProvider: "openai",
        modelId: "gpt-6-luna",
        thinkingLevel: "low",
      }),
    ).rejects.toThrow("Connect that model provider first");
    const cleared = await setCallModel({ prisma: prisma as unknown as PrismaClient }, actor, {
      modelProvider: null,
      modelId: null,
      thinkingLevel: "high",
    });
    expect(cleared).toMatchObject({ modelProvider: null, modelId: null, thinkingLevel: null });
  });

  it("runs call tasks on the chosen model only while it stays connected", async () => {
    const row = {
      userId: "user-1",
      secretId: "s",
      modelProvider: "openai",
      modelId: "gpt-6-luna",
      thinkingLevel: "low",
    };
    const deps = { prisma: prismaWith(row) as unknown as PrismaClient };
    await expect(callModelPin(deps, actor)).resolves.toEqual({
      modelProvider: "openai",
      modelId: "gpt-6-luna",
      thinkingLevel: "low",
    });
    validateConnectedModelChoice.mockResolvedValueOnce("Connect that model provider first");
    await expect(callModelPin(deps, actor)).resolves.toBeNull();
    const unset = {
      prisma: prismaWith({ ...row, modelProvider: null }) as unknown as PrismaClient,
    };
    await expect(callModelPin(unset, actor)).resolves.toBeNull();
  });
});
