import { useLingui } from "@lingui/react/macro";
import type { ReminderBlock } from "@rakazo/core";
import { AlarmClock, Check } from "lucide-react";

/** The reminder in the chat: what it was about and whether the user got to it. */
export function ReminderCard({ block }: { block: ReminderBlock }) {
  const { t, i18n } = useLingui();
  const time = new Date(block.ringsAt).toLocaleTimeString(i18n.locale, {
    hour: "numeric",
    minute: "2-digit",
  });
  const status = {
    ringing: { text: t`Ringing now`, className: "text-warning" },
    snoozed: { text: t`Snoozed until ${time}`, className: "text-warning" },
    done: { text: t({ message: "Done", context: "reminder" }), className: "text-success" },
    missed: { text: t`Missed`, className: "text-destructive" },
  }[block.status];
  return (
    <div
      data-testid="reminder-card"
      className="flex w-[min(340px,90%)] flex-col gap-2 rounded-[18px] border border-border bg-card px-4 py-3.5"
    >
      <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <AlarmClock className="size-4" aria-hidden="true" />
        {t`Reminder`}
      </span>
      <span
        className={`text-[15px] font-medium ${block.status === "done" ? "text-muted-foreground line-through" : "text-foreground"}`}
        dir="auto"
      >
        {block.text}
      </span>
      {block.details && block.status !== "done" ? (
        <span className="text-[14px] leading-snug text-muted-foreground" dir="auto">
          {block.details}
        </span>
      ) : null}
      <span className={`flex items-center gap-1.5 text-[14px] ${status.className}`}>
        {block.status === "done" ? <Check className="size-4" aria-hidden="true" /> : null}
        {status.text}
      </span>
    </div>
  );
}
