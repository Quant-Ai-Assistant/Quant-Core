import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountMobileUpdateRoutes } from "./mobile-updates.js";

const edge = {
  id: "11111111-2222-4333-8444-555555555555",
  createdAt: "2026-10-16T10:00:00.000Z",
  sha: "abc",
  runtimeVersion: "fp1",
  launchAsset: {
    key: "a".repeat(32),
    name: `${"a".repeat(32)}.bundle`,
    hash: "h1",
    contentType: "application/javascript",
    fileExtension: ".bundle",
  },
  assets: [
    {
      key: "b".repeat(32),
      name: `${"b".repeat(32)}.png`,
      hash: "h2",
      contentType: "image/png",
      fileExtension: ".png",
    },
  ],
};

function server() {
  const fetch = vi.fn(async (url: string) =>
    url.endsWith("mobile-edge.json")
      ? Response.json(edge)
      : new Response("bytes", { headers: { "content-type": "image/png" } }),
  );
  const app = new Hono();
  mountMobileUpdateRoutes(app, { fetch: fetch as unknown as typeof globalThis.fetch });
  return { app, fetch };
}

const asks = (headers: Record<string, string>) =>
  new Request("http://server/api/mobile-updates/manifest", {
    headers: {
      "expo-platform": "android",
      "expo-runtime-version": "fp1",
      "x-quant-base": "https://quant.example.test:8443/",
      ...headers,
    },
  });

describe("Android updates from main", () => {
  it("serves a manifest whose files come from the app's own server", async () => {
    const { app } = server();
    const res = await app.fetch(asks({}));
    expect(res.headers.get("expo-protocol-version")).toBe("1");
    expect(res.headers.get("content-type")).toMatch(/^multipart\/mixed; boundary=/);
    const body = await res.text();
    expect(body).toContain('name="manifest"');
    const manifest = JSON.parse(body.split("\r\n\r\n")[1]?.split("\r\n")[0] ?? "{}");
    expect(manifest).toMatchObject({
      id: edge.id,
      runtimeVersion: "fp1",
      launchAsset: {
        hash: "h1",
        url: `https://quant.example.test:8443/api/mobile-updates/files/${"a".repeat(32)}.bundle`,
      },
    });
    expect(manifest.assets).toHaveLength(1);
  });

  it("has nothing for another native build, another platform, or the update already running", async () => {
    const { app } = server();
    for (const headers of [
      { "expo-runtime-version": "fp0" },
      { "expo-platform": "ios" },
      { "expo-current-update-id": edge.id },
      { "x-quant-base": "javascript:alert(1)" },
    ]) {
      const body = await (await app.fetch(asks(headers))).text();
      expect(body).toContain('name="directive"');
      expect(body).toContain("noUpdateAvailable");
    }
  });

  it("relays only content-named files", async () => {
    const { app, fetch } = server();
    const ok = await app.fetch(
      new Request(`http://server/api/mobile-updates/files/${"b".repeat(32)}.png`),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toContain("immutable");
    const bad = await app.fetch(new Request("http://server/api/mobile-updates/files/..%2Fsecret"));
    expect(bad.status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
