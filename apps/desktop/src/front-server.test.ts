import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FrontServer, gateAdmits, startFrontServer } from "./front-server.js";
import { allocateLoopbackPort } from "./local-server.js";

const BASIC = Buffer.from("quant:hunter2-pw").toString("base64");
const TOKEN = "ab".repeat(32);

let webRoot: string;
let api: http.Server;
let seen: http.IncomingHttpHeaders[];
let front: FrontServer | undefined;
let gatePort: number;

beforeEach(async () => {
  webRoot = await mkdtemp(path.join(tmpdir(), "front-web-"));
  await mkdir(path.join(webRoot, "assets"));
  await writeFile(path.join(webRoot, "index.html"), "<main>Quant web</main>");
  await writeFile(path.join(webRoot, "assets", "app-1.js"), "console.log(1)");
  seen = [];
  api = http.createServer((request, response) => {
    seen.push(request.headers);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ path: request.url, method: request.method }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  gatePort = await allocateLoopbackPort();
  front = await startFrontServer({
    webRoot,
    apiUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
    loopbackPort: await allocateLoopbackPort(),
    gate: { port: gatePort, basic: BASIC, token: TOKEN },
  });
});

afterEach(async () => {
  await front?.close();
  front = undefined;
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await rm(webRoot, { recursive: true, force: true });
});

function loopback(pathname: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${front?.loopbackPort}${pathname}`, init);
}

function gate(pathname: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${gatePort}${pathname}`, init);
}

describe("front server", () => {
  it("serves the web app with the SPA fallback and long-lived assets", async () => {
    const page = await loopback("/chat/42", { headers: { accept: "text/html" } });
    expect(await page.text()).toBe("<main>Quant web</main>");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const asset = await loopback("/assets/app-1.js");
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await loopback("/missing.js")).status).toBe(404);
  });

  it("passes the API routes through with the API as host", async () => {
    const response = await loopback("/rpc/health?x=1", { method: "POST", body: "{}" });
    expect(await response.json()).toEqual({ path: "/rpc/health?x=1", method: "POST" });
    expect(seen[0]?.host).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(seen[0]?.["x-forwarded-proto"]).toBe("http");
  });

  it("keeps the gate closed without credentials", async () => {
    const response = await gate("/");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
    expect((await gate("/rpc/health", { method: "POST" })).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("lets a device in by Basic Auth, the apps' header or the cookie, and hides them from the API", async () => {
    const basic = await gate("/rpc/me", { headers: { authorization: `Basic ${BASIC}` } });
    expect(basic.status).toBe(200);
    expect(basic.headers.get("set-cookie")).toContain(`quant_gate=${TOKEN}`);
    const app = await gate("/rpc/me", {
      headers: { "x-quant-auth": `Basic ${BASIC}`, authorization: "Bearer session" },
    });
    expect(app.status).toBe(200);
    const cookie = await gate("/", { headers: { cookie: `a=1; quant_gate=${TOKEN}` } });
    expect(await cookie.text()).toBe("<main>Quant web</main>");
    expect(seen[0]?.authorization).toBeUndefined();
    expect(seen[1]?.["x-quant-auth"]).toBeUndefined();
    // The app's own session token is not the gate's to remove.
    expect(seen[1]?.authorization).toBe("Bearer session");
  });

  it("refuses wrong credentials and a wrong cookie", async () => {
    const wrong = Buffer.from("quant:nope").toString("base64");
    expect((await gate("/", { headers: { authorization: `Basic ${wrong}` } })).status).toBe(401);
    expect((await gate("/", { headers: { cookie: "quant_gate=nope" } })).status).toBe(401);
  });
});

describe("gateAdmits", () => {
  it("does not open for an empty remembered-device token", () => {
    const open = { port: 1, basic: BASIC, token: "" };
    expect(gateAdmits(open, { cookie: "quant_gate=" })).toBe(false);
    expect(gateAdmits(open, { authorization: `basic ${BASIC}` })).toBe(true);
  });
});
