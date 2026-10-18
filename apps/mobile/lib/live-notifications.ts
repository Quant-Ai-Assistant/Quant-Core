import { requireNativeModule } from "expo-modules-core";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { apiBaseWarning, normalizeApiBase } from "./endpoint";
import { t } from "./i18n";
import { serverAccessHeader } from "./server-access";

export interface LiveNotificationSettings {
  liveConnection: boolean;
  messages: boolean;
  scheduledTasks: boolean;
  needsAttention: boolean;
}

export const DEFAULT_LIVE_NOTIFICATION_SETTINGS: LiveNotificationSettings = {
  liveConnection: false,
  messages: true,
  scheduledTasks: true,
  needsAttention: true,
};

type NativeNotifications = {
  getSettings(): Promise<LiveNotificationSettings>;
  setSettings(
    settings: LiveNotificationSettings,
    endpoint: string,
    token: string,
    spaceId: string,
    gateAuth: string,
  ): Promise<void>;
  resume(endpoint: string, token: string, spaceId: string, gateAuth: string): Promise<void>;
  setCalls(
    calls: boolean,
    reminders: boolean,
    endpoint: string,
    token: string,
    spaceId: string,
    gateAuth: string,
  ): Promise<void>;
  dismissCall(callId: string): Promise<void>;
  dismissReminder(reminderId: string): Promise<void>;
  canUseFullScreenIntent(): Promise<boolean>;
  openFullScreenIntentSettings(): Promise<void>;
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  requestIgnoreBatteryOptimizations(): Promise<void>;
  canRequestPackageInstalls(): Promise<boolean>;
  openInstallSettings(): Promise<void>;
  showOverLockScreen(show: boolean): Promise<void>;
  stop(clearSession: boolean): Promise<void>;
  setOpenThread(botId: string | null, threadId: string | null): Promise<void>;
  openSettings(): Promise<void>;
  canPostPromotedNotifications(): Promise<boolean>;
  openPromotedSettings(): Promise<void>;
};

const nativeNotifications =
  Platform.OS === "android"
    ? requireNativeModule<NativeNotifications>("RakazoNotifications")
    : null;

export type NotificationThreadTarget = { botId?: string; threadId?: string };

let openThread: NotificationThreadTarget | null = null;
let lastConfirmed: NotificationThreadTarget | null = null;
let hasConfirmed = false;
let pendingReports = 0;
let reportSeq = 0;
let foregroundHandlerConfigured = false;

export function notificationTargetsThread(
  data: Record<string, unknown> | null | undefined,
  target: NotificationThreadTarget | null,
): boolean {
  if (!data || !target) return false;
  const dataThreadId = data.threadId ?? data["rakazo.threadId"];
  if (target.threadId && dataThreadId) return dataThreadId === target.threadId;
  return Boolean(
    target.botId && (data.botId === target.botId || data["rakazo.botId"] === target.botId),
  );
}

export function configureForegroundNotifications(): void {
  if (foregroundHandlerConfigured) return;
  foregroundHandlerConfigured = true;
  Notifications.setNotificationHandler({
    handleNotification: async ({ request }) => {
      const show = !notificationTargetsThread(request.content.data, openThread);
      return {
        shouldShowBanner: show,
        shouldShowList: show,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    },
  });
}

export async function getLiveNotificationSettings(): Promise<LiveNotificationSettings> {
  return nativeNotifications?.getSettings() ?? DEFAULT_LIVE_NOTIFICATION_SETTINGS;
}

export async function setLiveNotificationSettings(
  settings: LiveNotificationSettings,
  endpoint: string,
  token: string,
  spaceId: string,
): Promise<void> {
  if (!nativeNotifications) return;
  const parsed = normalizeApiBase(endpoint);
  if (!parsed.ok) throw new Error(parsed.error);
  const endpointWarning = apiBaseWarning(parsed.url);
  if (endpointWarning) throw new Error(endpointWarning);
  if (settings.liveConnection) {
    const existing = await Notifications.getPermissionsAsync();
    const granted = existing.granted || (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) throw new Error(t("Android blocked notifications."));
  }
  await nativeNotifications.setSettings(
    settings,
    parsed.url,
    token,
    spaceId,
    serverAccessHeader(parsed.url) ?? "",
  );
}

export async function resumeLiveNotifications(
  endpoint: string,
  token: string,
  spaceId: string,
): Promise<void> {
  if (!nativeNotifications || !token) return;
  const parsed = normalizeApiBase(endpoint);
  if (!parsed.ok || apiBaseWarning(parsed.url)) return;
  await nativeNotifications.resume(
    parsed.url,
    token,
    spaceId,
    serverAccessHeader(parsed.url) ?? "",
  );
}

export async function stopLiveNotifications(clearSession = false): Promise<void> {
  await nativeNotifications?.stop(clearSession);
}

export async function setOpenNotificationThread(
  target: NotificationThreadTarget | null,
): Promise<void> {
  // Each native call restarts the Android poller, which re-posts live notifications.
  // The foreground handler reads openThread immediately. Native is skipped only
  // for the last target it accepted when no report is pending, so overlapping
  // changes reach native and a rejection stays eligible for retry.
  openThread = target;
  if (
    pendingReports === 0 &&
    hasConfirmed &&
    lastConfirmed?.botId === target?.botId &&
    lastConfirmed?.threadId === target?.threadId
  ) {
    return;
  }
  const seq = ++reportSeq;
  pendingReports += 1;
  try {
    await nativeNotifications?.setOpenThread(target?.botId ?? null, target?.threadId ?? null);
    if (seq === reportSeq) {
      lastConfirmed = target;
      hasConfirmed = true;
    }
  } catch (error) {
    // An overlapping report may still change native state after this failure.
    hasConfirmed = false;
    throw error;
  } finally {
    pendingReports -= 1;
  }
}

export async function dismissThreadNotifications(target: {
  botId?: string;
  threadId?: string;
}): Promise<void> {
  if (!target.botId && !target.threadId) return;
  const presented = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    presented
      .filter(({ request }) => {
        const data = request.content.data ?? {};
        return notificationTargetsThread(data, target);
      })
      .map(({ request }) => Notifications.dismissNotificationAsync(request.identifier)),
  );
}

export async function openLiveNotificationSettings(): Promise<void> {
  await nativeNotifications?.openSettings();
}

export async function canPostPromotedNotifications(): Promise<boolean> {
  return nativeNotifications?.canPostPromotedNotifications() ?? true;
}

export async function openPromotedNotificationSettings(): Promise<void> {
  await nativeNotifications?.openPromotedSettings();
}

/**
 * Android only: keeps the call service running so a bot's call or reminder rings with the app
 * closed. Off when neither may ring or the server is not usable from the background.
 */
export async function setIncomingCalls(
  ringing: { calls: boolean; reminders: boolean },
  endpoint: string,
  token: string,
  spaceId: string,
): Promise<void> {
  if (!nativeNotifications) return;
  const parsed = normalizeApiBase(endpoint);
  const usable = parsed.ok && !apiBaseWarning(parsed.url) && Boolean(token);
  await nativeNotifications.setCalls(
    ringing.calls && usable,
    ringing.reminders && usable,
    parsed.ok ? parsed.url : "",
    token,
    spaceId,
    parsed.ok ? (serverAccessHeader(parsed.url) ?? "") : "",
  );
}

/** Stops the ringing for a call this device answered or declined. */
export async function dismissIncomingCall(callId: string): Promise<void> {
  await nativeNotifications?.dismissCall(callId);
}

/** Stops the ringing for a reminder this device marked done or snoozed. */
export async function dismissReminder(reminderId: string): Promise<void> {
  await nativeNotifications?.dismissReminder(reminderId);
}

/** What still keeps calls from ringing on a locked or idle phone. */
export async function incomingCallBlockers(): Promise<{
  fullScreen: boolean;
  battery: boolean;
}> {
  if (!nativeNotifications) return { fullScreen: false, battery: false };
  const [fullScreen, battery] = await Promise.all([
    nativeNotifications.canUseFullScreenIntent().then((allowed) => !allowed),
    nativeNotifications.isIgnoringBatteryOptimizations().then((ignoring) => !ignoring),
  ]);
  return { fullScreen, battery };
}

export async function openFullScreenCallSettings(): Promise<void> {
  await nativeNotifications?.openFullScreenIntentSettings();
}

export async function requestUnrestrictedBattery(): Promise<void> {
  await nativeNotifications?.requestIgnoreBatteryOptimizations();
}

/** Whether Android lets Quant install its own updates; null where the module is absent. */
export async function canInstallUpdates(): Promise<boolean | null> {
  return nativeNotifications ? nativeNotifications.canRequestPackageInstalls() : null;
}

export async function openInstallUpdateSettings(): Promise<void> {
  await nativeNotifications?.openInstallSettings();
}

/** The incoming call screen shows over the lock screen and wakes it. */
export async function showOverLockScreen(show: boolean): Promise<void> {
  await nativeNotifications?.showOverLockScreen(show);
}
