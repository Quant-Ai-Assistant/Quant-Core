import { t } from "@lingui/core/macro";
import type { ActivityKind, ActivityStatus } from "@rakazo/contracts";
import type { LucideIcon } from "lucide-react";
import {
  AppWindow,
  ArrowRightLeft,
  BellRing,
  BookMarked,
  BookmarkPlus,
  BookOpen,
  Bot,
  Brain,
  CalendarClock,
  ChartLine,
  Cloud,
  Compass,
  Eraser,
  ExternalLink,
  Eye,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  FlaskConical,
  FolderOpen,
  GitCommitHorizontal,
  Globe,
  Hand,
  History,
  KeyRound,
  LayoutGrid,
  ListChecks,
  Loader,
  MessageCircleQuestion,
  MessagesSquare,
  Monitor,
  MousePointerClick,
  Package,
  Paperclip,
  PenLine,
  PhoneOutgoing,
  PlugZap,
  Radar,
  ScanEye,
  Send,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Ticket,
  Trash2,
  Upload,
  Users,
  Wrench,
} from "lucide-react";

/** What the bot is doing, as it reads while the step runs. Details show beside it. */
export function activityLabel(kind: ActivityKind): string {
  switch (kind) {
    case "thinking":
      return t({ message: "Thinking", context: "activity" });
    case "writing":
      return t`Writing a reply`;
    case "list_folder":
      return t`Looking in a folder`;
    case "search_files":
      return t`Searching files`;
    case "read_file":
      return t`Reading a file`;
    case "create_file":
      return t`Creating a file`;
    case "edit_file":
      return t`Editing a file`;
    case "delete_file":
      return t`Deleting a file`;
    case "attach_file":
      return t`Attaching a file`;
    case "open_file":
      return t`Opening a file`;
    case "run_command":
      return t`Running a command`;
    case "run_tests":
      return t`Running tests`;
    case "install":
      return t`Installing packages`;
    case "commit":
      return t`Committing`;
    case "push":
      return t`Pushing changes`;
    case "launch_app":
      return t`Opening an app`;
    case "web_search":
      return t`Searching the web`;
    case "read_page":
      return t`Reading a page`;
    case "open_site":
      return t`Opening a site`;
    case "look_page":
      return t`Looking at the page`;
    case "use_page":
      return t`Using the page`;
    case "look_screen":
      return t`Looking at the screen`;
    case "computer":
      return t`Working on the computer`;
    case "takeover":
      return t`Asking you to take over`;
    case "recall":
      return t({ message: "Remembering", context: "activity" });
    case "remember":
      return t`Saving to memory`;
    case "forget":
      return t`Forgetting`;
    case "search_chat":
      return t`Searching the chat`;
    case "read_chat":
      return t`Reading the chat`;
    case "plan":
      return t`Updating the plan`;
    case "reminder":
      return t`Setting a reminder`;
    case "schedule":
      return t`Scheduling`;
    case "watch":
      return t`Setting up a watch`;
    case "ticket":
      return t`Updating a task`;
    case "tasks":
      return t`Checking tasks`;
    case "read_skill":
      return t`Reading a skill`;
    case "create_skill":
      return t`Saving a skill`;
    case "helper":
      return t`Working with a helper`;
    case "message_bot":
      return t`Messaging a bot`;
    case "handoff":
      return t`Handing off`;
    case "create_bot":
      return t`Setting up a bot`;
    case "cloud_agent":
      return t`Working with a cloud agent`;
    case "approval":
      return t`Waiting for your approval`;
    case "ask":
      return t`Waiting for your answer`;
    case "secret":
      return t`Waiting for a code`;
    case "chart":
      return t`Drawing a chart`;
    case "call":
      return t`Calling you`;
    case "connect":
      return t`Connecting`;
    case "create_space":
      return t`Creating a space`;
    case "starting":
      return t({ message: "Starting", context: "activity" });
    case "tool":
      return t`Using a tool`;
  }
}

/** The same step once it is done, as a line in a finished list. */
export function activityStepLabel(kind: ActivityKind): string {
  switch (kind) {
    case "list_folder":
      return t`Folder`;
    case "search_files":
      return t`File search`;
    case "read_file":
      return t`Read`;
    case "create_file":
      return t`New file`;
    case "edit_file":
      return t`Edit`;
    case "delete_file":
      return t`Deleted`;
    case "run_command":
      return t`Command`;
    case "run_tests":
      return t`Tests`;
    case "install":
      return t`Install`;
    case "commit":
      return t`Commit`;
    case "push":
      return t`Push`;
    case "web_search":
      return t`Web search`;
    case "read_page":
      return t`Page`;
    case "helper":
      return t`Helper`;
    case "plan":
      return t`Plan`;
    case "read_skill":
      return t`Skill`;
    case "tool":
      return t`Tool`;
    default:
      return activityLabel(kind);
  }
}

const ICONS: Record<ActivityKind, LucideIcon> = {
  thinking: Sparkles,
  writing: PenLine,
  list_folder: FolderOpen,
  search_files: FileSearch,
  read_file: FileText,
  create_file: FilePlus,
  edit_file: FilePen,
  delete_file: Trash2,
  attach_file: Paperclip,
  open_file: ExternalLink,
  run_command: SquareTerminal,
  run_tests: FlaskConical,
  install: Package,
  commit: GitCommitHorizontal,
  push: Upload,
  launch_app: AppWindow,
  web_search: Globe,
  read_page: BookOpen,
  open_site: Compass,
  look_page: ScanEye,
  use_page: MousePointerClick,
  look_screen: Eye,
  computer: Monitor,
  takeover: Hand,
  recall: Brain,
  remember: BookmarkPlus,
  forget: Eraser,
  search_chat: History,
  read_chat: MessagesSquare,
  plan: ListChecks,
  reminder: BellRing,
  schedule: CalendarClock,
  watch: Radar,
  ticket: Ticket,
  tasks: LayoutGrid,
  read_skill: BookMarked,
  create_skill: Sparkles,
  helper: Users,
  message_bot: Send,
  handoff: ArrowRightLeft,
  create_bot: Bot,
  cloud_agent: Cloud,
  approval: ShieldCheck,
  ask: MessageCircleQuestion,
  secret: KeyRound,
  chart: ChartLine,
  call: PhoneOutgoing,
  connect: PlugZap,
  create_space: LayoutGrid,
  starting: Loader,
  tool: Wrench,
};

export function activityIcon(kind: ActivityKind): LucideIcon {
  return ICONS[kind];
}

/** One line for small spaces such as the call card: the integration first, then the step. */
export function activityLine(status: ActivityStatus): string {
  const label = activityLabel(status.kind);
  return status.via === "claude_code" ? `Claude Code · ${label}` : label;
}

/** The kinds that mean the bot waits on the user rather than working. */
export function activityWaitsForUser(kind: ActivityKind): boolean {
  return kind === "approval" || kind === "ask" || kind === "secret" || kind === "takeover";
}
