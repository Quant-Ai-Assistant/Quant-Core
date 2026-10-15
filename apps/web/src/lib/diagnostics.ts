import { desktopBridge } from "./desktop";

type DiagnosticReport = { kind: string; message: string; detail?: unknown; at: string };

const FLUSH_DELAY_MS = 2_000;
const MAX_QUEUED = 50;

let queue: DiagnosticReport[] = [];
let timer: number | undefined;

/**
 * Sends an error to the server's daily log, batched and best-effort: a report that cannot be
 * delivered is dropped rather than retried, so diagnostics never get in the way of the app.
 */
export function reportError(kind: string, message: string, detail?: unknown): void {
  if (typeof window === "undefined" || queue.length >= MAX_QUEUED) return;
  queue.push({ kind, message, detail, at: new Date().toISOString() });
  timer ??= window.setTimeout(flushDiagnostics, FLUSH_DELAY_MS);
}

function flushDiagnostics(): void {
  window.clearTimeout(timer);
  timer = undefined;
  const entries = queue;
  queue = [];
  if (!entries.length) return;
  void fetch("/api/diagnostics", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: desktopBridge() ? "desktop" : "web", entries }),
    keepalive: true,
  }).catch(() => undefined);
}

/** Uncaught errors and unhandled rejections also go to the server. */
export function reportUncaughtErrors(): void {
  window.addEventListener("error", (event) => {
    reportError("uncaught", event.message, {
      source: event.filename,
      line: event.lineno,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    reportError("unhandled", reason instanceof Error ? reason.message : String(reason), {
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
