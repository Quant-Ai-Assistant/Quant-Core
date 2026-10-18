import * as z from "zod";
import { ActivityStatusSchema } from "./activity.js";

/** Claude Code CLI model aliases; each names the latest model of that family. */
export const CLAUDE_CODE_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
export type ClaudeCodeFamily = (typeof CLAUDE_CODE_FAMILIES)[number];

/** Pinned model versions the CLI's `--model` takes, newest first in each family. */
export const CLAUDE_CODE_VERSIONS = [
  { id: "claude-fable-5-1", family: "fable", name: "Fable 5.1" },
  { id: "claude-fable-5", family: "fable", name: "Fable 5" },
  { id: "claude-opus-5-5", family: "opus", name: "Opus 5.5" },
  { id: "claude-opus-5", family: "opus", name: "Opus 5" },
  { id: "claude-opus-4-8", family: "opus", name: "Opus 4.8" },
  { id: "claude-opus-4-7", family: "opus", name: "Opus 4.7" },
  { id: "claude-opus-4-6", family: "opus", name: "Opus 4.6" },
  { id: "claude-sonnet-5-5", family: "sonnet", name: "Sonnet 5.5" },
  { id: "claude-sonnet-5", family: "sonnet", name: "Sonnet 5" },
  { id: "claude-sonnet-4-6", family: "sonnet", name: "Sonnet 4.6" },
  { id: "claude-haiku-5-5", family: "haiku", name: "Haiku 5.5" },
  { id: "claude-haiku-4-5", family: "haiku", name: "Haiku 4.5" },
] as const satisfies readonly { id: string; family: ClaudeCodeFamily; name: string }[];

/** A family alias (always its latest model) or a pinned version. */
export const CLAUDE_CODE_MODELS = [
  ...CLAUDE_CODE_FAMILIES,
  ...CLAUDE_CODE_VERSIONS.map((version) => version.id),
] as const;
export const ClaudeCodeModelSchema = z.enum(CLAUDE_CODE_MODELS);
export type ClaudeCodeModel = z.infer<typeof ClaudeCodeModelSchema>;

/** "Opus" for the alias, "Opus 4.8" for a pinned version. */
export function claudeCodeModelName(model: ClaudeCodeModel): string {
  const version = CLAUDE_CODE_VERSIONS.find((entry) => entry.id === model);
  return version ? version.name : `${model.slice(0, 1).toUpperCase()}${model.slice(1)}`;
}

/** Each family's choices: its alias first, then its pinned versions. */
export function claudeCodeModelGroups(): { family: ClaudeCodeFamily; models: ClaudeCodeModel[] }[] {
  return CLAUDE_CODE_FAMILIES.map((family) => ({
    family,
    models: [
      family,
      ...CLAUDE_CODE_VERSIONS.filter((version) => version.family === family).map(
        (version) => version.id,
      ),
    ],
  }));
}

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
