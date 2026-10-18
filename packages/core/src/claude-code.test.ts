import { describe, expect, it } from "vitest";
import {
  claudeCodeToolStatus,
  commandActivityStatus,
  toolActivityStatus,
} from "./activity-status.js";
import {
  appendClaudeCodeStep,
  botClaudeCode,
  claudeCodeArgv,
  parseClaudeCodeStreamLine,
  splitStreamLines,
} from "./claude-code.js";

describe("Claude Code CLI", () => {
  it("passes the prompt as one argument after the options", () => {
    expect(
      claudeCodeArgv({ prompt: "--fix; rm -rf /", model: "opus", effort: "high", sessionId: "s1" }),
    ).toEqual([
      "bash",
      "-c",
      'PATH="$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"; exec claude "$@"',
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model",
      "opus",
      "--effort",
      "high",
      "--resume",
      "s1",
      "--",
      "--fix; rm -rf /",
    ]);
    expect(claudeCodeArgv({ prompt: "x", model: null, effort: null })).not.toContain("--model");
  });

  it("reads stored settings and drops values the CLI does not know", () => {
    expect(
      botClaudeCode({ claudeCodeEnabled: true, claudeCodeModel: "opus", claudeCodeEffort: "max" }),
    ).toEqual({ enabled: true, model: "opus", effort: "max" });
    expect(botClaudeCode({ claudeCodeModel: "gpt-6-luna", claudeCodeEffort: "huge" })).toEqual({
      enabled: false,
      model: null,
      effort: null,
    });
  });

  it("turns stream-json lines into steps and a result", () => {
    expect(
      parseClaudeCodeStreamLine(
        JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "opus" }),
      ),
    ).toEqual([{ type: "init", sessionId: "s1", model: "opus" }]);
    expect(
      parseClaudeCodeStreamLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "…" },
              { type: "text", text: "Looking." },
              { type: "tool_use", name: "Read", input: { file_path: "/repo/src/auth/session.ts" } },
            ],
          },
        }),
      ),
    ).toEqual([
      { type: "thinking" },
      { type: "writing" },
      {
        type: "step",
        status: { kind: "read_file", detail: "session.ts", via: "claude_code" },
      },
    ]);
    expect(
      parseClaudeCodeStreamLine(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Fixed.",
          session_id: "s1",
          duration_ms: 4200,
        }),
      ),
    ).toEqual([{ type: "result", ok: true, text: "Fixed.", sessionId: "s1", durationMs: 4200 }]);
  });

  it("treats a result flagged as an error as a failure even when its subtype says success", () => {
    const [event] = parseClaudeCodeStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "You've hit your weekly limit",
      }),
    );
    expect(event).toMatchObject({
      type: "result",
      ok: false,
      text: "You've hit your weekly limit",
    });
  });

  it("ignores lines that are not events", () => {
    expect(parseClaudeCodeStreamLine("warming up")).toEqual([]);
    expect(parseClaudeCodeStreamLine("{not json")).toEqual([]);
    expect(parseClaudeCodeStreamLine(JSON.stringify({ type: "rate_limit_event" }))).toEqual([]);
  });

  it("keeps a half line until the rest of it arrives", () => {
    const first = splitStreamLines("", '{"a":1}\n{"b"');
    expect(first).toEqual({ lines: ['{"a":1}'], rest: '{"b"' });
    expect(splitStreamLines(first.rest, ":2}\n")).toEqual({ lines: ['{"b":2}'], rest: "" });
  });

  it("collapses repeats of one kind of step into a count", () => {
    const read = (file: string) => claudeCodeToolStatus("Read", { file_path: file });
    let steps = appendClaudeCodeStep([], read("a.ts"));
    steps = appendClaudeCodeStep(steps, read("b.ts"));
    steps = appendClaudeCodeStep(steps, claudeCodeToolStatus("Bash", { command: "pnpm test" }));
    expect(steps).toEqual([
      { status: { kind: "read_file", detail: "b.ts", via: "claude_code" }, count: 2 },
      { status: { kind: "run_tests", detail: "pnpm test", via: "claude_code" }, count: 1 },
    ]);
  });
});

describe("activity statuses", () => {
  it("names a shell command by what it does", () => {
    expect(commandActivityStatus("git commit -m 'fix'")).toEqual({ kind: "commit" });
    expect(commandActivityStatus("git push origin main")).toEqual({ kind: "push" });
    expect(commandActivityStatus("pnpm vitest run auth")).toMatchObject({ kind: "run_tests" });
    expect(commandActivityStatus("npm install left-pad")).toMatchObject({ kind: "install" });
    const long = commandActivityStatus(`echo ${"x".repeat(80)}`);
    expect(long.kind).toBe("run_command");
    expect(long.detail?.length).toBeLessThanOrEqual(40);
  });

  it("shows a file name, never its folders, and a site, never its path", () => {
    expect(toolActivityStatus("read_file", { path: "bots/abc/secret/plan.md" })).toEqual({
      kind: "read_file",
      detail: "plan.md",
    });
    expect(
      toolActivityStatus("web_fetch", { url: "https://user:pw@www.example.com/a?token=1" }),
    ).toEqual({ kind: "read_page", detail: "example.com" });
  });

  it("gives every tool a status, including ones it has never seen", () => {
    expect(toolActivityStatus("computer_act", {})).toEqual({ kind: "computer" });
    expect(toolActivityStatus("scratchpad_add", {})).toEqual({ kind: "plan" });
    expect(toolActivityStatus("mcp__linear__create_issue", {})).toEqual({
      kind: "tool",
      detail: "linear",
    });
    expect(toolActivityStatus("brand_new_tool", null)).toEqual({
      kind: "tool",
      detail: "brand new tool",
    });
    expect(toolActivityStatus("claude_code", { prompt: "x" })).toEqual({
      kind: "starting",
      via: "claude_code",
    });
  });

  it("maps Claude Code's own tools onto the same vocabulary", () => {
    expect(claudeCodeToolStatus("Edit", { file_path: "src/a.ts" })).toEqual({
      kind: "edit_file",
      detail: "a.ts",
      via: "claude_code",
    });
    expect(claudeCodeToolStatus("Grep", { pattern: "refreshToken" })).toMatchObject({
      kind: "search_files",
      detail: "refreshToken",
    });
    expect(claudeCodeToolStatus("Task", { description: "Review the diff" })).toMatchObject({
      kind: "helper",
    });
    expect(claudeCodeToolStatus("mcp__github__create_pr", {})).toMatchObject({
      kind: "tool",
      detail: "github",
    });
  });
});
