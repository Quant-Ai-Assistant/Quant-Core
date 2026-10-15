import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import type { DesktopLocalStackState } from "@rakazo/contracts";
import {
  classifyDockerFailure,
  composeSupportsWaitTimeout,
  type DockerFailureKind,
  dockerSpawnEnv,
  type RunDocker,
  type RunDockerResult,
  resolveDockerBinary,
} from "./docker-cli.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export const STACK_DIR_NAME = "stack";
export const STACK_PROJECT_NAME = "quant-desktop";
export const STACK_COMPOSE_FILE = "docker-compose.images.yml";
export const STACK_ENV_TEMPLATE = ".env.images.example";
export const STACK_ENV_FILE = ".env";
export const STACK_WEB_URL_FILE = ".desktop-web-url";
export const STACK_TOKEN_FILE = ".desktop-stack-token";
export const STACK_GATE_FILE = "Caddyfile.gate";
/** The port setup suggests for the gate; the person may choose another one. */
export const GATE_DEFAULT_PORT = 8080;
export const GATE_PORT_MIN = 1024;
export const GATE_PORT_MAX = 65535;
export const STACK_OUTPUT_LINES = 20;
export const STACK_HEALTH_TIMEOUT_MS = 120_000;
export const COMPOSE_WAIT_TIMEOUT_S = 300;

export async function readStackWebUrl(dir: string, fallback: string): Promise<string> {
  const raw = await readPrivateFile(path.join(dir, STACK_WEB_URL_FILE), 128);
  const match = raw?.match(/^http:\/\/127\.0\.0\.1:(\d{4,5})$/);
  const port = Number(match?.[1]);
  return match && port >= 1024 && port <= 65535 && raw === `http://127.0.0.1:${port}`
    ? raw
    : fallback;
}

/** Docker owns the final bind; a racing listener is handled by bounded up retries. */
export async function allocateLoopbackPort(): Promise<number> {
  return listenOnce(0, "127.0.0.1");
}

/** The gate listens on every interface, so its port must be free on all of them. */
export async function gatePortFree(port: number): Promise<boolean> {
  try {
    await listenOnce(port, "0.0.0.0");
    return true;
  } catch {
    return false;
  }
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

function listenOnce(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("No loopback port allocated."));
      });
    });
  });
}

const HEALTH_POLL_INTERVAL_MS = 2_000;
const COMPOSE_VERSION_TIMEOUT_MS = 15_000;
const DOCKER_INFO_TIMEOUT_MS = 20_000;
const PULL_TIMEOUT_MS = 30 * 60_000;
const UP_TIMEOUT_MS = (COMPOSE_WAIT_TIMEOUT_S + 60) * 1_000;
const LOGS_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 90_000;
const HASH_TIMEOUT_MS = 5 * 60_000;
const GATE_RM_TIMEOUT_MS = 60_000;
const MAX_STACK_TOKEN_BYTES = 1024;
const MAX_STACK_ENV_BYTES = 256 * 1024;

/** The compose project lives under the app's user data, next to the `.env` it generates. */
export function stackDir(userDataDir: string): string {
  return path.join(userDataDir, STACK_DIR_NAME);
}

/** Installed builds ship the compose YAML and env template as extra resources outside asar. */
export function stackResourceDir(input: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string {
  if (input.packaged) return path.join(input.resourcesPath, STACK_DIR_NAME);
  return path.resolve(input.appPath, "..", "..", "infra", "compose");
}

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Installed builds pin images to their own version so the DMG and the multi-arch
 * images move together; development builds follow `edge`.
 */
export function resolveImageTag(input: {
  version: string;
  packaged: boolean;
  override?: string;
}): string {
  const override = input.override?.trim();
  if (override) return override;
  if (input.packaged && STABLE_VERSION.test(input.version)) return `v${input.version}`;
  return "edge";
}

const GENERATED_SECRETS: Record<string, number> = {
  POSTGRES_PASSWORD: 16,
  BETTER_AUTH_SECRET: 32,
  ENCRYPTION_KEY: 32,
  SCREEN_PROXY_SECRET: 32,
  SANDBOX_SUPERVISOR_TOKEN: 32,
};
const LAUNCH_SUPPLIED = ["RAKAZO_IMAGE_TAG", "RAKAZO_COMPUTER_IMAGE_TAG"];

/**
 * Port of install-images.sh `create_env`: fills the empty secret lines with random
 * hex and keeps everything else verbatim. Image tags are dropped because the app
 * supplies them per launch, so an update never leaves a stale pin behind.
 */
export function renderStackEnv(template: string, randomHex: (bytes: number) => string): string {
  const lines = template.split("\n");
  const rendered: string[] = [];
  for (const line of lines) {
    const separator = line.indexOf("=");
    const name = separator === -1 ? "" : line.slice(0, separator);
    if (line === `${name}=` && Object.hasOwn(GENERATED_SECRETS, name)) {
      rendered.push(`${name}=${randomHex(GENERATED_SECRETS[name]!)}`);
      continue;
    }
    if (LAUNCH_SUPPLIED.includes(name)) continue;
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

/** Reads one value of the stack `.env`, without the single quotes a bcrypt hash needs. */
export function envValue(env: string, name: string): string {
  const line = env.split("\n").find((candidate) => candidate.startsWith(`${name}=`));
  const value = line?.slice(name.length + 1) ?? "";
  return value.length >= 2 && value.startsWith("'") && value.endsWith("'")
    ? value.slice(1, -1)
    : value;
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

/** Basic Auth for the gate that lets phones and other computers reach this stack. */
export interface GateAccess {
  username: string;
  password: string;
}

/** `keep` leaves the gate as it is, `off` closes it, `set` opens it with new credentials. */
export type GateChange = { kind: "keep" } | { kind: "off" } | { kind: "set"; access: GateAccess };

const GATE_USERNAME = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_GATE_PASSWORD = 256;
const BCRYPT_HASH = /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/;

/** Absent keeps the gate, null turns it off; anything malformed is refused. */
export function parseGateChange(value: unknown): GateChange | null {
  if (value === undefined) return { kind: "keep" };
  if (value === null) return { kind: "off" };
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
  if (username === "" || envValue(env, "QUANT_BASIC_HASH") === "") return null;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? { username, port } : null;
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

/** Creates an app-private identity without placing it in the user-editable Compose env file. */
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
  | { type: "check-start" }
  | { type: "docker-missing"; message: string }
  | { type: "docker-not-running"; message: string }
  | { type: "prepare" }
  | { type: "pull-start" }
  | { type: "up-start" }
  | { type: "wait-start" }
  | { type: "output"; line: string }
  | { type: "ready" }
  | { type: "failed"; message: string };

export function initialStackState(imageTag: string): DesktopLocalStackState {
  return { phase: "idle", message: null, output: [], layerBytes: {}, imageTag };
}

/** `COMPOSE_PROGRESS=plain` reports a layer's downloaded size and never its total. */
const PULL_PROGRESS = /^\s*(\S+)\s+Downloading\s+([\d.]+)\s*([kKMG]?B)\b/;
const BYTE_UNITS: Record<string, number> = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9 };

/** Layers report a growing size, so the largest value seen for a layer is what it has pulled. */
function reduceLayerBytes(layerBytes: Record<string, number>, line: string) {
  const match = PULL_PROGRESS.exec(line);
  if (match === null) return layerBytes;
  const layer = match[1] ?? "";
  const unit = match[3] === "KB" ? "kB" : (match[3] ?? "");
  const bytes = Number(match[2]) * (BYTE_UNITS[unit] ?? 0);
  if (!Number.isFinite(bytes) || bytes <= (layerBytes[layer] ?? 0)) return layerBytes;
  return { ...layerBytes, [layer]: bytes };
}

export function reduceStackState(
  state: DesktopLocalStackState,
  event: LocalStackEvent,
): DesktopLocalStackState {
  if (event.type === "check-start") {
    return { ...state, phase: "checking-docker", message: null, output: [], layerBytes: {} };
  }
  // Terminal phases only leave through the next check-start.
  if (state.phase === "ready" || state.phase === "failed") return state;
  switch (event.type) {
    case "docker-missing":
      return { ...state, phase: "docker-missing", message: event.message };
    case "docker-not-running":
      return { ...state, phase: "docker-not-running", message: event.message };
    case "prepare":
      return { ...state, phase: "preparing", message: null };
    case "pull-start":
      return { ...state, phase: "pulling", message: null };
    case "up-start":
      return { ...state, phase: "starting", message: null };
    case "wait-start":
      return { ...state, phase: "waiting-healthy", message: null };
    case "output":
      if (
        state.phase !== "pulling" &&
        state.phase !== "starting" &&
        state.phase !== "waiting-healthy"
      ) {
        return state;
      }
      return {
        ...state,
        output: [...state.output, event.line].slice(-STACK_OUTPUT_LINES),
        layerBytes: reduceLayerBytes(state.layerBytes, event.line),
      };
    case "ready":
      return { ...state, phase: "ready", message: null };
    case "failed":
      return { ...state, phase: "failed", message: event.message };
  }
}

const DOCKER_GROUP_HINT =
  "This user cannot access Docker. Add it to the docker group (sudo usermod -aG docker $USER), sign out and back in, then check again.";
const STOP_FAILED = "Could not stop the local stack. Check that Docker is running, then try again.";
const START_INTERRUPTED = "The start was interrupted. Retry to continue.";
const GATE_HASH_FAILED = "Could not save the password for other devices. Retry.";

/** Docker output may contain paths and hostnames, so the person only ever sees these. */
export function stackFailureMessage(
  kind: DockerFailureKind,
  phase: "pulling" | "starting",
  imageTag: string,
): string {
  switch (kind) {
    case "image-not-found":
      return `Images for ${imageTag} are not published yet. Try again in a few minutes.`;
    case "port-in-use":
      return "Could not bind a local port after retrying. Retry to choose another port.";
    case "address-pool-exhausted":
      return "Docker has no free network address pools. Remove unused Docker networks or expand Docker’s address pools, then retry.";
    case "network":
      return "Could not reach the image registry. Check the internet connection, then retry.";
    case "daemon-down":
      return "Docker stopped answering. Start Docker, then retry.";
    case "socket-permission":
      return DOCKER_GROUP_HINT;
    case "compose-missing":
      return "Docker Compose is missing. Install Docker Desktop or the docker-compose-plugin, then retry.";
    case "other":
      return phase === "pulling"
        ? "Downloading Quant images failed. Check the output below, then retry."
        : "Quant services did not start. Check the output below, then retry.";
  }
}

function failureKind(result: RunDockerResult): DockerFailureKind {
  return classifyDockerFailure(`${result.stdout}\n${result.stderr}`);
}

/** runDocker exits 130 after an abort; that is a quit or Stop, not a docker failure. */
function interrupted(signal: AbortSignal, result: RunDockerResult): boolean {
  return signal.aborted || result.code === 130;
}

export interface LocalStackDeps {
  platform: string;
  env: NodeJS.ProcessEnv;
  exists: (file: string) => boolean;
  run: RunDocker;
  stackDir: string;
  resourceDir: string;
  localWebUrl: string;
  allocatePort?: () => Promise<number>;
  imageTag: string;
  /** Returns the authenticated running image tag, or null for any other listener. */
  probe: (url: string, signal: AbortSignal, token: string) => Promise<string | null>;
  randomHex: (bytes: number) => string;
  /** Called on every state change so the setup window is pushed progress instead of polling for it. */
  onState?: (state: DesktopLocalStackState) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  healthTimeoutMs?: number;
}

/** Resolves early on abort so a stop never waits out a health poll. */
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

/**
 * Installs and starts the compose stack under the app's user data. Every docker call
 * uses a fixed argv and an allowlisted environment; the setup window polls `state()`.
 */
export class LocalStackController {
  private current: DesktopLocalStackState;
  private currentWebUrl: string;
  private currentStackToken: string | null = null;
  private running: Promise<DesktopLocalStackState> | null = null;
  private stopping: Promise<DesktopLocalStackState> | null = null;
  private inFlight: AbortController | null = null;
  private ticket = 0;
  private gateChange: GateChange = { kind: "keep" };
  /** The gate port the next attempt applies; null keeps the saved one. */
  private gatePort: number | null = null;
  /** Whether the current attempt runs the gate profile. */
  private gateOn = false;
  /** Starts ticketed at or below this were superseded by a later stop and must not run. */
  private voidBefore = 0;

  constructor(private readonly deps: LocalStackDeps) {
    this.current = initialStackState(deps.imageTag);
    this.currentWebUrl = deps.localWebUrl;
  }

  webUrl(): string {
    return this.currentWebUrl;
  }

  state(): DesktopLocalStackState {
    return this.current;
  }

  /** Fast path for launch: only a stack with our private token and desired image may be reused. */
  async matchesDesiredStack(url = this.currentWebUrl): Promise<boolean> {
    const token = await readStackToken(this.deps.stackDir);
    if (token === null) return false;
    this.currentStackToken = token;
    try {
      return (
        (await this.deps.probe(url, AbortSignal.timeout(HEALTH_POLL_INTERVAL_MS), token)) ===
        this.deps.imageTag
      );
    } catch {
      return false;
    }
  }

  /**
   * Idempotent while a start is in flight; otherwise begins a fresh attempt from any
   * phase, after any stop still running so `compose up` and `compose stop` never overlap.
   */
  start(
    gate: GateChange = { kind: "keep" },
    port: number | null = null,
  ): Promise<DesktopLocalStackState> {
    if (this.running !== null) return this.running;
    this.gateChange = gate;
    this.gatePort = port;
    const ticket = ++this.ticket;
    const attempt = (this.stopping ?? Promise.resolve())
      .then(() => (ticket <= this.voidBefore ? this.current : this.run()))
      .finally(() => {
        if (this.running === attempt) this.running = null;
      });
    this.running = attempt;
    return attempt;
  }

  /** Kills the in-flight docker command; containers already started keep running. */
  abort() {
    this.inFlight?.abort();
  }

  /** Stops the containers (`compose stop`); volumes and images stay for the next start. */
  stop(): Promise<DesktopLocalStackState> {
    this.voidBefore = this.ticket;
    // Join a stop already running unless a start was queued behind it; the latest
    // intent is "stopped", so that start is voided and a fresh stop follows it.
    if (this.stopping !== null && this.running === null) return this.stopping;
    this.abort();
    // Release the attempt now so a start requested during this stop queues a fresh
    // attempt behind it instead of joining the one being torn down.
    const settled = [this.stopping, this.running].map((pending) => pending?.catch(() => undefined));
    this.running = null;
    const stopping = Promise.all(settled)
      .then(() => this.runStop())
      .finally(() => {
        if (this.stopping === stopping) this.stopping = null;
      });
    this.stopping = stopping;
    return stopping;
  }

  private async runStop(): Promise<DesktopLocalStackState> {
    const binary = resolveDockerBinary(this.deps.platform, this.deps.env, this.deps.exists);
    const stopped = binary === null ? null : await this.compose(binary, ["stop"], STOP_TIMEOUT_MS);
    this.setState(
      stopped?.code === 0
        ? initialStackState(this.deps.imageTag)
        : { ...this.current, phase: "failed", message: STOP_FAILED },
    );
    return this.current;
  }

  private push(event: LocalStackEvent) {
    this.setState(reduceStackState(this.current, event));
  }

  private setState(next: DesktopLocalStackState) {
    if (next === this.current) return;
    this.current = next;
    this.deps.onState?.(next);
  }

  private async run(): Promise<DesktopLocalStackState> {
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      await this.attempt(controller.signal);
    } catch {
      // Copying the bundled compose files failed; the path would not help the person.
      this.push({ type: "failed", message: "Could not prepare the local stack. Retry." });
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
    return this.current;
  }

  private async attempt(signal: AbortSignal) {
    this.push({ type: "check-start" });
    await mkdir(this.deps.stackDir, { recursive: true, mode: 0o700 });

    const binary = resolveDockerBinary(this.deps.platform, this.deps.env, this.deps.exists);
    if (binary === null) {
      this.push({ type: "docker-missing", message: "Docker is not installed on this computer." });
      return;
    }
    const version = await this.docker(
      binary,
      ["compose", "version", "--short"],
      COMPOSE_VERSION_TIMEOUT_MS,
      signal,
    );
    if (interrupted(signal, version))
      return this.push({ type: "failed", message: START_INTERRUPTED });
    if (version.code !== 0) {
      this.push({
        type: "docker-missing",
        message:
          "Docker is installed, but Docker Compose is missing. Install Docker Desktop or the docker-compose-plugin.",
      });
      return;
    }
    const info = await this.docker(
      binary,
      ["info", "--format", "{{.ServerVersion}}"],
      DOCKER_INFO_TIMEOUT_MS,
      signal,
    );
    if (interrupted(signal, info)) return this.push({ type: "failed", message: START_INTERRUPTED });
    if (info.code !== 0) {
      this.push({
        type: "docker-not-running",
        message:
          failureKind(info) === "socket-permission"
            ? DOCKER_GROUP_HINT
            : "Docker is installed but not running. Start Docker, then check again.",
      });
      return;
    }

    this.push({ type: "prepare" });
    await copyFile(
      path.join(this.deps.resourceDir, STACK_COMPOSE_FILE),
      path.join(this.deps.stackDir, STACK_COMPOSE_FILE),
    );
    const template = await readFile(path.join(this.deps.resourceDir, STACK_ENV_TEMPLATE), "utf8");
    await ensureStackEnv(this.deps.stackDir, template, this.deps.randomHex);
    const stackToken = await ensureStackToken(this.deps.stackDir, this.deps.randomHex);
    this.currentStackToken = stackToken;
    const gate = this.gateChange;
    this.gateChange = { kind: "keep" };
    const requestedPort = this.gatePort;
    this.gatePort = null;
    const envPath = path.join(this.deps.stackDir, STACK_ENV_FILE);
    const env = await readFile(envPath, "utf8");
    const existingGate = gateFromEnv(env);
    this.gateOn = gate.kind === "set" || (gate.kind === "keep" && existingGate !== null);
    if (this.gateOn) {
      await copyFile(
        path.join(this.deps.resourceDir, STACK_GATE_FILE),
        path.join(this.deps.stackDir, STACK_GATE_FILE),
      );
    }

    this.push({ type: "pull-start" });
    const pulled = await this.compose(binary, ["pull"], PULL_TIMEOUT_MS, signal);
    if (interrupted(signal, pulled))
      return this.push({ type: "failed", message: START_INTERRUPTED });
    if (pulled.code !== 0) {
      this.push({
        type: "failed",
        message: stackFailureMessage(failureKind(pulled), "pulling", this.deps.imageTag),
      });
      return;
    }

    const port = requestedPort ?? existingGate?.port ?? GATE_DEFAULT_PORT;
    if (gate.kind === "set") {
      const hash = await this.hashGatePassword(binary, gate.access.password, signal);
      if (signal.aborted) return this.push({ type: "failed", message: START_INTERRUPTED });
      if (hash === null) {
        this.push({ type: "failed", message: GATE_HASH_FAILED });
        return;
      }
      const { username, password } = gate.access;
      await writePrivateFile(
        envPath,
        withEnvValues(env, {
          QUANT_BASIC_USER: username,
          QUANT_BASIC_HASH: `'${hash}'`,
          QUANT_BASIC_B64: Buffer.from(`${username}:${password}`).toString("base64"),
          // A new password also signs out the devices the gate remembered.
          QUANT_GATE_TOKEN: this.deps.randomHex(32),
          QUANT_PORT: String(port),
          // The gate's HTTPS port is unused without a domain; any free loopback port will do.
          QUANT_HTTPS_BIND: "127.0.0.1:",
        }),
      );
    } else if (gate.kind === "keep" && existingGate !== null && port !== existingGate.port) {
      await writePrivateFile(envPath, withEnvValues(env, { QUANT_PORT: String(port) }));
    } else if (gate.kind === "off" && existingGate !== null) {
      await writePrivateFile(
        envPath,
        withEnvValues(env, {
          QUANT_BASIC_USER: "",
          QUANT_BASIC_HASH: "",
          QUANT_BASIC_B64: "",
          QUANT_GATE_TOKEN: "",
        }),
      );
    }

    this.push({ type: "up-start" });
    const upArgs = composeSupportsWaitTimeout(version.stdout)
      ? ["up", "-d", "--wait", "--wait-timeout", String(COMPOSE_WAIT_TIMEOUT_S)]
      : ["up", "-d"];
    await writePrivateFile(path.join(this.deps.stackDir, STACK_WEB_URL_FILE), this.currentWebUrl);
    let up = await this.compose(binary, upArgs, UP_TIMEOUT_MS, signal);
    for (
      let retry = 0;
      retry < 2 && !interrupted(signal, up) && up.code !== 0 && failureKind(up) === "port-in-use";
      retry += 1
    ) {
      const port = await (this.deps.allocatePort ?? allocateLoopbackPort)();
      if (signal.aborted) break;
      this.currentWebUrl = `http://127.0.0.1:${port}`;
      await writePrivateFile(path.join(this.deps.stackDir, STACK_WEB_URL_FILE), this.currentWebUrl);
      up = await this.compose(binary, upArgs, UP_TIMEOUT_MS, signal);
    }
    if (interrupted(signal, up)) return this.push({ type: "failed", message: START_INTERRUPTED });
    if (up.code !== 0) {
      // Best effort: recent service logs usually name the failing service.
      await this.compose(binary, ["logs", "--tail", "30", "--no-color"], LOGS_TIMEOUT_MS, signal);
      this.push({
        type: "failed",
        message: stackFailureMessage(failureKind(up), "starting", this.deps.imageTag),
      });
      return;
    }

    if (gate.kind === "off" && existingGate !== null) {
      // `up` leaves a container whose profile is off running, so remove the gate explicitly.
      await this.compose(binary, ["rm", "--stop", "--force", "gate"], GATE_RM_TIMEOUT_MS, signal, {
        env: { COMPOSE_PROFILES: "gate" },
      });
    }

    this.push({ type: "wait-start" });
    const sleep = this.deps.sleep ?? defaultSleep;
    const deadline = Date.now() + (this.deps.healthTimeoutMs ?? STACK_HEALTH_TIMEOUT_MS);
    while (!signal.aborted) {
      if ((await this.deps.probe(this.currentWebUrl, signal, stackToken)) === this.deps.imageTag) {
        this.push({ type: "ready" });
        return;
      }
      if (Date.now() >= deadline) break;
      await sleep(HEALTH_POLL_INTERVAL_MS, signal);
    }
    this.push({
      type: "failed",
      message: signal.aborted
        ? START_INTERRUPTED
        : "The stack started but the web app did not answer. Retry, and check the output below.",
    });
  }

  /** Caddy's own bcrypt, run in the gate image; the password travels in the environment. */
  private async hashGatePassword(binary: string, password: string, signal: AbortSignal) {
    const hashed = await this.compose(
      binary,
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "-e",
        "QUANT_HASH_INPUT",
        "gate",
        "sh",
        "-c",
        'caddy hash-password --plaintext "$QUANT_HASH_INPUT"',
      ],
      HASH_TIMEOUT_MS,
      signal,
      { env: { QUANT_HASH_INPUT: password }, quiet: true },
    );
    const hash = hashed.stdout.trim().split("\n").at(-1)?.trim() ?? "";
    return hashed.code === 0 && BCRYPT_HASH.test(hash) ? hash : null;
  }

  private docker(
    binary: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
    options: DockerCallOptions = {},
  ) {
    return this.deps.run(binary, args, {
      cwd: this.deps.stackDir,
      env: dockerSpawnEnv(this.deps.platform, this.deps.env, binary, {
        RAKAZO_IMAGE_TAG: this.deps.imageTag,
        RAKAZO_COMPUTER_IMAGE_TAG: this.deps.imageTag,
        ...(this.currentStackToken === null
          ? {}
          : { RAKAZO_DESKTOP_STACK_TOKEN: this.currentStackToken }),
        RAKAZO_WEB_PORT: new URL(this.currentWebUrl).port || "80",
        // Only web needs a stable host address. Docker allocates the API host port.
        RAKAZO_API_PORT: "0",
        BETTER_AUTH_URL: this.currentWebUrl,
        WEB_ORIGIN: this.currentWebUrl,
        API_URL: this.currentWebUrl,
        COMPOSE_PROGRESS: "plain",
        ...(this.gateOn ? { COMPOSE_PROFILES: "gate" } : {}),
        ...options.env,
      }),
      timeoutMs,
      signal,
      // A quiet call's output can hold a secret, so it never reaches the setup window.
      onLine: options.quiet ? undefined : (line) => this.push({ type: "output", line }),
    });
  }

  private compose(
    binary: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
    options: DockerCallOptions = {},
  ) {
    return this.docker(
      binary,
      [
        "compose",
        "--env-file",
        STACK_ENV_FILE,
        "-f",
        STACK_COMPOSE_FILE,
        "--project-name",
        STACK_PROJECT_NAME,
        ...args,
      ],
      timeoutMs,
      signal,
      options,
    );
  }
}

interface DockerCallOptions {
  env?: Record<string, string>;
  quiet?: boolean;
}
