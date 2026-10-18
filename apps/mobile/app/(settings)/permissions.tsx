import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSymbol } from "../../components/native-symbol";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import type { PermissionKey, PermissionState } from "../../lib/app-permissions";
import { loadPermissions, nextToRequest, permissionProbes } from "../../lib/app-permissions";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { native, useMobileTokens, useThemedStyles } from "../../lib/native";

/** What Quant may use on this phone, with a way to allow each missing one, or all at once. */
export default function PermissionsScreen() {
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const probes = useMemo(() => permissionProbes(Platform.OS), []);
  const [states, setStates] = useState<PermissionState[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Set while "Allow all" walks the list; system settings pages return through AppState.
  const allowAll = useRef<Set<PermissionKey> | null>(null);

  const copy: Record<PermissionKey, { title: string; detail: string }> = {
    notifications: { title: t("Notifications"), detail: t("Replies, calls and reminders") },
    lockScreen: { title: t("Over the lock screen"), detail: t("Reminder alarms and calls") },
    background: { title: t("Background work"), detail: t("No battery restrictions") },
    microphone: { title: t("Microphone"), detail: t("Voice messages and calls") },
    camera: { title: t("Camera"), detail: t("Photos in chat") },
    photos: { title: t("Photos and videos"), detail: t("Attachments from your gallery") },
    updates: { title: t("Install updates"), detail: t("Update Quant from the app") },
    assistant: {
      title: t("Default assistant"),
      detail: t("Hold the power button to ask Quant"),
    },
  };

  const refresh = useCallback(async () => {
    const next = await loadPermissions(probes);
    setStates(next);
    return next;
  }, [probes]);

  const continueAllowAll = useCallback(
    async (current: PermissionState[]) => {
      const asked = allowAll.current;
      if (!asked) return;
      const key = nextToRequest(current, asked);
      const probe = probes.find((entry) => entry.key === key);
      if (!probe) {
        allowAll.current = null;
        setBusy(false);
        return;
      }
      asked.add(probe.key);
      await probe.request().catch(() => undefined);
      // A settings page continues when the app comes back to the foreground.
      if (!probe.opensSettings) await continueAllowAll(await refresh());
    },
    [probes, refresh],
  );

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void refresh().then((next) => continueAllowAll(next));
    });
    return () => subscription.remove();
  }, [refresh, continueAllowAll]);

  async function request(key: PermissionKey) {
    await probes
      .find((probe) => probe.key === key)
      ?.request()
      .catch(() => undefined);
    await refresh();
  }

  function startAllowAll() {
    if (!states) return;
    setBusy(true);
    allowAll.current = new Set();
    void continueAllowAll(states);
  }

  const granted = states?.filter((state) => state.granted).length ?? 0;
  const total = states?.length ?? 0;

  function rows(required: boolean) {
    return (states ?? [])
      .filter((state) => state.required === required)
      .map((state) => (
        <SettingsRow
          key={state.key}
          title={copy[state.key].title}
          detail={copy[state.key].detail}
          trailing={
            state.granted ? (
              <View style={styles.allowed} accessibilityLabel={t("Allowed")}>
                <NativeSymbol
                  ios="checkmark"
                  android="checkmark"
                  size={15}
                  color={tokens.success}
                />
                <Text style={styles.allowedText}>{t("Allowed")}</Text>
              </View>
            ) : (
              <NativeActionButton
                accessibilityLabel={`${t("Allow")}: ${copy[state.key].title}`}
                label={t("Allow")}
                onPress={() => void request(state.key)}
                prominence="secondary"
                size="compact"
              />
            )
          }
        />
      ));
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        {states ? (
          <View style={styles.summary}>
            <View style={styles.summaryText}>
              <Text style={styles.count}>
                {t("{granted} of {total} allowed", { granted, total })}
              </Text>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${total ? (granted / total) * 100 : 0}%` }]} />
              </View>
            </View>
            {granted < total ? (
              <NativeActionButton
                busy={busy}
                label={t("Allow all")}
                onPress={startAllowAll}
                size="compact"
              />
            ) : null}
          </View>
        ) : null}
        <SettingsGroup label={t("Needed to work")}>{rows(true)}</SettingsGroup>
        <SettingsGroup label={t("Optional")}>{rows(false)}</SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { padding: 16, gap: 8 },
    summary: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderRadius: 16,
      backgroundColor: native.fill,
      paddingHorizontal: 16,
      paddingVertical: 14,
      marginBottom: 8,
    },
    summaryText: { flex: 1, gap: 8 },
    count: { color: native.label, fontSize: 15 },
    track: { height: 4, borderRadius: 2, backgroundColor: tokens.border },
    fill: { height: 4, borderRadius: 2, backgroundColor: tokens.foreground },
    allowed: { flexDirection: "row", alignItems: "center", gap: 4 },
    allowedText: { color: tokens.success, fontSize: 13 },
  });
}
