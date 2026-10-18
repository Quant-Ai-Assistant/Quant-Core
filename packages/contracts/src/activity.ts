import * as z from "zod";

/**
 * What a bot is doing right now, in one shared vocabulary. The server sends a kind and an
 * optional detail (a file name, a query, a domain); every client turns the kind into its own
 * localized words, so the chat, the call and the phone all say the same thing.
 */
export const ACTIVITY_KINDS = [
  "thinking",
  "writing",
  "list_folder",
  "search_files",
  "read_file",
  "create_file",
  "edit_file",
  "delete_file",
  "attach_file",
  "open_file",
  "run_command",
  "run_tests",
  "install",
  "commit",
  "push",
  "launch_app",
  "web_search",
  "read_page",
  "open_site",
  "look_page",
  "use_page",
  "look_screen",
  "computer",
  "takeover",
  "recall",
  "remember",
  "forget",
  "search_chat",
  "read_chat",
  "plan",
  "reminder",
  "schedule",
  "watch",
  "ticket",
  "tasks",
  "read_skill",
  "create_skill",
  "helper",
  "message_bot",
  "handoff",
  "create_bot",
  "cloud_agent",
  "approval",
  "ask",
  "secret",
  "chart",
  "call",
  "connect",
  "create_space",
  "starting",
  "tool",
] as const;

export const ActivityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

/** Longest detail a status carries; clients truncate further to fit their space. */
export const ACTIVITY_DETAIL_MAX_LENGTH = 120;

export const ActivityStatusSchema = z.object({
  kind: ActivityKindSchema,
  detail: z.string().max(ACTIVITY_DETAIL_MAX_LENGTH).optional(),
  /** Set when the step ran inside an integration rather than as the bot's own tool. */
  via: z.literal("claude_code").optional(),
});
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;
