import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

const APP_MARKER = "Local Quant server ready";
const GATE_USER = "quant";
const GATE_PASSWORD = "e2e-gate-pw";
const APP_AUTH = {
  "x-quant-auth": `Basic ${Buffer.from(`${GATE_USER}:${GATE_PASSWORD}`).toString("base64")}`,
};

let userData: string;
let resources: string;
let webRoot: string;
let gatePort: number;
let webUrl: string;
let app: ElectronApplication | undefined;

// The stand-in Postgres tools are POSIX shell scripts; Windows desktop e2e does not run in CI.
test.skip(process.platform === "win32", "fake Postgres tools need a POSIX shell");

/** A port nothing listens on, on every interface. */
async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "0.0.0.0", resolve));
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("probe has no port");
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function callLog() {
  return path.join(userData, "calls.log");
}

/**
 * A stand-in for the bundled server: Postgres tools that only record their calls, a migrator,
 * an API that answers health and the local settings route, and a worker that idles. The app
 * runs the scripts with its own binary as Node, exactly as it runs the real bundles.
 */
async function writeFakeServer() {
  const bin = path.join(
    resources,
    "app",
    "node_modules",
    "@embedded-postgres",
    "fake",
    "native",
    "bin",
  );
  await mkdir(bin, { recursive: true });
  await mkdir(path.join(resources, "app"), { recursive: true });
  await mkdir(path.join(resources, "migrations"), { recursive: true });
  const record = (name: string) => `printf '%s %s\\n' '${name}' "$*" >> '${callLog()}'`;
  const scripts: Record<string, string> = {
    initdb: [
      "#!/bin/sh",
      record("initdb"),
      'while [ "$1" != "-D" ]; do shift; done',
      'mkdir -p "$2" && echo 16 > "$2/PG_VERSION"',
    ].join("\n"),
    pg_ctl: ["#!/bin/sh", record("pg_ctl"), '[ "$1" = "status" ] && exit 3', "exit 0"].join("\n"),
  };
  for (const [name, body] of Object.entries(scripts)) {
    await writeFile(path.join(bin, name), `${body}\n`);
    await chmod(path.join(bin, name), 0o755);
  }
  await writeFile(
    path.join(resources, "app", "migrate.mjs"),
    `import { appendFileSync, existsSync } from "node:fs";
appendFileSync(${JSON.stringify(callLog())}, "migrate " + process.argv.slice(2).length + "\\n");
if (existsSync(${JSON.stringify(path.join(userData, "fail-migrate"))})) {
  console.error("relation does not exist");
  process.exit(1);
}
`,
  );
  await writeFile(
    path.join(resources, "app", "api.mjs"),
    `import { createServer } from "node:http";
createServer((request, response) => {
  if (request.url === "/health") return response.end("ok");
  if (request.url === "/rpc/health") {
    response.setHeader("content-type", "application/json");
    return response.end(JSON.stringify({ json: { ok: true, version: "0.1.0" } }));
  }
  if (request.url === "/api/desktop-settings/rpc/integrationSetup/get") {
    const allowed =
      request.headers["x-rakazo-local-settings-token"] === process.env.RAKAZO_DESKTOP_STACK_TOKEN &&
      !request.headers.cookie;
    response.writeHead(allowed ? 200 : 401, { "content-type": "application/json" });
    return response.end(JSON.stringify({ json: { canConfigure: allowed } }));
  }
  response.writeHead(404).end();
}).listen(Number(process.env.API_PORT), "127.0.0.1");
`,
  );
  await writeFile(path.join(resources, "app", "worker.mjs"), "setInterval(() => {}, 60_000);\n");
}

test.beforeEach(async () => {
  userData = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-desktop-server-")));
  resources = path.join(userData, "resources");
  webRoot = path.join(userData, "web");
  await mkdir(webRoot, { recursive: true });
  await writeFile(
    path.join(webRoot, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Quant</title></head><body><main>${APP_MARKER}</main></body></html>`,
  );
  await writeFakeServer();
  gatePort = await freePort();
  webUrl = `http://127.0.0.1:${await freePort()}`;
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(userData, { recursive: true, force: true });
});

function launch() {
  const env: NodeJS.ProcessEnv = { ...process.env, RAKAZO_PERFORMANCE_USER_DATA: userData };
  // A stale RAKAZO_WEB_URL from the developer's shell would bypass setup entirely.
  delete env.RAKAZO_WEB_URL;
  return electron.launch({
    args: ["."],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...env,
      RAKAZO_SERVER_DIR: resources,
      RAKAZO_WEB_ROOT: webRoot,
      RAKAZO_LOCAL_WEB_URL: webUrl,
    },
  });
}

/** Walks the This computer steps: sign-in for other devices, then the port, then Install. */
async function installHere(setup: Page, port = gatePort) {
  await setup.getByRole("button", { name: "Next" }).click();
  await setup.locator("#gate-username").fill(GATE_USER);
  await setup.locator("#gate-password").fill(GATE_PASSWORD);
  await setup.getByRole("button", { name: "Next" }).click();
  await setup.locator("#gate-port").fill(String(port));
  await setup.getByRole("button", { name: "Install" }).click();
}

async function savedSetup() {
  try {
    return JSON.parse(await readFile(path.join(userData, "setup.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function calls() {
  try {
    return (await readFile(callLog(), "utf8")).trim().split("\n");
  } catch {
    return [];
  }
}

function gate(pathname = "/", headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${gatePort}${pathname}`, { headers });
}

test("This computer runs the server inside the app, then opens it", async () => {
  app = await launch();
  const setup = await app.firstWindow();

  await expect(setup.getByRole("radio", { name: /This computer/ })).toBeChecked();
  await expect(setup.getByText("Server inside the app")).toBeVisible();

  // Sign-in for other devices is required, and the port step shows where a tunnel points.
  await setup.getByRole("button", { name: "Next" }).click();
  await expect(setup.getByText("Step 2 of 3")).toBeVisible();
  await setup.getByRole("button", { name: "Next" }).click();
  await expect(setup.locator("#status")).toHaveText("Enter a username.");
  await setup.locator("#gate-username").fill(GATE_USER);
  await setup.getByRole("button", { name: "Next" }).click();
  await expect(setup.locator("#status")).toHaveText("Enter a password.");
  await setup.locator("#gate-password").fill(GATE_PASSWORD);
  await setup.getByRole("button", { name: "Next" }).click();
  await expect(setup.getByText("Step 3 of 3")).toBeVisible();
  await expect(setup.locator("#gate-port")).toHaveValue("8080");
  await expect(setup.locator("#gate-address")).toHaveText("Tunnel address: http://localhost:8080");
  await setup.locator("#gate-port").fill("80");
  await setup.getByRole("button", { name: "Install" }).click();
  await expect(setup.locator("#status")).toHaveText("Enter a port from 1024 to 65535.");
  await setup.locator("#gate-port").fill(String(gatePort));
  await expect(setup.locator("#gate-address")).toHaveText(
    `Tunnel address: http://localhost:${gatePort}`,
  );
  await setup.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "11-setup-port.png"),
  });
  // Nothing runs before Install.
  expect(await calls()).toEqual([]);

  const appWindowPromise = app.waitForEvent("window");
  await setup.getByRole("button", { name: "Install" }).click();
  const appWindow = await appWindowPromise;
  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();
  await expect.poll(savedSetup).toEqual({ mode: "new", serverUrl: webUrl });

  const log = await calls();
  expect(log[0]).toMatch(
    /^initdb -D .* -U rakazo -A scram-sha-256 --pwfile=.* -E UTF8 --locale=C$/,
  );
  expect(log.slice(1)).toEqual([
    expect.stringMatching(/^pg_ctl status -D /),
    expect.stringMatching(/^pg_ctl start -D .* -o -c listen_addresses=127\.0\.0\.1 /),
    "migrate 1",
  ]);

  const envFile = path.join(userData, "stack", ".env");
  expect((await stat(envFile)).mode & 0o777).toBe(0o600);
  const env = await readFile(envFile, "utf8");
  expect(env).toMatch(/^POSTGRES_PASSWORD=[0-9a-f]{32}$/m);
  expect(env).toContain(`QUANT_PORT=${gatePort}\n`);
  expect(env).toContain(`QUANT_BASIC_USER=${GATE_USER}\n`);
  expect(env).not.toContain(GATE_PASSWORD);

  // Other devices get in only through the gate, with its credentials.
  expect((await gate()).status).toBe(401);
  const admitted = await gate("/", { ...APP_AUTH, accept: "text/html" });
  expect(await admitted.text()).toContain(APP_MARKER);
  expect(admitted.headers.get("set-cookie")).toMatch(/^quant_gate=[0-9a-f]{64};/);
});

test("a busy port is refused before anything is installed", async () => {
  const busy = createServer();
  await new Promise<void>((resolve) => busy.listen(0, "0.0.0.0", resolve));
  try {
    const address = busy.address();
    if (address === null || typeof address === "string") throw new Error("busy has no port");
    app = await launch();
    const setup = await app.firstWindow();

    await installHere(setup, address.port);
    await expect(setup.locator("#status")).toHaveText(
      `Port ${address.port} is busy. Choose another.`,
    );
    await expect(setup.getByRole("heading", { name: "Port" })).toBeVisible();
    expect(await calls()).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      busy.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("a failed start shows the output and offers Back and Retry", async () => {
  await writeFile(path.join(userData, "fail-migrate"), "");
  app = await launch();
  const setup = await app.firstWindow();

  await installHere(setup);
  await expect(setup.locator("#stack-phase")).toHaveText(
    "Could not update the database. Check the output below, then retry.",
  );
  await expect(setup.locator("#stack-phase")).toHaveAttribute("data-tone", "error");
  await expect(setup.locator("#stack-output")).toContainText("relation does not exist");
  await expect(setup.getByRole("button", { name: "Back" })).toBeVisible();
  await setup.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "07-setup-server-failed.png"),
  });
  // The database is shut down again rather than left running.
  expect((await calls()).at(-1)).toMatch(/^pg_ctl stop -D /);

  await rm(path.join(userData, "fail-migrate"));
  const appWindowPromise = app.waitForEvent("window");
  await setup.getByRole("button", { name: "Retry" }).click();
  await expect((await appWindowPromise).getByText(APP_MARKER)).toBeVisible();
});

async function saveLocalServer({ started }: { started: boolean }) {
  await writeFile(
    path.join(userData, "setup.json"),
    `${JSON.stringify({ mode: "new", serverUrl: webUrl }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  if (started) {
    await mkdir(path.join(userData, "server", "postgres"), { recursive: true });
    await writeFile(path.join(userData, "server", "postgres", "PG_VERSION"), "16\n");
  }
}

test("a saved local server starts with the app and opens without setup", async () => {
  await saveLocalServer({ started: true });
  app = await launch();
  const appWindow = await app.firstWindow();
  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();
  expect(app.windows()).toHaveLength(1);
  expect(await calls()).toContain("migrate 1");
});

test("a saved server the app never ran opens the wizard on its first step", async () => {
  // An install from the Docker version: setup.json says This computer, but nothing ran here.
  await saveLocalServer({ started: false });
  app = await launch();
  const setup = await app.firstWindow();
  await expect(setup.getByRole("heading", { name: "Where will Quant run?" })).toBeVisible();
  await expect(setup.getByRole("radio", { name: /This computer/ })).toBeChecked();
  expect(await calls()).toEqual([]);
});

test("a launch whose start fails goes back to the first step with the reason", async () => {
  await saveLocalServer({ started: true });
  await writeFile(path.join(userData, "fail-migrate"), "");
  app = await launch();
  const setup = await app.firstWindow();
  await expect(setup.getByRole("heading", { name: "Where will Quant run?" })).toBeVisible();
  await expect(setup.locator("#status")).toHaveText(
    "Could not update the database. Check the output below, then retry.",
  );
  await expect(setup.getByRole("button", { name: "Back" })).toBeHidden();
});

test("closing the window keeps the server running, and quitting stops it", async () => {
  app = await launch();
  const setup = await app.firstWindow();
  const appWindowPromise = app.waitForEvent("window");
  await installHere(setup);
  const appWindow = await appWindowPromise;
  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();

  // Closing the window hides it: the app lives on in the tray, and phones still get in.
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.close();
  });
  await expect
    .poll(() =>
      app?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible()),
      ),
    )
    .toBe(false);
  expect((await gate("/", APP_AUTH)).status).toBe(200);

  const running = app;
  app = undefined;
  const exited = new Promise((resolve) => running.process().once("exit", resolve));
  await running.evaluate(({ app }) => app.quit());
  await exited;
  expect((await calls()).at(-1)).toMatch(/^pg_ctl stop -D /);
  await expect(gate("/", APP_AUTH)).rejects.toThrow();
});

test("an existing stack .env keeps its secrets", async () => {
  const stackDir = path.join(userData, "stack");
  await mkdir(stackDir, { recursive: true });
  await writeFile(path.join(stackDir, ".env"), "POSTGRES_PASSWORD=keep-me\nSENTINEL=1\n", {
    encoding: "utf8",
    mode: 0o600,
  });

  app = await launch();
  const setup = await app.firstWindow();
  const appWindowPromise = app.waitForEvent("window");
  await installHere(setup);
  await expect((await appWindowPromise).getByText(APP_MARKER)).toBeVisible();

  // Only the gate's lines are added; nothing already there is regenerated.
  await expect(readFile(path.join(stackDir, ".env"), "utf8")).resolves.toMatch(
    /^POSTGRES_PASSWORD=keep-me\nSENTINEL=1\nQUANT_BASIC_USER=quant\n/,
  );
});

test("the native settings menu opens an isolated logged-out settings capability", async () => {
  app = await launch();
  const setup = await app.firstWindow();
  const nextWindow = app.waitForEvent("window");
  await installHere(setup);
  const main = await nextWindow;
  await expect(main.getByText(APP_MARKER)).toBeVisible();
  await expect.poll(savedSetup).toEqual({ mode: "new", serverUrl: webUrl });
  const denied = await main.evaluate(async () => {
    try {
      await window.rakazoDesktop?.localSettings?.request(
        "/api/desktop-settings/rpc/integrationSetup/get",
        "{}",
      );
      return false;
    } catch {
      return true;
    }
  });
  expect(denied).toBe(true);
  const settingsOpened = app.waitForEvent("window");
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("local-server-settings");
    if (!item) throw new Error("Missing settings menu");
    item.click();
  });
  const settings = await settingsOpened;
  await expect(settings).toHaveURL(`${webUrl}/desktop-settings`);
  const result = await settings.evaluate(() =>
    window.rakazoDesktop?.localSettings?.request(
      "/api/desktop-settings/rpc/integrationSetup/get",
      "{}",
    ),
  );
  expect(result?.status).toBe(200);
  expect(JSON.parse(result!.body)).toEqual({ json: { canConfigure: true } });
  await settings.close();
  await expect(main.getByText(APP_MARKER)).toBeVisible();
});
