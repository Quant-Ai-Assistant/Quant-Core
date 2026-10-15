import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BotAvatar } from "../components/bot-avatar";
import { GlassIconButton } from "../components/glass-icon-button";
import { rpc, selectedSpaceId, selectSpace } from "../lib/api";
import { startCall } from "../lib/call-session";
import { reportError } from "../lib/diagnostics";
import { useI18n } from "../lib/i18n";
import type { RingingCall } from "../lib/incoming-calls";
import { answerIncomingCall, isStillRinging } from "../lib/incoming-calls";
import { dismissIncomingCall, showOverLockScreen } from "../lib/live-notifications";
import { useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";

const RING_CHECK_MS = 3_000;

function param(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** A bot ringing this phone: opened from the ringing notification, over the lock screen. */
export default function IncomingCallScreen() {
  const params = useLocalSearchParams<{
    botId?: string;
    name?: string;
    color?: string;
    callId?: string;
    spaceId?: string;
    answer?: string;
  }>();
  const botId = param(params.botId);
  const botName = param(params.name);
  const botColor = param(params.color);
  const callId = param(params.callId);
  const spaceId = param(params.spaceId);
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  const answer = async () => {
    if (handled.current) return;
    handled.current = true;
    setBusy(true);
    setError(null);
    try {
      await answerIncomingCall(
        { botId, botName, callId, spaceId: spaceId || undefined },
        {
          selectedSpaceId,
          selectSpace,
          ringing: () => rpc<RingingCall[]>("threads/ringingCalls"),
          answer: (id, call) =>
            rpc<{ opening: string }>("threads/answerCall", { botId: id, callId: call }),
          dismiss: dismissIncomingCall,
          start: startCall,
        },
      );
      router.replace({ pathname: "/thread", params: { botId, name: botName } });
    } catch (cause) {
      // What the ringing notification handed this screen, next to the server's view of the call.
      reportError("call.answer", cause instanceof Error ? cause.message : String(cause), {
        params,
        botId,
        callId,
        spaceId,
      });
      handled.current = false;
      setError(errorText(cause, t("This call is no longer ringing.")));
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    if (handled.current) return;
    handled.current = true;
    setBusy(true);
    await rpc("threads/declineCall", { botId, callId }).catch(() => undefined);
    await dismissIncomingCall(callId).catch(() => undefined);
    close();
  };

  useEffect(() => {
    void showOverLockScreen(true).catch(() => undefined);
    return () => void showOverLockScreen(false).catch(() => undefined);
  }, []);

  // "Answer" on the notification opens this screen already picking up.
  const autoAnswer = param(params.answer) === "1";
  useEffect(() => {
    if (autoAnswer && botId && callId) void answer();
  }, [autoAnswer, botId, callId]);

  // Answered on another device, declined there, or it stopped: this screen goes away.
  useEffect(() => {
    if (!callId) return;
    const timer = setInterval(() => {
      if (handled.current) return;
      void isStillRinging(callId)
        .then((ringing) => {
          if (!ringing && !handled.current) close();
        })
        .catch(() => undefined);
    }, RING_CHECK_MS);
    return () => clearInterval(timer);
  }, [callId]);

  return (
    <View
      style={[
        styles.screen,
        {
          backgroundColor: tokens.background,
          paddingTop: insets.top + 64,
          paddingBottom: insets.bottom + 40,
        },
      ]}
    >
      <View style={styles.center}>
        <BotAvatar color={botColor} identity={botId} size={128} />
        <Text numberOfLines={1} style={[styles.name, { color: tokens.foreground }]}>
          {botName}
        </Text>
        <Text style={[styles.status, { color: tokens.mutedForeground }]}>
          {error ?? t("Incoming call")}
        </Text>
      </View>
      <View style={styles.actions}>
        <Action
          label={t("Decline")}
          ios="phone.down.fill"
          android="call"
          background={tokens.destructive}
          color={tokens.destructiveForeground}
          disabled={busy}
          onPress={() => void decline()}
        />
        <Action
          label={t("Answer")}
          ios="phone.fill"
          android="call"
          background={tokens.success}
          color={tokens.destructiveForeground}
          disabled={busy}
          onPress={() => void answer()}
        />
      </View>
    </View>
  );
}

function Action(props: {
  label: string;
  ios: string;
  android: "call";
  background: string;
  color: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const tokens = useMobileTokens();
  return (
    <View style={[styles.action, { opacity: props.disabled ? 0.5 : 1 }]}>
      <GlassIconButton
        accessibilityLabel={props.label}
        ios={props.ios}
        android={props.android}
        size={72}
        iconSize={28}
        color={props.color}
        tint={props.background}
        onPress={props.disabled ? () => undefined : props.onPress}
        fallbackStyle={{ backgroundColor: props.background }}
      />
      <Text
        importantForAccessibility="no"
        style={[styles.actionLabel, { color: tokens.mutedForeground }]}
      >
        {props.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 32, justifyContent: "space-between" },
  center: { alignItems: "center", gap: 8 },
  name: { fontSize: 30, fontWeight: "600", marginTop: 20, writingDirection: "auto" },
  status: { fontSize: 17, textAlign: "center" },
  actions: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16 },
  action: { alignItems: "center", gap: 10 },
  actionLabel: { fontSize: 14 },
});
