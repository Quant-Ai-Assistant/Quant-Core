import * as Updates from "expo-updates";
import { currentApiBase } from "./api";
import { deviceLog } from "./device-log";
import { SERVER_ACCESS_HEADER, serverAccessHeader } from "./server-access";

/** The header the server builds update file links from; see apps/api/src/mobile-updates.ts. */
const APP_BASE_HEADER = "x-quant-base";

export type OtaDeps = {
  isEnabled: () => boolean;
  apiBase: () => string;
  gateHeader: (url: string) => string | null;
  setSource: (source: { updateUrl: string; requestHeaders: Record<string, string> }) => void;
  check: () => Promise<{ isAvailable: boolean }>;
  fetch: () => Promise<{ isNew: boolean }>;
  reload: () => Promise<void>;
};

const productionDeps: OtaDeps = {
  isEnabled: () => Updates.isEnabled && !__DEV__,
  apiBase: currentApiBase,
  gateHeader: serverAccessHeader,
  setSource: (source) => Updates.setUpdateURLAndRequestHeadersOverride(source),
  check: () => Updates.checkForUpdateAsync(),
  fetch: () => Updates.fetchUpdateAsync(),
  reload: () => Updates.reloadAsync(),
};

/**
 * Asks this app's own server for an over-the-air update built from main. It applies only to an
 * install with the same native code, which the server checks by the runtime fingerprint.
 */
export async function checkForOtaUpdate(deps: OtaDeps = productionDeps): Promise<boolean> {
  if (!deps.isEnabled()) {
    deviceLog("info", "ota", "Updates are off in this build");
    return false;
  }
  const apiBase = deps.apiBase().replace(/\/+$/, "");
  const updateUrl = `${apiBase}/api/mobile-updates/manifest`;
  const gate = deps.gateHeader(updateUrl);
  deps.setSource({
    updateUrl,
    requestHeaders: {
      [APP_BASE_HEADER]: apiBase,
      ...(gate ? { [SERVER_ACCESS_HEADER]: gate } : {}),
    },
  });
  deviceLog("info", "ota", "Checking", { updateUrl, gate: Boolean(gate) });
  try {
    const result = await deps.check();
    deviceLog("info", "ota", "Checked", result);
    return result.isAvailable;
  } catch (error) {
    deviceLog("error", "ota", "Check failed", error);
    throw error;
  }
}

/** Downloads the update and restarts into it; sign-in, server and settings stay as they are. */
export async function installOtaUpdate(deps: OtaDeps = productionDeps): Promise<void> {
  try {
    deviceLog("info", "ota", "Downloading");
    deviceLog("info", "ota", "Downloaded", await deps.fetch());
  } catch (error) {
    deviceLog("error", "ota", "Download failed", error);
    throw error;
  }
  try {
    deviceLog("info", "ota", "Restarting into the update");
    await deps.reload();
  } catch (error) {
    deviceLog("error", "ota", "Restart failed", error);
    throw error;
  }
}
