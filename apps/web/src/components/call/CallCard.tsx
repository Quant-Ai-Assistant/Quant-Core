import { useLingui } from "@lingui/react/macro";
import type { ActivityStatus } from "@rakazo/contracts";
import { liveToolKind } from "@rakazo/core";
import { BotAvatar, Button, cn, defaultBotAvatarValue } from "@rakazo/ui-web";
import type { LucideIcon } from "lucide-react";
import {
  Brain,
  ChevronDown,
  FileText,
  Globe,
  Mic,
  MicOff,
  Monitor,
  PhoneOff,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { activityIcon, activityLine } from "../../lib/activity-label";
import type { CallState } from "../../lib/call-session";
import { endCall, setCallMinimized, toggleMute, useCallSession } from "../../lib/call-session";

const EDITABLE = /^(?:input|textarea|select)$/i;

export function callClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Whole seconds the call has been connected, ticking while it is and frozen once it ends. */
export function useCallElapsed(call: CallState | null): number {
  const connectedAt = call?.connectedAt ?? null;
  const endedAt = call?.endedAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (connectedAt === null || endedAt !== null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connectedAt, endedAt]);
  if (connectedAt === null) return 0;
  return Math.max(0, Math.floor(((endedAt ?? now) - connectedAt) / 1000));
}

/** What the call's badge says for the tool the bot is using, with its icon. */
export function useCallTool(
  tool: string | null,
  activity: ActivityStatus | null = null,
): { label: string; Icon: LucideIcon } | null {
  const { t } = useLingui();
  if (!tool) return null;
  if (activity) return { label: activityLine(activity), Icon: activityIcon(activity.kind) };
  switch (liveToolKind(tool)) {
    case "computer":
      return { label: t`Working on the computer`, Icon: Monitor };
    case "web":
      return { label: t`Searching the web`, Icon: Globe };
    case "page":
      return { label: t`Opening a page`, Icon: Globe };
    case "files":
      return { label: t`Working with files`, Icon: FileText };
    case "terminal":
      return { label: t`Running a command`, Icon: SquareTerminal };
    case "memory":
      return { label: t`Remembering`, Icon: Brain };
    default:
      return { label: t`Using a tool`, Icon: Wrench };
  }
}

export function CallCard({ onOpenComputer }: { onOpenComputer: (botId: string) => void }) {
  const { t } = useLingui();
  const call = useCallSession();
  const elapsed = useCallElapsed(call);
  const navigate = useNavigate();
  const { botId } = useParams();
  const tool = useCallTool(call?.tool ?? null, call?.activity ?? null);
  const onCall = Boolean(call);
  useEffect(() => {
    if (!onCall) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || EDITABLE.test(target?.tagName ?? "")) return;
      endCall();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCall]);
  if (!call || call.minimized) return null;
  const onBotScreen = botId === call.botId;
  const ended = call.endedAt !== null;
  const connected = call.connectedAt !== null;
  // Like a phone call: "Connecting…" until the bot answers, then only the clock.
  const status = ended
    ? t`Call ended · ${callClock(elapsed)}`
    : connected
      ? callClock(elapsed)
      : t({ message: "Connecting…", context: "call status" });
  return (
    <div
      data-testid="call-view"
      data-call-state={ended ? "ended" : connected ? "connected" : "connecting"}
      role="dialog"
      aria-label={t`Call with ${call.botName}`}
      className="fixed inset-0 z-50 flex flex-col bg-background px-5 pt-[max(env(safe-area-inset-top),12px)] pb-[max(env(safe-area-inset-bottom),24px)] md:inset-auto md:end-4 md:top-16 md:w-[360px] md:rounded-[22px] md:border md:border-border md:bg-card md:px-4 md:pt-2 md:pb-5 md:shadow-lg"
    >
      <div className={cn("flex items-center gap-1", ended && "invisible")}>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-muted-foreground"
          aria-label={t`Minimize call`}
          onClick={() => setCallMinimized(true)}
        >
          <ChevronDown />
        </Button>
      </div>

      <div className="relative flex flex-1 flex-col items-center justify-center gap-4 py-6 md:flex-none">
        <button
          type="button"
          aria-label={t`Open chat with ${call.botName}`}
          onClick={() => {
            if (!onBotScreen) navigate(`/app/${call.botId}`);
          }}
          className={cn(
            "relative grid size-32 place-items-center md:size-24",
            ended && "opacity-60",
          )}
        >
          {call.phase === "speaking" && !ended ? (
            <span
              aria-hidden="true"
              className="absolute -inset-2 animate-pulse rounded-full border-2 motion-reduce:animate-none"
              style={{ borderColor: defaultBotAvatarValue(call.botColor) }}
            />
          ) : null}
          <BotAvatar color={call.botColor} identity={call.botId} size={96} />
        </button>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="text-[22px] font-semibold text-foreground md:text-[19px]" dir="auto">
            {call.botName}
          </span>
          <span className="text-[15px] tabular-nums text-muted-foreground" aria-live="polite">
            {status}
          </span>
        </div>
        {tool && !ended ? (
          <button
            type="button"
            data-testid="call-tool"
            onClick={() => {
              if (liveToolKind(call.tool ?? "") !== "computer") return;
              setCallMinimized(true);
              onOpenComputer(call.botId);
            }}
            className="inline-flex animate-in fade-in slide-in-from-bottom-1 items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-[12.5px] text-foreground motion-reduce:animate-none"
          >
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-foreground" />
            <tool.Icon size={14} strokeWidth={1.8} aria-hidden />
            {tool.label}
          </button>
        ) : null}
        {call.error ? (
          <p role="alert" className="text-center text-[13px] text-destructive" dir="auto">
            {call.error}
          </p>
        ) : null}
      </div>

      <div className={cn("flex items-center justify-center gap-3", ended && "invisible")}>
        <Button
          variant={call.muted ? "default" : "secondary"}
          size="icon-lg"
          className="size-14 rounded-full md:size-12"
          aria-label={call.muted ? t`Unmute` : t`Mute`}
          aria-pressed={call.muted}
          onClick={toggleMute}
        >
          {call.muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
        </Button>
        <Button
          variant="destructive"
          size="icon-lg"
          className="size-14 rounded-full md:size-12"
          aria-label={t`Hang up`}
          onClick={endCall}
        >
          <PhoneOff className="size-5" />
        </Button>
      </div>
    </div>
  );
}

/** Shown while the call window is minimized, so the call is never out of reach. */
export function CallReturnBar() {
  const { t } = useLingui();
  const call = useCallSession();
  const elapsed = useCallElapsed(call);
  if (!call?.minimized) return null;
  return (
    <button
      type="button"
      data-testid="call-return-bar"
      onClick={() => setCallMinimized(false)}
      className="app-no-drag flex min-h-10 w-full shrink-0 items-center justify-center gap-1.5 bg-success px-3 text-[13.5px] font-medium text-background"
    >
      <span dir="auto">{t`Return to call with ${call.botName}`}</span>
      <span className="tabular-nums">
        ·{" "}
        {call.connectedAt === null
          ? t({ message: "Connecting…", context: "call status" })
          : callClock(elapsed)}
      </span>
    </button>
  );
}
