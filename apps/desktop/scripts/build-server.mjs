// Builds the Quant server that the desktop app runs itself for "This computer":
//   server-dist/app/*.mjs        API, worker and migrator, bundled with esbuild
//   server-dist/migrations/      the Prisma migrations the migrator applies
//   server-dist/app/node_modules/ native modules the bundles leave external, and Postgres
//                                (nested: electron-builder drops a node_modules at the root)
// electron-builder ships the folder as resources/server.
//
// Usage: node scripts/build-server.mjs [--platform darwin|win32|linux]
// The platform defaults to this machine's. A macOS build carries both arm64 and x64 modules
// because one runner packages both DMGs (the Postgres binaries are already universal).
import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "..", "..");
const out = path.join(desktop, "server-dist");

const platformFlag = process.argv.indexOf("--platform");
const platform = platformFlag === -1 ? process.platform : process.argv[platformFlag + 1];
const ARCHES = { darwin: ["arm64", "x64"], win32: ["x64"], linux: ["x64"] };
const POSTGRES = {
  darwin: "@embedded-postgres/darwin-arm64",
  win32: "@embedded-postgres/windows-x64",
  linux: "@embedded-postgres/linux-x64",
};
const POSTGRES_VERSION = "16.14.0-beta.17";
/** Native or file-reading modules that do not survive bundling. */
const EXTERNAL = ["sharp", "koffi", "jsdom"];
if (!ARCHES[platform]) throw new Error(`Unsupported platform: ${platform}`);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: {
    api: path.join(root, "apps/api/src/index.ts"),
    worker: path.join(root, "apps/worker/src/index.ts"),
    migrate: path.join(desktop, "server/migrate-entry.ts"),
  },
  outdir: path.join(out, "app"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outExtension: { ".js": ".mjs" },
  external: EXTERNAL,
  // Workspace packages point their `development` export at TypeScript sources.
  conditions: ["development"],
  // CommonJS dependencies inside an ES module bundle still expect these globals.
  banner: {
    js: [
      "import { createRequire as __quantRequire } from 'node:module';",
      "import { fileURLToPath as __quantPath } from 'node:url';",
      "const require = __quantRequire(import.meta.url);",
      "const __filename = __quantPath(import.meta.url);",
      "const __dirname = __quantPath(new URL('.', import.meta.url));",
    ].join(" "),
  },
  logLevel: "warning",
});

await cp(path.join(root, "packages/db/prisma/migrations"), path.join(out, "migrations"), {
  recursive: true,
});

const adapters = JSON.parse(
  await readFile(path.join(root, "packages/adapters/package.json"), "utf8"),
);
const dependencies = Object.fromEntries(
  EXTERNAL.map((name) => [name, adapters.dependencies[name]]),
);
dependencies[POSTGRES[platform]] = POSTGRES_VERSION;
// sharp and koffi load their binaries from per-platform packages; list each target one.
for (const name of ["sharp", "koffi"]) {
  const optional = JSON.parse(
    execFileSync(
      "npm",
      ["view", `${name}@${dependencies[name]}`, "optionalDependencies", "--json"],
      {
        encoding: "utf8",
        shell: process.platform === "win32",
      },
    ),
  );
  for (const [pkg, version] of Object.entries(optional)) {
    if (ARCHES[platform].some((arch) => pkg.endsWith(`-${platform}-${arch}`))) {
      dependencies[pkg] = version;
    }
  }
}
await writeFile(
  path.join(out, "app", "package.json"),
  `${JSON.stringify({ name: "quant-server", private: true, type: "module", dependencies }, null, 2)}\n`,
);
// --force installs the other architecture's sharp packages; scripts stay off because every
// module here ships prebuilt binaries and Postgres links are restored below as plain copies.
execFileSync(
  "npm",
  [
    "install",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    "--force",
    "--no-package-lock",
  ],
  { cwd: path.join(out, "app"), stdio: "inherit", shell: process.platform === "win32" },
);

// The Postgres package lists its library aliases instead of shipping symlinks. Only the aliases
// a binary actually loads are needed; a library nothing names directly is renamed, not copied.
const postgres = path.join(out, "app", "node_modules", POSTGRES[platform], "native");
const binaries = await Promise.all(
  (await readdir(postgres, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".json"))
    .filter((entry) => !entry.parentPath.includes(`${path.sep}share`))
    .map(async (entry) => ({
      name: entry.name,
      content: await readFile(path.join(entry.parentPath, entry.name), "latin1"),
    })),
);
// A library names itself as its install name, which is not a load.
const loaded = (name) => binaries.some((file) => file.name !== name && file.content.includes(name));
const links = JSON.parse(await readFile(path.join(postgres, "pg-symlinks.json"), "utf8"));
const bySource = Map.groupBy(links, (link) => link.source);
for (const [source, group] of bySource) {
  const needed = group.map((link) => link.target).filter((target) => loaded(path.basename(target)));
  const from = path.join(postgres, "..", source);
  if (needed.length === 1 && !loaded(path.basename(source))) {
    await rename(from, path.join(postgres, "..", needed[0]));
  } else {
    for (const target of needed) await cp(from, path.join(postgres, "..", target));
  }
}
