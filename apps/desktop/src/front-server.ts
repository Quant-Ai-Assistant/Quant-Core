import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  bundledRendererCandidates,
  contentType,
  immutableRendererAsset,
  isRendererAssetMiss,
} from "./renderer-assets.js";

/**
 * The web front of the server the app runs for "This computer": it serves the bundled web app,
 * and passes `/api` and `/rpc` to the API process. It listens twice. The loopback listener is
 * the one this app opens. The gate listener is the only way in from the network and, like
 * `infra/compose/Caddyfile.gate`, asks for the gate's Basic Auth before anything else.
 */
export interface FrontGate {
  port: number;
  /** base64 of `username:password`, exactly what a Basic Auth header carries. */
  basic: string;
  /** Value of the `quant_gate` cookie that lets a device back in without the header. */
  token: string;
}

export interface FrontServerOptions {
  webRoot: string;
  apiUrl: string;
  loopbackPort: number;
  gate: FrontGate | null;
}

export interface FrontServer {
  loopbackPort: number;
  close(): Promise<void>;
}

const GATE_COOKIE = "quant_gate";
const APP_AUTH_HEADER = "x-quant-auth";
const PROXIED = ["/api", "/rpc"];
/** Hop-by-hop headers never cross a proxy. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function sameSecret(expected: string, supplied: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string) {
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/** Whether a request may pass the gate: its cookie, the apps' own header, or Basic Auth. */
export function gateAdmits(gate: FrontGate, headers: IncomingMessage["headers"]): boolean {
  const cookie = cookieValue(headers.cookie, GATE_COOKIE);
  if (gate.token !== "" && cookie !== undefined && sameSecret(gate.token, cookie)) return true;
  for (const value of [headers[APP_AUTH_HEADER], headers.authorization]) {
    const match = typeof value === "string" ? /^Basic\s+(\S+)$/i.exec(value) : null;
    if (match?.[1] !== undefined && sameSecret(gate.basic, match[1])) return true;
  }
  return false;
}

function matchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The headers sent on to the API: the gate's credentials never reach the application. */
export function upstreamHeaders(
  request: IncomingMessage,
  target: URL,
  gated: boolean,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || name.startsWith("x-forwarded-")) continue;
    if (gated && name === APP_AUTH_HEADER) continue;
    if (gated && name === "authorization" && /^Basic\s/i.test(String(value))) continue;
    headers[name] = value;
  }
  headers.host = target.host;
  headers["x-forwarded-for"] = request.socket.remoteAddress ?? "";
  headers["x-forwarded-proto"] = "http";
  if (request.headers.host) headers["x-forwarded-host"] = request.headers.host;
  return headers;
}

function proxy(request: IncomingMessage, response: ServerResponse, apiUrl: URL, gated: boolean) {
  const upstream = http.request(
    {
      protocol: apiUrl.protocol,
      hostname: apiUrl.hostname,
      port: apiUrl.port,
      method: request.method,
      path: request.url,
      headers: upstreamHeaders(request, apiUrl, gated),
    },
    (incoming) => {
      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
      }
      response.writeHead(incoming.statusCode ?? 502, headers);
      incoming.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (response.headersSent) response.destroy();
    else response.writeHead(502, { "content-type": "text/plain" }).end("Quant is starting.");
  });
  // A stream the browser closed (an SSE subscription) must not keep the API request open.
  response.once("close", () => upstream.destroy());
  request.pipe(upstream);
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  webRoot: string,
  origin: string,
) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;
  const candidates = bundledRendererCandidates(
    webRoot,
    new URL(request.url ?? "/", origin).href,
    origin,
    acceptsHtml,
  );
  for (const file of candidates ?? []) {
    try {
      if (!(await stat(file)).isFile()) continue;
      const body = request.method === "HEAD" ? null : await readFile(file);
      response.writeHead(200, {
        "cache-control": immutableRendererAsset(file)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "content-type": contentType(file),
        "x-content-type-options": "nosniff",
      });
      response.end(body);
      return;
    } catch (error) {
      if (!isRendererAssetMiss(error)) throw error;
    }
  }
  response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
}

function handler(options: FrontServerOptions, gate: FrontGate | null) {
  const apiUrl = new URL(options.apiUrl);
  return (request: IncomingMessage, response: ServerResponse) => {
    if (gate !== null) {
      if (!gateAdmits(gate, request.headers)) {
        response
          .writeHead(401, {
            "content-type": "text/plain",
            "www-authenticate": 'Basic realm="Quant", charset="UTF-8"',
          })
          .end("Unauthorized");
        return;
      }
      // Remember this device, as the Compose gate does.
      if (gate.token !== "") {
        response.setHeader(
          "set-cookie",
          `${GATE_COOKIE}=${gate.token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`,
        );
      }
    }
    const pathname = (request.url ?? "/").split("?", 1)[0] ?? "/";
    if (PROXIED.some((prefix) => matchesPrefix(pathname, prefix))) {
      proxy(request, response, apiUrl, gate !== null);
      return;
    }
    // Past the gate the request is authenticated, so the name it used does not matter.
    const origin = `http://127.0.0.1:${options.loopbackPort}`;
    serveStatic(request, response, options.webRoot, origin).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
      else response.destroy();
    });
  };
}

function listen(server: http.Server, port: number, host: string) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: http.Server) {
  return new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    // Open streams would otherwise hold the close forever.
    server.closeAllConnections();
  });
}

export async function startFrontServer(options: FrontServerOptions): Promise<FrontServer> {
  const loopback = http.createServer(handler(options, null));
  const gate = options.gate === null ? null : http.createServer(handler(options, options.gate));
  try {
    const loopbackPort = await listen(loopback, options.loopbackPort, "127.0.0.1");
    if (gate !== null && options.gate !== null) await listen(gate, options.gate.port, "0.0.0.0");
    return {
      loopbackPort,
      close: async () => {
        await Promise.all([closeServer(loopback), gate === null ? undefined : closeServer(gate)]);
      },
    };
  } catch (error) {
    await Promise.all([closeServer(loopback), gate === null ? undefined : closeServer(gate)]);
    throw error;
  }
}
