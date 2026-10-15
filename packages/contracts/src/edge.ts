/**
 * Fast updates built from main (the `edge` pre-release, see .github/workflows/edge.yml). Desktop
 * apps and Quant servers read them here; Android apps read them through their own server.
 */
export { EDGE_DOWNLOAD_URL } from "./edge-download.js";

/** A desktop build from main: the web app and server JavaScript (apps/desktop/scripts/pack-edge.mjs). */
export interface DesktopEdgeManifest {
  sha: string;
  committedAt: string;
  /** Installed apps whose native parts match take it; see apps/desktop/scripts/build-info.mjs. */
  compat: string;
  asset: string;
  size: number;
  sha256: string;
}

/** One file of an Android over-the-air update (apps/mobile/scripts/pack-edge.mjs). */
export interface MobileEdgeFile {
  key: string;
  name: string;
  hash: string;
  contentType: string;
  fileExtension: string;
}

export interface MobileEdgeManifest {
  id: string;
  createdAt: string;
  sha: string;
  runtimeVersion: string;
  launchAsset: MobileEdgeFile;
  assets: MobileEdgeFile[];
}
