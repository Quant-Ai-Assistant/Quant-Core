import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

const APP_MARKER = "Local Quant stack ready";
const IMAGE_TAG = "v9.9.9";
const STACK_PROBE_PATH = "/.well-known/rakazo-desktop-stack";
const STACK_TOKEN_HEADER = "x-rakazo-desktop-stack-token";
const COMPOSE_DIR = path.resolve(import.meta.dirname, "..", "..", "..", "infra", "compose");
const GATE_HASH = `$2a$14$${"a".repeat(53)}`;

type FakeDockerMode =
  | "ok"
  | "daemon-down"
  | "pull-fails"
  | "pool-exhausted"
  | "port-conflict"
  | "ports-exhausted";

let server: Server;
let serverUrl: string;
let userData: string;
let gatePort: number;
let app: ElectronApplication | undefined;

// The fake docker is a POSIX shell script; Windows desktop e2e does not run in CI.
test.skip(process.platform === "win32", "fake docker needs a POSIX shell");

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    if (request.url === STACK_PROBE_PATH && request.method === "GET") {
      const expected = await readFile(path.join(userData, "stack", ".desktop-stack-token"), "utf8")
        .then((value) => value.trim())
        .catch(() => null);
      if (expected === null || request.headers[STACK_TOKEN_HEADER] !== expected) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, imageTag: IMAGE_TAG }));
      return;
    }
    if (request.url === "/api/desktop-settings/rpc/integrationSetup/get") {
      const expected = await readFile(path.join(userData, "stack", ".desktop-stack-token"), "utf8");
      if (
        request.headers["x-rakazo-local-settings-token"] !== expected.trim() ||
        request.headers.cookie
      ) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ json: { canConfigure: true } }));
      return;
    }
    if (request.url === "/rpc/health" && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ json: { ok: true, version: "0.1.0" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Quant</title></head><body><main>${APP_MARKER}</main></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("stub server has no port");
  serverUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test.beforeEach(async () => {
  // The fake docker logs $PWD, which is the resolved path (macOS /var is a symlink).
  userData = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-desktop-stack-")));
  gatePort = await freePort();
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(userData, { recursive: true, force: true });
});

/** A port nothing listens on, for the gate the fake docker never actually binds. */
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

/** Walks the This computer steps: sign-in for other devices, then the port, then Install. */
async function installHere(setup: Page, port = gatePort) {
  await setup.getByRole("button", { name: "Next" }).click();
  await setup.locator("#gate-username").fill("quant");
  await setup.locator("#gate-password").fill("e2e-gate-pw");
  await setup.getByRole("button", { name: "Next" }).click();
  await setup.locator("#gate-port").fill(String(port));
  await setup.getByRole("button", { name: "Install" }).click();
}

function fakeDockerLog() {
  return path.join(userData, "fake-docker.log");
}

/**
 * Stands in for the docker CLI: records `cwd | RAKAZO_IMAGE_TAG | argv` for every call and
 * answers the handful of commands the app issues. The log path and mode are baked into the
 * script because the app passes docker an allowlisted environment.
 */
async function writeFakeDocker(mode: FakeDockerMode) {
  const script = path.join(userData, "fake-docker.sh");
  let up = '  up) echo "Container rakazo-web-1 Started"; exit 0 ;;';
  if (mode === "pool-exhausted") {
    up = '  up) echo "all predefined address pools have been fully subnetted" >&2; exit 1 ;;';
  } else if (mode === "ports-exhausted") {
    up = '  up) echo "port is already allocated" >&2; exit 1 ;;';
  } else if (mode === "port-conflict") {
    up = `  up) if [ ! -f '${path.join(userData, "port-conflict")}' ]; then touch '${path.join(userData, "port-conflict")}'; echo "port is already allocated" >&2; exit 1; fi; echo "Container rakazo-web-1 Started"; exit 0 ;;`;
  }
  const lines = [
    "#!/bin/sh",
    `printf '%s | %s | %s\\n' "$PWD" "$RAKAZO_IMAGE_TAG" "$*" >> '${fakeDockerLog()}'`,
    'case "$1 $2" in',
    '  "compose version") echo "2.29.0"; exit 0 ;;',
    '  "info --format")',
    mode === "daemon-down"
      ? '    echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1 ;;'
      : '    echo "27.1.1"; exit 0 ;;',
    "esac",
    "# compose --env-file .env -f docker-compose.images.yml --project-name quant-desktop <command> ...",
    'case "$8" in',
    `  run) echo '${GATE_HASH}'; exit 0 ;;`,
    "  pull)",
    mode === "pull-fails"
      ? '    echo "Error response from daemon: manifest unknown" >&2; exit 1 ;;'
      : '    echo " a235d761c5d1 Downloading 59.47MB"; echo " a235d761c5d1 Downloading 412.3MB"; echo "app Pulled"; sleep 2; echo "computer Pulled"; exit 0 ;;',
    up,
    '  logs) echo "web-1 | listening"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ];
  await writeFile(script, lines.join("\n"), { encoding: "utf8", mode: 0o755 });
  return script;
}

async function launch(mode: FakeDockerMode | "missing") {
  const env: NodeJS.ProcessEnv = { ...process.env, RAKAZO_PERFORMANCE_USER_DATA: userData };
  // A stale RAKAZO_WEB_URL from the developer's shell would bypass setup entirely.
  delete env.RAKAZO_WEB_URL;
  return electron.launch({
    args: ["."],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...env,
      RAKAZO_DOCKER_BINARY:
        mode === "missing" ? "/nonexistent/docker" : await writeFakeDocker(mode),
      RAKAZO_LOCAL_WEB_URL: serverUrl,
      RAKAZO_IMAGE_TAG: IMAGE_TAG,
    },
  });
}

async function savedSetup() {
  try {
    return JSON.parse(await readFile(path.join(userData, "setup.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readLog() {
  try {
    return (await readFile(fakeDockerLog(), "utf8")).trim().split("\n");
  } catch {
    return [];
  }
}

test("This computer installs and starts the stack, then opens the app", async () => {
  app = await launch("ok");
  const setup = await app.firstWindow();

  await expect(setup.getByRole("radio", { name: /This computer/ })).toBeChecked();

  // Sign-in for other devices is required, and the port step shows where a tunnel points.
  await setup.getByRole("button", { name: "Next" }).click();
  await expect(setup.getByText("Step 2 of 3")).toBeVisible();
  await setup.getByRole("button", { name: "Next" }).click();
  await expect(setup.locator("#status")).toHaveText("Enter a username.");
  await setup.locator("#gate-username").fill("quant");
  await setup.getByRole("button", { name: "Next" }).click();
  await expect(setup.locator("#status")).toHaveText("Enter a password.");
  await setup.locator("#gate-password").fill("e2e-gate-pw");
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
  expect(await readLog()).toEqual([]);

  const appWindowPromise = app.waitForEvent("window");
  await setup.getByRole("button", { name: "Install" }).click();
  await expect(setup.locator("#stack-phase")).toHaveText("Downloading Quant…");
  await expect(setup.locator("#install-address")).toHaveText(
    `Tunnel address: http://localhost:${gatePort}`,
  );
  await expect(setup.getByRole("button", { name: "Back" })).toBeHidden();
  // Docker output stays behind the details toggle; the phase, the bar, and the size show by default.
  await expect(setup.locator("#stack-detail")).toHaveText("412 MB downloaded");
  await expect(setup.locator("#stack-progress")).toBeVisible();
  await expect(setup.locator("#stack-output")).toBeHidden();
  await setup.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "06-setup-installing.png"),
    // Fast-forward the bar's width transition so the artifact shows the value, not a frame of it.
    animations: "disabled",
  });
  await setup.getByRole("button", { name: "Technical details" }).click();
  await expect(setup.locator("#stack-output")).toContainText("app Pulled");

  const appWindow = await appWindowPromise;
  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();
  await expect.poll(savedSetup).toEqual({ mode: "new", serverUrl });

  const stackDir = path.join(userData, "stack");
  const envFile = path.join(stackDir, ".env");
  const tokenFile = path.join(stackDir, ".desktop-stack-token");
  expect((await stat(envFile)).mode & 0o777).toBe(0o600);
  expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
  expect(await readFile(tokenFile, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
  const env = await readFile(envFile, "utf8");
  expect(env).toMatch(/^POSTGRES_PASSWORD=[0-9a-f]{32}$/m);
  expect(env).toMatch(/^BETTER_AUTH_SECRET=[0-9a-f]{64}$/m);
  expect(env).not.toContain("RAKAZO_IMAGE_TAG=");
  expect(env).not.toContain("RAKAZO_COMPUTER_IMAGE_TAG=");
  expect(env).toContain(`QUANT_PORT=${gatePort}\n`);
  expect(env).toContain("QUANT_BASIC_USER=quant\n");
  expect(env).not.toContain("e2e-gate-pw");
  await expect(readFile(path.join(stackDir, "docker-compose.images.yml"), "utf8")).resolves.toBe(
    await readFile(path.join(COMPOSE_DIR, "docker-compose.images.yml"), "utf8"),
  );

  const compose =
    "compose --env-file .env -f docker-compose.images.yml --project-name quant-desktop";
  expect(await readLog()).toEqual([
    `${stackDir} | ${IMAGE_TAG} | compose version --short`,
    `${stackDir} | ${IMAGE_TAG} | info --format {{.ServerVersion}}`,
    `${stackDir} | ${IMAGE_TAG} | ${compose} pull`,
    `${stackDir} | ${IMAGE_TAG} | ${compose} run --rm --no-deps -T -e QUANT_HASH_INPUT gate sh -c caddy hash-password --plaintext "$QUANT_HASH_INPUT"`,
    `${stackDir} | ${IMAGE_TAG} | ${compose} up -d --wait --wait-timeout 300`,
  ]);
});

test("without Docker the app explains how to get it and offers to check again", async () => {
  app = await launch("missing");
  const setup = await app.firstWindow();

  await installHere(setup);
  await expect(setup.locator("#stack-phase")).toHaveText(
    "Docker is not installed on this computer.",
  );
  await expect(setup.locator("#stack-phase")).toHaveAttribute("data-tone", "error");
  await expect(setup.getByRole("button", { name: "Docker Desktop" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "OrbStack" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Docker Engine" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Check again" })).toBeEnabled();
  await setup.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "07-setup-docker-missing.png"),
  });

  // Another server stays available without Docker.
  for (let step = 0; step < 3; step += 1) {
    await setup.getByRole("button", { name: "Back" }).click();
  }
  await setup.getByRole("radio", { name: /Another server/ }).check();
  await setup.getByRole("button", { name: "Next" }).click();
  await expect(setup.getByRole("button", { name: "Continue" })).toBeEnabled();
  expect(await savedSetup()).toBeNull();
});

test("a busy port is refused before anything is installed", async () => {
  const busy = createServer();
  await new Promise<void>((resolve) => busy.listen(0, "0.0.0.0", resolve));
  try {
    const address = busy.address();
    if (address === null || typeof address === "string") throw new Error("busy has no port");
    app = await launch("ok");
    const setup = await app.firstWindow();

    await installHere(setup, address.port);
    await expect(setup.locator("#status")).toHaveText(
      `Port ${address.port} is busy. Choose another.`,
    );
    await expect(setup.getByRole("heading", { name: "Port" })).toBeVisible();
    expect(await readLog()).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      busy.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("a stopped Docker daemon is reported and Check again asks Docker once more", async () => {
  app = await launch("daemon-down");
  const setup = await app.firstWindow();

  await installHere(setup);
  await expect(setup.locator("#stack-phase")).toHaveText(
    "Docker is installed but not running. Start Docker, then check again.",
  );
  await expect(setup.getByRole("button", { name: "Docker Desktop" })).toBeVisible();
  expect((await readLog()).filter((line) => line.includes("info --format"))).toHaveLength(1);

  await setup.getByRole("button", { name: "Check again" }).click();
  await expect(setup.getByRole("button", { name: "Check again" })).toBeEnabled();
  expect((await readLog()).filter((line) => line.includes("info --format"))).toHaveLength(2);
  expect((await readLog()).some((line) => line.includes(" pull"))).toBe(false);
});

test("unpublished images show the docker output and a Retry button", async () => {
  app = await launch("pull-fails");
  const setup = await app.firstWindow();

  await installHere(setup);
  await expect(setup.locator("#stack-phase")).toHaveText(
    `Images for ${IMAGE_TAG} are not published yet. Try again in a few minutes.`,
  );
  await expect(setup.locator("#stack-output")).toContainText("manifest unknown");
  await expect(setup.getByRole("button", { name: "Retry" })).toBeEnabled();
  await expect(setup.locator("#stack-docker-help")).toBeHidden();
  expect((await readLog()).some((line) => line.endsWith(" up -d --wait --wait-timeout 300"))).toBe(
    false,
  );
});

test("a saved local stack that is down is started again without asking", async () => {
  // Nothing listens on the saved address, so the launch probe fails and the stack is restarted.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("probe has no port");
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  await writeFile(
    path.join(userData, "setup.json"),
    `${JSON.stringify({ mode: "new", serverUrl: `http://127.0.0.1:${address.port}` }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  app = await launch("ok");
  const setup = await app.firstWindow();
  await expect(setup.getByRole("heading", { name: "Installing Quant" })).toBeVisible();
  await expect(setup.locator("#stack-phase")).not.toBeEmpty();
  await expect(setup.locator("#status")).toBeEmpty();

  const appWindow = await app.waitForEvent("window");
  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();
  await expect.poll(savedSetup).toEqual({ mode: "new", serverUrl });
  expect((await readLog()).some((line) => line.includes(" pull"))).toBe(true);
});

test("a saved local stack is reused only after its private identity matches", async () => {
  const stackDir = path.join(userData, "stack");
  await mkdir(stackDir, { recursive: true });
  await writeFile(path.join(stackDir, ".desktop-stack-token"), `${"ab".repeat(32)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(
    path.join(userData, "setup.json"),
    `${JSON.stringify({ mode: "new", serverUrl }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  app = await launch("ok");
  const appWindow = await app.firstWindow();
  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();
  expect(await readLog()).toEqual([]);
});

test("a saved local target is the exact origin authenticated before reuse", async () => {
  const uncheckedServer = createServer((request, response) => {
    if (request.url === "/rpc/health" && request.method === "POST") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ json: { ok: true, version: "0.1.0" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body>Unchecked listener</body></html>");
  });
  await new Promise<void>((resolve) => uncheckedServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = uncheckedServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("unchecked server has no port");
    }
    const stackDir = path.join(userData, "stack");
    await mkdir(stackDir, { recursive: true });
    await writeFile(path.join(stackDir, ".desktop-stack-token"), `${"ab".repeat(32)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeFile(
      path.join(userData, "setup.json"),
      `${JSON.stringify(
        { mode: "new", serverUrl: `http://127.0.0.1:${address.port}` },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    app = await launch("ok");
    const setup = await app.firstWindow();
    await expect(setup.getByRole("heading", { name: "Installing Quant" })).toBeVisible();
    await expect(setup.getByText("Unchecked listener")).toHaveCount(0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      uncheckedServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("an existing stack .env keeps its secrets", async () => {
  const stackDir = path.join(userData, "stack");
  await mkdir(stackDir, { recursive: true });
  const sentinel = "POSTGRES_PASSWORD=keep-me\nSENTINEL=1\n";
  await writeFile(path.join(stackDir, ".env"), sentinel, { encoding: "utf8", mode: 0o600 });

  app = await launch("ok");
  const setup = await app.firstWindow();
  const appWindowPromise = app.waitForEvent("window");
  await installHere(setup);
  const appWindow = await appWindowPromise;
  await expect(appWindow.getByText(APP_MARKER)).toBeVisible();

  // Only the gate's lines are added; nothing already there is regenerated.
  await expect(readFile(path.join(stackDir, ".env"), "utf8")).resolves.toMatch(
    /^POSTGRES_PASSWORD=keep-me\nSENTINEL=1\nQUANT_BASIC_USER=quant\n/,
  );
});

test("exhausted address pools explain recovery", async () => {
  app = await launch("pool-exhausted");
  const setup = await app.firstWindow();
  await installHere(setup);
  await expect(setup.locator("#stack-phase")).toHaveText(
    "Docker has no free network address pools. Remove unused Docker networks or expand Docker’s address pools, then retry.",
  );
  await expect(setup.getByRole("button", { name: "Retry" })).toBeEnabled();
  await setup.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "09-setup-address-pool-exhausted.png"),
  });
});

test("a port conflict opens and saves the replacement managed origin", async () => {
  app = await launch("port-conflict");
  const setup = await app.firstWindow();
  const appWindowPromise = app.waitForEvent("window");
  await installHere(setup);
  const urlFile = path.join(userData, "stack", ".desktop-web-url");
  let replacementUrl = "";
  await expect
    .poll(async () => {
      replacementUrl = await readFile(urlFile, "utf8").catch(() => "");
      return replacementUrl !== "" && replacementUrl !== serverUrl;
    })
    .toBe(true);
  // Stand in for the web container Docker would bind to the selected port.
  const replacement = createServer(server.listeners("request")[0] as RequestListener);
  await new Promise<void>((resolve) =>
    replacement.listen(Number(new URL(replacementUrl).port), "127.0.0.1", resolve),
  );
  try {
    const appWindow = await appWindowPromise;
    await expect(appWindow.getByText(APP_MARKER)).toBeVisible();
    await expect.poll(savedSetup).toEqual({ mode: "new", serverUrl: replacementUrl });
    expect((await readLog()).filter((line) => line.includes(" up -d"))).toHaveLength(2);
  } finally {
    replacement.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      replacement.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("repeated port conflicts stop with a retry action", async () => {
  app = await launch("ports-exhausted");
  const setup = await app.firstWindow();
  await installHere(setup);
  await expect(setup.locator("#stack-phase")).toHaveText(
    "Could not bind a local port after retrying. Retry to choose another port.",
  );
  await expect(setup.getByRole("button", { name: "Retry" })).toBeEnabled();
  expect((await readLog()).filter((line) => line.includes(" up -d"))).toHaveLength(3);
  await setup.screenshot({
    path: path.join(import.meta.dirname, "screenshots", "10-setup-ports-unavailable.png"),
  });
});

test("the native settings menu opens an isolated logged-out settings capability", async () => {
  app = await launch("ok");
  const setup = await app.firstWindow();
  const nextWindow = app.waitForEvent("window");
  await installHere(setup);
  const main = await nextWindow;
  await expect(main.getByText(APP_MARKER)).toBeVisible();
  await expect.poll(savedSetup).toEqual({ mode: "new", serverUrl });
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
  await expect(settings).toHaveURL(`${serverUrl}/desktop-settings`);
  const result = await settings.evaluate(() =>
    window.rakazoDesktop?.localSettings?.request(
      "/api/desktop-settings/rpc/integrationSetup/get",
      "{}",
    ),
  );
  expect(result?.status).toBe(200);
  expect(JSON.parse(result!.body)).toEqual({ json: { canConfigure: true } });
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.getMenuItemById("local-server-settings")?.click(),
  );
  expect(app.windows()).toHaveLength(2);
  await settings.close();
  await expect(main.getByText(APP_MARKER)).toBeVisible();
});
