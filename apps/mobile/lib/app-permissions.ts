/** Everything Quant asks the phone for, in the order the Permissions screen lists it. */
export type PermissionKey =
  | "notifications"
  | "lockScreen"
  | "background"
  | "microphone"
  | "camera"
  | "photos"
  | "updates";

export type PermissionProbe = {
  key: PermissionKey;
  /** Needed for replies, reminders and calls to work; the rest only unlock a feature. */
  required: boolean;
  /** True once allowed; null when this phone has no such permission. */
  check: () => Promise<boolean | null>;
  /** Asks for it: a system dialog, or the system screen where it is switched on. */
  request: () => Promise<void>;
  /** The request leaves the app for system settings instead of showing a dialog. */
  opensSettings: boolean;
};

export type PermissionState = { key: PermissionKey; required: boolean; granted: boolean };

type RuntimePermission = { granted: boolean; canAskAgain?: boolean };

/** A runtime dialog; once the phone stops showing it, only app settings can allow it. */
async function askOrOpenSettings(ask: () => Promise<RuntimePermission>): Promise<void> {
  const result = await ask();
  if (result.granted || result.canAskAgain !== false) return;
  const { Linking } = await import("react-native");
  await Linking.openSettings();
}

/** The permissions this platform has. Android adds the lock screen, background and updates. */
export function permissionProbes(os: string): PermissionProbe[] {
  const android = os === "android";
  const probes: PermissionProbe[] = [
    {
      key: "notifications",
      required: true,
      opensSettings: false,
      check: async () =>
        (await import("expo-notifications")).getPermissionsAsync().then((p) => p.granted),
      request: async () => {
        const Notifications = await import("expo-notifications");
        await askOrOpenSettings(() => Notifications.requestPermissionsAsync());
      },
    },
    {
      key: "lockScreen",
      required: true,
      opensSettings: true,
      check: async () => {
        const { incomingCallBlockers } = await import("./live-notifications");
        return !(await incomingCallBlockers()).fullScreen;
      },
      request: async () => (await import("./live-notifications")).openFullScreenCallSettings(),
    },
    {
      key: "background",
      required: true,
      opensSettings: true,
      check: async () => {
        const { incomingCallBlockers } = await import("./live-notifications");
        return !(await incomingCallBlockers()).battery;
      },
      request: async () => (await import("./live-notifications")).requestUnrestrictedBattery(),
    },
    {
      key: "microphone",
      required: true,
      opensSettings: false,
      check: async () =>
        (await import("expo-audio")).getRecordingPermissionsAsync().then((p) => p.granted),
      request: async () => {
        const { requestRecordingPermissionsAsync } = await import("expo-audio");
        await askOrOpenSettings(requestRecordingPermissionsAsync);
      },
    },
    {
      key: "camera",
      required: false,
      opensSettings: false,
      check: async () =>
        (await import("expo-image-picker")).getCameraPermissionsAsync().then((p) => p.granted),
      request: async () => {
        const { requestCameraPermissionsAsync } = await import("expo-image-picker");
        await askOrOpenSettings(requestCameraPermissionsAsync);
      },
    },
    {
      key: "photos",
      required: false,
      opensSettings: false,
      check: async () =>
        (await import("expo-image-picker"))
          .getMediaLibraryPermissionsAsync()
          .then((p) => p.granted),
      request: async () => {
        const { requestMediaLibraryPermissionsAsync } = await import("expo-image-picker");
        await askOrOpenSettings(() => requestMediaLibraryPermissionsAsync());
      },
    },
    {
      key: "updates",
      required: false,
      opensSettings: true,
      check: async () => (await import("./live-notifications")).canInstallUpdates(),
      request: async () => (await import("./live-notifications")).openInstallUpdateSettings(),
    },
  ];
  const androidOnly: PermissionKey[] = ["lockScreen", "background", "updates"];
  return android ? probes : probes.filter((probe) => !androidOnly.includes(probe.key));
}

/** Checks every probe; one that fails to answer counts as not allowed yet. */
export async function loadPermissions(probes: PermissionProbe[]): Promise<PermissionState[]> {
  const states = await Promise.all(
    probes.map(async (probe) => {
      const granted = await probe.check().catch(() => false);
      return granted === null
        ? null
        : { key: probe.key, required: probe.required, granted: granted === true };
    }),
  );
  return states.filter((state): state is PermissionState => state !== null);
}

/**
 * "Allow all" asks for one missing permission at a time, required ones first, and skips any
 * already asked for in this pass so a declined one does not loop.
 */
export function nextToRequest(
  states: PermissionState[],
  asked: ReadonlySet<PermissionKey>,
): PermissionKey | null {
  const missing = states.filter((state) => !state.granted && !asked.has(state.key));
  return (missing.find((state) => state.required) ?? missing[0])?.key ?? null;
}
