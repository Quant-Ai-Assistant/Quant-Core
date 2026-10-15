import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticLog, recordRpcFailure, redactForLog } from "./diagnostic-log.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "diagnostics-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("daily diagnostic log", () => {
  it("appends a day's entries to that day's file and keeps only today and yesterday", async () => {
    await writeFile(path.join(dir, "14.10.2026.log"), "old\n");
    await writeFile(path.join(dir, "15.10.2026.log"), "yesterday\n");
    await writeFile(path.join(dir, "notes.txt"), "not a log\n");
    const log = new DiagnosticLog(dir, () => new Date(2026, 9, 16, 9, 30));
    await log.write({ source: "mobile", kind: "call.answer", message: "first" });
    await log.write({ source: "server", kind: "rpc.error", message: "second" });
    expect((await readdir(dir)).sort()).toEqual(["15.10.2026.log", "16.10.2026.log", "notes.txt"]);
    const lines = (await readFile(path.join(dir, "16.10.2026.log"), "utf8")).trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).message)).toEqual(["first", "second"]);
  });

  it("never writes credentials or bulky payloads", () => {
    expect(
      redactForLog({ apiKey: "sk-x", offerSdp: "v=0", nested: { password: "p", callId: "c1" } }),
    ).toEqual({
      apiKey: "[redacted]",
      offerSdp: "[redacted]",
      nested: { password: "[redacted]", callId: "c1" },
    });
    expect(String(redactForLog("x".repeat(5_000)))).toContain("… (5000)");
  });

  it("records the input of a rejected call and ignores ordinary refusals", () => {
    const log = { write: vi.fn(async () => {}) };
    recordRpcFailure(
      log,
      new ORPCError("BAD_REQUEST", {
        message: "Input validation failed",
        data: { issues: [{ path: ["callId"] }] },
      }),
      { path: ["threads", "answerCall"], input: { botId: "b", callId: "" } },
    );
    expect(log.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "rpc.rejected",
        message: "threads/answerCall: Input validation failed",
        detail: expect.objectContaining({ input: { botId: "b", callId: "" } }),
      }),
    );
    log.write.mockClear();
    recordRpcFailure(log, new ORPCError("CONFLICT", { message: "No longer ringing." }), {
      path: ["threads", "answerCall"],
      input: {},
    });
    expect(log.write).not.toHaveBeenCalled();
  });
});
