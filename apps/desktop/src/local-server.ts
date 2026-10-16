import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import type { DesktopLocalStackState } from "@rakazo/contracts";
import {
  classifyDockerFailure,
  dockerSpawnEnv,
  type RunDocker,
  resolveDockerBinary,
} from "./docker-cli.js";
import type { FrontGate, FrontServer, FrontServerOptions } from "./front-server.js";
import type { LaunchProcess, ServerProcess } from "./server-processes.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

/**
 * The Quant server the app runs itself for "This computer": its own Postgres, the API and
 * worker as child processes of the app, and a web front with the gate for other devices.
 * Nothing runs in Docker, and nothing keeps running once the app quits.
 *
 * Settings stay in `stack/` where the Compose stack of earlier versions kept them, so an
 * install made with Docker keeps its secrets, its gate and its port. Its data is moved in
 * once, from the Docker containers, the first time the app starts the server itself.
 */
export const STACK_DIR_NAME = "stack";
export const SERVER_DIR_NAME = "server";
export const STACK_ENV_TEMPLATE = ".env.images.example";
export const STACK_ENV_FILE = ".env";
export const STACK_WEB_URL_FILE = ".desktop-web-url";
export const STACK_TOKEN_FILE = ".desktop-stack-token";
/** Earlier versions ran the server with Docker Compose from this file. */
export const LEGACY_COMPOSE_FILE = "docker-compose.images.yml";
export const LEGACY_PROJECT_NAME = "quant-desktop";
/** The Compose stack's own images, which an earlier install already has. */
export const LEGACY_POSTGRES_IMAGE = "postgres:16";
export const LEGACY_COPY_IMAGE = "busybox:1";
const LEGACY_READY_ATTEMPTS = 60;
/** Written once the Compose stack's data lives in the app. */
export const LEGACY_MOVED_FILE = ".moved-to-app";
/** The port setup suggests for the gate; the person may choose another one. */
export const GATE_DEFAULT_PORT = 8080;
export const GATE_PORT_MIN = 1024;
export const GATE_PORT_MAX = 65535;
export const STACK_OUTPUT_LINES = 20;
export const STACK_HEALTH_TIMEOUT_MS = 120_000;

const HEALTH_POLL_INTERVAL_MS = 500;
const POSTGRES_TIMEOUT_MS = 120_000;
const MIGRATE_TIMEOUT_MS = 10 * 60_000;
const LEGACY_DUMP_TIMEOUT_MS = 30 * 60_000;
const LEGACY_STEP_TIMEOUT_MS = 5 * 60_000;
const RESTART_DELAY_MS = 2_000;
const DOCKER_PROBE_TIMEOUT_MS = 5_000;
/** The desktop image a bot's virtual desktop runs, unless `.env` names another. */
export const COMPUTER_IMAGE = "ghcr.io/quant-ai-assistant/quant-core/computer:latest";
const MAX_STACK_TOKEN_BYTES = 1024;
const MAX_STACK_ENV_BYTES = 256 * 1024;

export function stackDir(userDataDir: string): string {
  return path.join(userDataDir, STACK_DIR_NAME);
}

export function serverDir(userDataDir: string): string {
  return path.join(userDataDir, SERVER_DIR_NAME);
}

/** Installed builds ship the bundled server as extra resources outside asar. */
export function serverResourceDir(input: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  if (input.packaged) return path.join(input.resourcesPath, SERVER_DIR_NAME);
  return path.resolve(input.appPath, "server-dist");
}

/** The `.env` template ships next to the bundled server; a checkout reads it from infra. */
export function envTemplatePath(input: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  if (input.packaged) return path.join(input.resourcesPath, STACK_DIR_NAME, STACK_ENV_TEMPLATE);
  return path.resolve(input.appPath, "..", "..", "infra", "compose", STACK_ENV_TEMPLATE);
}

export async function readStackWebUrl(dir: string, fallback: string): Promise<string> {
  const raw = await readPrivateFile(path.join(dir, STACK_WEB_URL_FILE), 128);
  const match = raw?.match(/^http:\/\/127\.0\.0\.1:(\d{4,5})$/);
  const port = Number(match?.[1]);
  return match && port >= 1024 && port <= 65535 && raw === `http://127.0.0.1:${port}`
    ? raw
    : fallback;
}

function listenOnce(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("No port allocated."));
      });
    });
  });
}

export async function allocateLoopbackPort(): Promise<number> {
  return listenOnce(0, "127.0.0.1");
}

/** Whether a listener could take this port on `host` right now. */
export async function portFree(port: number, host: string): Promise<boolean> {
  try {
    await listenOnce(port, host);
    return true;
  } catch {
    return false;
  }
}

/** The gate listens on every interface, so its port must be free on all of them. */
export function gatePortFree(port: number): Promise<boolean> {
  return portFree(port, "0.0.0.0");
}

/** A port the gate may use: unprivileged, so binding it needs no administrator rights. */
export function parseGatePort(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= GATE_PORT_MIN &&
    value <= GATE_PORT_MAX
    ? value
    : null;
}

const GENERATED_SECRETS: Record<string, number> = {
  POSTGRES_PASSWORD: 16,
  BETTER_AUTH_SECRET: 32,
  ENCRYPTION_KEY: 32,
  SCREEN_PROXY_SECRET: 32,
  SANDBOX_SUPERVISOR_TOKEN: 32,
};
/** Compose image pins that mean nothing to a server running inside the app. */
const DROPPED = ["RAKAZO_IMAGE_TAG", "RAKAZO_COMPUTER_IMAGE_TAG"];

/** Fills the template's empty secret lines with random hex and keeps everything else verbatim. */
export function renderStackEnv(template: string, randomHex: (bytes: number) => string): string {
  const rendered: string[] = [];
  for (const line of template.split("\n")) {
    const separator = line.indexOf("=");
    const name = separator === -1 ? "" : line.slice(0, separator);
    if (line === `${name}=` && Object.hasOwn(GENERATED_SECRETS, name)) {
      rendered.push(`${name}=${randomHex(GENERATED_SECRETS[name]!)}`);
      continue;
    }
    if (DROPPED.includes(name)) continue;
    rendered.push(line);
  }
  return rendered.join("\n");
}

/** Keeps an existing regular `.env`, but replaces a final symlink instead of trusting its target. */
export async function ensureStackEnv(
  dir: string,
  template: string,
  randomHex: (bytes: number) => string,
): Promise<"kept" | "created"> {
  const destination = path.join(dir, STACK_ENV_FILE);
  try {
    const info = await lstat(destination);
    if (!info.isSymbolicLink()) return "kept";
  } catch {
    // Missing files are created below.
  }
  await writePrivateFile(destination, renderStackEnv(template, randomHex));
  return "created";
}

function unquote(value: string) {
  return value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
    ? value.slice(1, -1)
    : value;
}

/** Reads one value of the stack `.env`, without the quotes a value may carry. */
export function envValue(env: string, name: string): string {
  const line = env.split("\n").find((candidate) => candidate.startsWith(`${name}=`));
  return unquote(line?.slice(name.length + 1) ?? "");
}

/** Every `NAME=value` line of the stack `.env`, as the process environment Compose would give. */
export function parseEnvFile(env: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of env.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trimEnd());
    if (match?.[1] !== undefined) values[match[1]] = unquote(match[2] ?? "");
  }
  return values;
}

/** Replaces each named line of the stack `.env`, appending names it does not have yet. */
export function withEnvValues(env: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values));
  const lines = env.split("\n").map((line) => {
    const name = line.slice(0, Math.max(0, line.indexOf("=")));
    const value = pending.get(name);
    if (value === undefined) return line;
    pending.delete(name);
    return `${name}=${value}`;
  });
  const added = [...pending].map(([name, value]) => `${name}=${value}`);
  if (added.length === 0) return lines.join("\n");
  const trailing = lines.at(-1) === "" ? lines.pop() : undefined;
  return [...lines, ...added, ...(trailing === undefined ? [] : [trailing])].join("\n");
}

/** Basic Auth for the gate that lets phones and other computers reach this server. */
export interface GateAccess {
  username: string;
  password: string;
}

/** `keep` leaves the gate as it is, `set` replaces its credentials. */
export type GateChange = { kind: "keep" } | { kind: "set"; access: GateAccess };

const GATE_USERNAME = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_GATE_PASSWORD = 256;

/** Absent keeps the gate; anything malformed is refused. */
export function parseGateChange(value: unknown): GateChange | null {
  if (value === undefined || value === null) return { kind: "keep" };
  if (typeof value !== "object") return null;
  const { username, password } = value as Record<string, unknown>;
  if (typeof username !== "string" || !GATE_USERNAME.test(username)) return null;
  if (typeof password !== "string" || password === "" || password.length > MAX_GATE_PASSWORD) {
    return null;
  }
  return { kind: "set", access: { username, password } };
}

/** What the setup window shows about the gate: who signs in, and the port a tunnel targets. */
export interface StackGate {
  username: string;
  port: number;
}

export function gateFromEnv(env: string): StackGate | null {
  const username = envValue(env, "QUANT_BASIC_USER");
  const port = Number(envValue(env, "QUANT_PORT"));
  if (username === "" || envValue(env, "QUANT_BASIC_B64") === "") return null;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? { username, port } : null;
}

/** The gate the front listens with, or null while nobody outside may connect. */
export function frontGateFromEnv(env: string): FrontGate | null {
  const gate = gateFromEnv(env);
  if (gate === null) return null;
  return {
    port: gate.port,
    basic: envValue(env, "QUANT_BASIC_B64"),
    token: envValue(env, "QUANT_GATE_TOKEN"),
  };
}

export async function readStackGate(dir: string): Promise<StackGate | null> {
  const env = await readPrivateFile(path.join(dir, STACK_ENV_FILE), MAX_STACK_ENV_BYTES);
  return env === null ? null : gateFromEnv(env);
}

const STACK_TOKEN = /^[a-f0-9]{64}$/;

export async function readStackToken(dir: string): Promise<string | null> {
  const raw = await readPrivateFile(path.join(dir, STACK_TOKEN_FILE), MAX_STACK_TOKEN_BYTES);
  const token = raw?.trim() ?? "";
  return STACK_TOKEN.test(token) ? token : null;
}

/** Creates an app-private identity the local settings window proves itself with. */
export async function ensureStackToken(
  dir: string,
  randomHex: (bytes: number) => string,
): Promise<string> {
  const existing = await readStackToken(dir);
  if (existing !== null) return existing;
  const token = randomHex(32);
  if (!STACK_TOKEN.test(token)) throw new Error("Stack token generator returned invalid data.");
  await writePrivateFile(path.join(dir, STACK_TOKEN_FILE), `${token}\n`);
  return token;
}

export type LocalStackEvent =
  | { type: "prepare" }
  | { type: "import-start" }
  | { type: "start" }
  | { type: "wait-start" }
  | { type: "output"; line: string }
  | { type: "ready" }
  | { type: "failed"; message: string };

export function initialStackState(): DesktopLocalStackState {
  return { phase: "idle", message: null, output: [] };
}

export function reduceStackState(
  state: DesktopLocalStackState,
  event: LocalStackEvent,
): DesktopLocalStackState {
  if (event.type === "prepare") {
    return { phase: "preparing", message: null, output: [] };
  }
  if (event.type === "output") {
    return { ...state, output: [...state.output, event.line].slice(-STACK_OUTPUT_LINES) };
  }
  // Terminal phases only leave through the next prepare.
  if (state.phase === "ready" || state.phase === "failed") return state;
  switch (event.type) {
    case "import-start":
      return { ...state, phase: "importing", message: null };
    case "start":
      return { ...state, phase: "starting", message: null };
    case "wait-start":
      return { ...state, phase: "waiting-healthy", message: null };
    case "ready":
      return { ...state, phase: "ready", message: null };
    case "failed":
      return { ...state, phase: "failed", message: event.message };
  }
}

const START_INTERRUPTED = "The start was interrupted. Retry to continue.";
const PREPARE_FAILED = "Could not prepare the local server. Retry.";
const DATABASE_FAILED = "The database did not start. Check the output below, then retry.";
const MIGRATE_FAILED = "Could not update the database. Check the output below, then retry.";
const NOT_ANSWERING = "The server started but did not answer. Retry, and check the output below.";
const SERVER_MISSING = "This build has no local server. Reinstall Quant.";
const MOVE_NEEDS_DOCKER =
  "Quant could not reach Docker to move your existing data into the app. Start Docker, then retry.";
const MOVE_NO_SPACE =
  "Docker is out of disk space, so Quant cannot read your existing data. Free some space in Docker, then retry.";
const MOVE_FAILED =
  "Quant could not move your existing data from Docker. Check the output below, then retry.";

export function gatePortBusyMessage(port: number) {
  return `Port ${port} is busy. Choose another port in setup.`;
}

/** Environment names the server processes inherit; the rest of the app's environment stays out. */
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_RUNTIME_DIR",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "PATHEXT",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

/**
 * The environment of the API and worker: the stack `.env` as Compose passed it, plus what
 * the Compose file set on top. Computers run on this machine as the signed-in user.
 */
export function serverProcessEnv(input: {
  platform: string;
  inherited: NodeJS.ProcessEnv;
  stackEnv: Record<string, string>;
  databaseUrl: string;
  apiPort: number;
  webUrl: string;
  dataDir: string;
  stackToken: string;
  version: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = input.inherited[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  // A GUI launch on macOS gets a minimal PATH; computers expect the usual tool locations.
  if (input.platform === "darwin") {
    env.PATH = [env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
  }
  return {
    ...env,
    ...input.stackEnv,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    DATABASE_URL: input.databaseUrl,
    API_HOST: "127.0.0.1",
    API_PORT: String(input.apiPort),
    BETTER_AUTH_URL: input.webUrl,
    WEB_ORIGIN: input.webUrl,
    API_URL: input.webUrl,
    DATA_DIR: input.dataDir,
    SANDBOX_PROVIDER: "desktop",
    WAKEUP_DRIVER: "graphile",
    AGENT_RUNTIME: "pi",
    SECRET_STORE: input.stackEnv.SECRET_STORE || "encrypted",
    PHONE_CALLS_ENABLED: input.stackEnv.PHONE_CALLS_ENABLED || "true",
    RAKAZO_DESKTOP_STACK_TOKEN: input.stackToken,
    RAKAZO_IMAGE_TAG: input.version,
  };
}

export interface LocalServerDeps {
  platform: string;
  env: NodeJS.ProcessEnv;
  /** The app's own binary, which runs the bundled server as Node. */
  execPath: string;
  /** The bundled server: `app/` with its `node_modules/` and Postgres, and `migrations/`. */
  resourceDir: string;
  envTemplate: string;
  webRoot: string;
  stackDir: string;
  /** Database, files and logs. */
  serverDir: string;
  localWebUrl: string;
  version: string;
  /** Bounded one-shot commands: Postgres tools, migrations, and Docker for the move. */
  run: RunDocker;
  launch: LaunchProcess;
  startFront: (options: FrontServerOptions) => Promise<FrontServer>;
  /** Whether the API answers its health check. */
  probe: (apiUrl: string, signal: AbortSignal) => Promise<boolean>;
  randomHex: (bytes: number) => string;
  exists?: (file: string) => boolean;
  allocatePort?: () => Promise<number>;
  portFree?: (port: number, host: string) => Promise<boolean>;
  /** Called on every state change so the setup window is pushed progress instead of polling. */
  onState?: (state: DesktopLocalStackState) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  healthTimeoutMs?: number;
  /** The built-in virtual desktop engine's Docker socket, used when Docker is not running. */
  virtualDesktopSocket?: () => string | null;
}

/** Resolves early on abort so a stop never waits out a poll. */
function defaultSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

class StartFailed extends Error {}

/** The parts of a running server, so a stop or a failed start can take them down. */
interface Running {
  postgres: { pgCtl: string; dataDir: string } | null;
  processes: ServerProcess[];
  front: FrontServer | null;
}

export class LocalServerController {
  private current = initialStackState();
  private currentWebUrl: string;
  private running: Promise<DesktopLocalStackState> | null = null;
  private stopping: Promise<DesktopLocalStackState> | null = null;
  private inFlight: AbortController | null = null;
  private parts: Running = { postgres: null, processes: [], front: null };
  private gateChange: GateChange = { kind: "keep" };
  /** The gate port the next attempt applies; null keeps the saved one. */
  private gatePort: number | null = null;
  /** What the running supervisor's computers run on; null with no supervisor. */
  private engine: "docker" | "vm" | null = null;

  constructor(private readonly deps: LocalServerDeps) {
    this.currentWebUrl = deps.localWebUrl;
  }

  webUrl(): string {
    return this.currentWebUrl;
  }

  /** Whether bots' virtual desktops run on Docker, on the app's own VM, or nowhere. */
  supervisorEngine(): "docker" | "vm" | null {
    return this.engine;
  }

  state(): DesktopLocalStackState {
    return this.current;
  }

  /** Whether the server this app started is up and may be opened. */
  ready(): boolean {
    return this.current.phase === "ready";
  }

  /** Idempotent while a start is in flight; otherwise starts afresh, after any stop. */
  start(
    gate: GateChange = { kind: "keep" },
    port: number | null = null,
  ): Promise<DesktopLocalStackState> {
    if (this.running !== null) return this.running;
    this.gateChange = gate;
    this.gatePort = port;
    const attempt = (this.stopping ?? Promise.resolve())
      .then(() => this.run())
      .finally(() => {
        if (this.running === attempt) this.running = null;
      });
    this.running = attempt;
    return attempt;
  }

  /** Stops every part of the server; the database and files stay for the next start. */
  stop(): Promise<DesktopLocalStackState> {
    if (this.stopping !== null) return this.stopping;
    this.inFlight?.abort();
    const pending = this.running?.catch(() => undefined);
    const stopping = Promise.resolve(pending)
      .then(() => this.teardown())
      .then(() => {
        this.setState(initialStackState());
        return this.current;
      })
      .finally(() => {
        if (this.stopping === stopping) this.stopping = null;
      });
    this.stopping = stopping;
    return stopping;
  }

  private push(event: LocalStackEvent) {
    this.setState(reduceStackState(this.current, event));
  }

  private setState(next: DesktopLocalStackState) {
    if (next === this.current) return;
    this.current = next;
    this.deps.onState?.(next);
  }

  private output = (line: string) => {
    this.push({ type: "output", line });
  };

  private async run(): Promise<DesktopLocalStackState> {
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      // A retry starts clean, whatever the last attempt left running.
      await this.teardown();
      await this.attempt(controller.signal);
    } catch (error) {
      await this.teardown();
      this.push({
        type: "failed",
        message: controller.signal.aborted
          ? START_INTERRUPTED
          : error instanceof StartFailed
            ? error.message
            : PREPARE_FAILED,
      });
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
    return this.current;
  }

  private exists(file: string) {
    return (this.deps.exists ?? existsSync)(file);
  }

  private async attempt(signal: AbortSignal) {
    const { deps } = this;
    this.push({ type: "prepare" });
    const app = path.join(deps.resourceDir, "app");
    if (!this.exists(path.join(app, "api.mjs"))) throw new StartFailed(SERVER_MISSING);
    await mkdir(deps.stackDir, { recursive: true, mode: 0o700 });
    const dataDir = path.join(deps.serverDir, "data");
    const logDir = path.join(deps.serverDir, "logs");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await mkdir(logDir, { recursive: true, mode: 0o700 });

    await ensureStackEnv(deps.stackDir, await readFile(deps.envTemplate, "utf8"), deps.randomHex);
    const stackToken = await ensureStackToken(deps.stackDir, deps.randomHex);
    const env = await this.applyGate();

    const importFile = await this.moveFromDocker(env, signal);
    this.checkAborted(signal);

    const gate = frontGateFromEnv(env);
    const free = deps.portFree ?? portFree;
    if (gate !== null && !(await free(gate.port, "0.0.0.0"))) {
      throw new StartFailed(gatePortBusyMessage(gate.port));
    }
    const allocate = deps.allocatePort ?? allocateLoopbackPort;
    const webPort = Number(new URL(this.currentWebUrl).port);
    if (!(await free(webPort, "127.0.0.1"))) {
      this.currentWebUrl = `http://127.0.0.1:${await allocate()}`;
    }
    await writePrivateFile(path.join(deps.stackDir, STACK_WEB_URL_FILE), this.currentWebUrl);

    const stackEnv = parseEnvFile(env);
    const databaseUrl = await this.startPostgres(stackEnv, signal);
    this.checkAborted(signal);

    const migrateArgs = [path.join(app, "migrate.mjs"), path.join(deps.resourceDir, "migrations")];
    if (importFile !== null) migrateArgs.push("--import", importFile);
    const migrated = await deps.run(deps.execPath, migrateArgs, {
      cwd: deps.serverDir,
      env: { ...this.inheritedEnv(), ELECTRON_RUN_AS_NODE: "1", DATABASE_URL: databaseUrl },
      timeoutMs: MIGRATE_TIMEOUT_MS,
      signal,
      onLine: this.output,
    });
    this.checkAborted(signal);
    if (migrated.code !== 0)
      throw new StartFailed(importFile === null ? MIGRATE_FAILED : MOVE_FAILED);
    if (importFile !== null) await this.finishMove(importFile);

    this.push({ type: "start" });
    const apiPort = await allocate();
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const processEnv = serverProcessEnv({
      platform: deps.platform,
      inherited: deps.env,
      stackEnv,
      databaseUrl,
      apiPort,
      webUrl: this.currentWebUrl,
      dataDir,
      stackToken,
      version: deps.version,
    });
    const supervisorUrl = await this.startSupervisor(app, processEnv, allocate, signal);
    if (supervisorUrl !== null) processEnv.SANDBOX_SUPERVISOR_URL = supervisorUrl;
    for (const name of ["api", "worker"]) this.keepRunning(name, app, processEnv);
    this.parts.front = await deps.startFront({
      webRoot: deps.webRoot,
      apiUrl,
      loopbackPort: Number(new URL(this.currentWebUrl).port),
      gate,
    });

    this.push({ type: "wait-start" });
    const sleep = deps.sleep ?? defaultSleep;
    const deadline = Date.now() + (deps.healthTimeoutMs ?? STACK_HEALTH_TIMEOUT_MS);
    while (!signal.aborted) {
      if (await deps.probe(apiUrl, signal).catch(() => false)) {
        this.push({ type: "ready" });
        return;
      }
      if (Date.now() >= deadline) break;
      await sleep(HEALTH_POLL_INTERVAL_MS, signal);
    }
    this.checkAborted(signal);
    throw new StartFailed(NOT_ANSWERING);
  }

  private checkAborted(signal: AbortSignal) {
    if (signal.aborted) throw new StartFailed(START_INTERRUPTED);
  }

  private inheritedEnv() {
    const { PATH, HOME, USERPROFILE, SystemRoot, TMPDIR, TEMP, TMP } = this.deps.env;
    const values = { PATH, HOME, USERPROFILE, SystemRoot, TMPDIR, TEMP, TMP };
    return Object.fromEntries(
      Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
  }

  /** Writes the gate setup asked for into `.env`, and returns the file as it now stands. */
  private async applyGate(): Promise<string> {
    const envPath = path.join(this.deps.stackDir, STACK_ENV_FILE);
    const gate = this.gateChange;
    const requestedPort = this.gatePort;
    this.gateChange = { kind: "keep" };
    this.gatePort = null;
    let env = await readFile(envPath, "utf8");
    const existing = gateFromEnv(env);
    const port = requestedPort ?? existing?.port ?? GATE_DEFAULT_PORT;
    if (gate.kind === "set") {
      const { username, password } = gate.access;
      env = withEnvValues(env, {
        QUANT_BASIC_USER: username,
        QUANT_BASIC_B64: Buffer.from(`${username}:${password}`).toString("base64"),
        // The Compose gate's bcrypt hash; the app's own gate compares the header instead.
        QUANT_BASIC_HASH: "",
        // A new password also signs out the devices the gate remembered.
        QUANT_GATE_TOKEN: this.deps.randomHex(32),
        QUANT_PORT: String(port),
      });
      await writePrivateFile(envPath, env);
    } else if (existing !== null && port !== existing.port) {
      env = withEnvValues(env, { QUANT_PORT: String(port) });
      await writePrivateFile(envPath, env);
    }
    return env;
  }

  private postgresBin(name: string) {
    const root = path.join(this.deps.resourceDir, "app", "node_modules", "@embedded-postgres");
    return { root, file: `${name}${this.deps.platform === "win32" ? ".exe" : ""}` };
  }

  private async startPostgres(stackEnv: Record<string, string>, signal: AbortSignal) {
    const { deps } = this;
    const { root, file } = this.postgresBin("pg_ctl");
    const [platformPackage] = await readdir(root).catch(() => [] as string[]);
    if (platformPackage === undefined) throw new StartFailed(SERVER_MISSING);
    const bin = path.join(root, platformPackage, "native", "bin");
    const pgCtl = path.join(bin, file);
    const dataDir = path.join(deps.serverDir, "postgres");
    const user = stackEnv.POSTGRES_USER || "rakazo";
    const password = stackEnv.POSTGRES_PASSWORD ?? "";
    const database = stackEnv.POSTGRES_DB || "rakazo";
    const call = (command: string, args: string[]) =>
      deps.run(command, args, {
        cwd: deps.serverDir,
        env: this.inheritedEnv(),
        timeoutMs: POSTGRES_TIMEOUT_MS,
        signal,
        onLine: this.output,
      });

    if (!this.exists(path.join(dataDir, "PG_VERSION"))) {
      // initdb refuses a non-empty directory, and a failed one leaves files behind.
      await rm(dataDir, { recursive: true, force: true });
      const passwordFile = path.join(deps.serverDir, ".postgres-password");
      await writePrivateFile(passwordFile, `${password}\n`);
      try {
        const initdb = path.join(bin, this.postgresBin("initdb").file);
        const created = await call(initdb, [
          "-D",
          dataDir,
          "-U",
          user,
          "-A",
          "scram-sha-256",
          `--pwfile=${passwordFile}`,
          "-E",
          "UTF8",
          "--locale=C",
        ]);
        this.checkAborted(signal);
        if (created.code !== 0) throw new StartFailed(DATABASE_FAILED);
      } finally {
        await rm(passwordFile, { force: true });
      }
    }

    // A crash may have left the last server running; it holds the data directory.
    if ((await call(pgCtl, ["status", "-D", dataDir])).code === 0) {
      await call(pgCtl, ["stop", "-D", dataDir, "-m", "fast", "-w"]);
    }
    const port = await (deps.allocatePort ?? allocateLoopbackPort)();
    const options = `-c listen_addresses=127.0.0.1 -c unix_socket_directories= -p ${port}`;
    this.parts.postgres = { pgCtl, dataDir };
    const started = await call(pgCtl, [
      "start",
      "-D",
      dataDir,
      "-l",
      path.join(deps.serverDir, "logs", "postgres.log"),
      "-w",
      "-t",
      "60",
      "-o",
      options,
    ]);
    this.checkAborted(signal);
    if (started.code !== 0) throw new StartFailed(DATABASE_FAILED);
    const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
    return `postgres://${credentials}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
  }

  /**
   * Starts the supervisor that gives each bot that asks for one its own virtual desktop: on
   * Docker when it is running, else on the app's own VM engine where this computer has one.
   * Without either every bot works on this computer, as before.
   */
  private async startSupervisor(
    app: string,
    processEnv: Record<string, string>,
    allocate: () => Promise<number>,
    signal: AbortSignal,
  ): Promise<string | null> {
    const { deps } = this;
    if (!this.exists(path.join(app, "supervisor.mjs"))) return null;
    this.engine = null;
    const engine = await this.dockerEngineEnv(signal);
    if (engine === null) return null;
    const port = await allocate();
    this.keepRunning("supervisor", app, {
      ...processEnv,
      ...engine,
      SUPERVISOR_HOST: "127.0.0.1",
      SUPERVISOR_PORT: String(port),
      // Docker Desktop cannot route to container addresses from the host.
      SANDBOX_CONTROL_VIA_LOOPBACK: "true",
      RAKAZO_COMPUTER_IMAGE: processEnv.RAKAZO_COMPUTER_IMAGE || COMPUTER_IMAGE,
    });
    return `http://127.0.0.1:${port}`;
  }

  /** How the supervisor reaches Docker: the running Docker, else the built-in VM's socket. */
  private async dockerEngineEnv(signal: AbortSignal): Promise<Record<string, string> | null> {
    const { deps } = this;
    const binary = resolveDockerBinary(deps.platform, deps.env, (file) => this.exists(file));
    if (binary !== null) {
      const probe = await deps
        .run(binary, ["info", "--format", "{{.ServerVersion}}"], {
          cwd: deps.serverDir,
          env: dockerSpawnEnv(deps.platform, deps.env, binary),
          timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
          signal,
        })
        .catch(() => null);
      if (probe?.code === 0) {
        this.engine = "docker";
        return dockerSpawnEnv(deps.platform, deps.env, binary);
      }
    }
    // The VM may still be downloading or booting; the supervisor connects on each request.
    const socket = deps.virtualDesktopSocket?.() ?? null;
    if (socket === null) return null;
    this.engine = "vm";
    return { DOCKER_HOST: "", DOCKER_SOCKET: socket };
  }

  /** Runs one bundled process and starts it again if it exits while the server is up. */
  private keepRunning(name: string, app: string, env: Record<string, string>) {
    const launched = this.deps.launch(this.deps.execPath, [path.join(app, `${name}.mjs`)], {
      cwd: this.deps.serverDir,
      env,
      onLine: this.output,
    });
    this.parts.processes.push(launched);
    void launched.exited.then(async (code) => {
      const index = this.parts.processes.indexOf(launched);
      // A stop or a teardown removed it first: the exit was asked for.
      if (index === -1) return;
      this.parts.processes.splice(index, 1);
      this.output(`${name} exited with code ${code}; restarting`);
      await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
      if (this.current.phase === "ready" && this.stopping === null) {
        this.keepRunning(name, app, env);
      }
    });
  }

  private async teardown() {
    const { processes, front, postgres } = this.parts;
    this.parts = { postgres: null, processes: [], front: null };
    await front?.close().catch(() => undefined);
    await Promise.all(processes.map((process) => process.stop().catch(() => undefined)));
    if (postgres !== null) {
      await this.deps
        .run(postgres.pgCtl, ["stop", "-D", postgres.dataDir, "-m", "fast", "-w"], {
          cwd: this.deps.serverDir,
          env: this.inheritedEnv(),
          timeoutMs: POSTGRES_TIMEOUT_MS,
        })
        .catch(() => undefined);
    }
  }

  private legacyCompose(binary: string, args: string[], timeoutMs: number, signal: AbortSignal) {
    return this.deps.run(
      binary,
      [
        "compose",
        "--env-file",
        STACK_ENV_FILE,
        "-f",
        LEGACY_COMPOSE_FILE,
        "--project-name",
        LEGACY_PROJECT_NAME,
        ...args,
      ],
      {
        cwd: this.deps.stackDir,
        env: dockerSpawnEnv(this.deps.platform, this.deps.env, binary),
        timeoutMs,
        signal,
        onLine: args[0] === "exec" ? undefined : this.output,
      },
    );
  }

  /**
   * An install made by an earlier version keeps its data in Docker volumes. Dump the database
   * with a throwaway Postgres container on its volume and copy the files out of theirs, so the
   * move works whether the stack's containers still exist or not. The migrator applies the
   * dump before any migration. Returns the dump to apply, or null when nothing moves.
   */
  private async moveFromDocker(env: string, signal: AbortSignal): Promise<string | null> {
    const { deps } = this;
    const moved = path.join(deps.stackDir, LEGACY_MOVED_FILE);
    if (!this.exists(path.join(deps.stackDir, LEGACY_COMPOSE_FILE)) || this.exists(moved)) {
      return null;
    }
    const importFile = path.join(deps.serverDir, "docker-import.sql");
    // A dump taken by an attempt that failed later is applied again from scratch.
    if (this.exists(importFile)) return importFile;
    // A database the app already runs is never overwritten.
    if (this.exists(path.join(deps.serverDir, "postgres", "PG_VERSION"))) {
      await writePrivateFile(moved, "kept\n");
      return null;
    }
    this.push({ type: "import-start" });
    const binary = resolveDockerBinary(deps.platform, deps.env, (file) => this.exists(file));
    if (binary === null) throw new StartFailed(MOVE_NEEDS_DOCKER);
    const docker = async (args: string[], timeoutMs = LEGACY_STEP_TIMEOUT_MS) => {
      const result = await deps.run(binary, args, {
        cwd: deps.stackDir,
        env: dockerSpawnEnv(deps.platform, deps.env, binary),
        timeoutMs,
        signal,
        // A dump is the database itself; it never goes to the setup window.
        onLine: args.includes("pg_dump") ? undefined : this.output,
      });
      this.checkAborted(signal);
      return result;
    };
    const volume = (name: string) => `${LEGACY_PROJECT_NAME}_${name}`;

    const database = await docker(["volume", "inspect", volume("pgdata")]);
    if (database.code !== 0) {
      const kind = classifyDockerFailure(`${database.stdout}\n${database.stderr}`);
      if (kind === "daemon-down" || kind === "socket-permission") {
        throw new StartFailed(MOVE_NEEDS_DOCKER);
      }
      // The volume is gone, so there is nothing left to move.
      await writePrivateFile(moved, "nothing\n");
      return null;
    }
    // Containers still running from the stack hold the volume and the gate's port.
    await this.legacyCompose(binary, ["stop"], LEGACY_STEP_TIMEOUT_MS, signal);
    this.checkAborted(signal);

    const user = envValue(env, "POSTGRES_USER") || "rakazo";
    const name = `quant-move-${deps.randomHex(4)}`;
    const started = await docker([
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      "none",
      "--mount",
      `type=volume,src=${volume("pgdata")},dst=/var/lib/postgresql/data`,
      "--env",
      "POSTGRES_PASSWORD=unused",
      envValue(env, "POSTGRES_IMAGE") || LEGACY_POSTGRES_IMAGE,
    ]);
    if (started.code !== 0) throw new StartFailed(MOVE_FAILED);
    let dump: string;
    try {
      const sleep = deps.sleep ?? defaultSleep;
      let ready = false;
      for (let attempt = 0; attempt < LEGACY_READY_ATTEMPTS && !ready; attempt += 1) {
        const check = await docker(["exec", name, "pg_isready", "-U", user]);
        ready = check.code === 0;
        // A container that exited will never become ready.
        if (!ready && /is not running/i.test(check.stderr)) break;
        if (!ready) await sleep(1_000, signal);
      }
      if (!ready) {
        const logs = await docker(["logs", "--tail", "20", name]);
        throw new StartFailed(
          /no space left on device/i.test(`${logs.stdout}\n${logs.stderr}`)
            ? MOVE_NO_SPACE
            : MOVE_FAILED,
        );
      }
      const dumped = await docker(
        [
          "exec",
          name,
          "pg_dump",
          "-U",
          user,
          "-d",
          envValue(env, "POSTGRES_DB") || "rakazo",
          "--no-owner",
          "--no-privileges",
          "--inserts",
          "--rows-per-insert=500",
        ],
        LEGACY_DUMP_TIMEOUT_MS,
      );
      if (dumped.code !== 0) throw new StartFailed(MOVE_FAILED);
      dump = dumped.stdout;
    } finally {
      await deps
        .run(binary, ["rm", "--force", name], {
          cwd: deps.stackDir,
          env: dockerSpawnEnv(deps.platform, deps.env, binary),
          timeoutMs: LEGACY_STEP_TIMEOUT_MS,
        })
        .catch(() => undefined);
    }

    if ((await docker(["volume", "inspect", volume("appdata")])).code === 0) {
      const copied = await docker(
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--mount",
          `type=volume,src=${volume("appdata")},dst=/data,readonly`,
          "--mount",
          `type=bind,src=${path.join(deps.serverDir, "data")},dst=/out`,
          LEGACY_COPY_IMAGE,
          "sh",
          "-c",
          // The copy runs as root; on Linux the files would otherwise belong to root.
          `cp -R /data/. /out/ && (chown -R ${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0} /out || true)`,
        ],
        LEGACY_DUMP_TIMEOUT_MS,
      );
      if (copied.code !== 0) throw new StartFailed(MOVE_FAILED);
    }
    await writeFile(importFile, dump, { encoding: "utf8", mode: 0o600 });
    return importFile;
  }

  private async finishMove(importFile: string) {
    await writePrivateFile(path.join(this.deps.stackDir, LEGACY_MOVED_FILE), "moved\n");
    await rm(importFile, { force: true });
  }
}
