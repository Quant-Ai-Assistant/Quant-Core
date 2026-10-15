export type DiagnosticReport = {
  kind: string;
  message: string;
  detail?: unknown;
  at: string;
};

type Transport = (entries: DiagnosticReport[]) => Promise<void>;

const FLUSH_DELAY_MS = 2_000;
const MAX_QUEUED = 50;

let transport: Transport | null = null;
let queue: DiagnosticReport[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** The API module supplies how reports reach the server, which keeps this free of its imports. */
export function setDiagnosticsTransport(next: Transport | null): void {
  transport = next;
}

/**
 * Sends an error to the server's daily log, batched and best-effort: a report that cannot be
 * delivered is dropped rather than retried, so diagnostics never get in the way of the app.
 */
export function reportError(kind: string, message: string, detail?: unknown): void {
  if (queue.length >= MAX_QUEUED) return;
  queue.push({ kind, message, detail, at: new Date().toISOString() });
  timer ??= setTimeout(() => void flushDiagnostics(), FLUSH_DELAY_MS);
}

export async function flushDiagnostics(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const entries = queue;
  queue = [];
  if (!entries.length || !transport) return;
  await transport(entries).catch(() => undefined);
}

/** Uncaught JS errors also go to the server, then on to the default handler. */
export function reportUncaughtErrors(): void {
  const errorUtils = (
    globalThis as {
      ErrorUtils?: {
        getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
        setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
      };
    }
  ).ErrorUtils;
  if (!errorUtils) return;
  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    reportError(
      isFatal ? "crash" : "uncaught",
      error instanceof Error ? error.message : String(error),
      { stack: error instanceof Error ? error.stack : undefined },
    );
    void flushDiagnostics();
    previous(error, isFatal);
  });
}
