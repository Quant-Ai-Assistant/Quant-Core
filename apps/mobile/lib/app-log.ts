import * as Application from "expo-application";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as Updates from "expo-updates";
import { AppState, Platform } from "react-native";
import type { LogDisk, LogLevel } from "./device-log";
import { deviceLog, flushDeviceLog, startDeviceLog, todaysLogFile } from "./device-log";

const UPDATES_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ERROR_BODY_MAX = 2_000;

function folder() {
  return new Directory(Paths.document, "logs");
}

const expoDisk: LogDisk = {
  list: () =>
    folder().exists
      ? folder()
          .list()
          .map((entry) => entry.name)
      : [],
  append(name, text) {
    folder().create({ intermediates: true, idempotent: true });
    const file = new File(folder(), name);
    if (!file.exists) file.create();
    file.write(text, { append: true });
  },
  size(name) {
    const file = new File(folder(), name);
    return file.exists ? file.size : 0;
  },
  remove(name) {
    const file = new File(folder(), name);
    if (file.exists) file.delete();
  },
};

/** What the phone and the running build are, so a log says where it came from. */
export function appSnapshot(): Record<string, unknown> {
  return {
    app: Application.nativeApplicationVersion,
    build: Application.nativeBuildVersion,
    platform: Platform.OS,
    osVersion: Platform.Version,
    device: Platform.constants,
    updates: {
      enabled: Updates.isEnabled,
      runtimeVersion: Updates.runtimeVersion,
      updateId: Updates.updateId,
      channel: Updates.channel,
      createdAt: Updates.createdAt,
      embeddedLaunch: Updates.isEmbeddedLaunch,
      emergencyLaunch: Updates.isEmergencyLaunch,
      emergencyLaunchReason: Updates.emergencyLaunchReason,
      launchDurationMs: Updates.launchDuration,
      checkAutomatically: Updates.checkAutomatically,
    },
  };
}

/** A URL without its query, fragment or user info, which may carry credentials. */
function loggedUrl(input: RequestInfo | URL): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split(/[?#]/)[0] ?? raw;
  }
}

function patchConsole() {
  const levels: [keyof Console, LogLevel][] = [
    ["debug", "debug"],
    ["log", "info"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
  ];
  for (const [method, level] of levels) {
    const original = console[method] as (...args: unknown[]) => void;
    (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      const [first, ...rest] = args;
      const message =
        typeof first === "string" ? first : first instanceof Error ? first.message : "";
      const detail = typeof first === "string" ? rest : args;
      deviceLog(level, "console", message, detail.length ? detail : undefined);
      original.apply(console, args);
    };
  }
}

function patchFetch() {
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const url = loggedUrl(input);
    const started = Date.now();
    try {
      const res = await original(input, init);
      const ms = Date.now() - started;
      if (res.ok) {
        deviceLog("debug", "net", `${method} ${url} → ${res.status} in ${ms} ms`);
      } else {
        const body = await res
          .clone()
          .text()
          .then((text) => text.slice(0, ERROR_BODY_MAX))
          .catch(() => undefined);
        deviceLog("warn", "net", `${method} ${url} → ${res.status} in ${ms} ms`, { body });
      }
      return res;
    } catch (error) {
      const aborted = init?.signal?.aborted ?? false;
      deviceLog(
        aborted ? "info" : "error",
        "net",
        `${method} ${url} failed after ${Date.now() - started} ms`,
        error,
      );
      throw error;
    }
  };
}

let installed = false;

/**
 * Keeps a detailed log of today on the phone: app start, console output, every request and
 * its outcome, errors and app state changes. Each new day replaces the previous day's file.
 */
export function installAppLog(): void {
  if (installed) return;
  installed = true;
  startDeviceLog(expoDisk);
  patchConsole();
  patchFetch();
  deviceLog("info", "app", "Started", appSnapshot());
  AppState.addEventListener("change", (state) => {
    deviceLog("info", "app", `State ${state}`);
    if (state !== "active") flushDeviceLog();
  });
}

/** Today's log with the phone's details and Expo Updates' own log, shared as one text file. */
export async function shareAppLog(): Promise<void> {
  const name = todaysLogFile();
  const source = new File(folder(), name);
  const today = source.exists ? await source.text() : "";
  const updates = await Updates.readLogEntriesAsync(UPDATES_LOG_MAX_AGE_MS).catch((error) => [
    { message: `Could not read: ${error instanceof Error ? error.message : String(error)}` },
  ]);
  const text = [
    `Quant log ${name}, exported ${new Date().toISOString()}`,
    JSON.stringify(appSnapshot(), null, 2),
    "",
    "=== App log ===",
    today,
    "=== Expo Updates native log (24 h) ===",
    ...updates.map((entry) => JSON.stringify(entry)),
    "",
  ].join("\n");
  const exportDir = new Directory(Paths.cache, "log-export");
  exportDir.create({ intermediates: true, idempotent: true });
  const exported = new File(exportDir, name.replace(/\.log$/, ".txt"));
  exported.create({ overwrite: true });
  exported.write(text);
  await Sharing.shareAsync(exported.uri, { mimeType: "text/plain", dialogTitle: name });
}
