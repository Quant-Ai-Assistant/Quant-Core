import type { ClaudeCodeBlock } from "@rakazo/contracts";
import { claudeCodeStepCount } from "@rakazo/core";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { activityLabel, activityStepLabel, activitySymbol } from "../lib/activity-label";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

const LIVE_STEP_WINDOW = 3;

function duration(ms: number | undefined): string {
  if (ms === undefined) return "";
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** One Claude Code run in the chat: the step it is on, then a list that opens on tap. */
export function ClaudeCodeCard({ block }: { block: ClaudeCodeBlock }) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const live = block.status === "running";
  const count = claudeCodeStepCount(block);
  const steps = live ? block.steps.slice(-LIVE_STEP_WINDOW) : open ? block.steps : [];
  const summary = live
    ? ""
    : block.status === "failed"
      ? t("Couldn’t finish")
      : block.status === "cancelled"
        ? t("Stopped")
        : count === 1
          ? t("1 step")
          : t("{count} steps", { count: String(count) });
  const current = live ? block.current : undefined;
  const currentSymbol = current ? activitySymbol(current.kind) : null;

  return (
    <Pressable
      testID="claude-code-card"
      accessibilityRole={live ? "text" : "button"}
      accessibilityLabel={
        current ? `Claude Code: ${activityLabel(current.kind)}` : `Claude Code: ${summary}`
      }
      disabled={live}
      onPress={() => setOpen((value) => !value)}
      style={{
        width: "90%",
        borderRadius: 18,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.card,
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <View
          style={{
            width: 16,
            height: 16,
            borderRadius: 4,
            backgroundColor: tokens.foreground,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: tokens.background, fontSize: 8, fontWeight: "700" }}>CC</Text>
        </View>
        <Text style={{ color: tokens.foreground, fontSize: 13 }}>Claude Code</Text>
        {summary ? (
          <Text
            style={{
              color: block.status === "failed" ? tokens.destructive : tokens.mutedForeground,
              fontSize: 13,
              flexShrink: 1,
            }}
            numberOfLines={1}
          >
            · {summary}
            {block.durationMs !== undefined ? ` · ${duration(block.durationMs)}` : ""}
          </Text>
        ) : null}
      </View>
      {current && currentSymbol ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <NativeSymbol {...currentSymbol} size={14} color={tokens.foreground} />
          <Text
            style={{ color: tokens.foreground, fontSize: 14.5, flexShrink: 1 }}
            numberOfLines={1}
          >
            {activityLabel(current.kind)}
            {current.detail ? (
              <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}> {current.detail}</Text>
            ) : null}
          </Text>
        </View>
      ) : null}
      {steps.length > 0 ? (
        <View style={{ gap: 3, borderTopWidth: 1, borderTopColor: tokens.border, paddingTop: 8 }}>
          {steps.map((step, index) => (
            <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
              <Text style={{ color: tokens.success, fontSize: 11 }}>✓</Text>
              <Text
                style={{ color: tokens.mutedForeground, fontSize: 12.5, flexShrink: 1 }}
                numberOfLines={1}
              >
                {activityStepLabel(step.status.kind)}
                {step.status.detail ? ` ${step.status.detail}` : ""}
                {step.count > 1 ? ` ×${step.count}` : ""}
              </Text>
            </View>
          ))}
          {!live && block.error ? (
            <Text style={{ color: tokens.destructive, fontSize: 12.5 }}>{block.error}</Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}
