import type { ActivityKind, ActivityStatus } from "@rakazo/contracts";
import type { ComponentProps } from "react";
import type { NativeSymbol } from "../components/native-symbol";
import { t } from "./i18n";

type Symbol = { ios: string; android: ComponentProps<typeof NativeSymbol>["android"] };

/** What the bot is doing while a step runs, in English; `t` translates it. */
const LIVE: Record<ActivityKind, string> = {
  thinking: "Thinking",
  writing: "Writing a reply",
  list_folder: "Looking in a folder",
  search_files: "Searching files",
  read_file: "Reading a file",
  create_file: "Creating a file",
  edit_file: "Editing a file",
  delete_file: "Deleting a file",
  attach_file: "Attaching a file",
  open_file: "Opening a file",
  run_command: "Running a command",
  run_tests: "Running tests",
  install: "Installing packages",
  commit: "Committing",
  push: "Pushing changes",
  launch_app: "Opening an app",
  web_search: "Searching the web",
  read_page: "Reading a page",
  open_site: "Opening a site",
  look_page: "Looking at the page",
  use_page: "Using the page",
  look_screen: "Looking at the screen",
  computer: "Working on the computer",
  takeover: "Asking you to take over",
  recall: "Remembering",
  remember: "Saving to memory",
  forget: "Forgetting",
  search_chat: "Searching the chat",
  read_chat: "Reading the chat",
  plan: "Updating the plan",
  reminder: "Setting a reminder",
  schedule: "Scheduling",
  watch: "Setting up a watch",
  ticket: "Updating a task",
  tasks: "Checking tasks",
  read_skill: "Reading a skill",
  create_skill: "Saving a skill",
  helper: "Working with a helper",
  message_bot: "Messaging a bot",
  handoff: "Handing off",
  create_bot: "Setting up a bot",
  cloud_agent: "Working with a cloud agent",
  approval: "Waiting for your approval",
  ask: "Waiting for your answer",
  secret: "Waiting for a code",
  chart: "Drawing a chart",
  call: "Calling you",
  connect: "Connecting",
  create_space: "Creating a space",
  starting: "Starting",
  tool: "Using a tool",
};

/** The same step once it is done, as a line in a finished list. */
const DONE: Partial<Record<ActivityKind, string>> = {
  list_folder: "Folder",
  search_files: "File search",
  read_file: "Read",
  create_file: "New file",
  edit_file: "Edit",
  delete_file: "Deleted",
  run_command: "Command",
  run_tests: "Tests",
  install: "Install",
  commit: "Commit",
  push: "Push",
  web_search: "Web search",
  read_page: "Page",
  helper: "Helper",
  plan: "Plan",
  read_skill: "Skill",
  tool: "Tool",
};

const SYMBOLS: Partial<Record<ActivityKind, Symbol>> = {
  thinking: { ios: "sparkles", android: "sparkles-outline" },
  writing: { ios: "pencil", android: "create-outline" },
  list_folder: { ios: "folder", android: "folder-open-outline" },
  search_files: { ios: "doc.text.magnifyingglass", android: "search-outline" },
  read_file: { ios: "doc.text", android: "document-text-outline" },
  create_file: { ios: "doc.badge.plus", android: "document-outline" },
  edit_file: { ios: "pencil.line", android: "create-outline" },
  delete_file: { ios: "trash", android: "trash-outline" },
  attach_file: { ios: "paperclip", android: "attach-outline" },
  open_file: { ios: "arrow.up.right.square", android: "open-outline" },
  run_command: { ios: "terminal", android: "terminal-outline" },
  run_tests: { ios: "testtube.2", android: "flask-outline" },
  install: { ios: "shippingbox", android: "cube-outline" },
  commit: { ios: "checkmark.circle", android: "git-commit-outline" },
  push: { ios: "arrow.up.circle", android: "cloud-upload-outline" },
  launch_app: { ios: "macwindow", android: "apps-outline" },
  web_search: { ios: "globe", android: "globe-outline" },
  read_page: { ios: "book", android: "book-outline" },
  open_site: { ios: "safari", android: "compass-outline" },
  look_page: { ios: "eye", android: "eye-outline" },
  use_page: { ios: "cursorarrow.click", android: "hand-left-outline" },
  look_screen: { ios: "eye", android: "eye-outline" },
  computer: { ios: "desktopcomputer", android: "desktop-outline" },
  takeover: { ios: "hand.raised", android: "hand-left-outline" },
  recall: { ios: "brain", android: "bulb-outline" },
  remember: { ios: "bookmark", android: "bookmark-outline" },
  plan: { ios: "checklist", android: "list-outline" },
  reminder: { ios: "alarm", android: "alarm-outline" },
  schedule: { ios: "calendar.badge.clock", android: "calendar-outline" },
  helper: { ios: "person.2", android: "people-outline" },
  message_bot: { ios: "paperplane", android: "paper-plane-outline" },
  approval: { ios: "checkmark.shield", android: "shield-checkmark-outline" },
  ask: { ios: "questionmark.bubble", android: "help-circle-outline" },
  secret: { ios: "key", android: "key-outline" },
  chart: { ios: "chart.xyaxis.line", android: "analytics-outline" },
  call: { ios: "phone.arrow.up.right", android: "call-outline" },
  connect: { ios: "powerplug", android: "flash-outline" },
};

const TOOL_SYMBOL: Symbol = { ios: "wrench.and.screwdriver", android: "construct-outline" };

/** Status words have their own catalog keys, so "Thinking" here never borrows a setting's word. */
function translated(key: string, english: string): string {
  const text = t(key);
  return text === key ? english : text;
}

export function activityLabel(kind: ActivityKind): string {
  return translated(`activity.${kind}`, LIVE[kind]);
}

export function activityStepLabel(kind: ActivityKind): string {
  const done = DONE[kind];
  return done ? translated(`activity.done.${kind}`, done) : activityLabel(kind);
}

export function activitySymbol(kind: ActivityKind): Symbol {
  return SYMBOLS[kind] ?? TOOL_SYMBOL;
}

/** One line for the call badge: the integration first, then the step. */
export function activityLine(status: ActivityStatus): string {
  const label = activityLabel(status.kind);
  return status.via === "claude_code" ? `Claude Code · ${label}` : label;
}
