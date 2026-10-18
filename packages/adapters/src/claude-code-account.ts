import type { SecretStore } from "@rakazo/adapter-kit";
import type { ClaudeCodeAccount } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { StoredModelSecret } from "./pi-oauth.js";
import {
  ANTHROPIC_OAUTH_PROVIDER,
  parseModelSecret,
  persistStoredModelSecret,
  resolveModelAuth,
  secretValuesToRedact,
  serializeModelSecret,
  withModelCredentialLock,
} from "./pi-oauth.js";

type Scope = { userId: string; spaceId: string };

export function toClaudeCodeAccount(row: { kind: string } | null): ClaudeCodeAccount {
  return {
    connected: Boolean(row),
    kind: row?.kind === "api_key" ? "api_key" : row ? "subscription" : null,
  };
}

export async function loadClaudeCodeAccount(
  prisma: Pick<PrismaClient, "userClaudeCode">,
  userId: string,
): Promise<ClaudeCodeAccount> {
  return toClaudeCodeAccount(
    await prisma.userClaudeCode.findUnique({ where: { userId }, select: { kind: true } }),
  );
}

/** Replace the user's Claude Code sign-in with a subscription credential or an API key. */
export async function saveClaudeCodeSecret(
  deps: { prisma: PrismaClient; secretStore: Pick<SecretStore, "put"> },
  scope: Scope,
  secret: Extract<StoredModelSecret, { kind: "oauth" | "api_key" }>,
  signal?: AbortSignal,
): Promise<ClaudeCodeAccount> {
  const stored = await deps.secretStore.put(serializeModelSecret(secret), {
    operationId: "claude-code",
    traceId: "claude-code",
    spaceId: scope.spaceId,
    userId: scope.userId,
    signal: signal ?? new AbortController().signal,
  });
  const kind = secret.kind === "oauth" ? "subscription" : "api_key";
  const row = await deps.prisma.$transaction(async (tx) => {
    const previous = await tx.userClaudeCode.findUnique({
      where: { userId: scope.userId },
      select: { secretId: true },
    });
    const created = await tx.secret.create({
      data: {
        id: stored.id,
        userId: scope.userId,
        spaceId: null,
        kind: "claude_code",
        ciphertext: stored.ciphertext,
      },
    });
    const next = await tx.userClaudeCode.upsert({
      where: { userId: scope.userId },
      create: { userId: scope.userId, secretId: created.id, kind },
      update: { secretId: created.id, kind },
    });
    if (previous) {
      await tx.secret.deleteMany({ where: { id: previous.secretId, userId: scope.userId } });
    }
    return next;
  });
  return toClaudeCodeAccount(row);
}

export async function disconnectClaudeCode(
  prisma: PrismaClient,
  userId: string,
): Promise<ClaudeCodeAccount> {
  await prisma.$transaction(async (tx) => {
    const previous = await tx.userClaudeCode.findUnique({ where: { userId } });
    if (!previous) return;
    // The account row cascades with its secret.
    await tx.secret.deleteMany({ where: { id: previous.secretId, userId } });
  });
  return toClaudeCodeAccount(null);
}

/**
 * The environment that signs the Claude Code CLI in for one run: a fresh subscription token, or
 * the API key. Empty when the user has not signed in, so the CLI falls back to whatever sign-in
 * that computer already has. Every value is registered for redaction before it is returned.
 */
export async function claudeCodeEnvironment(
  deps: { prisma: PrismaClient; secretStore: Pick<SecretStore, "load" | "put"> },
  scope: Scope,
  registerSecrets: (values: string[]) => void,
): Promise<Record<string, string>> {
  const row = await deps.prisma.userClaudeCode.findUnique({
    where: { userId: scope.userId },
    select: { secret: { select: { id: true, ciphertext: true } } },
  });
  if (!row) return {};
  const secretId = row.secret.id;
  return withModelCredentialLock(secretId, async (): Promise<Record<string, string>> => {
    const current = await deps.prisma.secret.findFirst({
      where: { id: secretId, userId: scope.userId },
      select: { ciphertext: true },
    });
    if (!current) return {};
    const plaintext = await deps.secretStore.load(current.ciphertext, secretId);
    registerSecrets(secretValuesToRedact(parseModelSecret(plaintext)));
    const resolved = await resolveModelAuth(plaintext, ANTHROPIC_OAUTH_PROVIDER, {
      persist: persistStoredModelSecret(deps.prisma, deps.secretStore, scope, secretId),
    });
    registerSecrets([resolved.apiKey]);
    return resolved.secret.kind === "oauth"
      ? { CLAUDE_CODE_OAUTH_TOKEN: resolved.apiKey }
      : { ANTHROPIC_API_KEY: resolved.apiKey };
  });
}
