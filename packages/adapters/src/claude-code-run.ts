import type { CommandRequest, ProcessEvent } from "@rakazo/adapter-kit";
import type {
  ActivityStatus,
  ClaudeCodeBlock,
  ClaudeCodeEffort,
  ClaudeCodeModel,
} from "@rakazo/contracts";
import {
  appendClaudeCodeStep,
  claudeCodeArgv,
  claudeCodeStepCount,
  MAX_SANDBOX_COMMAND_TIMEOUT_MS,
  parseClaudeCodeStreamLine,
  splitStreamLines,
} from "@rakazo/core";
import { clipToolResultText } from "./pi-runtime-limits.js";

/** Card updates are coalesced so a burst of quick steps is one write. */
export const CLAUDE_CODE_CARD_INTERVAL_MS = 500;

const STDERR_TAIL_CHARS = 2_000;
const MISSING_CLI_EXIT_CODE = 127;

export const CLAUDE_CODE_MISSING_MESSAGE =
  "The Claude Code CLI is not installed on this computer. Install it with `curl -fsSL https://claude.ai/install.sh | bash`, then try again.";

export type ClaudeCodeRunResult =
  | { ok: true; result: string; sessionId?: string; steps: number }
  | { ok: false; error: string; sessionId?: string; steps: number };

export type ClaudeCodeRunInput = {
  runKey: string;
  prompt: string;
  model: ClaudeCodeModel | null;
  effort: ClaudeCodeEffort | null;
  sessionId?: string;
  cwd?: string;
  env?: Record<string, string>;
  unsetEnv?: string[];
  execute: (request: CommandRequest) => AsyncIterable<ProcessEvent>;
  /** Hides secret values in anything that reaches the chat or the model. */
  redact: (text: string) => string;
  /** Saves the card: the first call creates it, later calls replace it. */
  publishCard: (block: ClaudeCodeBlock) => Promise<void>;
  /** The live status line, for calls and the chat's activity row. */
  publishActivity: (status: ActivityStatus) => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
};

/**
 * One Claude Code CLI run on the bot's computer. Each step it takes becomes a status on the
 * card and in the live activity line; the final report goes back to the bot.
 */
export async function runClaudeCode(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const redactStatus = (status: ActivityStatus): ActivityStatus =>
    status.detail ? { ...status, detail: input.redact(status.detail) } : status;
  let block: ClaudeCodeBlock = {
    kind: "claude_code",
    runKey: input.runKey,
    status: "running",
    ...(input.model ? { model: input.model } : {}),
    current: { kind: "starting", via: "claude_code" },
    steps: [],
  };
  let sessionId = input.sessionId;
  let lastCardAt = 0;
  let cardTimer: ReturnType<typeof setTimeout> | undefined;
  let cardWrite: Promise<void> = Promise.resolve();
  const writeCard = () => {
    if (cardTimer) clearTimeout(cardTimer);
    cardTimer = undefined;
    lastCardAt = now();
    const snapshot = block;
    // Writes stay in order so an older card can never land after a newer one.
    cardWrite = cardWrite.then(() => input.publishCard(snapshot)).catch(() => undefined);
    return cardWrite;
  };
  const scheduleCard = () => {
    if (now() - lastCardAt >= CLAUDE_CODE_CARD_INTERVAL_MS) {
      void writeCard();
      return;
    }
    cardTimer ??= setTimeout(() => void writeCard(), CLAUDE_CODE_CARD_INTERVAL_MS);
  };
  const show = (status: ActivityStatus, asStep: boolean) => {
    const safe = redactStatus(status);
    block = {
      ...block,
      current: safe,
      ...(asStep ? { steps: appendClaudeCodeStep(block.steps, safe) } : {}),
    };
    scheduleCard();
    void input.publishActivity(safe).catch(() => undefined);
  };

  await writeCard();
  void input.publishActivity(block.current as ActivityStatus).catch(() => undefined);

  let buffer = "";
  let stderr = "";
  let exitCode: number | undefined;
  let result: { ok: boolean; text: string } | undefined;
  const handleLine = (line: string) => {
    for (const event of parseClaudeCodeStreamLine(line)) {
      if (event.type === "init") {
        if (event.sessionId) sessionId = event.sessionId;
        if (event.model && !input.model) block = { ...block, model: event.model };
      } else if (event.type === "step") {
        show(event.status, true);
      } else if (event.type === "thinking") {
        show({ kind: "thinking", via: "claude_code" }, false);
      } else if (event.type === "writing") {
        show({ kind: "writing", via: "claude_code" }, false);
      } else {
        if (event.sessionId) sessionId = event.sessionId;
        result = { ok: event.ok, text: event.text };
      }
    }
  };

  let failure: string | undefined;
  try {
    for await (const event of input.execute({
      argv: claudeCodeArgv({
        prompt: input.prompt,
        model: input.model,
        effort: input.effort,
        sessionId: input.sessionId,
      }),
      cwd: input.cwd,
      env: input.env && Object.keys(input.env).length > 0 ? input.env : undefined,
      unsetEnv: input.unsetEnv,
      timeoutMs: MAX_SANDBOX_COMMAND_TIMEOUT_MS,
    })) {
      if (event.type === "stdout") {
        const split = splitStreamLines(buffer, event.data);
        buffer = split.rest;
        for (const line of split.lines) handleLine(line);
      } else if (event.type === "stderr") {
        stderr = (stderr + event.data).slice(-STDERR_TAIL_CHARS);
      } else {
        exitCode = event.code;
      }
    }
    if (buffer) handleLine(buffer);
  } catch (error) {
    failure = error instanceof Error ? error.message : "Claude Code stopped unexpectedly.";
  }

  const cancelled = input.signal?.aborted === true;
  const missing = exitCode === MISSING_CLI_EXIT_CODE || /claude: (command )?not found/.test(stderr);
  const error = cancelled
    ? "Stopped."
    : missing
      ? CLAUDE_CODE_MISSING_MESSAGE
      : (failure ??
        (result && !result.ok
          ? result.text || "Claude Code could not finish."
          : !result
            ? stderr.trim() || `Claude Code exited with code ${exitCode ?? "unknown"}.`
            : undefined));
  const safeError = error ? input.redact(error) : undefined;
  const { current: _current, ...settled } = block;
  block = {
    ...settled,
    status: cancelled ? "cancelled" : safeError ? "failed" : "finished",
    durationMs: Math.max(0, now() - startedAt),
    ...(safeError && !cancelled ? { error: clipToolResultText(safeError, 500) } : {}),
  };
  await writeCard();
  const steps = claudeCodeStepCount(block);
  if (safeError) {
    return { ok: false, error: safeError, ...(sessionId ? { sessionId } : {}), steps };
  }
  return {
    ok: true,
    result: clipToolResultText(input.redact(result?.text ?? "")),
    ...(sessionId ? { sessionId } : {}),
    steps,
  };
}
