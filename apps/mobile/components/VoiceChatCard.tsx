import type { VoiceChatGroup } from "@rakazo/core";
import { describeVoiceChat, formatMessageTime } from "@rakazo/core";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileMessage } from "../lib/api";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

/** `3 min 24 s`, as a call log reads a call's length. */
function callLength(seconds: number, t: ReturnType<typeof useI18n>["t"]): string {
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60);
  return minutes > 0
    ? t("{minutes} min {seconds} s", { minutes: String(minutes), seconds: rest })
    : t("{seconds} s", { seconds: rest });
}

/**
 * A call in the chat, like a phone's call log: which way it went, when, and for how long,
 * with a button to call again. The transcript opens in place from a link under it.
 */
export function VoiceChatCard({
  group,
  onCallBack,
}: {
  group: VoiceChatGroup<MobileMessage>;
  onCallBack?: () => void;
}) {
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const [open, setOpen] = useState(false);
  const entry = describeVoiceChat(group);
  const mine = entry.direction === "outgoing";
  const missed = entry.outcome === "missed" || entry.outcome === "declined";
  const title =
    entry.outcome === "cancelled"
      ? t("Cancelled call")
      : entry.outcome === "ringing"
        ? t("Calling you…")
        : entry.outcome === "declined"
          ? t("Declined call")
          : entry.outcome === "missed"
            ? t("Missed call")
            : mine
              ? t("Outgoing call")
              : t("Incoming call");
  const time = entry.startedAt ? formatMessageTime(entry.startedAt, dateLocaleForUi(locale)) : "";
  const detail = [time, entry.outcome === "answered" ? callLength(entry.seconds, t) : ""]
    .filter(Boolean)
    .join(" · ");
  const lines = entry.transcript.filter((line) => line.text);
  const foreground = mine ? tokens.primaryForeground : tokens.foreground;
  const accent = missed && !mine ? tokens.destructive : foreground;
  return (
    <View
      testID="voice-chat-card"
      style={[styles.entry, { alignItems: mine ? "flex-end" : "flex-start" }]}
    >
      <View
        style={[
          styles.call,
          mine
            ? { backgroundColor: tokens.primary }
            : { backgroundColor: tokens.card, borderColor: tokens.border, borderWidth: 1 },
        ]}
      >
        <View style={styles.text} accessible accessibilityLabel={`${title}. ${detail}`}>
          <Text style={[styles.title, { color: accent }]}>{title}</Text>
          <View style={styles.detail}>
            <NativeSymbol
              ios={mine ? "arrow.up.right" : "arrow.down.left"}
              android={mine ? "arrow-up" : "arrow-down"}
              size={11}
              color={accent}
            />
            <Text style={[styles.detailText, { color: foreground }]}>{detail}</Text>
          </View>
        </View>
        {onCallBack && entry.outcome !== "ringing" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Call again")}
            hitSlop={6}
            onPress={onCallBack}
            style={[
              styles.callBack,
              { backgroundColor: mine ? tokens.background : tokens.primary },
            ]}
          >
            <NativeSymbol
              ios="phone.fill"
              android="call"
              size={15}
              color={mine ? tokens.foreground : tokens.primaryForeground}
            />
          </Pressable>
        ) : null}
      </View>
      {lines.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          hitSlop={8}
          onPress={() => setOpen((wasOpen) => !wasOpen)}
          style={styles.link}
        >
          <Text style={[styles.linkText, { color: tokens.mutedForeground }]}>
            {open ? t("Hide transcript") : t("Transcript")}
          </Text>
          <NativeSymbol
            ios={open ? "chevron.up" : "chevron.down"}
            android={open ? "chevron-up" : "chevron-down"}
            size={11}
            color={tokens.mutedForeground}
          />
        </Pressable>
      ) : null}
      {open ? (
        <View style={[styles.transcript, { borderStartColor: tokens.border }]}>
          {lines.map((line) => (
            <Text key={line.id} selectable style={[styles.line, { color: tokens.mutedForeground }]}>
              <Text style={{ color: tokens.foreground, fontWeight: "600" }}>
                {line.role === "user" ? t("You:") : t("Bot:")}
              </Text>{" "}
              {line.text}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  entry: { gap: 4 },
  call: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    width: 270,
    maxWidth: "88%",
    borderRadius: 20,
    paddingStart: 14,
    paddingEnd: 10,
    paddingVertical: 10,
  },
  text: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, fontWeight: "600" },
  detail: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  detailText: { fontSize: 12.5, opacity: 0.7, fontVariant: ["tabular-nums"] },
  callBack: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  link: { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 4 },
  linkText: { fontSize: 12.5 },
  transcript: { borderStartWidth: 2, paddingStart: 10, gap: 4, maxWidth: "92%" },
  line: { fontSize: 13.5, lineHeight: 19, writingDirection: "auto" },
});
