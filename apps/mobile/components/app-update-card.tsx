import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { AppUpdate } from "../lib/app-update";
import { checkForAppUpdate, installAppUpdate, installedVersionName } from "../lib/app-update";
import { deviceLog } from "../lib/device-log";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { checkForOtaUpdate, installOtaUpdate } from "../lib/ota-update";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { NativeSymbol } from "./native-symbol";

type Available = Extract<AppUpdate, { available: true }>;

export type UpdateCardState =
  | { phase: "checking" }
  | { phase: "available"; update: Available }
  /** Fixes from main that install over the air, with no new APK. */
  | { phase: "fixes" }
  | { phase: "downloading"; update: Available; received: number; total: number | null }
  | { phase: "installing" }
  | { phase: "current"; checkedAt: number }
  | { phase: "error"; message: string };

/** `v0.1.21` reads as `0.1.21`. */
export function versionFromTag(tag: string): string {
  return tag.replace(/^v/, "");
}

/** Within a minute a check reads "just now"; later, the time it ran. */
export function checkedLabel(
  checkedAt: number,
  now: number,
  t: (text: string, values?: Record<string, string>) => string,
  locale: string,
): string {
  if (now - checkedAt < 60_000) return t("checked just now");
  const time = new Date(checkedAt).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return t("checked at {time}", { time });
}

/**
 * The Android update card: it checks by itself when settings open, says which version is
 * installed and which is out, and shows the download as it happens.
 */
export function AppUpdateCard() {
  const tokens = useMobileTokens();
  const { t, locale } = useI18n();
  const [state, setState] = useState<UpdateCardState>({ phase: "checking" });
  const download = useRef<AbortController | null>(null);
  const installed = installedVersionName();
  const megabytes = new Intl.NumberFormat(dateLocaleForUi(locale), {
    style: "unit",
    unit: "megabyte",
    maximumFractionDigits: 0,
  });
  const mb = (bytes: number) => megabytes.format(bytes / 1_000_000);

  const check = useCallback(async () => {
    setState({ phase: "checking" });
    try {
      const release = await checkForAppUpdate();
      deviceLog("info", "app-update", "Checked for a new version", release);
      if (release.available) {
        setState({ phase: "available", update: release });
        return;
      }
      setState(
        (await checkForOtaUpdate())
          ? { phase: "fixes" }
          : { phase: "current", checkedAt: Date.now() },
      );
    } catch (error) {
      deviceLog("error", "app-update", "Update check failed", error);
      setState({ phase: "error", message: errorText(error, t("Check your connection")) });
    }
  }, [t]);

  useEffect(() => {
    void check();
    return () => download.current?.abort();
  }, [check]);

  async function install(update: Available) {
    const controller = new AbortController();
    download.current = controller;
    setState({ phase: "downloading", update, received: 0, total: update.size });
    try {
      await installAppUpdate(update, {
        signal: controller.signal,
        onProgress: (received, total) =>
          setState({ phase: "downloading", update, received, total }),
      });
      setState({ phase: "available", update });
    } catch (error) {
      deviceLog(
        controller.signal.aborted ? "info" : "error",
        "app-update",
        "Download stopped",
        error,
      );
      if (controller.signal.aborted) setState({ phase: "available", update });
      else
        setState({ phase: "error", message: errorText(error, t("Could not download the update")) });
    } finally {
      download.current = null;
    }
  }

  async function installFixes() {
    setState({ phase: "installing" });
    try {
      await installOtaUpdate();
    } catch (error) {
      setState({ phase: "error", message: errorText(error, t("Could not download the update")) });
    }
  }

  const fresh =
    state.phase === "available" || state.phase === "downloading" || state.phase === "fixes";
  const icon =
    state.phase === "error"
      ? ({ ios: "wifi.slash", android: "cloud-offline-outline" } as const)
      : state.phase === "current"
        ? ({ ios: "checkmark", android: "checkmark" } as const)
        : ({ ios: "arrow.down", android: "arrow-down" } as const);
  let title: string;
  let subtitle: string | null = null;
  switch (state.phase) {
    case "checking":
      title = t("Checking for updates…");
      subtitle = installed;
      break;
    case "available":
      title = t("Version {version} is out", { version: versionFromTag(state.update.tag) });
      subtitle = [installed ? t("You have {version}", { version: installed }) : null]
        .concat(state.update.size ? [mb(state.update.size)] : [])
        .filter(Boolean)
        .join(" · ");
      break;
    case "fixes":
      title = t("Fixes are ready");
      subtitle = installed;
      break;
    case "downloading":
      title = t("Downloading {version}", { version: versionFromTag(state.update.tag) });
      subtitle =
        state.total !== null
          ? t("{received} of {total}", { received: mb(state.received), total: mb(state.total) })
          : mb(state.received);
      break;
    case "installing":
      title = t("Installing the fixes…");
      break;
    case "current":
      title = t("Latest version");
      subtitle = [installed, checkedLabel(state.checkedAt, Date.now(), t, dateLocaleForUi(locale))]
        .filter(Boolean)
        .join(" · ");
      break;
    case "error":
      title = t("Could not check for updates");
      subtitle = state.message;
      break;
  }

  return (
    <View
      testID="app-update-card"
      style={{
        alignSelf: "stretch",
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 14,
        borderRadius: 16,
        backgroundColor: tokens.card,
        borderColor: tokens.border,
        borderWidth: 1,
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: fresh ? tokens.primary : tokens.muted,
        }}
      >
        <NativeSymbol
          ios={icon.ios}
          android={icon.android}
          size={19}
          color={fresh ? tokens.primaryForeground : tokens.mutedForeground}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0 }} accessible accessibilityRole="summary">
        <Text style={{ color: tokens.foreground, fontSize: 15.5, fontWeight: "600" }}>{title}</Text>
        {subtitle ? (
          <Text
            numberOfLines={2}
            style={{ color: tokens.mutedForeground, fontSize: 13, marginTop: 2 }}
          >
            {subtitle}
          </Text>
        ) : null}
        {state.phase === "downloading" ? (
          <View
            accessibilityRole="progressbar"
            accessibilityValue={
              state.total ? { min: 0, max: state.total, now: state.received } : undefined
            }
            style={{
              height: 4,
              borderRadius: 2,
              marginTop: 8,
              overflow: "hidden",
              backgroundColor: tokens.muted,
            }}
          >
            <View
              style={{
                height: 4,
                width: `${state.total ? Math.min(100, (state.received / state.total) * 100) : 0}%`,
                backgroundColor: tokens.primary,
              }}
            />
          </View>
        ) : null}
      </View>
      {state.phase === "available" ? (
        <NativeActionButton
          size="compact"
          label={t("Update")}
          onPress={() => void install(state.update)}
        />
      ) : state.phase === "fixes" ? (
        <NativeActionButton
          size="compact"
          label={t("Install")}
          onPress={() => void installFixes()}
        />
      ) : state.phase === "downloading" ? (
        <NativeActionButton
          size="compact"
          prominence="secondary"
          label={t("Cancel")}
          onPress={() => download.current?.abort()}
        />
      ) : state.phase === "current" ? (
        <NativeActionButton
          size="compact"
          prominence="secondary"
          label={t("Check")}
          onPress={() => void check()}
        />
      ) : state.phase === "error" ? (
        <NativeActionButton
          size="compact"
          prominence="secondary"
          label={t("Retry")}
          onPress={() => void check()}
        />
      ) : null}
    </View>
  );
}
