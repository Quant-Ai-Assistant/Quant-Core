import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Basic Auth credentials for a self-hosted server's gate. They live apart from setup.json,
 * encrypted with the OS keychain through Electron's safeStorage, and answer the gate's
 * challenge for that origin only.
 */
export type ServerAccess = { username: string; password: string };

export const SERVER_ACCESS_FILE = "server-access.bin";
const MAX_FIELD_LENGTH = 512;

export interface AccessCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

let active: { origin: string; access: ServerAccess } | null = null;

/** Validates an untrusted IPC payload; an empty username means the server has no gate. */
export function parseServerAccess(value: unknown): ServerAccess | null {
  if (typeof value !== "object" || value === null) return null;
  const { username, password } = value as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") return null;
  const name = username.trim();
  if (name === "" || name.length > MAX_FIELD_LENGTH || password.length > MAX_FIELD_LENGTH) {
    return null;
  }
  if (name.includes(":")) return null;
  return { username: name, password };
}

export function basicAuthorization(access: ServerAccess): string {
  return `Basic ${Buffer.from(`${access.username}:${access.password}`, "utf8").toString("base64")}`;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function activeServerAccess(): { origin: string; access: ServerAccess } | null {
  return active;
}

export function setActiveServerAccess(origin: string | null, access: ServerAccess | null): void {
  active = origin !== null && access !== null ? { origin, access } : null;
}

/** The credentials for a request to `url`, only when it targets the configured server. */
export function serverAccessFor(url: string): ServerAccess | null {
  if (active === null) return null;
  return originOf(url) === active.origin ? active.access : null;
}

export async function loadServerAccess(dir: string, cipher: AccessCipher): Promise<void> {
  try {
    if (!cipher.isEncryptionAvailable()) return;
    const raw = await readFile(path.join(dir, SERVER_ACCESS_FILE));
    const parsed = JSON.parse(cipher.decryptString(raw)) as { origin?: unknown; access?: unknown };
    const origin = typeof parsed.origin === "string" ? originOf(parsed.origin) : null;
    setActiveServerAccess(origin, parseServerAccess(parsed.access));
  } catch {
    setActiveServerAccess(null, null);
  }
}

/** Persists the credentials for `origin`, or removes them when `access` is null. */
export async function saveServerAccess(
  dir: string,
  cipher: AccessCipher,
  origin: string,
  access: ServerAccess | null,
): Promise<void> {
  const file = path.join(dir, SERVER_ACCESS_FILE);
  if (access === null) {
    await rm(file, { force: true });
  } else {
    if (!cipher.isEncryptionAvailable()) {
      throw new Error("The system keychain is not available to protect the password.");
    }
    await writeFile(file, cipher.encryptString(JSON.stringify({ origin, access })), {
      mode: 0o600,
    });
  }
  setActiveServerAccess(origin, access);
}

/**
 * Chromium asks again after rejected credentials. Answer a few times per origin and minute, then
 * let the challenge fail so a wrong password shows the gate's 401 instead of looping.
 */
export function createLoginLimiter(maxAttempts = 3, windowMs = 60_000, now = () => Date.now()) {
  const attempts = new Map<string, number[]>();
  return (origin: string): boolean => {
    const recent = (attempts.get(origin) ?? []).filter((at) => now() - at < windowMs);
    if (recent.length >= maxAttempts) {
      attempts.set(origin, recent);
      return false;
    }
    recent.push(now());
    attempts.set(origin, recent);
    return true;
  };
}
