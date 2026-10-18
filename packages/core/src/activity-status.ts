import type { ActivityKind, ActivityStatus } from "@rakazo/contracts";
import { ACTIVITY_DETAIL_MAX_LENGTH } from "@rakazo/contracts";

const COMMAND_DETAIL_MAX = 40;

type Args = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.replaceAll(/\s+/g, " ").trim() : "";
}

function clip(value: string, max = ACTIVITY_DETAIL_MAX_LENGTH): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** A file's own name: statuses never show the folders above it. */
export function activityFileName(path: unknown): string {
  const value = text(path).replace(/[\\/]+$/, "");
  return value.split(/[\\/]/).pop() ?? "";
}

/** A page's host, without scheme, path or credentials. */
export function activitySiteName(url: unknown): string {
  const value = text(url);
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function status(kind: ActivityKind, detail?: string): ActivityStatus {
  const clipped = detail ? clip(detail) : "";
  return clipped ? { kind, detail: clipped } : { kind };
}

const TEST_COMMAND =
  /(^|[\s;&|(])(vitest|jest|pytest|mocha|rspec|phpunit|go test|cargo test|swift test|xcodebuild test)\b|\b(npm|pnpm|yarn|bun)( run)? test\b/;
const INSTALL_COMMAND =
  /\b(npm|pnpm|yarn|bun) (i|install|add|ci)\b|\b(pip3?|uv( tool)?|brew|apt(-get)?|gem|cargo|go) (install|add|get)\b/;
const COMMIT_COMMAND = /\bgit commit\b/;
const PUSH_COMMAND = /\bgit push\b/;

/** A shell command, recognized where its purpose is plain from the command itself. */
export function commandActivityStatus(command: unknown): ActivityStatus {
  const value = text(command);
  if (COMMIT_COMMAND.test(value)) return status("commit");
  if (PUSH_COMMAND.test(value)) return status("push");
  if (TEST_COMMAND.test(value)) return status("run_tests", clip(value, COMMAND_DETAIL_MAX));
  if (INSTALL_COMMAND.test(value)) return status("install", clip(value, COMMAND_DETAIL_MAX));
  return status("run_command", clip(value, COMMAND_DETAIL_MAX));
}

function prefixed(name: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => name.startsWith(prefix));
}

/** What a bot's own tool call looks like to the user. Unknown tools still get a status. */
export function toolActivityStatus(toolName: string, rawArgs: unknown): ActivityStatus {
  const args: Args = rawArgs && typeof rawArgs === "object" ? (rawArgs as Args) : {};
  switch (toolName) {
    case "shell":
      return commandActivityStatus(args.command ?? args.cmd);
    case "read_file":
      return status("read_file", activityFileName(args.path));
    case "write_file":
      return status("edit_file", activityFileName(args.path));
    case "list_files":
      return status("list_folder", activityFileName(args.path));
    case "attach_file":
      return status("attach_file", activityFileName(args.path));
    case "open_path":
      return status("open_file", activitySiteName(args.path) || activityFileName(args.path));
    case "launch_app":
      return status("launch_app", text(args.application));
    case "web_search":
      return status("web_search", text(args.query));
    case "web_fetch":
      return status("read_page", activitySiteName(args.url));
    case "browser_navigate":
      return status("open_site", activitySiteName(args.url));
    case "browser_snapshot":
      return status("look_page");
    case "browser_act":
      return status("use_page");
    case "computer_observe":
      return status("look_screen");
    case "computer_act":
      return status("computer");
    case "request_takeover":
      return status("takeover");
    case "recall_memory":
      return status("recall");
    case "remember":
    case "save_memory":
    case "save_shared_memory":
      return status("remember");
    case "forget_memory":
      return status("forget");
    case "search_history":
      return status("search_chat", text(args.query));
    case "read_history":
      return status("read_chat");
    case "remind_user":
      return status("reminder");
    case "task_catalog":
      return status("tasks");
    case "skill_read":
      return status("read_skill", text(args.name));
    case "run_subagent":
      return status("helper", text(args.name));
    case "handoff_to_bot":
      return status("handoff");
    case "ask_user":
      return status("ask");
    case "request_secret":
    case "secret_request":
      return status("secret");
    case "render_plot":
      return status("chart");
    case "call_user":
      return status("call");
    case "add_mcp_server":
      return status("connect", text(args.name));
    case "create_space":
      return status("create_space", text(args.name));
    case "claude_code":
      return { kind: "starting", via: "claude_code" };
  }
  if (prefixed(toolName, ["scratchpad_"])) return status("plan");
  if (prefixed(toolName, ["schedule_"])) return status("schedule");
  if (prefixed(toolName, ["watch_"])) return status("watch");
  if (prefixed(toolName, ["ticket_", "board_"])) return status("ticket");
  if (prefixed(toolName, ["skill_"])) return status("create_skill", text(args.name));
  if (prefixed(toolName, ["message_", "connect_agent", "respond_agent"])) {
    return status("message_bot");
  }
  if (prefixed(toolName, ["spawn_bot", "update_bot", "archive_bot", "delete_bot"])) {
    return status("create_bot", text(args.name));
  }
  if (prefixed(toolName, ["cloud_agent_"])) return status("cloud_agent");
  const mcp = toolName.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return status("tool", mcp[1]);
  return status("tool", toolName.replaceAll("_", " "));
}

/** The same vocabulary for a step Claude Code took inside its own session. */
export function claudeCodeToolStatus(toolName: string, rawInput: unknown): ActivityStatus {
  const input: Args = rawInput && typeof rawInput === "object" ? (rawInput as Args) : {};
  const own = ((): ActivityStatus => {
    switch (toolName) {
      case "Read":
      case "NotebookRead":
        return status("read_file", activityFileName(input.file_path ?? input.notebook_path));
      case "Write":
        return status("create_file", activityFileName(input.file_path));
      case "Edit":
      case "MultiEdit":
      case "NotebookEdit":
        return status("edit_file", activityFileName(input.file_path ?? input.notebook_path));
      case "Glob":
      case "Grep":
        return status("search_files", text(input.pattern));
      case "LS":
        return status("list_folder", activityFileName(input.path));
      case "Bash":
      case "PowerShell":
        return commandActivityStatus(input.command);
      case "BashOutput":
      case "KillShell":
      case "Monitor":
        return status("run_command");
      case "WebSearch":
        return status("web_search", text(input.query));
      case "WebFetch":
        return status("read_page", activitySiteName(input.url));
      case "Task":
      case "Agent":
        return status("helper", text(input.description));
      case "TodoWrite":
      case "ExitPlanMode":
        return status("plan");
      case "Skill":
        return status("read_skill", text(input.skill ?? input.command));
      case "AskUserQuestion":
        return status("ask");
    }
    const mcp = toolName.match(/^mcp__(.+?)__(.+)$/);
    if (mcp) return status("tool", mcp[1]);
    return status("tool", toolName);
  })();
  return { ...own, via: "claude_code" };
}

export function sameActivityStatus(a: ActivityStatus, b: ActivityStatus): boolean {
  return a.kind === b.kind && a.detail === b.detail && a.via === b.via;
}
