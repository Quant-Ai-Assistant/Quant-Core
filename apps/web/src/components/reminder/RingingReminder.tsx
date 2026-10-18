import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { BotAvatar, Button } from "@rakazo/ui-web";
import { AlarmClock, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

const POLL_MS = 5_000;

type Reminder = Awaited<ReturnType<typeof rpc.threads.ringingReminders>>[number];

/** Three soft bell notes, once per ring: a reminder asks for attention, it does not ring on. */
function playChime(): void {
  const Context =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return;
  let context: AudioContext;
  try {
    context = new Context();
  } catch {
    return;
  }
  const start = context.currentTime + 0.05;
  for (const [index, frequency] of [880, 1109, 1319].entries()) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    gain.connect(context.destination);
    const at = start + index * 0.22;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.09, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
    oscillator.start(at);
    oscillator.stop(at + 0.95);
  }
  setTimeout(() => void context.close().catch(() => undefined), 2_000);
}

/**
 * A bot's reminder that came due: stays over the app until the user marks it done or asks for
 * it again in five minutes, on this device or any other.
 */
export function RingingReminder({ bots }: { bots: Bot[] }) {
  const { t } = useLingui();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  /** Rings this tab already answered, so a stale poll cannot show them again. */
  const [handled, setHandled] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const announced = useRef(new Set<string>());

  useEffect(() => {
    let stopped = false;
    const load = () =>
      rpc.threads
        .ringingReminders()
        .then((next) => {
          if (!stopped) setReminders(next);
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const ringKey = (reminder: Reminder) => `${reminder.reminderId}:${reminder.ringsAt}`;
  const reminder = reminders.find((item) => !handled.has(ringKey(item))) ?? null;
  const key = reminder ? ringKey(reminder) : null;

  const current = useRef(reminder);
  current.current = reminder;
  useEffect(() => {
    const reminder = current.current;
    if (!reminder || !key || announced.current.has(key)) return;
    announced.current.add(key);
    setError(null);
    playChime();
    if (document.visibilityState === "visible" || typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const notice = new Notification(reminder.text, {
      body: reminder.botName,
      tag: `reminder:${reminder.reminderId}`,
      requireInteraction: true,
    });
    notice.onclick = () => {
      window.focus();
      notice.close();
    };
    return () => notice.close();
  }, [key]);

  if (!reminder || !key) return null;
  const bot = bots.find((item) => item.id === reminder.botId);

  const settle = async (action: "done" | "snooze") => {
    setBusy(true);
    setError(null);
    try {
      await rpc.threads.settleReminder({
        botId: reminder.botId,
        reminderId: reminder.reminderId,
        action,
      });
      setHandled((current) => new Set(current).add(key));
    } catch (cause) {
      setError(errorText(cause, t`Could not send that`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="ringing-reminder"
      role="alertdialog"
      aria-label={t`Reminder from ${reminder.botName}`}
      className="fixed inset-0 z-50 flex flex-col bg-background px-7 pt-[max(env(safe-area-inset-top),96px)] pb-[max(env(safe-area-inset-bottom),40px)] md:inset-auto md:end-4 md:top-4 md:w-[360px] md:gap-3 md:rounded-[18px] md:border md:border-border md:bg-card md:p-3.5 md:shadow-lg"
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center md:flex-none md:flex-row md:items-start md:gap-3 md:text-start">
        <span className="md:hidden">
          <BotAvatar color={bot?.color ?? reminder.botColor} identity={reminder.botId} size={72} />
        </span>
        <span className="hidden shrink-0 md:block">
          <BotAvatar color={bot?.color ?? reminder.botColor} identity={reminder.botId} size={36} />
        </span>
        <span className="flex min-w-0 flex-col gap-1.5 md:gap-0.5">
          <span className="text-[15px] text-muted-foreground md:text-[12px]" dir="auto">
            {t`Reminder`} · {reminder.botName}
          </span>
          <span
            className="text-[28px] font-semibold leading-tight text-foreground md:text-[15px] md:leading-snug"
            dir="auto"
          >
            {reminder.text}
          </span>
          {reminder.details ? (
            <span
              className="text-[16px] leading-relaxed text-muted-foreground md:text-[13px] md:leading-snug"
              dir="auto"
            >
              {reminder.details}
            </span>
          ) : null}
        </span>
      </div>
      {error ? (
        <p role="alert" className="mb-4 text-center text-[13px] text-destructive md:mb-0">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-3 md:grid md:grid-cols-2 md:gap-2">
        <Button
          className="order-1 h-14 rounded-full text-[17px] md:order-2 md:h-[34px] md:rounded-[10px] md:text-[13px]"
          disabled={busy}
          onClick={() => void settle("done")}
        >
          <Check className="size-5 md:size-4" aria-hidden="true" />
          {t({ message: "Done", context: "reminder" })}
        </Button>
        <Button
          variant="outline"
          className="order-2 h-14 rounded-full text-[17px] md:order-1 md:h-[34px] md:rounded-[10px] md:text-[13px]"
          disabled={busy}
          onClick={() => void settle("snooze")}
        >
          <AlarmClock className="size-5 md:size-4" aria-hidden="true" />
          {t`In 5 minutes`}
        </Button>
      </div>
    </div>
  );
}
