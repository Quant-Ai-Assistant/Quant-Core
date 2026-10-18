import { resolveComposerSendPlan } from "@rakazo/core";
import { File } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import type { MobileBot, MobileSnapshot } from "../lib/api";
import { applyMobileThreadEvent, loadApiBase, rpc, subscribeThread } from "../lib/api";
import { loadAppearancePreference } from "../lib/appearance";
import {
  assistantReply,
  assistantScreenshot,
  closeAssistant,
  loadAssistantBotId,
  pickAssistantBot,
  saveAssistantBotId,
} from "../lib/assistant";
import { loadAvatarStyle } from "../lib/avatar-style";
import type { VoiceClip } from "../lib/hold-to-talk";
import { useHoldToTalk } from "../lib/hold-to-talk";
import { bootstrapI18n, getActiveUiLocale, useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import type { PickedAttachment } from "../lib/pick-attachments";
import { pickFromLibrary, takePhoto } from "../lib/pick-attachments";
import { loadServerAccess } from "../lib/server-access-store";
import type { SendPayload } from "../lib/thread-feedback";
import { deliverSend } from "../lib/thread-feedback";
import { errorText } from "../lib/user-error";
import { AvatarStyleProvider } from "./avatar-style";
import { BotAvatar } from "./bot-avatar";
import { MenuPickerMenu } from "./menu-picker";
import { NativeSymbol } from "./native-symbol";

const ACTIVE_RUN = new Set(["queued", "leased", "running", "waiting_input"]);

function newNonce(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The Android assistant's own React root: the translucent activity Android opens on a long
 * press of the power button renders this, not the app's router, so it loads what it needs.
 */
export function AssistantRoot() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void Promise.all([
      loadServerAccess().then(() => loadApiBase()),
      loadAppearancePreference(),
      loadAvatarStyle(),
      bootstrapI18n(),
    ])
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {ready ? (
        <AvatarStyleProvider>
          <AssistantSheet />
        </AvatarStyleProvider>
      ) : null}
    </GestureHandlerRootView>
  );
}

function AssistantSheet() {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const [bots, setBots] = useState<MobileBot[] | null>(null);
  const [bot, setBot] = useState<MobileBot | null>(null);
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PickedAttachment[]>([]);
  const [sentNonce, setSentNonce] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subscription = useRef<AbortController | null>(null);

  useEffect(() => {
    void Promise.all([rpc<MobileBot[]>("bots/list"), loadAssistantBotId()])
      .then(([list, savedId]) => {
        setBots(list);
        setBot(pickAssistantBot(list, savedId));
      })
      .catch((err: unknown) => setError(errorText(err, t("Could not reach Quant"))));
  }, [t]);

  // Follow the bot's chat from now on, so its answer shows in the sheet as it arrives.
  useEffect(() => {
    if (!bot) return;
    const controller = new AbortController();
    subscription.current?.abort();
    subscription.current = controller;
    setSnapshot(null);
    setSentNonce(null);
    void rpc<MobileSnapshot>("threads/get", { botId: bot.id })
      .then(async (initial) => {
        if (controller.signal.aborted) return;
        setSnapshot(initial);
        let cursor = initial.cursor ?? 0;
        while (!controller.signal.aborted) {
          await subscribeThread(
            { botId: bot.id },
            cursor,
            (event) => {
              cursor = Math.max(cursor, event.seq ?? cursor);
              setSnapshot((prev) => applyMobileThreadEvent(prev, event));
            },
            controller.signal,
          ).catch(() => new Promise((resolve) => setTimeout(resolve, 2_000)));
        }
      })
      .catch((err: unknown) => setError(errorText(err, t("Could not reach Quant"))));
    return () => controller.abort();
  }, [bot, t]);

  const send = useCallback(
    async (input: {
      text: string;
      attachments: PickedAttachment[];
      voice?: SendPayload["voice"];
    }) => {
      if (!bot || sending) return;
      const plan = resolveComposerSendPlan({
        text: input.text,
        mentions: [],
        hasAttachments: input.attachments.length > 0,
      });
      if (!plan.shouldSend) return;
      const clientNonce = newNonce();
      setSending(true);
      setError(null);
      try {
        await deliverSend(
          {
            originThreadKey: bot.id,
            displayText: input.text,
            replyPreview: null,
            initialBotTarget: bot.id,
            botTarget: bot.id,
            reroutedToGroup: false,
            plan,
            attachments: input.attachments,
            replyQuote: null,
            voice: input.voice,
          },
          { clientNonce, artifactIds: new Map() },
          rpc,
        );
        setSentNonce(clientNonce);
        setText("");
        setAttachments([]);
      } catch (err) {
        setError(errorText(err, t("Failed to send message")));
      } finally {
        setSending(false);
      }
    },
    [bot, sending, t],
  );

  const sendVoice = useCallback(
    async (clip: VoiceClip) => {
      const file = new File(clip.uri);
      const contentBase64 = await file.base64();
      const attachment: PickedAttachment = {
        id: `voice-${Date.now()}`,
        name: "voice.m4a",
        mimeType: "audio/mp4",
        contentBase64,
      };
      await send({
        text: "",
        attachments: [...attachments, attachment],
        voice: {
          attachmentId: attachment.id,
          durationMs: Math.round(clip.durationMs),
          waveform: clip.waveform,
          language: getActiveUiLocale().split("-")[0],
        },
      });
    },
    [attachments, send],
  );

  const talk = useHoldToTalk({ disabled: !bot || sending, onClip: (clip) => void sendVoice(clip) });
  const gesture = Gesture.Pan()
    .minDistance(0)
    .onBegin(() => talk.press())
    .onUpdate((event) => talk.move(-event.translationY, -event.translationX))
    .onFinalize(() => talk.release())
    .runOnJS(true);

  async function attachScreen() {
    const uri = await assistantScreenshot();
    if (!uri) {
      setError(t("Android did not share the screen"));
      return;
    }
    const contentBase64 = await new File(uri).base64();
    setAttachments((prev) => [
      ...prev,
      { id: `screen-${Date.now()}`, name: "screen.jpg", mimeType: "image/jpeg", contentBase64 },
    ]);
  }

  async function attach(pick: typeof takePhoto) {
    const { attachments: picked } = await pick(attachments.length);
    if (picked.length) setAttachments((prev) => [...prev, ...picked]);
  }

  function openChat() {
    if (!bot) return;
    void Linking.openURL(
      `rakazo://thread?botId=${encodeURIComponent(bot.id)}&name=${encodeURIComponent(bot.name)}`,
    );
    void closeAssistant();
  }

  function chooseBot(id: string) {
    const next = bots?.find((entry) => entry.id === id);
    if (!next) return;
    void saveAssistantBotId(next.id);
    setBot(next);
  }

  const reply = assistantReply(snapshot?.messages ?? [], sentNonce);
  const thinking = Boolean(sentNonce) && !reply && ACTIVE_RUN.has(snapshot?.run?.status ?? "");
  const status = talk.recording
    ? t("Listening…")
    : sending || thinking
      ? t("Thinking…")
      : (error ?? (reply ? "" : (bot?.title ?? "")));

  const chip = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: tokens.border,
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: "flex-end" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Close")}
        onPress={() => void closeAssistant()}
        style={{ flex: 1 }}
      />
      <View
        style={{
          backgroundColor: tokens.background,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          paddingHorizontal: 16,
          paddingTop: 10,
          paddingBottom: 24,
          gap: 12,
        }}
      >
        <View
          style={{
            alignSelf: "center",
            width: 36,
            height: 4,
            borderRadius: 2,
            backgroundColor: tokens.border,
          }}
        />
        {bot ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <BotAvatar identity={bot.id} color={bot.color} size={32} />
            <MenuPickerMenu
              label={t("Assistant")}
              choices={(bots ?? [])
                .filter((entry) => !entry.archivedAt)
                .map((entry) => ({
                  key: entry.id,
                  label: entry.name,
                }))}
              value={bot.id}
              onChange={chooseBot}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <Text style={{ color: tokens.foreground, fontSize: 15, fontWeight: "500" }}>
                  {bot.name}
                </Text>
                <NativeSymbol ios="chevron.down" android="chevron-down" size={13} />
              </View>
            </MenuPickerMenu>
            <View style={{ flex: 1 }} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Open chat")}
              hitSlop={8}
              onPress={openChat}
            >
              <NativeSymbol
                ios="arrow.up.left.and.arrow.down.right"
                android="expand"
                size={18}
                color={tokens.mutedForeground}
              />
            </Pressable>
          </View>
        ) : bots ? (
          <Pressable accessibilityRole="button" onPress={() => void Linking.openURL("rakazo://")}>
            <Text style={{ color: tokens.foreground, fontSize: 15 }}>{t("Open Quant")}</Text>
          </Pressable>
        ) : error ? null : (
          <ActivityIndicator color={tokens.mutedForeground} />
        )}
        {status ? (
          <Text
            style={{ color: error ? tokens.destructive : tokens.mutedForeground, fontSize: 13 }}
          >
            {status}
          </Text>
        ) : null}
        {reply ? (
          <ScrollView style={{ maxHeight: 280 }}>
            <Text selectable style={{ color: tokens.foreground, fontSize: 15, lineHeight: 21 }}>
              {reply}
            </Text>
          </ScrollView>
        ) : null}
        {attachments.length ? (
          <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>
            {attachments.map((attachment) => attachment.name).join(", ")}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Pressable accessibilityRole="button" onPress={() => void attachScreen()} style={chip}>
            <NativeSymbol ios="iphone" android="phone-portrait-outline" size={15} />
            <Text style={{ color: tokens.foreground, fontSize: 13 }}>{t("About the screen")}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => void attach(takePhoto)} style={chip}>
            <NativeSymbol ios="camera" android="camera-outline" size={15} />
            <Text style={{ color: tokens.foreground, fontSize: 13 }}>{t("Camera")}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => void attach(pickFromLibrary)}
            style={chip}
          >
            <NativeSymbol ios="photo" android="image-outline" size={15} />
            <Text style={{ color: tokens.foreground, fontSize: 13 }}>{t("Photo")}</Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <TextInput
            accessibilityLabel={t("Ask anything")}
            placeholder={t("Ask anything")}
            placeholderTextColor={tokens.mutedForeground}
            value={text}
            onChangeText={setText}
            onSubmitEditing={() => void send({ text, attachments })}
            returnKeyType="send"
            style={{
              flex: 1,
              height: 44,
              borderRadius: 22,
              paddingHorizontal: 16,
              backgroundColor: tokens.muted,
              color: tokens.foreground,
              fontSize: 15,
            }}
          />
          {text.trim() || attachments.length ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Send")}
              disabled={sending}
              onPress={() => void send({ text, attachments })}
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: tokens.primary,
              }}
            >
              <NativeSymbol
                ios="arrow.up"
                android="arrow-up"
                size={18}
                color={tokens.primaryForeground}
              />
            </Pressable>
          ) : (
            <GestureDetector gesture={gesture}>
              <View
                accessible
                accessibilityRole="button"
                accessibilityLabel={t("Record voice message")}
                accessibilityHint={t("Hold to record, release to send")}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: talk.recording ? tokens.destructive : tokens.primary,
                  transform: [{ scale: talk.recording ? 1.15 : 1 }],
                }}
              >
                <NativeSymbol
                  ios="mic.fill"
                  android="mic"
                  size={18}
                  color={talk.recording ? tokens.destructiveForeground : tokens.primaryForeground}
                />
              </View>
            </GestureDetector>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
