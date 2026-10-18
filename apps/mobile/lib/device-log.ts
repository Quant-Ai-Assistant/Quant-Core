export type LogLevel = "debug" | "info" | "warn" | "error";

/** Where the day's log lives; the app supplies the file system so this stays testable. */
export type LogDisk = {
  /** Names of the files in the log folder. */
  list(): string[];
  append(name: string, text: string): void;
  size(name: string): number;
  remove(name: string): void;
};

const PREFIX = "quant-";
const SUFFIX = ".log";
const FLUSH_DELAY_MS = 1_000;
/** A day's log stops taking routine lines past this, so a loop cannot fill the phone. */
export const DAY_LOG_MAX_BYTES = 20 * 1024 * 1024;
const MAX_STRING = 8_000;
const MAX_DEPTH = 6;
const SECRET_KEY = /authorization|cookie|token|secret|password|passcode|api[-_]?key|x-quant-auth/i;

let disk: LogDisk | null = null;
let buffer: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let currentFile: string | null = null;
let capped = false;
let now: () => Date = () => new Date();

/** The log file for a local calendar day, e.g. `quant-2026-10-18.log`. */
export function logFileName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${PREFIX}${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}${SUFFIX}`;
}

/** Plain data for a log line: errors keep their code, stack and cause; secrets are masked. */
export function serializeDetail(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string")
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)`
      : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[too deep]";
  seen.add(value);
  if (value instanceof Error) {
    const extra = value as Error & { code?: unknown; status?: unknown; cause?: unknown };
    const out: Record<string, unknown> = { name: value.name, message: value.message };
    if (extra.code !== undefined) out.code = serializeDetail(extra.code, depth + 1, seen);
    if (extra.status !== undefined) out.status = serializeDetail(extra.status, depth + 1, seen);
    if (value.stack) out.stack = serializeDetail(value.stack, depth + 1, seen);
    if (extra.cause !== undefined) out.cause = serializeDetail(extra.cause, depth + 1, seen);
    return out;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => serializeDetail(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : serializeDetail(item, depth + 1, seen);
  }
  return out;
}

export function formatLogLine(
  at: Date,
  level: LogLevel,
  scope: string,
  message: string,
  detail?: unknown,
): string {
  let line = `${at.toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (detail !== undefined) {
    try {
      line += ` ${JSON.stringify(serializeDetail(detail))}`;
    } catch {
      line += " [unserializable detail]";
    }
  }
  return `${line.replace(/\r?\n/g, "\n    ")}\n`;
}

/** Starts writing to `disk`. Lines logged before this are kept and written on the first flush. */
export function startDeviceLog(next: LogDisk, clock: () => Date = () => new Date()): void {
  disk = next;
  now = clock;
  currentFile = null;
  capped = false;
  flushDeviceLog();
}

/** Writes one line to today's log. Warnings and errors reach the disk at once. */
export function deviceLog(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  buffer.push(formatLogLine(now(), level, scope, message, detail));
  if (buffer.length > 2_000) buffer.splice(0, buffer.length - 2_000);
  if (level === "warn" || level === "error") flushDeviceLog();
  else timer ??= setTimeout(flushDeviceLog, FLUSH_DELAY_MS);
}

/** Moves buffered lines to today's file, deleting the files of earlier days first. */
export function flushDeviceLog(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!disk || !buffer.length) return;
  const lines = buffer;
  buffer = [];
  try {
    const name = logFileName(now());
    if (name !== currentFile) {
      for (const file of disk.list()) {
        if (file !== name && file.startsWith(PREFIX) && file.endsWith(SUFFIX)) disk.remove(file);
      }
      currentFile = name;
      capped = false;
    }
    if (capped || disk.size(name) >= DAY_LOG_MAX_BYTES) {
      const urgent = lines.filter((line) => / (WARN |ERROR) \[/.test(line));
      if (!capped)
        urgent.unshift(
          formatLogLine(
            now(),
            "warn",
            "log",
            "Daily log limit reached; only warnings and errors from now on",
          ),
        );
      capped = true;
      if (urgent.length) disk.append(name, urgent.join(""));
      return;
    }
    disk.append(name, lines.join(""));
  } catch {
    /* Logging must never break the app. */
  }
}

/** The name of today's log file, after everything buffered has been written. */
export function todaysLogFile(): string {
  flushDeviceLog();
  return logFileName(now());
}

/** Test hook: forget the disk and anything buffered. */
export function resetDeviceLogForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  disk = null;
  buffer = [];
  currentFile = null;
  capped = false;
  now = () => new Date();
}
