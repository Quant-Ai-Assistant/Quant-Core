import { ActionSheetIOS, Alert, Image, Platform, Pressable, Text, View } from "react-native";
import Animated, { FadeInDown, FadeInUp } from "react-native-reanimated";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import type { SendAttempt } from "../lib/thread-feedback";
import { NativeSymbol } from "./native-symbol";

/** Rises out of the composer; an inverted list flips its cells, so its "down" is up. */
const RISE_MS = 220;

/**
 * A send that has no message yet. While it is on its way it looks like the message it will
 * become, with a clock, and gives way to it in place; a failed send says so and offers a retry.
 */
export function FailedSendBubble({
  attempt,
  onRetry,
  onDelete,
  inverted,
}: {
  attempt: SendAttempt;
  onRetry: () => void;
  onDelete: () => void;
  inverted: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { payload, state } = attempt;
  // A send waits in the queue for a moment before it goes; only an error makes it unsent.
  const sending = state === "pending" || (state === "queued" && !attempt.error);
  const retryable = state === "failed" || state === "queued";
  const caption = sending
    ? t("Sending…")
    : retryable
      ? t("Not sent · Tap to retry")
      : t("Not sent");
  const messageLabel = [payload.displayText, ...payload.attachments.map(({ name }) => name)]
    .filter(Boolean)
    .join(", ");
  const color = sending ? tokens.mutedForeground : tokens.destructive;

  function showActions() {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          message: attempt.error,
          options: retryable
            ? [t("Try Again"), t("Delete"), t("Cancel")]
            : [t("Delete"), t("Cancel")],
          destructiveButtonIndex: retryable ? 1 : 0,
          cancelButtonIndex: retryable ? 2 : 1,
        },
        (index) => {
          if (retryable && index === 0) onRetry();
          if (index === (retryable ? 1 : 0)) onDelete();
        },
      );
    } else {
      Alert.alert(caption, attempt.error, [
        ...(retryable ? [{ text: t("Try Again"), onPress: onRetry }] : []),
        { text: t("Delete"), style: "destructive", onPress: onDelete },
        { text: t("Cancel"), style: "cancel" },
      ]);
    }
  }

  const entering = (inverted ? FadeInDown : FadeInUp).duration(RISE_MS);
  if (sending) {
    return (
      <Animated.View
        entering={entering}
        accessible
        accessibilityLabel={messageLabel ? `${messageLabel}. ${caption}` : caption}
        style={{ alignSelf: "flex-end", maxWidth: "90%", marginTop: 12 }}
      >
        <View
          style={{
            backgroundColor: tokens.secondary,
            padding: 12,
            borderRadius: 20,
            gap: 8,
          }}
        >
          {payload.replyPreview ? (
            <Text
              numberOfLines={3}
              style={{
                color: tokens.mutedForeground,
                fontSize: 13,
                borderLeftWidth: 2,
                borderLeftColor: tokens.border,
                paddingLeft: 8,
              }}
            >
              {payload.replyPreview}
            </Text>
          ) : null}
          {payload.displayText ? (
            <Text style={{ color: tokens.secondaryForeground, fontSize: 15.5, lineHeight: 23 }}>
              {payload.displayText}
            </Text>
          ) : payload.voice ? (
            <Text style={{ color: tokens.secondaryForeground, fontSize: 15.5, lineHeight: 23 }}>
              {t("Voice message")}
            </Text>
          ) : null}
          {payload.attachments.map((attachment) =>
            attachment.previewUri ? (
              <Image
                key={attachment.id}
                source={{ uri: attachment.previewUri }}
                style={{ width: 180, height: 120, borderRadius: 12 }}
              />
            ) : payload.voice?.attachmentId === attachment.id ? null : (
              <Text key={attachment.id} style={{ color: tokens.secondaryForeground, fontSize: 13 }}>
                {attachment.name}
              </Text>
            ),
          )}
          <View style={{ alignSelf: "flex-end", marginTop: -4 }}>
            <NativeSymbol
              ios="clock"
              android="time-outline"
              size={12}
              color={tokens.mutedForeground}
            />
          </View>
        </View>
      </Animated.View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={messageLabel ? `${messageLabel}. ${caption}` : caption}
      accessibilityHint={sending ? undefined : t("Long press to delete")}
      accessibilityState={{ disabled: sending }}
      disabled={sending}
      onPress={retryable ? onRetry : undefined}
      onLongPress={showActions}
      style={{ alignSelf: "flex-end", maxWidth: "90%", marginTop: 12, gap: 4 }}
    >
      <View
        style={{
          borderRadius: 20,
          borderWidth: 1,
          borderColor: tokens.border,
          backgroundColor: tokens.secondary,
          paddingHorizontal: 14,
          paddingVertical: 12,
          gap: 8,
          opacity: 0.8,
        }}
      >
        {payload.replyPreview ? (
          <Text
            numberOfLines={3}
            style={{
              color: tokens.mutedForeground,
              fontSize: 13,
              borderLeftWidth: 2,
              borderLeftColor: tokens.border,
              paddingLeft: 8,
            }}
          >
            {payload.replyPreview}
          </Text>
        ) : null}
        {payload.displayText ? (
          <Text style={{ color: tokens.secondaryForeground, fontSize: 15.5, lineHeight: 23 }}>
            {payload.displayText}
          </Text>
        ) : null}
        {payload.attachments.map((attachment) => (
          <View key={attachment.id} style={{ gap: 4 }}>
            {attachment.previewUri ? (
              <Image
                source={{ uri: attachment.previewUri }}
                style={{ width: 180, height: 120, borderRadius: 12 }}
              />
            ) : null}
            <Text style={{ color: tokens.secondaryForeground, fontSize: 13 }}>
              {attachment.name}
            </Text>
          </View>
        ))}
      </View>
      <View
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4 }}
      >
        {!sending ? (
          <NativeSymbol
            ios="exclamationmark.circle.fill"
            android="alert-circle"
            size={13}
            color={color}
          />
        ) : null}
        <Text style={{ color, fontSize: 13 }}>{caption}</Text>
      </View>
    </Pressable>
  );
}
