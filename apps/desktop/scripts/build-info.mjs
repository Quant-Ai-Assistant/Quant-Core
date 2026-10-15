// Writes what a build is made of: its commit and the key that says which installed apps can run
// its web app and server JavaScript. Usage: node scripts/build-info.mjs <out.json>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXTERNAL, POSTGRES_VERSION, SHELL_CONTRACT } from "./server-deps.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "..", "..");

export async function buildInfo() {
  const desktopPackage = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"));
  const adapters = JSON.parse(
    await readFile(path.join(root, "packages/adapters/package.json"), "utf8"),
  );
  const compat = createHash("sha256")
    .update(
      JSON.stringify({
        shell: SHELL_CONTRACT,
        electron: desktopPackage.devDependencies.electron,
        postgres: POSTGRES_VERSION,
        external: Object.fromEntries(EXTERNAL.map((name) => [name, adapters.dependencies[name]])),
      }),
    )
    .digest("hex")
    .slice(0, 16);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  return {
    sha: process.env.GITHUB_SHA || git("rev-parse", "HEAD"),
    committedAt: git("log", "-1", "--format=%cI", process.env.GITHUB_SHA || "HEAD"),
    compat,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) throw new Error("Usage: node scripts/build-info.mjs <out.json>");
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(out, `${JSON.stringify(await buildInfo(), null, 2)}\n`);
}
