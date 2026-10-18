import type {
  ActivityStatus,
  BotClaudeCode,
  ClaudeCodeBlock,
  ClaudeCodeEffort,
  ClaudeCodeModel,
} from "@rakazo/contracts";
import {
  CLAUDE_CODE_STEPS_MAX,
  ClaudeCodeEffortSchema,
  ClaudeCodeModelSchema,
} from "@rakazo/contracts";
import { claudeCodeToolStatus } from "./activity-status.js";

/** A bot row's stored Claude Code setup; unknown stored values fall back to the CLI default. */
export function botClaudeCode(row: {
  claudeCodeEnabled?: boolean | null;
  claudeCodeModel?: string | null;
  claudeCodeEffort?: string | null;
}): BotClaudeCode {
  const model = ClaudeCodeModelSchema.safeParse(row.claudeCodeModel);
  const effort = ClaudeCodeEffortSchema.safeParse(row.claudeCodeEffort);
  return {
    enabled: row.claudeCodeEnabled === true,
    model: model.success ? model.data : null,
    effort: effort.success ? effort.data : null,
  };
}

/**
 * Where the official installer, Homebrew and npm put the CLI. A desktop app starts with a short
 * PATH, so the run adds these instead of relying on the user's shell profile.
 */
const CLAUDE_CODE_PATH = "$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin";

/** The CLI command for one Claude Code run. The prompt is an argument, never shell text. */
export function claudeCodeArgv(input: {
  prompt: string;
  model: ClaudeCodeModel | null;
  effort: ClaudeCodeEffort | null;
  sessionId?: string;
}): string[] {
  return [
    "bash",
    "-c",
    `PATH="${CLAUDE_CODE_PATH}:$PATH"; exec claude "$@"`,
    "claude",
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    // The bot's computer is the sandbox: the bot can already run any command there.
    "--dangerously-skip-permissions",
    ...(input.model ? ["--model", input.model] : []),
    ...(input.effort ? ["--effort", input.effort] : []),
    ...(input.sessionId ? ["--resume", input.sessionId] : []),
    "--",
    input.prompt,
  ];
}

export type ClaudeCodeStreamEvent =
  | { type: "init"; sessionId?: string; model?: string }
  | { type: "step"; status: ActivityStatus }
  | { type: "thinking" }
  | { type: "writing" }
  | {
      type: "result";
      ok: boolean;
      text: string;
      sessionId?: string;
      durationMs?: number;
    };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * One line of `claude --output-format stream-json`, as the events the chat shows. Lines that
 * are not JSON, or that carry nothing to show, give no events.
 */
export function parseClaudeCodeStreamLine(line: string): ClaudeCodeStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const event = record(parsed);
  if (!event) return [];
  const sessionId = typeof event.session_id === "string" ? event.session_id : undefined;
  if (event.type === "system" && event.subtype === "init") {
    return [
      {
        type: "init",
        ...(sessionId ? { sessionId } : {}),
        ...(typeof event.model === "string" ? { model: event.model } : {}),
      },
    ];
  }
  if (event.type === "result") {
    const ok =
      event.is_error !== true && (event.subtype === undefined || event.subtype === "success");
    const resultText = typeof event.result === "string" ? event.result : "";
    return [
      {
        type: "result",
        ok,
        text: resultText,
        ...(sessionId ? { sessionId } : {}),
        ...(typeof event.duration_ms === "number" ? { durationMs: event.duration_ms } : {}),
      },
    ];
  }
  if (event.type !== "assistant") return [];
  const content = record(event.message)?.content;
  if (!Array.isArray(content)) return [];
  const out: ClaudeCodeStreamEvent[] = [];
  for (const item of content) {
    const part = record(item);
    if (!part) continue;
    if (part.type === "tool_use" && typeof part.name === "string") {
      out.push({ type: "step", status: claudeCodeToolStatus(part.name, part.input) });
    } else if (part.type === "thinking") {
      out.push({ type: "thinking" });
    } else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      out.push({ type: "writing" });
    }
  }
  return out;
}

/** Split streamed stdout into whole lines, keeping the unfinished tail for the next chunk. */
export function splitStreamLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const joined = buffer + chunk;
  const parts = joined.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

/** Repeats of one kind of step collapse into a count, like "Read 5 files". */
export function appendClaudeCodeStep(
  steps: ClaudeCodeBlock["steps"],
  status: ActivityStatus,
): ClaudeCodeBlock["steps"] {
  const last = steps.at(-1);
  if (last && last.status.kind === status.kind) {
    return [...steps.slice(0, -1), { status, count: last.count + 1 }];
  }
  const next = [...steps, { status, count: 1 }];
  return next.length > CLAUDE_CODE_STEPS_MAX ? next.slice(-CLAUDE_CODE_STEPS_MAX) : next;
}

/** All steps a Claude Code card took, counting repeats. */
export function claudeCodeStepCount(block: Pick<ClaudeCodeBlock, "steps">): number {
  return block.steps.reduce((sum, step) => sum + step.count, 0);
}
