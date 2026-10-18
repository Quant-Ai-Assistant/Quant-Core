import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/bot-avatar";
import { NativeActionButton } from "../components/native-action-button";
import { rpc, selectedSpaceId, selectSpace } from "../lib/api";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { dismissReminder, showOverLockScreen } from "../lib/live-notifications";
import { useMobileTokens } from "../lib/native";
import type { RingingReminder } from "../lib/reminders";
import { isReminderStillRinging, settleReminder } from "../lib/reminders";
import { errorText } from "../lib/user-error";

const RING_CHECK_MS = 3_000;

function param(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** A bot's reminder that came due: opened from its alarm notification, over the lock screen. */
export default function ReminderScreen() {
  const params = useLocalSearchParams<{
    botId?: string;
    name?: string;
    color?: string;
    reminderId?: string;
    text?: string;
    details?: string;
    spaceId?: string;
  }>();
  const botId = param(params.botId);
  const reminderId = param(params.reminderId);
  const spaceId = param(params.spaceId);
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const handled = useRef(false);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  const settle = async (action: "done" | "snooze") => {
    if (handled.current) return;
    handled.current = true;
    setBusy(true);
    setError(null);
    try {
      await settleReminder(
        { botId, reminderId, spaceId: spaceId || undefined, action },
        {
          selectedSpaceId,
          selectSpace,
          settle: (input) => rpc<{ ok: true }>("threads/settleReminder", input),
          dismiss: dismissReminder,
        },
      );
      close();
    } catch (cause) {
      handled.current = false;
      setError(errorText(cause, t("Could not complete action")));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void showOverLockScreen(true).catch(() => undefined);
    return () => void showOverLockScreen(false).catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(timer);
  }, []);

  // Done or snoozed on another device, or it rang out: this screen goes away.
  useEffect(() => {
    if (!reminderId) return;
    const timer = setInterval(() => {
      if (handled.current) return;
      void isReminderStillRinging(reminderId, () =>
        rpc<RingingReminder[]>("threads/ringingReminders"),
      )
        .then((ringing) => {
          if (!ringing && !handled.current) close();
        })
        .catch(() => undefined);
    }, RING_CHECK_MS);
    return () => clearInterval(timer);
  }, [reminderId]);

  const dateLocale = dateLocaleForUi(locale);
  const details = param(params.details);
  return (
    <View
      style={[
        styles.screen,
        {
          backgroundColor: tokens.background,
          paddingTop: insets.top + 64,
          paddingBottom: insets.bottom + 32,
        },
      ]}
    >
      <View style={styles.clock}>
        <Text style={[styles.time, { color: tokens.foreground }]}>
          {now.toLocaleTimeString(dateLocale, { hour: "numeric", minute: "2-digit" })}
        </Text>
        <Text style={[styles.date, { color: tokens.mutedForeground }]}>
          {now.toLocaleDateString(dateLocale, { weekday: "long", day: "numeric", month: "long" })}
        </Text>
      </View>
      <View style={styles.center}>
        <BotAvatar color={param(params.color)} identity={botId} size={72} />
        <Text style={[styles.label, { color: tokens.mutedForeground }]}>
          {t("Reminder")} · {param(params.name)}
        </Text>
        <Text accessibilityRole="header" style={[styles.text, { color: tokens.foreground }]}>
          {param(params.text)}
        </Text>
        {details ? (
          <Text style={[styles.details, { color: tokens.mutedForeground }]}>{details}</Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={[styles.details, { color: tokens.destructive }]}>
            {error}
          </Text>
        ) : null}
      </View>
      <View style={styles.actions}>
        <NativeActionButton
          label={t("Done")}
          icon={{ ios: "checkmark", android: "checkmark" }}
          busy={busy}
          onPress={() => void settle("done")}
          style={styles.action}
        />
        <NativeActionButton
          label={t("In 5 minutes")}
          icon={{ ios: "alarm", android: "alarm-outline" }}
          prominence="secondary"
          fill
          disabled={busy}
          onPress={() => void settle("snooze")}
          style={styles.action}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 28, justifyContent: "space-between" },
  clock: { alignItems: "center", gap: 8 },
  time: { fontSize: 64, fontWeight: "300", fontVariant: ["tabular-nums"] },
  date: { fontSize: 15 },
  center: { alignItems: "center", gap: 10 },
  label: { fontSize: 15, marginTop: 8 },
  text: { fontSize: 28, fontWeight: "600", textAlign: "center", writingDirection: "auto" },
  details: { fontSize: 16, lineHeight: 23, textAlign: "center", writingDirection: "auto" },
  actions: { gap: 12 },
  action: { minHeight: 56, borderRadius: 28 },
});
