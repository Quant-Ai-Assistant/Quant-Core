/**
 * Credentials for a self-hosted server's Basic Auth gate. The app already uses Authorization for
 * its session token, so the gate also accepts the same credential in X-Quant-Auth, and answers
 * with a cookie that covers images and web views, which cannot add headers.
 *
 * This module only holds the active credential; lib/server-access-store.ts persists it.
 */
export type ServerAccess = { username: string; password: string };

export const SERVER_ACCESS_HEADER = "x-quant-auth";

let active: { apiBase: string; access: ServerAccess } | null = null;

export function basicCredential(access: ServerAccess): string {
  const bytes = new TextEncoder().encode(`${access.username}:${access.password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

export function setActiveServerAccess(apiBase: string | null, access: ServerAccess | null): void {
  active = apiBase && access ? { apiBase, access } : null;
}

export function currentServerAccess(apiBase: string): ServerAccess | null {
  return active?.apiBase === apiBase ? active.access : null;
}

/** The gate header for a request to `url`, or null when it is not for the gated server. */
export function serverAccessHeader(url: string): string | null {
  if (!active) return null;
  if (url !== active.apiBase && !url.startsWith(`${active.apiBase}/`)) return null;
  return basicCredential(active.access);
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

let installed = false;

/** Adds the gate header to every fetch the app makes to the gated server. */
export function installServerAccessFetch(): void {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const header = serverAccessHeader(requestUrl(input));
    if (!header) return original(input, init);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (!headers.has(SERVER_ACCESS_HEADER)) headers.set(SERVER_ACCESS_HEADER, header);
    return original(input, { ...init, headers });
  };
}
