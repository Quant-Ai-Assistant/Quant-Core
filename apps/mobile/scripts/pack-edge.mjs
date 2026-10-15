// Packs an over-the-air update from main for Android: the JavaScript bundle and assets that
// `expo export` produced, named by content, plus the manifest a Quant server hands the app.
//   out-edge/<md5>.<ext>      every file the update needs
//   out-edge/mobile-edge.json what the server turns into an Expo Updates manifest
// Usage: node scripts/pack-edge.mjs <runtimeVersion>   (after `expo export --platform android
// --output-dir dist-edge`; the runtime version comes from `expo-updates runtimeversion:resolve`).
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const mobile = path.resolve(import.meta.dirname, "..");
const dist = path.join(mobile, "dist-edge");
const out = path.join(mobile, "out-edge");
const runtimeVersion = process.argv[2];
if (!runtimeVersion) throw new Error("Usage: node scripts/pack-edge.mjs <runtimeVersion>");

const CONTENT_TYPES = {
  bundle: "application/javascript",
  hbc: "application/javascript",
  js: "application/javascript",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  otf: "font/otf",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  json: "application/json",
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

/** Expo Updates names a file by its MD5 and checks it by its base64url SHA-256. */
async function entry(relative, ext, launch = false) {
  const bytes = await readFile(path.join(dist, relative));
  const key = createHash("md5").update(bytes).digest("hex");
  const fileExtension = launch ? ".bundle" : `.${ext}`;
  const name = `${key}${fileExtension}`;
  await copyFile(path.join(dist, relative), path.join(out, name));
  return {
    key,
    name,
    hash: createHash("sha256").update(bytes).digest("base64url"),
    contentType: CONTENT_TYPES[launch ? "bundle" : ext] ?? "application/octet-stream",
    fileExtension,
  };
}

const metadata = JSON.parse(await readFile(path.join(dist, "metadata.json"), "utf8"));
const android = metadata.fileMetadata?.android;
if (!android?.bundle) throw new Error("expo export produced no Android bundle");
const launchAsset = await entry(android.bundle, "bundle", true);
const assets = [];
for (const asset of android.assets ?? []) assets.push(await entry(asset.path, asset.ext));

const git = (...args) => execFileSync("git", args, { cwd: mobile, encoding: "utf8" }).trim();
await writeFile(
  path.join(out, "mobile-edge.json"),
  `${JSON.stringify(
    {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      sha: process.env.GITHUB_SHA || git("rev-parse", "HEAD"),
      runtimeVersion,
      launchAsset,
      assets,
    },
    null,
    2,
  )}\n`,
);
