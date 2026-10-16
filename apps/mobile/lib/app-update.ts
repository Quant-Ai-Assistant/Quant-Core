import * as Application from "expo-application";
import { DownloadTask, File, Paths } from "expo-file-system";
import * as IntentLauncher from "expo-intent-launcher";

/** Releases publish the Android build as this asset; the tag's patch number is its versionCode. */
export const RELEASES_API =
  "https://api.github.com/repos/Quant-Ai-Assistant/Quant-Core/releases/latest";
export const APK_ASSET = "quant.apk";
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const FLAG_GRANT_READ_URI_PERMISSION = 1;
const FLAG_ACTIVITY_NEW_TASK = 0x10000000;

export type AppUpdate =
  | { available: false; current: number | null }
  | {
      available: true;
      current: number | null;
      versionCode: number;
      tag: string;
      apkUrl: string;
      /** The APK's size in bytes, when GitHub reports it. */
      size: number | null;
    };

type Release = {
  tag_name?: unknown;
  assets?: Array<{ name?: unknown; browser_download_url?: unknown; size?: unknown }>;
};

/** The versionCode a release tag carries: `v0.1.42` is build 42. */
export function releaseVersionCode(tag: string): number | null {
  const match = RELEASE_TAG.exec(tag);
  return match ? Number(match[3]) : null;
}

/** The installed version as people read it, such as `0.1.20`. */
export function installedVersionName(): string | null {
  return Application.nativeApplicationVersion || null;
}

export function installedVersionCode(): number | null {
  const build = Number(Application.nativeBuildVersion);
  return Number.isInteger(build) && build > 0 ? build : null;
}

/** Compares the newest GitHub release with the running build. */
export async function checkForAppUpdate(fetchImpl: typeof fetch = fetch): Promise<AppUpdate> {
  const current = installedVersionCode();
  const response = await fetchImpl(RELEASES_API, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const release = (await response.json()) as Release;
  const tag = typeof release.tag_name === "string" ? release.tag_name : "";
  const versionCode = releaseVersionCode(tag);
  const asset = release.assets?.find((candidate) => candidate.name === APK_ASSET);
  const apkUrl = typeof asset?.browser_download_url === "string" ? asset.browser_download_url : "";
  if (versionCode === null || !apkUrl.startsWith("https://")) return { available: false, current };
  if (current !== null && versionCode <= current) return { available: false, current };
  const size = typeof asset?.size === "number" && asset.size > 0 ? asset.size : null;
  return { available: true, current, versionCode, tag, apkUrl, size };
}

/**
 * Downloads the APK, reporting bytes as they arrive, and hands it to Android's installer, which
 * asks the user to confirm. The signal cancels the download.
 */
export async function installAppUpdate(
  update: Extract<AppUpdate, { available: true }>,
  options: {
    onProgress?: (received: number, total: number | null) => void;
    signal?: AbortSignal;
  } = {},
) {
  const target = new File(Paths.cache, `quant-${update.versionCode}.apk`);
  if (target.exists) target.delete();
  const task = new DownloadTask(update.apkUrl, target, {
    signal: options.signal,
    onProgress: ({ bytesWritten, totalBytes }) =>
      options.onProgress?.(bytesWritten, totalBytes > 0 ? totalBytes : update.size),
  });
  const downloaded = await task.downloadAsync();
  if (!downloaded) return;
  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: downloaded.contentUri,
    type: "application/vnd.android.package-archive",
    flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
  });
}
