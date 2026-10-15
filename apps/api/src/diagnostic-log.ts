import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { ORPCError } from "@orpc/server";
import { getLogger } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import { readBoundedBody } from "./http-body.js";

/** One file per day, `16.10.2026.log`, so a report names the day to read. */
const FILE = /^(\d{2})\.(\d{2})\.(\d{4})\.log$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_STRING = 2_000;
const MAX_DEPTH = 6;
const MAX_KEYS = 40;
/** Keys whose values never reach a log: credentials, and payloads too large to be useful. */
const REDACTED = /key|token|secret|password|authorization|cookie|ciphertext|sdp|audio|base64/i;

export type DiagnosticEntry = {
  source: "server" | "web" | "mobile" | "desktop";
  kind: string;
  message: string;
  userId?: string;
  detail?: unknown;
  /** When the client saw it; the server stamps its own time as well. */
  at?: string;
};

function dayName(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${date.getFullYear()}.log`;
}

/** Copies a value for the log, dropping secrets and capping size so one entry stays small. */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length})` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[nested]";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: redactForLog(value.stack, depth + 1),
      ...(value.cause !== undefined ? { cause: redactForLog(value.cause, depth + 1) } : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_KEYS).map((item) => redactForLog(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
    out[key] = REDACTED.test(key) ? "[redacted]" : redactForLog(item, depth + 1);
  }
  return out;
}

/**
 * A day's diagnostics on the server: server failures and the errors apps report, one JSON
 * line each. Today's and yesterday's files are kept; older ones are deleted, so the 22nd's
 * file goes on the 24th.
 */
export class DiagnosticLog {
  private queue: Promise<void> = Promise.resolve();
  private prunedFor = "";

  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  write(entry: DiagnosticEntry): Promise<void> {
    const at = this.now();
    const line = `${JSON.stringify({
      time: at.toISOString(),
      ...entry,
      message: redactForLog(entry.message),
      ...(entry.detail === undefined ? {} : { detail: redactForLog(entry.detail) }),
    })}\n`;
    this.queue = this.queue
      .then(async () => {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
        const today = dayName(at);
        if (this.prunedFor !== today) {
          this.prunedFor = today;
          await this.prune(at);
        }
        await appendFile(path.join(this.dir, today), line, { mode: 0o600 });
      })
      .catch((error) => getLogger().warn("diagnostic log write failed", { error: String(error) }));
    return this.queue;
  }

  private async prune(now: Date): Promise<void> {
    const keep = new Set([dayName(now), dayName(new Date(now.getTime() - DAY_MS))]);
    for (const name of await readdir(this.dir)) {
      if (FILE.test(name) && !keep.has(name)) await rm(path.join(this.dir, name), { force: true });
    }
  }
}

/**
 * Records an RPC the router turned down for its input, or one that broke, with what the client
 * sent: a rejected field is only diagnosable from the value that arrived.
 */
export function recordRpcFailure(
  log: Pick<DiagnosticLog, "write">,
  error: unknown,
  call: { path: readonly string[]; input: unknown },
): void {
  const where = call.path.join("/");
  const status = (error as { status?: unknown } | null)?.status;
  if (error instanceof ORPCError) {
    const issues = (error.data as { issues?: unknown } | undefined)?.issues;
    const rejected = error.code === "BAD_REQUEST" && issues !== undefined;
    if (!rejected && error.status < 500) return;
    void log.write({
      source: "server",
      kind: rejected ? "rpc.rejected" : "rpc.error",
      message: `${where}: ${error.message}`,
      detail: { status, issues, input: call.input },
    });
    return;
  }
  void log.write({
    source: "server",
    kind: "rpc.error",
    message: `${where}: ${error instanceof Error ? error.message : String(error)}`,
    detail: { error, input: call.input },
  });
}

const MAX_CLIENT_REPORT_BYTES = 64 * 1024;
const MAX_CLIENT_ENTRIES = 20;
const CLIENT_SOURCES = new Set(["web", "mobile", "desktop"]);

/** Apps send the errors they hit, so a failure on a phone is on the server the same day. */
export function mountDiagnosticRoutes(
  app: Hono,
  log: Pick<DiagnosticLog, "write">,
  authenticate: (c: Context) => Promise<{ userId: string } | null>,
) {
  app.post("/api/diagnostics", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const raw = await readBoundedBody(c.req.raw, MAX_CLIENT_REPORT_BYTES);
    if (raw === null) return c.json({ error: "Request body is too large." }, 413);
    let body: { source?: unknown; entries?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return c.json({ error: "Invalid report." }, 400);
    }
    const source = typeof body.source === "string" ? body.source : "";
    if (!CLIENT_SOURCES.has(source) || !Array.isArray(body.entries)) {
      return c.json({ error: "Invalid report." }, 400);
    }
    for (const item of body.entries.slice(0, MAX_CLIENT_ENTRIES)) {
      const entry = (item ?? {}) as Record<string, unknown>;
      await log.write({
        source: source as DiagnosticEntry["source"],
        kind: typeof entry.kind === "string" ? entry.kind.slice(0, 80) : "error",
        message: typeof entry.message === "string" ? entry.message : "",
        userId: actor.userId,
        detail: entry.detail,
        at: typeof entry.at === "string" ? entry.at.slice(0, 40) : undefined,
      });
    }
    return c.json({ ok: true });
  });
}
