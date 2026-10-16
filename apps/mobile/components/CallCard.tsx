import { liveToolKind } from "@rakazo/core";
import { useKeepAwake } from "expo-keep-awake";
import { useRouter } from "expo-router";
import type { ComponentProps, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CallPhase, CallState } from "../lib/call-session";
import { endCall, toggleMute, useCallSession } from "../lib/call-session";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { BotAvatar } from "./bot-avatar";
import { GlassIconButton } from "./glass-icon-button";
import { NativeSymbol } from "./native-symbol";

const AVATAR = 128;

/**
 * A call lives in the foreground: once the screen locks, Android pauses the app and the
 * microphone, recognition, and reply feed stop until it is unlocked. Mounted only while a
 * call is up, so the screen sleeps normally the rest of the time.
 */
function KeepScreenOnDuringCall() {
  useKeepAwake("rakazo-call");
  return null;
}

/** Seconds since the bot answered, ticking once a second and frozen once the call ends. */
function useCallSeconds(call: CallState | null): number {
  const connectedAt = call?.connectedAt ?? null;
  const endedAt = call?.endedAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (connectedAt === null || endedAt !== null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [connectedAt, endedAt]);
  if (connectedAt === null) return 0;
  return Math.max(0, Math.floor(((endedAt ?? now) - connectedAt) / 1000));
}

type ToolBadge = {
  label: string;
  ios: string;
  android: ComponentProps<typeof NativeSymbol>["android"];
};

/** What the call's badge says for the tool the bot is using; new tools read generically. */
function useToolBadge(tool: string | null): ToolBadge | null {
  const { t } = useI18n();
  if (!tool) return null;
  switch (liveToolKind(tool)) {
    case "computer":
      return {
        label: t("Working on the computer"),
        ios: "desktopcomputer",
        android: "desktop-outline",
      };
    case "web":
      return { label: t("Searching the web"), ios: "globe", android: "globe-outline" };
    case "page":
      return { label: t("Opening a page"), ios: "safari", android: "globe-outline" };
    case "files":
      return { label: t("Working with files"), ios: "doc.text", android: "document-text-outline" };
    case "terminal":
      return { label: t("Running a command"), ios: "terminal", android: "terminal-outline" };
    case "memory":
      return { label: t("Remembering"), ios: "brain", android: "bulb-outline" };
    default:
      return {
        label: t("Using a tool"),
        ios: "wrench.and.screwdriver",
        android: "construct-outline",
      };
  }
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Telegram-style call: a full screen while talking, a bar to return to it when tucked away. */
export function CallCard() {
  const call = useCallSession();
  const [minimized, setMinimized] = useState(false);
  const seconds = useCallSeconds(call);
  const botId = call?.botId;
  // A new call always opens full screen.
  useEffect(() => {
    if (botId) setMinimized(false);
  }, [botId]);
  if (!call) return null;
  return (
    <>
      <KeepScreenOnDuringCall />
      {minimized ? (
        <CallBar call={call} seconds={seconds} onExpand={() => setMinimized(false)} />
      ) : (
        <CallScreen call={call} seconds={seconds} onMinimize={() => setMinimized(true)} />
      )}
    </>
  );
}

function CallBar({
  call,
  seconds,
  onExpand,
}: {
  call: CallState;
  seconds: number;
  onExpand: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Return to call with {name}", { name: call.botName })}
      onPress={onExpand}
      style={[styles.bar, { top: insets.top + 4, backgroundColor: tokens.primary }]}
    >
      <NativeSymbol ios="phone.fill" android="call" size={13} color={tokens.primaryForeground} />
      <Text numberOfLines={1} style={[styles.barText, { color: tokens.primaryForeground }]}>
        {call.botName}
      </Text>
      <Text style={[styles.barText, styles.digits, { color: tokens.primaryForeground }]}>
        {call.connectedAt === null ? t("Connecting…") : clock(seconds)}
      </Text>
    </Pressable>
  );
}

function CallScreen({
  call,
  seconds,
  onMinimize,
}: {
  call: CallState;
  seconds: number;
  onMinimize: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const ended = call.endedAt !== null;
  // Like a phone call: "Connecting…" until the bot answers, then only the clock.
  const status = ended
    ? t("Call ended · {time}", { time: clock(seconds) })
    : call.connectedAt !== null
      ? clock(seconds)
      : t("Connecting…");
  const tool = useToolBadge(ended ? null : call.tool);
  return (
    <View
      accessibilityViewIsModal
      style={[
        styles.screen,
        {
          backgroundColor: tokens.background,
          paddingTop: insets.top + 8,
          paddingBottom: insets.bottom + 24,
        },
      ]}
    >
      <View style={styles.top}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Minimize call")}
          hitSlop={10}
          onPress={onMinimize}
        >
          <NativeSymbol
            ios="chevron.down"
            android="chevron-down"
            size={22}
            color={tokens.foreground}
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Open chat with {name}", { name: call.botName })}
          hitSlop={10}
          onPress={() => {
            onMinimize();
            router.push({ pathname: "/thread", params: { botId: call.botId, name: call.botName } });
          }}
        >
          <NativeSymbol
            ios="message"
            android="chatbubble-outline"
            size={21}
            color={tokens.foreground}
          />
        </Pressable>
      </View>
      <View style={styles.center}>
        <Pulse
          phase={call.muted || ended ? "thinking" : call.phase}
          color={call.botColor || tokens.foreground}
        >
          <View style={{ opacity: ended ? 0.6 : 1 }}>
            <BotAvatar color={call.botColor} identity={call.botId} size={AVATAR} />
          </View>
        </Pulse>
        <Text numberOfLines={1} style={[styles.name, { color: tokens.foreground }]}>
          {call.botName}
        </Text>
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.status, styles.digits, { color: tokens.mutedForeground }]}
        >
          {status}
        </Text>
        {tool ? (
          <Pressable
            testID="call-tool"
            accessibilityRole="button"
            accessibilityLabel={tool.label}
            onPress={() => {
              if (liveToolKind(call.tool ?? "") !== "computer") return;
              onMinimize();
              router.push({
                pathname: "/computer",
                params: { botId: call.botId, name: call.botName },
              });
            }}
            style={[styles.tool, { borderColor: tokens.border, backgroundColor: tokens.muted }]}
          >
            <View style={[styles.toolDot, { backgroundColor: tokens.foreground }]} />
            <NativeSymbol
              ios={tool.ios}
              android={tool.android}
              size={14}
              color={tokens.foreground}
            />
            <Text style={{ fontSize: 13, color: tokens.foreground }}>{tool.label}</Text>
          </Pressable>
        ) : null}
        {call.error ? (
          <Text accessibilityRole="alert" style={[styles.error, { color: tokens.destructive }]}>
            {call.error}
          </Text>
        ) : null}
      </View>
      <View
        style={[styles.actions, ended && { opacity: 0 }]}
        pointerEvents={ended ? "none" : "auto"}
      >
        <RoundAction
          label={call.muted ? t("Unmute") : t("Mute")}
          ios={call.muted ? "mic.slash.fill" : "mic.fill"}
          android={call.muted ? "mic-off" : "mic"}
          selected={call.muted}
          onPress={toggleMute}
        />
        <RoundAction
          label={t("Hang up")}
          ios="phone.down.fill"
          android="call"
          destructive
          onPress={endCall}
        />
      </View>
    </View>
  );
}

function RoundAction({
  label,
  ios,
  android,
  selected,
  destructive,
  onPress,
}: {
  label: string;
  ios: string;
  android: ComponentProps<typeof NativeSymbol>["android"];
  selected?: boolean;
  destructive?: boolean;
  onPress: () => void;
}) {
  const tokens = useMobileTokens();
  return (
    <View style={styles.action}>
      <GlassIconButton
        accessibilityLabel={label}
        ios={ios}
        android={android}
        size={64}
        iconSize={24}
        color={destructive ? tokens.destructiveForeground : tokens.foreground}
        tint={destructive ? tokens.destructive : undefined}
        selected={selected}
        onPress={onPress}
        fallbackStyle={{
          backgroundColor: destructive ? tokens.destructive : tokens.muted,
        }}
      />
      <Text
        numberOfLines={1}
        importantForAccessibility="no"
        style={[styles.actionLabel, { color: tokens.mutedForeground }]}
      >
        {label}
      </Text>
    </View>
  );
}

/** Rings around the avatar while the bot speaks, like the other side of a real call. */
function Pulse({
  phase,
  color,
  children,
}: {
  phase: CallPhase;
  color: string;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const ring = useRef(new Animated.Value(0)).current;
  const still = phase !== "speaking" || reduceMotion;

  useEffect(() => {
    if (still) {
      ring.setValue(0);
      return;
    }
    const duration = 700;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(ring, { toValue: 1, duration, useNativeDriver: true }),
        Animated.timing(ring, { toValue: 0, duration, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [phase, still, ring]);

  const halo = (spread: number, opacity: number) => ({
    position: "absolute" as const,
    width: AVATAR + spread,
    height: AVATAR + spread,
    borderRadius: (AVATAR + spread) / 2,
    backgroundColor: color,
    opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [opacity * 0.4, opacity] }),
    transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.06] }) }],
  });

  return (
    <View accessible={false} style={styles.pulse}>
      <Animated.View style={halo(72, 0.08)} />
      <Animated.View style={halo(36, 0.14)} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 50,
    paddingHorizontal: 24,
  },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", height: 44 },
  center: { flex: 1, alignItems: "center", marginTop: 48, gap: 6 },
  pulse: {
    width: AVATAR + 72,
    height: AVATAR + 72,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  name: { fontSize: 28, fontWeight: "600", writingDirection: "auto" },
  status: { fontSize: 16 },
  digits: { fontVariant: ["tabular-nums"] },
  tool: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  toolDot: { width: 6, height: 6, borderRadius: 3 },
  error: { fontSize: 14, textAlign: "center", marginTop: 16, writingDirection: "auto" },
  actions: { flexDirection: "row", justifyContent: "space-evenly", paddingBottom: 8 },
  action: { alignItems: "center", gap: 8, width: 72 },
  actionLabel: { fontSize: 12 },
  bar: {
    position: "absolute",
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    height: 32,
    borderRadius: 16,
    zIndex: 50,
  },
  barText: { fontSize: 14, fontWeight: "600", maxWidth: 160 },
});
