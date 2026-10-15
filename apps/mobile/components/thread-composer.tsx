import type { MenuAction } from "@expo/ui/community/menu";
import { MenuView } from "@expo/ui/community/menu";
import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type { buildComposerMentionOptions, ComposerMention, SlashActionId } from "@rakazo/core";
import {
  mentionChipKey,
  SLASH_ACTIONS,
  serializeComposerPrompt,
  truncateSlashDescription,
} from "@rakazo/core";
import type { Ref } from "react";
import { useEffect, useImperativeHandle, useMemo, useState } from "react";
import type { ViewStyle } from "react-native";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { HoldToTalk } from "../lib/hold-to-talk";
import { useHoldToTalk } from "../lib/hold-to-talk";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import type { ComposerSnapshot } from "../lib/thread-feedback";
import { GlassSurface } from "./glass-surface";
import { NativeSymbol } from "./native-symbol";

export type ThreadComposerHandle = {
  snapshot: () => ComposerSnapshot;
  reset: () => void;
};

type ThreadComposerProps = {
  ref: Ref<ThreadComposerHandle>;
  agentSkills: AgentSkillCatalogEntry[];
  composerMentionTargets: ReturnType<typeof buildComposerMentionOptions>;
  composerPrompt: string;
  replyTargetId?: string;
  replyQuote: string | null;
  attachmentIds: string[];
  onCall: boolean;
  working: boolean;
  sending: boolean;
  styles: { circleButton: ViewStyle; composerFill: ViewStyle };
  attachActions: MenuAction[];
  attachFrom: (source: string) => void;
  send: () => Promise<void>;
  stop: () => Promise<void>;
  /** Hold-to-talk is available in this thread; `transcribe` sends the audio to the voice provider. */
  holdToTalk: { transcribe: boolean } | null;
  onSlashAction: (action: SlashActionId) => void;
};

export function ThreadComposer({
  ref,
  agentSkills,
  composerMentionTargets,
  composerPrompt,
  replyTargetId,
  replyQuote,
  attachmentIds,
  onCall,
  working,
  sending,
  styles,
  attachActions,
  attachFrom,
  send,
  stop,
  holdToTalk,
  onSlashAction,
}: ThreadComposerProps) {
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<ComposerMention[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  /** Dictated text landed in the draft and goes out as soon as the snapshot sees it. */
  const [sendDictated, setSendDictated] = useState(false);
  const talk = useHoldToTalk({
    transcribe: holdToTalk?.transcribe ?? false,
    disabled: !holdToTalk || onCall || sending,
    // A refused send keeps the words in the field to edit or retry.
    onText: (text) => {
      setDraft((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text));
      setSendDictated(true);
    },
  });
  useEffect(() => {
    if (!sendDictated) return;
    setSendDictated(false);
    void send();
  }, [sendDictated, send]);
  useImperativeHandle(ref, () => ({
    snapshot: () => ({
      promptText: serializeComposerPrompt(draft, selectedSkill, selectedMentions),
      mentions: selectedMentions,
      skill: selectedSkill,
      replyTargetId,
      replyQuote,
      attachmentIds,
    }),
    reset: () => {
      setDraft("");
      setMentionQuery(null);
      setSlashQuery(null);
      setSelectedSkill(null);
      setSelectedMentions([]);
    },
  }));
  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || composerMentionTargets.length === 0) return [];
    const query = mentionQuery.trim().toLowerCase();
    return composerMentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [composerMentionTargets, mentionQuery]);
  const slashQueryNormalized = slashQuery?.trim().toLowerCase() ?? null;
  const slashSkillOptions =
    slashQuery !== null && mentionQuery === null
      ? agentSkills
          .filter((skill) => {
            if (!slashQueryNormalized) return true;
            return (
              skill.name.toLowerCase().includes(slashQueryNormalized) ||
              skill.description.toLowerCase().includes(slashQueryNormalized)
            );
          })
          .slice(0, 8)
      : [];
  const slashActionOptions =
    slashQuery !== null && mentionQuery === null
      ? SLASH_ACTIONS.filter((action) => {
          if (!slashQueryNormalized) return true;
          const label = t(action.label);
          return (
            action.label.toLowerCase().includes(slashQueryNormalized) ||
            label.toLowerCase().includes(slashQueryNormalized)
          );
        })
      : [];
  function updateDraft(value: string) {
    setDraft(value);
    const match = /(?:^|\s)@([\w-]*)$/.exec(value);
    setMentionQuery(match ? (match[1] ?? "") : null);
    const slashMatch = selectedSkill === null ? /^\/([^\n]*)$/.exec(value) : null;
    setSlashQuery(slashMatch ? (slashMatch[1] ?? "") : null);
  }

  function insertMention(mention: ComposerMention) {
    setDraft((current) => current.replace(/@([\w-]*)$/, ""));
    setMentionQuery(null);
    setSelectedMentions((current) =>
      current.some((selected) => mentionChipKey(selected) === mentionChipKey(mention))
        ? current
        : [...current, mention],
    );
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    setSelectedSkill(skill);
    setDraft("");
    setSlashQuery(null);
  }

  function removeLastChip() {
    if (selectedMentions.length > 0) {
      setSelectedMentions((current) => current.slice(0, -1));
      return;
    }
    if (selectedSkill) setSelectedSkill(null);
  }

  function runSlashAction(action: SlashActionId) {
    setDraft("");
    setSlashQuery(null);
    onSlashAction(action);
  }

  const composerPillStyle = {
    width: 36,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  } as const;

  const canSend =
    Boolean(draft.trim()) ||
    selectedSkill !== null ||
    selectedMentions.length > 0 ||
    attachmentIds.length > 0;

  return (
    <>
      {mentionOptions.length ? (
        <ScrollView
          testID="mention-picker"
          keyboardShouldPersistTaps="handled"
          style={{
            flexGrow: 0,
            flexShrink: 1,
            marginTop: 12,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: tokens.border,
            backgroundColor: tokens.card,
            overflow: "hidden",
          }}
        >
          {mentionOptions.map((mention) => (
            <Pressable
              key={mentionChipKey(mention)}
              accessibilityLabel={t("@{name}", { name: mention.name })}
              onPress={() => insertMention(mention)}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 10,
                paddingHorizontal: 14,
                paddingVertical: 10,
              }}
            >
              <MentionOptionIcon mention={mention} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: tokens.foreground, fontSize: 14 }}>@{mention.name}</Text>
                {mention.subtitle ? (
                  <Text
                    numberOfLines={1}
                    style={{
                      color: tokens.mutedForeground,
                      fontSize: 12.5,
                      marginTop: 2,
                    }}
                  >
                    {mention.subtitle}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {slashSkillOptions.length || slashActionOptions.length ? (
        <ScrollView
          testID="slash-picker"
          keyboardShouldPersistTaps="handled"
          style={{
            flexGrow: 0,
            flexShrink: 1,
            marginTop: 12,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: tokens.border,
            backgroundColor: tokens.card,
            overflow: "hidden",
          }}
        >
          {slashSkillOptions.map((skill) => (
            <Pressable
              key={skill.id}
              accessibilityLabel={t("Skill {name}", { name: skill.name })}
              onPress={() => insertSkill(skill)}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 10,
                paddingHorizontal: 14,
                paddingVertical: 10,
              }}
            >
              <NativeSymbol
                ios="cube"
                android="cube-outline"
                size={16}
                color={tokens.mutedForeground}
              />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: tokens.foreground, fontSize: 14 }}>{skill.name}</Text>
                <Text
                  numberOfLines={1}
                  style={{ color: tokens.mutedForeground, fontSize: 12.5, marginTop: 2 }}
                >
                  {truncateSlashDescription(skill.description)}
                </Text>
              </View>
            </Pressable>
          ))}
          {slashActionOptions.map((action) => (
            <Pressable
              key={action.id}
              accessibilityLabel={t(action.label)}
              onPress={() => runSlashAction(action.id)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingHorizontal: 14,
                paddingVertical: 10,
              }}
            >
              <NativeSymbol
                ios="gearshape"
                android="settings-outline"
                size={16}
                color={tokens.mutedForeground}
              />
              <Text style={{ color: tokens.foreground, fontSize: 14 }}>{t(action.label)}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10, marginTop: 8 }}>
        <MenuView
          actions={attachActions}
          colorScheme={colorScheme}
          onPressAction={(event) => attachFrom(event.nativeEvent.event)}
        >
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={t("Attach file")}
            style={{ width: 44, height: 44 }}
          >
            <GlassSurface
              shape="circle"
              style={styles.circleButton}
              fallbackStyle={styles.composerFill}
            >
              <NativeSymbol ios="plus" android="add" size={18} color={tokens.mutedForeground} />
            </GlassSurface>
          </View>
        </MenuView>
        <GlassSurface
          shape="roundedRectangle"
          style={{
            flex: 1,
            minHeight: 44,
            borderRadius: 22,
            flexDirection: "row",
            alignItems: "flex-end",
            paddingStart: 16,
            paddingEnd: 4,
          }}
          fallbackStyle={styles.composerFill}
        >
          {talk.recording ? <HoldToTalkStrip talk={talk} /> : null}
          <View
            style={{
              display: talk.recording ? "none" : "flex",
              flex: 1,
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 6,
            }}
          >
            {selectedSkill ? (
              <View
                testID="skill-chip"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  backgroundColor: tokens.muted,
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  maxWidth: "100%",
                }}
              >
                <NativeSymbol
                  ios="cube"
                  android="cube-outline"
                  size={13}
                  color={tokens.mutedForeground}
                />
                <Text
                  numberOfLines={1}
                  style={{ color: tokens.foreground, fontSize: 13, flexShrink: 1 }}
                >
                  {selectedSkill.name}
                </Text>
                <Pressable
                  accessibilityLabel={t("Remove skill {name}", { name: selectedSkill.name })}
                  hitSlop={8}
                  onPress={() => setSelectedSkill(null)}
                >
                  <NativeSymbol
                    ios="xmark"
                    android="close"
                    size={12}
                    color={tokens.mutedForeground}
                  />
                </Pressable>
              </View>
            ) : null}
            {selectedMentions.map((mention) => (
              <View
                key={mentionChipKey(mention)}
                testID="mention-chip"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  backgroundColor: tokens.muted,
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  maxWidth: "100%",
                }}
              >
                <MentionChipIcon mention={mention} />
                <Text
                  numberOfLines={1}
                  style={{ color: tokens.foreground, fontSize: 13, flexShrink: 1 }}
                >
                  {mention.name}
                </Text>
                <Pressable
                  accessibilityLabel={t("Remove mention {name}", { name: mention.name })}
                  hitSlop={8}
                  onPress={() =>
                    setSelectedMentions((current) =>
                      current.filter(
                        (selected) => mentionChipKey(selected) !== mentionChipKey(mention),
                      ),
                    )
                  }
                >
                  <NativeSymbol
                    ios="xmark"
                    android="close"
                    size={12}
                    color={tokens.mutedForeground}
                  />
                </Pressable>
              </View>
            ))}
            <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 96 }}>
              {!draft && !selectedSkill && !selectedMentions.length ? (
                <Text
                  numberOfLines={1}
                  importantForAccessibility="no"
                  accessibilityElementsHidden
                  accessible={false}
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    top: 11,
                    start: 0,
                    end: 0,
                    fontSize: 17,
                    lineHeight: 22,
                    color: tokens.mutedForeground,
                  }}
                >
                  {composerPrompt}
                </Text>
              ) : null}
              <TextInput
                value={draft}
                onChangeText={updateDraft}
                accessibilityLabel={composerPrompt}
                onKeyPress={(event) => {
                  if (
                    event.nativeEvent.key === "Backspace" &&
                    draft.length === 0 &&
                    (selectedSkill !== null || selectedMentions.length > 0)
                  ) {
                    removeLastChip();
                  }
                }}
                keyboardAppearance={colorScheme}
                multiline
                textAlignVertical="top"
                blurOnSubmit={false}
                style={{
                  color: tokens.foreground,
                  fontSize: 17,
                  lineHeight: 22,
                  paddingTop: 11,
                  paddingBottom: 11,
                  maxHeight: 132,
                  writingDirection: "auto",
                }}
              />
            </View>
          </View>
          {talk.recording?.locked ? (
            <HoldToTalkLockedActions talk={talk} pillStyle={composerPillStyle} />
          ) : !canSend && holdToTalk && !onCall ? (
            <HoldToTalkButton talk={talk} pillStyle={composerPillStyle} />
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Send")}
              disabled={sending || !canSend}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
              onPress={() => void send()}
              style={{ marginBottom: 8, opacity: sending || !canSend ? 0.5 : 1 }}
            >
              <GlassSurface
                tint={tokens.primary}
                style={composerPillStyle}
                fallbackStyle={{ backgroundColor: tokens.primary }}
              >
                <NativeSymbol
                  ios="arrow.up"
                  android="arrow-up"
                  size={15}
                  color={tokens.primaryForeground}
                />
              </GlassSurface>
            </Pressable>
          )}
        </GlassSurface>
        {working ? (
          <Pressable
            accessibilityLabel={t("Stop")}
            disabled={sending}
            onPress={() => void stop()}
            style={{ width: 44, height: 44, opacity: sending ? 0.5 : 1 }}
          >
            <GlassSurface
              shape="circle"
              style={styles.circleButton}
              fallbackStyle={{ borderColor: tokens.border, borderWidth: 1 }}
            >
              <NativeSymbol ios="stop.fill" android="stop" size={15} color={tokens.foreground} />
            </GlassSurface>
          </Pressable>
        ) : null}
      </View>
    </>
  );
}

function MentionOptionIcon({ mention }: { mention: ComposerMention }) {
  const tokens = useMobileTokens();
  if (mention.kind === "routine") {
    return (
      <NativeSymbol ios="clock" android="time-outline" size={16} color={tokens.mutedForeground} />
    );
  }
  if (mention.kind === "connector") {
    return (
      <NativeSymbol
        ios="puzzlepiece.extension"
        android="extension-puzzle-outline"
        size={16}
        color={tokens.mutedForeground}
      />
    );
  }
  if (mention.kind === "group") {
    return (
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 9 }}>G</Text>
      </View>
    );
  }
  if (mention.kind === "everyone") {
    return (
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 8,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 9 }}>@</Text>
      </View>
    );
  }
  return (
    <View
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        backgroundColor: mention.color ?? tokens.mutedForeground,
      }}
    />
  );
}

function MentionChipIcon({ mention }: { mention: ComposerMention }) {
  const tokens = useMobileTokens();
  if (mention.kind === "routine") {
    return (
      <NativeSymbol ios="clock" android="time-outline" size={13} color={tokens.mutedForeground} />
    );
  }
  if (mention.kind === "connector") {
    return (
      <NativeSymbol
        ios="puzzlepiece.extension"
        android="extension-puzzle-outline"
        size={13}
        color={tokens.mutedForeground}
      />
    );
  }
  if (mention.kind === "group" || mention.kind === "everyone") {
    return (
      <View
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: tokens.muted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 9 }}>
          {mention.kind === "group" ? "G" : "@"}
        </Text>
      </View>
    );
  }
  return (
    <View
      style={{
        width: 14,
        height: 14,
        borderRadius: 4,
        backgroundColor: mention.color ?? tokens.mutedForeground,
      }}
    />
  );
}

type PillStyle = ViewStyle;

function useSeconds(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** Takes the text field's place while recording: a live dot, the time, and what was heard. */
function HoldToTalkStrip({ talk }: { talk: HoldToTalk }) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const seconds = useSeconds(talk.recording?.startedAt ?? Date.now());
  const hint = talk.transcribing
    ? t("Transcribing…")
    : talk.recording?.locked
      ? t("Listening…")
      : t("Slide up to lock");
  return (
    <View
      testID="hold-to-talk-strip"
      style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tokens.destructive }} />
      <Text style={{ color: tokens.foreground, fontSize: 15, fontVariant: ["tabular-nums"] }}>
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      </Text>
      <Text
        numberOfLines={1}
        accessibilityLiveRegion="polite"
        style={{
          flex: 1,
          fontSize: 15,
          color: talk.transcript ? tokens.foreground : tokens.mutedForeground,
        }}
      >
        {talk.transcript || hint}
      </Text>
    </View>
  );
}

/** The microphone: hold to talk, slide up to lock. A tap only explains the gesture. */
function HoldToTalkButton({ talk, pillStyle }: { talk: HoldToTalk; pillStyle: PillStyle }) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .minDistance(0)
        .shouldCancelWhenOutside(false)
        .onBegin(() => talk.press())
        .onUpdate((event) => talk.move(-event.translationY))
        .onFinalize(() => talk.release()),
    [talk.press, talk.move, talk.release],
  );
  const recording = talk.recording !== null;
  return (
    <View style={{ marginBottom: 8 }}>
      {recording ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            bottom: 44,
            start: 4,
            alignItems: "center",
            gap: 2,
            paddingVertical: 8,
            width: 28,
            borderRadius: 14,
            backgroundColor: tokens.card,
            borderColor: tokens.border,
            borderWidth: 1,
            transform: [{ translateY: -talk.lift }],
          }}
        >
          <NativeSymbol
            ios="lock"
            android="lock-closed-outline"
            size={13}
            color={tokens.mutedForeground}
          />
          <NativeSymbol
            ios="chevron.up"
            android="chevron-up"
            size={12}
            color={tokens.mutedForeground}
          />
        </View>
      ) : null}
      {talk.notice && !recording ? (
        <View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={{
            position: "absolute",
            bottom: 40,
            end: 0,
            width: 220,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 10,
            backgroundColor: tokens.card,
            borderColor: tokens.border,
            borderWidth: 1,
          }}
        >
          <Text style={{ color: tokens.foreground, fontSize: 13 }}>{talk.notice}</Text>
        </View>
      ) : null}
      <GestureDetector gesture={gesture}>
        <View
          testID="hold-to-talk"
          accessible
          accessibilityRole="button"
          accessibilityLabel={t("Hold to talk")}
          accessibilityHint={t("Hold to talk, release to send")}
          style={{ transform: [{ scale: recording ? 1.25 : 1 }] }}
        >
          <GlassSurface
            tint={recording ? tokens.destructive : tokens.primary}
            style={pillStyle}
            fallbackStyle={{ backgroundColor: recording ? tokens.destructive : tokens.primary }}
          >
            <NativeSymbol
              ios="mic.fill"
              android="mic"
              size={15}
              color={recording ? tokens.destructiveForeground : tokens.primaryForeground}
            />
          </GlassSurface>
        </View>
      </GestureDetector>
    </View>
  );
}

/** A locked recording: discard it, or send what was said. */
function HoldToTalkLockedActions({ talk, pillStyle }: { talk: HoldToTalk; pillStyle: PillStyle }) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  return (
    <View style={{ flexDirection: "row", gap: 6, marginBottom: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Discard recording")}
        hitSlop={6}
        onPress={talk.cancel}
      >
        <View style={pillStyle}>
          <NativeSymbol
            ios="trash"
            android="trash-outline"
            size={15}
            color={tokens.mutedForeground}
          />
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Send recording")}
        disabled={talk.transcribing}
        hitSlop={6}
        onPress={talk.submit}
        style={{ opacity: talk.transcribing ? 0.5 : 1 }}
      >
        <GlassSurface
          tint={tokens.primary}
          style={pillStyle}
          fallbackStyle={{ backgroundColor: tokens.primary }}
        >
          <NativeSymbol
            ios="arrow.up"
            android="arrow-up"
            size={15}
            color={tokens.primaryForeground}
          />
        </GlassSurface>
      </Pressable>
    </View>
  );
}
