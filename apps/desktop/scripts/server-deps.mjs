// What the bundled server needs besides its own JavaScript. A build from main can replace the
// JavaScript in place only while these match the installed app; see build-info.mjs.
export const ARCHES = { darwin: ["arm64", "x64"], win32: ["x64"], linux: ["x64"] };
export const POSTGRES = {
  darwin: "@embedded-postgres/darwin-arm64",
  win32: "@embedded-postgres/windows-x64",
  linux: "@embedded-postgres/linux-x64",
};
export const POSTGRES_VERSION = "16.14.0-beta.17";
/** Native or file-reading modules that do not survive bundling. */
export const EXTERNAL = ["sharp", "koffi", "jsdom"];
/**
 * Bump when the app's main process and the bundled server or web app stop understanding each
 * other (environment, files, IPC), so installed apps wait for a full release instead.
 */
export const SHELL_CONTRACT = 1;
