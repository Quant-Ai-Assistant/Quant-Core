import type { CommandRequest, ProcessEvent } from "@rakazo/adapter-kit";
import type { ActivityStatus, ClaudeCodeBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_MISSING_MESSAGE, runClaudeCode } from "./claude-code-run.js";

function line(event: Record<string, unknown>): string {
  return `${JSON.stringify(event)}\n`;
}

function tool(name: string, input: Record<string, unknown>): string {
  return line({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
}

function harness(events: ProcessEvent[], options: { aborted?: boolean } = {}) {
  const requests: CommandRequest[] = [];
  const cards: ClaudeCodeBlock[] = [];
  const activity: ActivityStatus[] = [];
  let clock = 1_000;
  const controller = new AbortController();
  if (options.aborted) controller.abort();
  const run = runClaudeCode({
    runKey: "call-1",
    prompt: "Fix the failing auth test",
    model: "opus",
    effort: "high",
    cwd: "bots/b1",
    env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-secret" },
    execute: (request) => {
      requests.push(request);
      return (async function* () {
        for (const event of events) {
          clock += 1_000;
          yield event;
        }
      })();
    },
    redact: (text) => text.replaceAll("sk-ant-oat-secret", "[redacted]"),
    publishCard: async (block) => {
      cards.push(block);
    },
    publishActivity: async (status) => {
      activity.push(status);
    },
    signal: controller.signal,
    now: () => clock,
  });
  return { run, requests, cards, activity };
}

describe("runClaudeCode", () => {
  it("runs the CLI, shows each step and returns the final report", async () => {
    const { run, requests, cards, activity } = harness([
      {
        type: "stdout",
        data: line({ type: "system", subtype: "init", session_id: "s1", model: "opus" }),
      },
      { type: "stdout", data: tool("Grep", { pattern: "refreshToken" }) },
      // A line split across two chunks still parses once it is whole.
      { type: "stdout", data: tool("Read", { file_path: "src/auth/session.ts" }).slice(0, 30) },
      { type: "stdout", data: tool("Read", { file_path: "src/auth/session.ts" }).slice(30) },
      { type: "stdout", data: tool("Bash", { command: "pnpm vitest auth" }) },
      {
        type: "stdout",
        data: line({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Fixed the token refresh order.",
          session_id: "s1",
        }),
      },
      { type: "exit", code: 0 },
    ]);
    const result = await run;

    expect(result).toEqual({
      ok: true,
      result: "Fixed the token refresh order.",
      sessionId: "s1",
      steps: 3,
    });
    expect(requests[0]?.argv.slice(3, 5)).toEqual(["claude", "--print"]);
    expect(requests[0]?.argv.at(-1)).toBe("Fix the failing auth test");
    expect(requests[0]?.cwd).toBe("bots/b1");
    expect(requests[0]?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-secret" });

    expect(cards[0]).toMatchObject({ status: "running", current: { kind: "starting" } });
    const final = cards.at(-1);
    expect(final).toMatchObject({ kind: "claude_code", runKey: "call-1", status: "finished" });
    expect(final?.current).toBeUndefined();
    expect(final?.steps.map((step) => step.status.kind)).toEqual([
      "search_files",
      "read_file",
      "run_tests",
    ]);
    expect(final?.durationMs).toBeGreaterThan(0);
    expect(activity.map((status) => status.kind)).toEqual([
      "starting",
      "search_files",
      "read_file",
      "run_tests",
    ]);
    expect(activity.every((status) => status.via === "claude_code")).toBe(true);
  });

  it("reports a result the CLI flagged as an error", async () => {
    const { run, cards } = harness([
      {
        type: "stdout",
        data: line({ type: "result", subtype: "success", is_error: true, result: "Weekly limit" }),
      },
      { type: "exit", code: 1 },
    ]);
    expect(await run).toMatchObject({ ok: false, error: "Weekly limit" });
    expect(cards.at(-1)).toMatchObject({ status: "failed", error: "Weekly limit" });
  });

  it("says how to install the CLI when the computer does not have it", async () => {
    const { run } = harness([
      { type: "stderr", data: "bash: claude: command not found\n" },
      { type: "exit", code: 127 },
    ]);
    expect(await run).toMatchObject({ ok: false, error: CLAUDE_CODE_MISSING_MESSAGE });
  });

  it("never lets the sign-in token reach the chat or the bot", async () => {
    const { run, cards, activity } = harness([
      { type: "stdout", data: tool("Bash", { command: "echo sk-ant-oat-secret" }) },
      {
        type: "stdout",
        data: line({ type: "result", is_error: false, result: "token is sk-ant-oat-secret" }),
      },
      { type: "exit", code: 0 },
    ]);
    const result = await run;
    const seen = JSON.stringify({ result, cards, activity });
    expect(seen).not.toContain("sk-ant-oat-secret");
    expect(seen).toContain("[redacted]");
  });

  it("marks a stopped run as cancelled", async () => {
    const { run, cards } = harness([{ type: "exit", code: 143 }], { aborted: true });
    expect(await run).toMatchObject({ ok: false, error: "Stopped." });
    expect(cards.at(-1)).toMatchObject({ status: "cancelled" });
    expect(cards.at(-1)?.error).toBeUndefined();
  });
});
