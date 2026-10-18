import * as z from "zod";
import { ActivityStatusSchema } from "./activity.js";

/** Claude Code CLI model aliases; each names the latest model of that family. */
export const CLAUDE_CODE_MODELS = ["fable", "opus", "sonnet", "haiku"] as const;
export const ClaudeCodeModelSchema = z.enum(CLAUDE_CODE_MODELS);
export type ClaudeCodeModel = z.infer<typeof ClaudeCodeModelSchema>;

/** The CLI's `--effort` levels. */
export const CLAUDE_CODE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const ClaudeCodeEffortSchema = z.enum(CLAUDE_CODE_EFFORTS);
export type ClaudeCodeEffort = z.infer<typeof ClaudeCodeEffortSchema>;

/** A bot's Claude Code setup. Null model or effort leaves the CLI's own default. */
export const BotClaudeCodeSchema = z.object({
  enabled: z.boolean(),
  model: ClaudeCodeModelSchema.nullable(),
  effort: ClaudeCodeEffortSchema.nullable(),
});
export type BotClaudeCode = z.infer<typeof BotClaudeCodeSchema>;

export const DEFAULT_BOT_CLAUDE_CODE: BotClaudeCode = { enabled: false, model: null, effort: null };

/** The Claude account Claude Code signs in with, separate from the bots' chat models. */
export const ClaudeCodeAccountSchema = z.object({
  connected: z.boolean(),
  kind: z.enum(["subscription", "api_key"]).nullable(),
});
export type ClaudeCodeAccount = z.infer<typeof ClaudeCodeAccountSchema>;

export const CLAUDE_CODE_STEPS_MAX = 200;

/** One Claude Code run in a chat: what it is doing now and the steps it took. */
export const ClaudeCodeBlockSchema = z.object({
  kind: z.literal("claude_code"),
  /** Stable per tool call, so live updates replace the right card. */
  runKey: z.string(),
  status: z.enum(["running", "finished", "failed", "cancelled"]),
  model: z.string().optional(),
  current: ActivityStatusSchema.optional(),
  steps: z
    .array(z.object({ status: ActivityStatusSchema, count: z.number().int().positive() }))
    .max(CLAUDE_CODE_STEPS_MAX),
  durationMs: z.number().int().nonnegative().optional(),
  error: z.string().max(500).optional(),
});
export type ClaudeCodeBlock = z.infer<typeof ClaudeCodeBlockSchema>;
