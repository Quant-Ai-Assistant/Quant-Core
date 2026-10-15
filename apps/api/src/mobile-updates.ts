import { randomBytes } from "node:crypto";
import type { MobileEdgeFile, MobileEdgeManifest } from "@rakazo/contracts";
import { EDGE_DOWNLOAD_URL } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import type { Context, Hono } from "hono";

/** How long the server trusts the edge manifest it read before reading it again. */
const MANIFEST_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const FILE_NAME = /^[a-f0-9]{32}\.[a-z0-9]{1,8}$/;

/** The base the app reached this server at, which its update files must be fetched from. */
export const APP_BASE_HEADER = "x-quant-base";

export type MobileUpdateDeps = {
  fetch?: typeof fetch;
  now?: () => number;
};

/**
 * Serves Android over-the-air updates built from main by the Expo Updates protocol. The app
 * asks its own server, which reads the edge pre-release and relays its files, so the app's
 * gate credentials never leave for another host.
 */
export function mountMobileUpdateRoutes(app: Hono, deps: MobileUpdateDeps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let cached: { at: number; manifest: MobileEdgeManifest | null } | null = null;

  async function edgeManifest(): Promise<MobileEdgeManifest | null> {
    if (cached && now() - cached.at < MANIFEST_TTL_MS) return cached.manifest;
    let manifest: MobileEdgeManifest | null = null;
    try {
      const res = await doFetch(`${EDGE_DOWNLOAD_URL}/mobile-edge.json`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) manifest = (await res.json()) as MobileEdgeManifest;
    } catch (error) {
      getLogger().warn("mobile edge manifest unavailable", { error: String(error) });
    }
    cached = { at: now(), manifest };
    return manifest;
  }

  app.get("/api/mobile-updates/manifest", async (c) => {
    const platform = c.req.header("expo-platform");
    const runtimeVersion = c.req.header("expo-runtime-version");
    const base = appBase(c);
    const manifest = await edgeManifest();
    if (
      platform !== "android" ||
      !base ||
      !manifest ||
      manifest.runtimeVersion !== runtimeVersion ||
      c.req.header("expo-current-update-id") === manifest.id
    ) {
      return expoResponse("directive", { type: "noUpdateAvailable" });
    }
    const file = (entry: MobileEdgeFile) => ({
      hash: entry.hash,
      key: entry.key,
      contentType: entry.contentType,
      fileExtension: entry.fileExtension,
      url: `${base}/api/mobile-updates/files/${entry.name}`,
    });
    return expoResponse("manifest", {
      id: manifest.id,
      createdAt: manifest.createdAt,
      runtimeVersion: manifest.runtimeVersion,
      launchAsset: file(manifest.launchAsset),
      assets: manifest.assets.map(file),
      metadata: { sha: manifest.sha },
      extra: {},
    });
  });

  app.get("/api/mobile-updates/files/:name", async (c) => {
    const name = c.req.param("name");
    if (!FILE_NAME.test(name)) return c.json({ error: "Not found" }, 404);
    const res = await doFetch(`${EDGE_DOWNLOAD_URL}/${name}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 3),
    }).catch(() => null);
    if (!res?.ok || !res.body) return c.json({ error: "Not found" }, 404);
    // Named by content, so a file never changes under its name.
    return new Response(res.body, {
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });
}

/** The app sends the base it reached this server at; only an http(s) origin and path qualify. */
function appBase(c: Context): string | null {
  const raw = c.req.header(APP_BASE_HEADER)?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.search || url.hash || url.username || url.password) return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** One Expo Updates protocol 1 response: a multipart body with a manifest or a directive. */
export function expoResponse(part: "manifest" | "directive", body: unknown): Response {
  const boundary = `quant-${randomBytes(12).toString("hex")}`;
  const text = [
    `--${boundary}`,
    `content-disposition: form-data; name="${part}"`,
    "content-type: application/json; charset=utf-8",
    "",
    JSON.stringify(body),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return new Response(text, {
    headers: {
      "content-type": `multipart/mixed; boundary=${boundary}`,
      "expo-protocol-version": "1",
      "expo-sfv-version": "0",
      "cache-control": "private, max-age=0",
    },
  });
}
