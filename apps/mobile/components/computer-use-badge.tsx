import { computerUseCount } from "@rakazo/core";
import { Pressable, Text, View } from "react-native";
import type { MobileMessage } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

/** Says a reply used the bot's computer, and opens its screen. Absent when it did not. */
export function ComputerUseBadge({
  message,
  onOpen,
}: {
  message: MobileMessage;
  onOpen: () => void;
}) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const count = computerUseCount(message.blocks);
  if (count === 0) return null;
  const live = message.id.startsWith("progress:");
  const label = live
    ? t("Working on the computer")
    : count === 1
      ? t("Computer · 1 action")
      : t("Computer · {count} actions", { count: String(count) });
  return (
    <Pressable
      testID="computer-use-badge"
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onOpen}
      hitSlop={6}
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        marginTop: 6,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.card,
      }}
    >
      {live ? (
        <View
          style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tokens.foreground }}
        />
      ) : (
        <NativeSymbol
          ios="desktopcomputer"
          android="desktop-outline"
          size={13}
          color={tokens.mutedForeground}
        />
      )}
      <Text style={{ fontSize: 12.5, color: live ? tokens.foreground : tokens.mutedForeground }}>
        {label}
      </Text>
      <NativeSymbol
        ios="chevron.right"
        android="chevron-forward"
        size={11}
        color={tokens.mutedForeground}
      />
    </Pressable>
  );
}
