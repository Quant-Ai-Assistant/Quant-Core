import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopReachability, DesktopSetup } from "@rakazo/contracts";
import { LOCAL_SETTINGS_PAGE } from "@rakazo/contracts/local-settings";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  type Session,
  safeStorage,
  session,
  shell,
  Tray,
} from "electron";
import type { AppDocumentState } from "./app-document-state.js";
import { APP_DOCUMENT_STATE_SCRIPT } from "./app-document-state.js";
import { createAppOpener } from "./app-opener.js";
import {
  DesktopUpdateController,
  type ElectronAutoUpdater,
  LAUNCH_CHECK_DELAY_MS,
} from "./auto-update.js";
import { openBrowserAuth } from "./browser-auth.js";
import { runDocker } from "./docker-cli.js";
import type { BuildInfo } from "./edge-update.js";
import { activeBuild, EdgeUpdater, forgetStaleBuild, systemExtract } from "./edge-update.js";
import { startFrontServer } from "./front-server.js";
import {
  envTemplatePath,
  GATE_DEFAULT_PORT,
  gatePortFree,
  LocalServerController,
  parseGateChange,
  parseGatePort,
  readStackGate,
  readStackToken,
  readStackWebUrl,
  serverDir,
  serverResourceDir,
  stackDir,
} from "./local-server.js";
import { requestLocalSettings } from "./local-settings.js";
import { oauthCallbackFrom } from "./oauth-callback.js";
import {
  bundledRendererCandidates,
  contentType,
  forwardedRendererRequestInit,
  immutableRendererAsset,
  isRendererAssetMiss,
} from "./renderer-assets.js";
import type { ServerAccess } from "./server-access.js";
import {
  activeServerAccess,
  basicAuthorization,
  createLoginLimiter,
  loadServerAccess,
  parseServerAccess,
  saveServerAccess,
  serverAccessFor,
  setActiveServerAccess,
} from "./server-access.js";
import { launchProcess } from "./server-processes.js";
import { installSessionPermissions } from "./session-permissions.js";
import {
  DEFAULT_LOCAL_WEB_URL,
  isRakazoHealth,
  managedLocalOpenUrl,
  normalizeServerUrl,
  parseSetupInput,
  probeFailureMessage,
  readProbeJson,
  resolveStartupTarget,
  safeExternalUrl,
  servesBundledRenderer,
  sessionPartitionForServerUrl,
} from "./setup-config.js";
import { clearSetup, readSetup, writeSetup } from "./setup-store.js";
import { oauthPopupSessionPreferences, shouldOpenInAppPopup } from "./window-open.js";
import {
  browserWindowOptions,
  developmentIconFile,
  setupWindowOptions,
  warmWindowTtlMs,
} from "./window-options.js";

const PERFORMANCE_USER_DATA = process.env.RAKAZO_PERFORMANCE_USER_DATA;
/** Test hook: where the app-managed stack answers. Mode `new` still requires loopback. */
const LOCAL_WEB_URL = process.env.RAKAZO_LOCAL_WEB_URL?.trim() || DEFAULT_LOCAL_WEB_URL;
const PROBE_TIMEOUT_MS = 8_000;
/** A launch shows setup's progress only when the local server takes longer than this. */
const QUIET_START_MS = 1_500;
let mainWindow: BrowserWindow | null = null;
const appWindowTargets = new WeakMap<BrowserWindow, string>();
let setupWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let openingSettings = false;
let settingsCleanup: Promise<void> = Promise.resolve();
let settingsTarget: { origin: string; token: string } | null = null;
const bundledRendererInstallations = new Set<string>();
let currentSetup: DesktopSetup | null = null;
let currentTargetUrl: string | null = null;
let setupError: string | null = null;
let setupSaveInProgress = false;
const appOpener = createAppOpener(openAppOnce);
/** Prior app window kept until setup is persisted (or the switch is abandoned). */
let pendingPreviousWindow: BrowserWindow | null = null;
let quitting = false;
let warmWindowTimer: NodeJS.Timeout | undefined;
const WARM_WINDOW_TTL_MS = warmWindowTtlMs(process.env.RAKAZO_WARM_WINDOW_TTL_MS);

const LATEST_RELEASE_URL = "https://github.com/Quant-Ai-Assistant/Quant-Core/releases/latest";
const updaterEnvironment = {
  packaged: app.isPackaged,
  version: app.getVersion(),
  disabled: process.env.RAKAZO_DISABLE_AUTO_UPDATE === "1",
  manualInstall: process.platform === "darwin",
};
const desktopUpdater = new DesktopUpdateController(
  updaterEnvironment,
  async () => {
    const module = await import("electron-updater");
    return (module.default ?? module).autoUpdater as unknown as ElectronAutoUpdater;
  },
  undefined,
  () => {
    quitting = false;
  },
);
/** Fast updates from main; null until the app is ready. */
let edgeUpdater: EdgeUpdater | null = null;
/** The web app this launch serves: a build from main, or null for the app's own. */
let activeWebRoot: string | null = null;
let launchUpdateCheckScheduled = false;
let localStack: LocalServerController;
let tray: Tray | null = null;
/** Set once the local server has stopped, so the next quit goes through. */
let serverStopped = false;

markOnce("rk:main:module-evaluated");
if (PERFORMANCE_USER_DATA) {
  app.setPath("userData", PERFORMANCE_USER_DATA);
  app.setPath("sessionData", path.join(PERFORMANCE_USER_DATA, "session"));
}
app.once("will-finish-launching", () => markOnce("rk:main:will-finish-launching"));
app.once("ready", () => markOnce("rk:main:ready"));
// Includes fresh partitions and popup-created sessions, before they load remote content.
app.on("session-created", (value) => installSessionPermissions(value, permissionTarget));

function permissionTarget() {
  if (mainWindow === null || mainWindow.isDestroyed()) return null;
  const url = appWindowTargets.get(mainWindow);
  return url === undefined ? null : { webContents: mainWindow.webContents, url };
}

function markOnce(name: string) {
  if (performance.getEntriesByName(name).length === 0) performance.mark(name);
}

function windowFrom(event: Electron.IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(event.sender);
}

function fromMainWindow(event: Electron.IpcMainInvokeEvent) {
  return mainWindow !== null && windowFrom(event) === mainWindow;
}

/** Dock/taskbar icon for unpackaged launches; packaged builds get theirs from electron-builder. */
function developmentIcon() {
  if (app.isPackaged) return undefined;
  const icon = path.join(app.getAppPath(), "assets", developmentIconFile(process.platform));
  return existsSync(icon) ? icon : undefined;
}

function sessionPartitionKey(targetUrl: string) {
  return sessionPartitionForServerUrl(targetUrl);
}

function legacyDefaultSessionFlag(partition: string) {
  return path.join(
    app.getPath("userData"),
    `legacy-default-${partition.replace(/[^a-zA-Z0-9_-]/g, "_")}.flag`,
  );
}

/**
 * Prefer the default session when that origin already has cookies or site
 * storage there, so upgrades keep localStorage/IndexedDB. Fresh origins get
 * an isolated partition.
 */
async function resolveSessionForTarget(targetUrl: string) {
  const partition = sessionPartitionKey(targetUrl);
  if (partition === null) {
    return { partition: null, value: session.defaultSession };
  }
  if (existsSync(legacyDefaultSessionFlag(partition))) {
    return { partition: null, value: session.defaultSession };
  }
  const origin = safeOrigin(targetUrl);
  if (origin !== null) {
    try {
      const defaultCookies = await session.defaultSession.cookies.get({ url: origin });
      if (defaultCookies.length > 0) {
        await writeFile(legacyDefaultSessionFlag(partition), new Date().toISOString(), "utf8");
        return { partition: null, value: session.defaultSession };
      }
    } catch {
      // Continue with a storage probe when the profile looks pre-partition.
    }
    if (defaultSessionProfileExists() && (await defaultSessionHasOriginData(origin))) {
      try {
        await writeFile(legacyDefaultSessionFlag(partition), new Date().toISOString(), "utf8");
      } catch {
        // Flag is best-effort; still stay on the default session this launch.
      }
      return { partition: null, value: session.defaultSession };
    }
  }
  return { partition, value: session.fromPartition(partition) };
}

function defaultSessionProfileExists() {
  const root = app.getPath("userData");
  return (
    existsSync(path.join(root, "Local Storage")) ||
    existsSync(path.join(root, "IndexedDB")) ||
    existsSync(path.join(root, "Cookies")) ||
    existsSync(path.join(root, "Network", "Cookies")) ||
    existsSync(path.join(root, "Cache Storage"))
  );
}

/** Page storage in the default session means a pre-partition install for this origin. */
async function defaultSessionHasOriginData(origin: string): Promise<boolean> {
  const probe = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  try {
    await probe.loadURL(origin);
    return (await probe.webContents.executeJavaScript(`(async () => {
      if (localStorage.length > 0 || sessionStorage.length > 0) return true;
      if (typeof indexedDB !== "undefined" && indexedDB.databases) {
        try {
          const databases = await indexedDB.databases();
          if (databases.length > 0) return true;
        } catch {}
      }
      if (typeof caches !== "undefined") {
        try {
          const keys = await caches.keys();
          if (keys.length > 0) return true;
        } catch {}
      }
      return false;
    })()`)) as boolean;
  } catch {
    return false;
  } finally {
    if (!probe.isDestroyed()) probe.destroy();
  }
}

function createWindow(url: string, partition: string | null) {
  markOnce("rk:main:window-create-start");
  const icon = developmentIcon();
  const win = new BrowserWindow({
    ...browserWindowOptions(process.platform),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      ...(partition === null ? {} : { partition }),
    },
  });
  mainWindow = win;
  appWindowTargets.set(win, url);
  const targetOrigin = safeOrigin(url);
  // Intentional OAuth flows open the provider's authorize page via a named
  // window; give those and same-origin popups a normal frame. Everything else
  // opens in the system browser so a connected server cannot navigate us away.
  // Hoisted for loopback OAuth capture so MCP/in-app localhost callbacks are skipped.
  const appOrigin = targetOrigin ?? safeOrigin(url);
  win.webContents.setWindowOpenHandler(({ url: childUrl, frameName }) => {
    if (shouldOpenInAppPopup(appOrigin, childUrl, frameName)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: oauthPopupWindowOptions(partition),
      };
    }
    const external = safeExternalUrl(childUrl);
    if (external !== null) void shell.openExternal(external);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, navigationUrl) => {
    if (targetOrigin !== null && safeOrigin(navigationUrl) === targetOrigin) return;
    event.preventDefault();
    const external = safeExternalUrl(navigationUrl);
    if (external !== null) void shell.openExternal(external);
  });
  // The popup has no address bar, so a loopback redirect would otherwise strand
  // the user on a blank window holding the authorization code in a URL they
  // cannot read. Capture it here and hand it to the app instead.
  win.webContents.on("did-create-window", (popup, { frameName }) => {
    const capture = (details: {
      preventDefault: () => void;
      url: string;
      isMainFrame?: boolean;
    }) => {
      // will-redirect can fire for iframes; only the top-level callback counts.
      if (details.isMainFrame === false) return;
      const callback = oauthCallbackFrom(details.url, {
        frameName,
        excludeOrigins: appOrigin !== null ? [appOrigin] : [],
      });
      if (!callback) return;
      details.preventDefault();
      if (!win.isDestroyed()) win.webContents.send("desktop.oauth.callback", callback);
      if (!popup.isDestroyed()) popup.close();
    };
    popup.webContents.on("will-redirect", (details) => capture(details));
    popup.webContents.on("will-navigate", (details) => capture(details));
  });
  win.on("close", (event) => {
    // The app lives on in the tray (and the macOS Dock) while its window is closed.
    if (!quitting && process.env.RAKAZO_DISABLE_WARM_WINDOW !== "1") {
      event.preventDefault();
      win.hide();
      clearTimeout(warmWindowTimer);
      warmWindowTimer = setTimeout(() => {
        if (mainWindow === win && !win.isDestroyed() && !win.isVisible()) win.destroy();
      }, WARM_WINDOW_TTL_MS);
    }
  });
  win.once("closed", () => {
    clearTimeout(warmWindowTimer);
    if (mainWindow === win) mainWindow = null;
  });
  markOnce("rk:main:window-created");
  if (win.isVisible()) markOnce("rk:main:window-shown");
  win.once("show", () => markOnce("rk:main:window-shown"));
  win.once("ready-to-show", () => markOnce("rk:main:ready-to-show"));
  win.webContents.once("dom-ready", () => markOnce("rk:main:dom-ready"));
  win.webContents.once("did-finish-load", () => markOnce("rk:main:did-finish-load"));
  win.webContents.once("did-stop-loading", () => markOnce("rk:main:did-stop-loading"));
  markOnce("rk:main:load-url-start");
  const loaded = loadAppUrl(win, url).then(
    (state) => {
      markOnce("rk:main:load-url-resolved");
      return state;
    },
    (error: unknown) => {
      markOnce("rk:main:load-url-rejected");
      throw error;
    },
  );
  if (!launchUpdateCheckScheduled) {
    launchUpdateCheckScheduled = true;
    setTimeout(() => void desktopUpdater.check(false), LAUNCH_CHECK_DELAY_MS).unref();
    setInterval(() => void desktopUpdater.check(false), 60 * 60 * 1_000).unref();
  }
  return { loaded, win };
}

async function probeDocument(url: string): Promise<string | null> {
  // Test/dev harnesses may load data: or file: documents; only probe real servers.
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;
  try {
    const response = await net.fetch(url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Allow 3xx (e.g. / → /login); reject hard HTTP errors before opening a window.
    if (response.status >= 400) {
      return `The server answered with HTTP ${response.status}.`;
    }
    return null;
  } catch (error) {
    return probeFailureMessage(error);
  }
}

/**
 * loadURL alone treats many HTTP error documents as success. Reject main-frame
 * failures, renderer crashes during load, HTTP 4xx/5xx main-frame responses, and
 * shells that never mount application content.
 */
function loadAppUrl(win: BrowserWindow, url: string): Promise<AppDocumentState> {
  const contents = win.webContents;
  const targetSession = contents.session;
  let mainStatus: number | undefined;

  targetSession.webRequest.onCompleted({ urls: ["*://*/*"] }, (details) => {
    if (details.webContentsId === contents.id && details.resourceType === "mainFrame") {
      mainStatus = details.statusCode;
    }
  });

  return new Promise<AppDocumentState>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      contents.removeListener("did-fail-load", onFail);
      // Keep render-process-gone until document readiness finishes so a crash
      // during mount still fails the switch.
      targetSession.webRequest.onCompleted(null);
      if (error) {
        contents.removeListener("render-process-gone", onGone);
        reject(error);
        return;
      }
      if (mainStatus !== undefined && mainStatus >= 400) {
        contents.removeListener("render-process-gone", onGone);
        reject(new Error(`The server answered with HTTP ${mainStatus}.`));
        return;
      }
      void waitForMountedAppDocument(contents)
        .then((state) => {
          contents.removeListener("render-process-gone", onGone);
          if (contents.isCrashed()) {
            reject(new Error("Renderer stopped after load."));
            return;
          }
          resolve(state);
        })
        .catch((inspectError: unknown) => {
          contents.removeListener("render-process-gone", onGone);
          reject(inspectError instanceof Error ? inspectError : new Error(String(inspectError)));
        });
    };

    const onFail = (
      _event: Electron.Event,
      _errorCode: number,
      errorDescription: string,
      _validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame) settle(new Error(errorDescription || "Page failed to load."));
    };
    const onGone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
      settle(new Error(`Renderer stopped (${details.reason}).`));
    };

    contents.on("did-fail-load", onFail);
    contents.on("render-process-gone", onGone);
    void contents.loadURL(url).then(
      async () => {
        // onCompleted can lag loadURL; wait briefly for the main-frame status.
        const deadline = Date.now() + 500;
        while (mainStatus === undefined && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }
        settle();
      },
      (error: unknown) => {
        settle(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function waitForMountedAppDocument(
  contents: Electron.WebContents,
): Promise<AppDocumentState> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (contents.isCrashed()) throw new Error("Renderer stopped after load.");
    const state = (await contents.executeJavaScript(APP_DOCUMENT_STATE_SCRIPT)) as
      | AppDocumentState
      | "pending";
    if (state !== "pending") return state;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("The server page did not become ready.");
}

async function installBundledRenderer(
  targetUrl: string,
  targetSession: Session,
  partition: string | null,
  managedLocalStack: boolean,
) {
  if (!app.isPackaged || process.env.RAKAZO_DISABLE_BUNDLED_RENDERER === "1") return;
  if (!servesBundledRenderer(targetUrl, managedLocalStack)) return;
  const webUrl = new URL(targetUrl);
  const installationKey = `${partition ?? "default"}:${webUrl.protocol}`;
  if (bundledRendererInstallations.has(installationKey)) return;
  const root = activeWebRoot ?? path.join(process.resourcesPath, "web");

  await targetSession.protocol.handle(webUrl.protocol.slice(0, -1), async (request) => {
    const forward = () => {
      return targetSession.fetch(request, forwardedRendererRequestInit(request, webUrl.origin));
    };
    // Mode can change on the same origin/session; only managed "new" keeps the overlay.
    if (partition !== "local-server-settings" && currentSetup?.mode !== "new") {
      return forward();
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return forward();
    }
    const acceptsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
    const candidates = bundledRendererCandidates(root, request.url, webUrl.origin, acceptsHtml);
    if (!candidates) return forward();
    for (const file of candidates) {
      let body: Buffer | null = null;
      try {
        if (request.method === "HEAD") {
          if (!(await stat(file)).isFile()) continue;
        } else {
          body = await readFile(file);
        }
      } catch (error) {
        if (isRendererAssetMiss(error)) continue;
        throw error;
      }
      const headers = new Headers({
        "cache-control": immutableRendererAsset(file)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "content-type": contentType(file),
        "x-content-type-options": "nosniff",
      });
      return new Response(body, { headers });
    }
    return forward();
  });
  bundledRendererInstallations.add(installationKey);
  markOnce("rk:main:bundled-renderer-ready");
}

function oauthPopupWindowOptions(partition: string | null) {
  return {
    width: 560,
    height: 720,
    frame: true,
    titleBarStyle: "default" as const,
    autoHideMenuBar: true,
    backgroundColor: "#0B0C0E",
    webPreferences: oauthPopupSessionPreferences(partition),
  };
}

function createSetupWindow() {
  const icon = developmentIcon();
  const win = new BrowserWindow({
    ...setupWindowOptions(process.platform),
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, "setup-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // A long pull runs while this window sits behind others; throttled timers would freeze it.
      backgroundThrottling: false,
    },
  });
  setupWindow = win;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("closed", () => {
    if (setupWindow === win) setupWindow = null;
    // Closing setup without saving restores a connected session (Change Server cancel).
    restoreAppWindowAfterSetup();
  });
  void win.loadFile(path.join(import.meta.dirname, "setup.html"));
  markOnce("rk:main:setup-window-created");
  return win;
}

/** Hide the app while setup is open; do not clear the saved target until a new one opens. */
function showSetupWindow(error: string | null = null) {
  setupError = error;

  let win: BrowserWindow;
  if (setupWindow !== null && !setupWindow.isDestroyed()) {
    if (error !== null) setupWindow.reload();
    win = setupWindow;
  } else {
    win = createSetupWindow();
  }
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.hide();
  win.show();
  win.focus();
  return win;
}

function restoreAppWindowAfterSetup() {
  if (quitting) return;
  if (setupWindow !== null && !setupWindow.isDestroyed()) return;
  if (mainWindow === null || mainWindow.isDestroyed() || currentTargetUrl === null) return;
  clearTimeout(warmWindowTimer);
  mainWindow.show();
  mainWindow.focus();
}

async function showLocalSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  if (openingSettings) return;
  openingSettings = true;
  try {
    const url = localStack.webUrl();
    const token = await readStackToken(stackDir(app.getPath("userData")));
    if (!token || !localStack.ready()) {
      await dialog.showMessageBox({
        message: "Start the local server before opening its settings.",
        type: "info",
      });
      return;
    }
    await settingsCleanup;
    const partition = "local-server-settings";
    const targetSession = session.fromPartition(partition);
    installSessionPermissions(targetSession, () => null);
    await installBundledRenderer(url, targetSession, partition, true);
    const win = new BrowserWindow({
      ...browserWindowOptions(process.platform),
      title: "Local Server Settings",
      frame: true,
      titleBarStyle: "default",
      trafficLightPosition: undefined,
      webPreferences: {
        preload: path.join(import.meta.dirname, "preload.cjs"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition,
      },
    });
    settingsWindow = win;
    const origin = new URL(url).origin;
    settingsTarget = { origin, token };
    win.webContents.setWindowOpenHandler(({ url: externalUrl }) => {
      const external = safeExternalUrl(externalUrl);
      if (external) void shell.openExternal(external);
      return { action: "deny" };
    });
    const preventNavigation = (event: Electron.Event, target: string) => {
      if (target === `${origin}${LOCAL_SETTINGS_PAGE}`) return;
      event.preventDefault();
    };
    win.webContents.on("will-navigate", preventNavigation);
    win.webContents.on("will-redirect", preventNavigation);
    win.once("closed", () => {
      if (settingsWindow === win) {
        settingsWindow = null;
        settingsTarget = null;
      }
      const protocol = new URL(url).protocol;
      if (bundledRendererInstallations.delete(`${partition}:${protocol}`)) {
        targetSession.protocol.unhandle(protocol.slice(0, -1));
      }
      settingsCleanup = targetSession.clearStorageData().catch(() => undefined);
    });
    await win.loadURL(`${origin}${LOCAL_SETTINGS_PAGE}`);
  } catch {
    settingsWindow?.close();
    await dialog.showMessageBox({
      message: "Could not open local server settings. Try again.",
      type: "error",
    });
  } finally {
    openingSettings = false;
  }
}

function installApplicationMenu() {
  const localSettings: Electron.MenuItemConstructorOptions = {
    id: "local-server-settings",
    label: "Local Server Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => {
      void showLocalSettings();
    },
  };
  const changeServer: Electron.MenuItemConstructorOptions = {
    id: "change-rakazo-server",
    label: "Change Quant Server…",
    accelerator: "CmdOrCtrl+Shift+K",
    click: () => showSetupWindow(),
  };
  const template: Electron.MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              localSettings,
              changeServer,
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          { role: "editMenu" },
          { role: "windowMenu" },
        ]
      : [
          {
            label: "File",
            submenu: [localSettings, changeServer, { type: "separator" }, { role: "quit" }],
          },
          { role: "editMenu" },
          { role: "windowMenu" },
        ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Setup IPC must only answer the setup window, never a connected Quant server. */
function fromSetupWindow(event: Electron.IpcMainInvokeEvent) {
  return (
    setupWindow !== null && !setupWindow.isDestroyed() && event.sender === setupWindow.webContents
  );
}

async function probeServer(
  rawUrl: string,
  signal?: AbortSignal,
  access: ServerAccess | null = null,
): Promise<DesktopReachability> {
  const url = normalizeServerUrl(rawUrl);
  if (url === null) return { ok: false, error: "Enter a valid http:// or https:// address." };
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);

  try {
    const response = await net.fetch(`${url}/rpc/health`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(access ? { authorization: basicAuthorization(access) } : {}),
      },
      body: JSON.stringify({ json: {} }),
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        status: response.status,
        url,
        error: "That address redirects elsewhere. Enter the final Quant server address.",
      };
    }
    if (response.status === 401) {
      return {
        ok: false,
        status: response.status,
        url,
        error: access
          ? "The server did not accept that username and password."
          : "This server asks for a username and password.",
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        url,
        error: `The server answered with HTTP ${response.status}.`,
      };
    }
    const health = await readProbeJson(response);
    if (!isRakazoHealth(health)) {
      return {
        ok: false,
        status: response.status,
        url,
        error: "That address did not respond like a Quant server.",
      };
    }
    return {
      ok: true,
      status: response.status,
      url,
    };
  } catch (error) {
    return { ok: false, url, error: probeFailureMessage(error) };
  }
}

function openFailureDetail(error: unknown): string {
  if (error instanceof Error) {
    const { message } = error;
    if (
      message.startsWith("The server answered with HTTP") ||
      message.startsWith("The server page loaded empty") ||
      message.startsWith("The server page did not become ready") ||
      message.startsWith("Renderer stopped") ||
      message.startsWith("Page failed to load")
    ) {
      return message;
    }
  }
  return probeFailureMessage(error);
}

async function openAppOnce(targetUrl: string, switching: boolean) {
  const target = await resolveSessionForTarget(targetUrl);
  const previous = mainWindow;
  let win: BrowserWindow | null = null;
  try {
    const documentError = await probeDocument(targetUrl);
    if (documentError !== null) {
      throw new Error(documentError);
    }
    await installBundledRenderer(
      targetUrl,
      target.value,
      target.partition,
      currentSetup?.mode === "new",
    );
    const created = createWindow(targetUrl, target.partition);
    win = created.win;
    // On launch the web app's error screen stays up so its Refresh can recover;
    // switching to a server that cannot render keeps the previous one instead.
    if ((await created.loaded) === "failed" && switching) {
      throw new Error("The server page did not become ready.");
    }
    currentTargetUrl = targetUrl;
    setupError = null;
    // Keep the previous window until the caller commits (after setup.json is written).
    pendingPreviousWindow =
      previous !== null && !previous.isDestroyed() && previous !== win ? previous : null;
    if (pendingPreviousWindow !== null) pendingPreviousWindow.hide();
    return true;
  } catch (error) {
    pendingPreviousWindow = null;
    // Keep the previous app window so Cancel / close can restore it.
    if (previous !== null && !previous.isDestroyed()) mainWindow = previous;
    // Show the setup window BEFORE destroying the failed one: on Windows/Linux,
    // destroying the last window fires "window-all-closed" -> app.quit() before
    // showSetupWindow() runs, so the app silently exits instead of showing this error.
    showSetupWindow(`Could not open that server. ${openFailureDetail(error)}`);
    if (win !== null && !win.isDestroyed()) win.destroy();
    return false;
  }
}

/** Drop the previous app window after the new server is opened and persisted. */
function commitPendingAppSwitch() {
  const previous = pendingPreviousWindow;
  pendingPreviousWindow = null;
  if (previous !== null && !previous.isDestroyed() && previous !== mainWindow) previous.destroy();
}

/**
 * Undo an open that could not be persisted. When a prior session exists, restore
 * it. On first run keep the connected window so the user can retry save.
 */
function abandonPendingAppSwitch(
  previousSetup: DesktopSetup | null,
  previousUrl: string | null,
): "restored" | "kept" {
  const previous = pendingPreviousWindow;
  pendingPreviousWindow = null;
  if (previous !== null && !previous.isDestroyed()) {
    const failed = mainWindow;
    if (failed !== null && !failed.isDestroyed() && failed !== previous) failed.destroy();
    mainWindow = previous;
    currentSetup = previousSetup;
    currentTargetUrl = previousUrl;
    // If setup was already closed (e.g. during a slow write), make the restored
    // session visible — otherwise macOS can be left with no shown window.
    if (setupWindow === null || setupWindow.isDestroyed()) {
      clearTimeout(warmWindowTimer);
      previous.show();
      previous.focus();
    }
    return "restored";
  }
  return "kept";
}

/** Watch for a renderer crash until setup is persisted (or the switch is abandoned). */
function watchRendererUntilCommitted(win: BrowserWindow) {
  let crashed = false;
  const onGone = () => {
    crashed = true;
  };
  win.webContents.once("render-process-gone", onGone);
  return {
    crashed: () => crashed || (!win.isDestroyed() && win.webContents.isCrashed()),
    dispose: () => {
      if (!win.isDestroyed()) win.webContents.removeListener("render-process-gone", onGone);
    },
  };
}

function destroySetupWindow() {
  const setup = setupWindow;
  setupWindow = null;
  if (setup !== null && !setup.isDestroyed()) setup.destroy();
}

/** Best-effort restore of setup.json after a failed save that already wrote disk. */
async function rollbackSetupFile(userDataDir: string, previousSetup: DesktopSetup | null) {
  try {
    if (previousSetup !== null) await writeSetup(userDataDir, previousSetup);
    else await clearSetup(userDataDir);
  } catch {
    // Disk rollback is best-effort; callers already restored in-memory state when possible.
  }
}

/**
 * After a renderer crash around save: restore prior setup when possible, otherwise
 * drop the crashed first-run window so setup remains the only recovery surface.
 */
async function recoverFromCrashedSave(
  userDataDir: string,
  previousSetup: DesktopSetup | null,
  previousUrl: string | null,
): Promise<string> {
  const outcome = abandonPendingAppSwitch(previousSetup, previousUrl);
  await rollbackSetupFile(userDataDir, previousSetup);
  if (outcome === "kept") {
    if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.destroy();
    mainWindow = null;
    currentSetup = previousSetup;
    currentTargetUrl = previousUrl;
  }
  const message =
    previousSetup !== null
      ? "Could not open that server. Renderer stopped. The previous instance was restored for the next launch."
      : "Could not open that server. Renderer stopped.";
  showSetupWindow(message);
  return message;
}

function safeOrigin(targetUrl: string) {
  try {
    return new URL(targetUrl).origin;
  } catch {
    return null;
  }
}

// The configured server's Basic Auth gate. Only its origin gets the saved credentials, and a
// rejected password is not retried forever.
const allowLogin = createLoginLimiter();
app.on("login", (event, _contents, details, authInfo, callback) => {
  if (authInfo.isProxy) return;
  const access = serverAccessFor(details.url);
  if (access === null) return;
  const origin = new URL(details.url).origin;
  if (!allowLogin(origin)) return;
  event.preventDefault();
  callback(access.username, access.password);
});

app.whenReady().then(async () => {
  installSessionPermissions(session.defaultSession, permissionTarget);
  const userDataDir = app.getPath("userData");
  await loadServerAccess(userDataDir, safeStorage);
  const resources = {
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  };
  const edgePaths = {
    root: path.join(userDataDir, "edge"),
    bundledServer: serverResourceDir(resources),
  };
  const ownBuild =
    app.isPackaged && process.env.RAKAZO_DISABLE_EDGE !== "1" ? await readOwnBuild() : null;
  const active = await activeBuild(edgePaths, ownBuild);
  void forgetStaleBuild(edgePaths, active);
  activeWebRoot = active?.webRoot ?? null;
  edgeUpdater = new EdgeUpdater(edgePaths, active?.build ?? null, {
    fetch: (url) => net.fetch(url),
    extract: systemExtract,
    relaunch: () => {
      app.relaunch();
      app.quit();
    },
    now: () => new Date().toISOString(),
  });
  localStack = new LocalServerController({
    platform: process.platform,
    env: process.env,
    execPath: process.execPath,
    // Test hooks: a stand-in server and web app for the desktop e2e suite.
    resourceDir:
      process.env.RAKAZO_SERVER_DIR?.trim() || active?.serverDir || serverResourceDir(resources),
    webRoot:
      process.env.RAKAZO_WEB_ROOT?.trim() ||
      active?.webRoot ||
      (app.isPackaged
        ? path.join(process.resourcesPath, "web")
        : path.resolve(app.getAppPath(), "..", "web", "dist")),
    envTemplate: envTemplatePath(resources),
    stackDir: stackDir(userDataDir),
    serverDir: serverDir(userDataDir),
    localWebUrl:
      process.env.RAKAZO_LOCAL_WEB_URL?.trim() ||
      (await readStackWebUrl(stackDir(userDataDir), LOCAL_WEB_URL)),
    version: app.getVersion(),
    run: runDocker,
    launch: launchProcess,
    startFront: startFrontServer,
    probe: async (apiUrl, signal) => {
      const response = await net.fetch(`${apiUrl}/health`, {
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
      });
      return response.ok;
    },
    randomHex: (bytes) => randomBytes(bytes).toString("hex"),
    onState: (state) => {
      if (setupWindow !== null && !setupWindow.isDestroyed()) {
        setupWindow.webContents.send("desktop.setup.stack.changed", state);
      }
    },
  });
  currentSetup = await readSetup(userDataDir);
  const target = resolveStartupTarget({
    envUrl: process.env.RAKAZO_WEB_URL,
    saved: currentSetup,
    forceSetup: process.env.RAKAZO_FORCE_SETUP === "1",
  });
  if (process.env.RAKAZO_PERFORMANCE_CLEAR_CACHE === "1") {
    const cacheSessions = new Set<Session>([session.defaultSession]);
    if (target.kind === "app") {
      cacheSessions.add((await resolveSessionForTarget(target.url)).value);
    }
    await Promise.all(
      [...cacheSessions].flatMap((value) => [value.clearCache(), value.clearCodeCaches({})]),
    );
    markOnce("rk:main:caches-cleared");
  }

  const icon = developmentIcon();
  if (process.platform === "darwin" && icon) app.dock?.setIcon(icon);
  installApplicationMenu();
  const browserAuthAttempts = new Map<string, AbortController>();
  const cancelBrowserAuth = () => {
    for (const attempt of browserAuthAttempts.values()) attempt.abort();
    browserAuthAttempts.clear();
  };
  app.on("before-quit", cancelBrowserAuth);
  ipcMain.handle("desktop.oauth.open", async (event, url: unknown) => {
    if (
      (!fromMainWindow(event) &&
        !(settingsWindow !== null && windowFrom(event) === settingsWindow)) ||
      event.senderFrame !== event.sender.mainFrame ||
      typeof url !== "string" ||
      url.length > 16_384
    )
      throw new Error("Invalid sign-in request.");
    if (browserAuthAttempts.has(url) || browserAuthAttempts.size >= 8) {
      throw new Error("A sign-in attempt is already active. Cancel it and retry.");
    }
    const controller = new AbortController();
    browserAuthAttempts.set(url, controller);
    const stop = () => controller.abort();
    const expiry = setTimeout(stop, 10 * 60_000);
    expiry.unref();
    event.sender.once("destroyed", stop);
    event.sender.once("did-navigate", stop);
    controller.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(expiry);
        event.sender.removeListener("destroyed", stop);
        event.sender.removeListener("did-navigate", stop);
        if (browserAuthAttempts.get(url) === controller) browserAuthAttempts.delete(url);
      },
      { once: true },
    );
    try {
      await openBrowserAuth(url, {
        signal: controller.signal,
        onClose: stop,
        openExternal: (target) => shell.openExternal(target),
        onCallback: (callback) => {
          if (!event.sender.isDestroyed()) event.sender.send("desktop.oauth.callback", callback);
        },
      });
    } catch {
      controller.abort();
      throw new Error("Could not open browser sign-in. Close other sign-in attempts and retry.");
    }
  });
  ipcMain.handle("desktop.oauth.cancel", (event, url: unknown) => {
    if (
      (!fromMainWindow(event) &&
        !(settingsWindow !== null && windowFrom(event) === settingsWindow)) ||
      event.senderFrame !== event.sender.mainFrame ||
      typeof url !== "string"
    )
      return;
    browserAuthAttempts.get(url)?.abort();
  });
  ipcMain.handle(
    "desktop.localSettings.request",
    async (event, pathname: unknown, body: unknown) => {
      if (
        !settingsWindow ||
        windowFrom(event) !== settingsWindow ||
        event.senderFrame !== event.sender.mainFrame ||
        !settingsTarget ||
        event.senderFrame.url !== `${settingsTarget.origin}${LOCAL_SETTINGS_PAGE}`
      ) {
        throw new Error("Local settings are not active");
      }
      return requestLocalSettings(settingsTarget, pathname, body, (input, init) =>
        net.fetch(input instanceof URL ? input.href : input, {
          ...init,
          bypassCustomProtocolHandlers: true,
        }),
      );
    },
  );
  ipcMain.handle("desktop.platform", () => process.platform);
  ipcMain.handle("desktop.window.close", (event) => {
    windowFrom(event)?.close();
  });
  ipcMain.handle("desktop.window.minimize", (event) => {
    windowFrom(event)?.minimize();
  });
  ipcMain.handle("desktop.window.toggleMaximize", (event) => {
    const win = windowFrom(event);
    if (!win) return;
    if (win.isMaximized() || win.isFullScreen()) {
      win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.handle("desktop.window.state", (event) => {
    const win = windowFrom(event);
    return {
      minimized: win?.isMinimized() ?? false,
      maximized: win?.isMaximized() ?? false,
      fullScreen: win?.isFullScreen() ?? false,
    };
  });
  ipcMain.handle("desktop.edge.state", () => edgeUpdater?.state() ?? null);
  ipcMain.handle("desktop.edge.check", (event) =>
    fromMainWindow(event) ? (edgeUpdater?.check() ?? null) : (edgeUpdater?.state() ?? null),
  );
  ipcMain.handle("desktop.edge.apply", (event) =>
    fromMainWindow(event) ? (edgeUpdater?.apply() ?? null) : (edgeUpdater?.state() ?? null),
  );
  ipcMain.handle("desktop.update.state", () => desktopUpdater.state());
  ipcMain.handle("desktop.update.check", (event) =>
    fromMainWindow(event) ? desktopUpdater.check(true) : desktopUpdater.state(),
  );
  ipcMain.handle("desktop.update.download", (event) => {
    if (!fromMainWindow(event)) return desktopUpdater.state();
    // Quant's macOS build has no Apple Developer ID, so Squirrel refuses to swap the app in
    // place and the release ships no update ZIP. Hand the user the new DMG instead.
    if (process.platform === "darwin") {
      void shell.openExternal(LATEST_RELEASE_URL);
      return desktopUpdater.state();
    }
    return desktopUpdater.download();
  });
  ipcMain.handle("desktop.update.install", async (event) => {
    if (!fromMainWindow(event) || desktopUpdater.state().phase !== "ready") {
      return desktopUpdater.state();
    }
    quitting = true;
    const state = await desktopUpdater.install();
    // A failed install stays ready for retry but reports a message. Restore normal
    // window behavior while the user keeps working after that failure.
    if (state.phase !== "ready" || state.message !== null) quitting = false;
    return state;
  });
  ipcMain.handle("desktop.setup.state", async (event) => {
    if (!fromSetupWindow(event)) return null;
    const saved = activeServerAccess();
    return {
      defaultLocalUrl: localStack.webUrl(),
      defaultPort: GATE_DEFAULT_PORT,
      gate: await readStackGate(stackDir(userDataDir)),
      saved: currentSetup,
      savedUsername:
        saved !== null && currentSetup !== null && saved.origin === currentSetup.serverUrl
          ? saved.access.username
          : undefined,
      error: setupError ?? undefined,
    };
  });

  ipcMain.handle("desktop.setup.test", async (event, payload: unknown) => {
    if (!fromSetupWindow(event)) return { ok: false, error: "Setup is not active." };
    const request =
      typeof payload === "string" ? { url: payload } : (payload as Record<string, unknown> | null);
    const url = request?.url;
    if (typeof url !== "string") return { ok: false, error: "Enter a server address." };
    return probeServer(url, undefined, parseServerAccess(request?.access));
  });

  ipcMain.handle("desktop.setup.save", async (event, payload: unknown) => {
    if (!fromSetupWindow(event)) return { ok: false, error: "Setup is not active." };
    // A launch still loading counts too: the switch must open and check its own server.
    if (setupSaveInProgress || appOpener.busy())
      return { ok: false, error: "A connection attempt is already running." };
    setupSaveInProgress = true;
    const previousSetup = currentSetup;
    const previousUrl = currentTargetUrl;
    const previousAccess = activeServerAccess();
    try {
      const setup = parseSetupInput(payload);
      if (setup === null) {
        return {
          ok: false,
          error:
            "Enter a valid server address. Public servers require HTTPS; a new local instance must use localhost.",
        };
      }

      // Only open the exact origin selected and authenticated by the managed stack.
      let openSetup = setup;
      if (setup.mode === "new") {
        const managedUrl = managedLocalOpenUrl(setup.serverUrl, localStack.webUrl());
        if (managedUrl === null || !localStack.ready()) {
          return {
            ok: false,
            error: "The app-managed Quant services are not ready. Retry setup.",
          };
        }
        openSetup = { mode: "new", serverUrl: managedUrl };
      }

      // The gate's Basic Auth, for an existing server that has one.
      const access =
        openSetup.mode === "existing"
          ? parseServerAccess((payload as Record<string, unknown>).access)
          : null;
      const reachability = await probeServer(openSetup.serverUrl, undefined, access);
      if (!reachability.ok) return { ok: false, error: reachability.error };

      // Open before persisting so a failed renderer load keeps the last working setup.
      currentSetup = openSetup;
      setActiveServerAccess(openSetup.serverUrl, access);
      const opened = await appOpener.open(openSetup.serverUrl, { switching: true });
      if (!opened) {
        currentSetup = previousSetup;
        setActiveServerAccess(previousAccess?.origin ?? null, previousAccess?.access ?? null);
        return {
          ok: false,
          error: "Could not open that server. The previous instance was left unchanged.",
        };
      }

      const appWindow = mainWindow;
      const rendererWatch =
        appWindow !== null && !appWindow.isDestroyed()
          ? watchRendererUntilCommitted(appWindow)
          : null;
      try {
        await writeSetup(userDataDir, openSetup);
        await saveServerAccess(userDataDir, safeStorage, openSetup.serverUrl, access);
        if (rendererWatch?.crashed()) {
          const message = await recoverFromCrashedSave(userDataDir, previousSetup, previousUrl);
          return { ok: false, error: message };
        }
        // Commit while the crash listener is still armed.
        commitPendingAppSwitch();
        if (rendererWatch?.crashed()) {
          const message = await recoverFromCrashedSave(userDataDir, previousSetup, previousUrl);
          return { ok: false, error: message };
        }
        destroySetupWindow();
        // Final check after setup closes — a crash in this gap still rolls back.
        if (rendererWatch?.crashed()) {
          const message = await recoverFromCrashedSave(userDataDir, previousSetup, previousUrl);
          return { ok: false, error: message };
        }
        return { ok: true };
      } catch {
        const outcome = abandonPendingAppSwitch(previousSetup, previousUrl);
        return {
          ok: false,
          error:
            outcome === "restored"
              ? "Could not save setup. The previous instance was restored."
              : "Connected, but could not save setup for the next launch. Try Continue again.",
        };
      } finally {
        rendererWatch?.dispose();
      }
    } finally {
      setupSaveInProgress = false;
    }
  });

  ipcMain.handle("desktop.setup.quit", (event) => {
    if (fromSetupWindow(event)) app.quit();
  });
  ipcMain.handle("desktop.setup.stack.state", (event) =>
    fromSetupWindow(event) ? localStack.state() : null,
  );
  ipcMain.handle("desktop.setup.stack.start", (event, payload: unknown) => {
    if (!fromSetupWindow(event)) return null;
    const request =
      payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const gate = parseGateChange(request.access);
    const port = request.port === undefined ? null : parseGatePort(request.port);
    if (gate === null || (request.port !== undefined && port === null)) return localStack.state();
    // Respond right away; the setup window polls `stack.state` until a terminal phase.
    void localStack.start(gate, port);
    return localStack.state();
  });
  ipcMain.handle("desktop.setup.stack.checkPort", async (event, value: unknown) => {
    if (!fromSetupWindow(event)) return null;
    const port = parseGatePort(value);
    if (port === null) return { ok: false, busy: false };
    // The app's own gate holds its port while it runs, so keeping it is never a conflict.
    if ((await readStackGate(stackDir(userDataDir)))?.port === port) return { ok: true };
    return (await gatePortFree(port)) ? { ok: true } : { ok: false, busy: true };
  });

  installTray();
  // Register before startup awaits so macOS dock clicks during probe/open are handled.
  app.on("activate", () => showApp());

  if (target.kind === "setup") {
    showSetupWindow();
  } else if (target.source === "saved") {
    if (currentSetup?.mode === "new") {
      await openLocalServer(userDataDir);
    } else {
      const reachability = await probeServer(target.url);
      if (reachability.ok) {
        if (await appOpener.open(target.url)) {
          commitPendingAppSwitch();
          destroySetupWindow();
        }
      } else {
        showSetupWindow(`Could not reconnect to the saved server. ${reachability.error}`);
      }
    }
  } else {
    if (await appOpener.open(target.url)) {
      commitPendingAppSwitch();
      destroySetupWindow();
    }
  }
});

/**
 * Starts the server this app runs itself and opens it. Setup shows the progress only when the
 * start takes a moment, and stays up with the reason when it fails.
 */
async function openLocalServer(userDataDir: string) {
  // A server this app never ran (an install from the Docker version) is set up with the
  // wizard first, so the person confirms its sign-in and port before anything starts.
  if (!existsSync(path.join(serverDir(userDataDir), "postgres", "PG_VERSION"))) {
    showSetupWindow();
    return;
  }
  const started = localStack.start();
  const quick = await Promise.race([
    started,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), QUIET_START_MS)),
  ]);
  if (quick?.phase !== "ready") {
    showSetupWindow();
    return;
  }
  const url = localStack.webUrl();
  if (!(await appOpener.open(url))) return;
  commitPendingAppSwitch();
  destroySetupWindow();
  // The previous loopback port was taken, so the server moved; remember where it is now.
  if (currentSetup?.serverUrl !== url) {
    currentSetup = { mode: "new", serverUrl: url };
    await writeSetup(userDataDir, currentSetup).catch(() => undefined);
  }
}

/** Brings back whatever window the app has: setup, the app itself, or a fresh one. */
function showApp() {
  if (setupWindow !== null && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    clearTimeout(warmWindowTimer);
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  if (appOpener.busy()) return;
  if (currentTargetUrl === null) showSetupWindow(setupError);
  else
    void appOpener.open(currentTargetUrl).then((opened) => {
      if (opened) commitPendingAppSwitch();
    });
}

const TRAY_LABELS = {
  en: { open: "Open Quant", quit: "Quit Quant" },
  ru: { open: "Открыть Quant", quit: "Выйти из Quant" },
};

/** The app keeps running, and so does its server, while its window is closed. */
function installTray() {
  const assets = app.isPackaged
    ? path.join(process.resourcesPath, "tray")
    : path.join(app.getAppPath(), "assets");
  const image = nativeImage.createFromPath(
    path.join(assets, process.platform === "darwin" ? "trayTemplate.png" : "tray.png"),
  );
  if (process.platform === "darwin") image.setTemplateImage(true);
  const labels = app.getLocale().toLowerCase().startsWith("ru") ? TRAY_LABELS.ru : TRAY_LABELS.en;
  tray = new Tray(image);
  tray.setToolTip("Quant");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { id: "tray-open", label: labels.open, click: () => showApp() },
      { type: "separator" },
      { id: "tray-quit", label: labels.quit, click: () => app.quit() },
    ]),
  );
  // Windows and Linux open the app on a click; macOS shows the menu.
  if (process.platform !== "darwin") tray.on("click", () => showApp());
}

// The tray keeps the app (and its server) running with every window closed; Quit ends it.
app.on("window-all-closed", () => undefined);

app.on("before-quit", (event) => {
  quitting = true;
  clearTimeout(warmWindowTimer);
  // The server runs inside the app, so it stops with it: Postgres gets a clean shutdown.
  if (localStack === undefined || serverStopped || localStack.state().phase === "idle") return;
  event.preventDefault();
  void localStack.stop().finally(() => {
    serverStopped = true;
    tray?.destroy();
    app.quit();
  });
});

/** The commit and native parts this app was built with; written by scripts/build-info.mjs. */
async function readOwnBuild(): Promise<BuildInfo | null> {
  try {
    return JSON.parse(
      await readFile(path.join(app.getAppPath(), "dist", "build-info.json"), "utf8"),
    ) as BuildInfo;
  } catch {
    return null;
  }
}
