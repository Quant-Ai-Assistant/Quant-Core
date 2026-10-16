import type { MessageBlock } from "@rakazo/contracts";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { MobileArtifactTarget } from "../lib/artifact-open";
import { imageArtifactUri } from "../lib/artifact-open";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

type VoiceBlock = Extract<MessageBlock, { kind: "voice" }>;

export function formatVoiceTime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * A voice message like Telegram's: play, a waveform across the bubble that seeks on tap, and
 * "Aa" that opens the transcript. The recording downloads on the first play.
 */
export function VoiceMessageBubble({
  target,
  block,
  transcript,
  fromUser,
}: {
  target: MobileArtifactTarget;
  block: VoiceBlock;
  transcript: string;
  fromUser: boolean;
}) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [loaded, setLoaded] = useState(false);
  const [wanted, setWanted] = useState(false);
  const [showText, setShowText] = useState(false);
  const [barsWidth, setBarsWidth] = useState(0);
  const foreground = fromUser ? tokens.primaryForeground : tokens.foreground;
  const background = fromUser ? tokens.primary : tokens.muted;

  useEffect(() => {
    if (!wanted || loaded) return;
    let cancelled = false;
    void imageArtifactUri(target, block.artifactId, block.mimeType)
      .then(async (uri) => {
        if (cancelled) return;
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
        player.replace({ uri });
        setLoaded(true);
        player.play();
      })
      .catch(() => setWanted(false));
    return () => {
      cancelled = true;
    };
  }, [wanted, loaded, target, block.artifactId, block.mimeType, player]);

  useEffect(() => {
    if (!status.didJustFinish) return;
    void player.seekTo(0);
    player.pause();
  }, [status.didJustFinish, player]);

  function toggle() {
    if (!loaded) {
      setWanted(true);
      return;
    }
    if (status.playing) player.pause();
    else player.play();
  }

  const positionMs = loaded ? status.currentTime * 1000 : 0;
  const played = block.durationMs > 0 ? positionMs / block.durationMs : 0;
  const bars = block.waveform.length ? block.waveform : [0];
  const hasText = Boolean(transcript.trim());

  return (
    <View
      testID="voice-message"
      style={{
        width: 280,
        maxWidth: "100%",
        alignSelf: fromUser ? "flex-end" : "flex-start",
        borderRadius: 20,
        paddingHorizontal: 12,
        paddingVertical: 10,
        backgroundColor: background,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={status.playing ? t("Pause voice message") : t("Play voice message")}
          onPress={toggle}
          hitSlop={6}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: foreground,
          }}
        >
          <NativeSymbol
            ios={status.playing ? "pause.fill" : "play.fill"}
            android={status.playing ? "pause" : "play"}
            size={15}
            color={background}
          />
        </Pressable>
        <Pressable
          accessible={false}
          onLayout={(event) => setBarsWidth(event.nativeEvent.layout.width)}
          onPress={(event) => {
            if (!loaded || barsWidth <= 0) return;
            const share = Math.min(1, Math.max(0, event.nativeEvent.locationX / barsWidth));
            void player.seekTo((share * block.durationMs) / 1000);
          }}
          style={{
            flex: 1,
            height: 28,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          {bars.map((level, index) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional and never reorder
              key={index}
              style={{
                width: 3,
                borderRadius: 2,
                height: Math.max(3, Math.round(level * 24)),
                backgroundColor: foreground,
                opacity: index / bars.length >= played ? 0.4 : 1,
              }}
            />
          ))}
        </Pressable>
        {hasText ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showText ? t("Hide transcript") : t("Show transcript")}
            accessibilityState={{ expanded: showText }}
            hitSlop={8}
            onPress={() => setShowText((open) => !open)}
            style={{
              borderRadius: 6,
              borderWidth: 1,
              borderColor: foreground,
              paddingHorizontal: 5,
              backgroundColor: showText ? foreground : "transparent",
            }}
          >
            <Text
              style={{ fontSize: 11, lineHeight: 18, color: showText ? background : foreground }}
            >
              Aa
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Text
        style={{
          marginTop: 4,
          fontSize: 12,
          color: foreground,
          opacity: 0.7,
          fontVariant: ["tabular-nums"],
        }}
      >
        {status.playing || positionMs > 0
          ? `${formatVoiceTime(positionMs)} / ${formatVoiceTime(block.durationMs)}`
          : formatVoiceTime(block.durationMs)}
      </Text>
      {showText && hasText ? (
        <Text
          selectable
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTopWidth: 1,
            borderTopColor: foreground,
            fontSize: 15,
            lineHeight: 21,
            color: foreground,
          }}
        >
          {transcript}
        </Text>
      ) : null}
    </View>
  );
}
