import { readBoundedJsonResponse } from "@rakazo/core";
import { t } from "./i18n";
import type { ServerAccess } from "./server-access";
import { basicCredential, SERVER_ACCESS_HEADER } from "./server-access";

const LOCAL_API = "http://127.0.0.1:3100";
const DEFAULT_API = process.env.EXPO_PUBLIC_API_URL ?? LOCAL_API;
export const API_PROBE_TIMEOUT_MS = 8_000;
export const MAX_API_PROBE_RESPONSE_BYTES = 64 * 1024;

export type EndpointResult = { ok: true; url: string } | { ok: false; error: string };
type HealthResponse = { json?: { ok?: boolean }; error?: { message?: string } };

/** True when this build ships with a server address; otherwise the user must enter one. */
export function hasBuiltInApiBase() {
  return Boolean(process.env.EXPO_PUBLIC_API_URL);
}

export function defaultApiBase() {
  return originOnly(DEFAULT_API) ?? LOCAL_API;
}

export function normalizeApiBase(input: string): EndpointResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: t("Enter a server URL") };
  const withScheme = hasScheme(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: t("That doesn’t look like a URL") };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: t("Use an http or https URL") };
  }
  if (!parsed.hostname) return { ok: false, error: t("That URL is missing a host") };
  const url = `${parsed.protocol}//${parsed.host}`;
  return { ok: true, url };
}

export function displayApiHost(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
  }
}

export function usesCustomApiBase(url: string, fallback = defaultApiBase()) {
  return url !== fallback;
}

export function apiBaseWarning(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" && !isLanOrLocalHost(parsed.hostname)) {
      return t("Public servers need https://. HTTP only works on your local network.");
    }
  } catch {
    return null;
  }
  return null;
}

export async function probeApiBase(
  input: string,
  fetchImpl: typeof fetch = fetch,
  access: ServerAccess | null = null,
): Promise<EndpointResult> {
  const first = await probeOrigin(input, fetchImpl, access);
  // A bare address gets https:// first; self-hosted servers without a domain only answer http.
  const result =
    !first.ok && "unreachable" in first && !hasScheme(input.trim())
      ? await probeOrigin(`http://${input.trim()}`, fetchImpl, access)
      : first;
  return result.ok ? { ok: true, url: result.url } : { ok: false, error: result.error };
}

function hasScheme(value: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

async function probeOrigin(
  input: string,
  fetchImpl: typeof fetch,
  access: ServerAccess | null,
): Promise<EndpointResult | { ok: false; error: string; unreachable: true }> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok) return parsed;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_PROBE_TIMEOUT_MS);
  try {
    const res = await withAbort(
      fetchImpl(`${parsed.url}/rpc/health`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "rakazo://",
          ...(access ? { [SERVER_ACCESS_HEADER]: basicCredential(access) } : {}),
        },
        body: JSON.stringify({ json: {} }),
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (res.status === 401) {
      cancelResponseBody(res);
      return {
        ok: false,
        error: access
          ? t("The server did not accept that username and password")
          : t("This server asks for a username and password"),
      };
    }
    if (!res.ok) {
      cancelResponseBody(res);
      return { ok: false, error: t("That URL did not look like a Quant server") };
    }
    let body: HealthResponse;
    try {
      body = await readBoundedJsonResponse<HealthResponse>(
        res,
        MAX_API_PROBE_RESPONSE_BYTES,
        controller.signal,
      );
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      body = {};
    }
    if (body.error || body.json?.ok !== true) {
      return { ok: false, error: t("That URL did not look like a Quant server") };
    }
    return parsed;
  } catch {
    return { ok: false, error: t("Could not reach that server"), unreachable: true };
  } finally {
    clearTimeout(timer);
  }
}

function cancelResponseBody(response: Response): void {
  try {
    void Promise.resolve(response.body?.cancel()).catch(() => undefined);
  } catch {
    // Probe cleanup is best-effort and must not delay the fallback result.
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request timed out"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Request timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function originOnly(value: string) {
  const parsed = normalizeApiBase(value);
  return parsed.ok ? parsed.url : null;
}

function isLanOrLocalHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host.endsWith(".local")) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])(?:\.\d{1,3}){2}$/.test(host)) return true;
  return false;
}
