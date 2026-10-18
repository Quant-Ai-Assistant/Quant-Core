import type { ReminderBlock } from "@rakazo/core";
import type { ViewProps } from "react-native";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { threadCardWidth } from "../lib/message-presentation";
import { native, useMobileTokens } from "../lib/native";

const styles = StyleSheet.create({
  card: { borderRadius: 18, gap: 6, paddingHorizontal: 16, paddingVertical: 14 },
  label: { fontSize: 13 },
  text: { fontSize: 16, fontWeight: "600", writingDirection: "auto" },
  details: { fontSize: 14, lineHeight: 19, writingDirection: "auto" },
  status: { fontSize: 14 },
});

/** The reminder in the chat: what it was about and whether the user got to it. */
export function ReminderCard({
  block,
  accessibilityActions,
  onAccessibilityAction,
}: {
  block: ReminderBlock;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}) {
  const { t, locale } = useI18n();
  const tokens = useMobileTokens();
  const { width: windowWidth } = useWindowDimensions();
  const time = new Date(block.ringsAt).toLocaleTimeString(dateLocaleForUi(locale), {
    hour: "numeric",
    minute: "2-digit",
  });
  const status = {
    ringing: { text: t("Ringing now"), color: tokens.warning },
    snoozed: { text: t("Snoozed until {time}", { time }), color: tokens.warning },
    done: { text: t("Done"), color: tokens.success },
    missed: { text: t("Missed"), color: tokens.destructive },
  }[block.status];
  const done = block.status === "done";
  return (
    <View
      testID="reminder-card"
      accessible
      accessibilityLabel={`${t("Reminder")}: ${block.text}. ${status.text}`}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      style={[styles.card, { width: threadCardWidth(windowWidth), backgroundColor: native.fill }]}
    >
      <Text style={[styles.label, { color: tokens.mutedForeground }]}>{t("Reminder")}</Text>
      <Text
        style={[
          styles.text,
          done
            ? { color: tokens.mutedForeground, textDecorationLine: "line-through" }
            : { color: tokens.foreground },
        ]}
      >
        {block.text}
      </Text>
      {block.details && !done ? (
        <Text style={[styles.details, { color: tokens.mutedForeground }]}>{block.details}</Text>
      ) : null}
      <Text style={[styles.status, { color: status.color }]}>{status.text}</Text>
    </View>
  );
}
