import { useLingui } from "@lingui/react/macro";
import type { VoiceChatGroup } from "@rakazo/core";
import { callRequestBlock, describeVoiceChat, formatMessageTime } from "@rakazo/core";
import { Button, cn } from "@rakazo/ui-web";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, Phone } from "lucide-react";
import { useState } from "react";

export function VoiceChatCard({
  group,
  revealMessageId,
  onCallBack,
}: {
  group: VoiceChatGroup;
  revealMessageId?: string;
  onCallBack?: () => void;
}) {
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const revealed =
    revealMessageId != null && group.messages.some((message) => message.id === revealMessageId);
  // A jump looks the row up in the same commit. Expand during render so the row exists,
  // and leave the card open after the request clears.
  if (revealed && !open) setOpen(true);
  const entry = describeVoiceChat(group);
  const request = callRequestBlock(group.messages[0]?.blocks);
  const hours = Math.floor(entry.seconds / 3600);
  const minutes = Math.floor((entry.seconds % 3600) / 60);
  const rest = entry.seconds % 60;
  const duration =
    hours > 0
      ? t`${hours} h ${minutes} min`
      : minutes > 0
        ? t`${minutes} min ${rest} s`
        : t`${rest} s`;
  const ringing = entry.outcome === "ringing";
  const missed = entry.outcome === "missed" || entry.outcome === "declined";
  const title =
    entry.outcome === "cancelled"
      ? t`Cancelled call`
      : entry.outcome === "ringing"
        ? t`Calling you…`
        : entry.outcome === "declined"
          ? t`Declined call`
          : entry.outcome === "missed"
            ? t`Missed call`
            : entry.direction === "outgoing"
              ? t`Outgoing call`
              : t`Incoming call`;
  const time = entry.startedAt ? formatMessageTime(entry.startedAt, i18n.locale || "en") : "";
  const detail = [time, entry.outcome === "answered" ? duration : ""].filter(Boolean).join(" · ");
  const transcript = entry.transcript;
  const expandable = transcript.some((line) => line.text);
  // The caller's own call sits on their side; the bot's call on the bot's.
  const mine = entry.direction === "outgoing";
  const Arrow = mine ? ArrowUpRight : ArrowDownLeft;
  return (
    <div
      data-testid="voice-chat-card"
      data-call-status={request?.status}
      className={cn("flex w-full flex-col gap-1", mine ? "items-end" : "items-start")}
    >
      <div
        className={cn(
          "flex w-[min(280px,100%)] items-center gap-3 rounded-[20px] py-2.5 ps-4 pe-2.5",
          mine
            ? "bg-chat-user text-chat-user-foreground"
            : "border border-border bg-card text-foreground",
        )}
      >
        <div className="min-w-0 flex-1">
          <p className={cn("text-[14.5px] font-medium", missed && !mine && "text-destructive")}>
            {title}
          </p>
          <p className="mt-0.5 flex items-center gap-1 text-[12px] tabular-nums opacity-70">
            <Arrow
              aria-hidden="true"
              className={cn("size-3.5 shrink-0", missed && !mine && "text-destructive opacity-100")}
            />
            {detail}
          </p>
        </div>
        {onCallBack && !ringing ? (
          <Button
            size="icon"
            variant={mine ? "secondary" : "default"}
            className="size-9 shrink-0 rounded-full"
            aria-label={t`Call again`}
            onClick={onCallBack}
          >
            <Phone className="size-4" />
          </Button>
        ) : null}
      </div>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          className="inline-flex items-center gap-0.5 px-1 text-[12px] text-muted-foreground hover:text-foreground"
        >
          {open ? t`Hide transcript` : t`Transcript`}
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        </button>
      ) : null}
      {open ? (
        <div
          className={cn(
            "w-[min(420px,100%)] space-y-1 border-s-2 border-border ps-3 text-[13px] leading-[1.5] text-muted-foreground",
          )}
        >
          {transcript.map((line) => {
            if (!line.text) {
              return <span key={line.id} data-message-id={line.id} className="sr-only" />;
            }
            return (
              <p key={line.id} data-message-id={line.id} dir="auto">
                <span className="font-medium text-foreground">
                  {line.role === "user" ? t`You:` : t`Bot:`}
                </span>{" "}
                {line.text}
              </p>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
