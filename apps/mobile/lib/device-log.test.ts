import { afterEach, describe, expect, it } from "vitest";
import type { LogDisk } from "./device-log";
import {
  DAY_LOG_MAX_BYTES,
  deviceLog,
  flushDeviceLog,
  logFileName,
  resetDeviceLogForTests,
  serializeDetail,
  startDeviceLog,
} from "./device-log";

function memoryDisk(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const disk: LogDisk = {
    list: () => [...files.keys()],
    append: (name, text) => files.set(name, (files.get(name) ?? "") + text),
    size: (name) => files.get(name)?.length ?? 0,
    remove: (name) => files.delete(name),
  };
  return { disk, files };
}

afterEach(() => resetDeviceLogForTests());

describe("device log", () => {
  it("names the file after the local day", () => {
    expect(logFileName(new Date(2026, 9, 8, 23, 59))).toBe("quant-2026-10-08.log");
  });

  it("writes to today's file and deletes earlier days", () => {
    const { disk, files } = memoryDisk({ "quant-2026-10-17.log": "old\n", "other.txt": "keep" });
    let now = new Date(2026, 9, 18, 9, 0);
    startDeviceLog(disk, () => now);
    deviceLog("info", "app", "Started");
    flushDeviceLog();
    expect([...files.keys()].sort()).toEqual(["other.txt", "quant-2026-10-18.log"]);
    expect(files.get("quant-2026-10-18.log")).toMatch(/INFO {2}\[app\] Started\n$/);

    now = new Date(2026, 9, 19, 0, 1);
    deviceLog("warn", "net", "Slow");
    expect([...files.keys()].sort()).toEqual(["other.txt", "quant-2026-10-19.log"]);
  });

  it("keeps lines logged before the disk is ready", () => {
    deviceLog("info", "app", "Early");
    const { disk, files } = memoryDisk();
    startDeviceLog(disk, () => new Date(2026, 9, 18));
    expect(files.get("quant-2026-10-18.log")).toContain("Early");
  });

  it("keeps only warnings and errors once the day's file is full", () => {
    const { disk, files } = memoryDisk({ "quant-2026-10-18.log": "x".repeat(DAY_LOG_MAX_BYTES) });
    startDeviceLog(disk, () => new Date(2026, 9, 18));
    deviceLog("info", "net", "Routine");
    deviceLog("error", "ota", "Restart failed");
    const tail = files.get("quant-2026-10-18.log")?.slice(DAY_LOG_MAX_BYTES) ?? "";
    expect(tail).not.toContain("Routine");
    expect(tail).toContain("Daily log limit reached");
    expect(tail).toContain("Restart failed");
  });

  it("keeps an error's code, stack and cause, and masks secrets", () => {
    const error = Object.assign(
      new Error("Call to function 'ExpoUpdates.reload' has been rejected"),
      {
        code: "ERR_UPDATES_RELOAD",
        cause: new Error("Cannot relaunch without a launched update."),
      },
    );
    const detail = serializeDetail({
      error,
      headers: { authorization: "Bearer t", "x-quant-auth": "Basic a" },
    });
    expect(detail).toMatchObject({
      error: {
        message: "Call to function 'ExpoUpdates.reload' has been rejected",
        code: "ERR_UPDATES_RELOAD",
        cause: { message: "Cannot relaunch without a launched update." },
      },
      headers: { authorization: "[redacted]", "x-quant-auth": "[redacted]" },
    });
    expect((detail as { error: { stack?: string } }).error.stack).toBeTruthy();
  });

  it("survives circular details", () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;
    expect(serializeDetail(value)).toEqual({ a: 1, self: "[circular]" });
  });
});
