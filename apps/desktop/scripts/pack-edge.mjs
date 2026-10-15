// Packs a desktop build from main: the web app and the server JavaScript, which an installed app
// with the same native parts can swap in without a new installer.
//   out-edge/desktop-edge.tar.gz   web/, server/app/*.mjs, server/migrations/, build-info.json
//   out-edge/desktop-edge.json     what it is, which apps can take it, and its checksum
// Run after `pnpm --filter @rakazo/web build` and `node scripts/build-server.mjs --bundle-only`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildInfo } from "./build-info.mjs";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "..", "..");
const out = path.join(desktop, "out-edge");
const stage = path.join(out, "stage");

await rm(out, { recursive: true, force: true });
await mkdir(path.join(stage, "server", "app"), { recursive: true });
await cp(path.join(root, "apps/web/dist"), path.join(stage, "web"), { recursive: true });
for (const file of ["api.mjs", "worker.mjs", "migrate.mjs"]) {
  await cp(path.join(desktop, "server-dist/app", file), path.join(stage, "server/app", file));
}
await cp(path.join(desktop, "server-dist/migrations"), path.join(stage, "server/migrations"), {
  recursive: true,
});
const info = await buildInfo();
await writeFile(path.join(stage, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);

const archive = path.join(out, "desktop-edge.tar.gz");
execFileSync("tar", ["-czf", archive, "-C", stage, "."], { stdio: "inherit" });
const bytes = await readFile(archive);
await writeFile(
  path.join(out, "desktop-edge.json"),
  `${JSON.stringify(
    {
      ...info,
      asset: "desktop-edge.tar.gz",
      size: (await stat(archive)).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    null,
    2,
  )}\n`,
);
await rm(stage, { recursive: true, force: true });
