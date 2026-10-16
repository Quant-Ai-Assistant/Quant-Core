import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunDockerOptions, RunDockerResult } from "./docker-cli.js";
import type { FrontServerOptions } from "./front-server.js";
import {
  COMPUTER_IMAGE,
  ensureStackEnv,
  envValue,
  GATE_DEFAULT_PORT,
  gateFromEnv,
  LEGACY_COMPOSE_FILE,
  LEGACY_MOVED_FILE,
  LocalServerController,
  type LocalServerDeps,
  parseEnvFile,
  parseGateChange,
  parseGatePort,
  readStackGate,
  reduceStackState,
  renderStackEnv,
  STACK_ENV_FILE,
  STACK_OUTPUT_LINES,
  STACK_TOKEN_FILE,
  serverProcessEnv,
} from "./local-server.js";

const TEMPLATE = [
  "QUANT_PORT=8080",
  "QUANT_BASIC_USER=",
  "QUANT_BASIC_HASH=",
  "QUANT_BASIC_B64=",
  "QUANT_GATE_TOKEN=",
  "POSTGRES_USER=rakazo",
  "POSTGRES_PASSWORD=",
  "POSTGRES_DB=rakazo",
  "BETTER_AUTH_SECRET=",
  "ENCRYPTION_KEY=",
  "SANDBOX_PROVIDER=docker",
  "RAKAZO_IMAGE_TAG=edge",
  "",
].join("\n");

let root: string;
let calls: { command: string; args: string[]; env: Record<string, string> }[];
let launched: { args: string[]; env: Record<string, string>; stopped: boolean }[];
let fronts: { options: FrontServerOptions; closed: boolean }[];
let busyPorts: Set<number>;

type Script = (command: string, args: string[]) => Partial<RunDockerResult> | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "local-server-"));
  const resources = path.join(root, "resources");
  await mkdir(path.join(resources, "app"), { recursive: true });
  await writeFile(path.join(resources, "app", "api.mjs"), "");
  await mkdir(path.join(resources, "app", "node_modules", "@embedded-postgres", "darwin-arm64"), {
    recursive: true,
  });
  await writeFile(path.join(root, "template"), TEMPLATE);
  calls = [];
  launched = [];
  fronts = [];
  busyPorts = new Set();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function hex(bytes: number) {
  return "ab".repeat(bytes);
}

function controller(overrides: Partial<LocalServerDeps> = {}, script: Script = () => undefined) {
  let nextPort = 50_000;
  const deps: LocalServerDeps = {
    platform: "darwin",
    env: { PATH: "/usr/bin", HOME: "/home/me", OPENROUTER_API_KEY: "sk-shell-secret" },
    execPath: EXEC_PATH,
    resourceDir: path.join(root, "resources"),
    envTemplate: path.join(root, "template"),
    webRoot: path.join(root, "web"),
    stackDir: path.join(root, "stack"),
    serverDir: path.join(root, "server"),
    localWebUrl: "http://127.0.0.1:45173",
    version: "0.1.50",
    run: async (command: string, args: string[], options: RunDockerOptions) => {
      calls.push({ command, args, env: options.env });
      const scripted = script(command, args);
      if (path.basename(command) === "initdb") {
        const dataDir = args[args.indexOf("-D") + 1] ?? "";
        await mkdir(dataDir, { recursive: true });
        await writeFile(path.join(dataDir, "PG_VERSION"), "16\n");
      }
      // pg_ctl status: no server is running unless a script says otherwise.
      const fallback = args[0] === "status" ? 3 : 0;
      return { code: fallback, stdout: "", stderr: "", ...scripted };
    },
    launch: (_command, args, options) => {
      const entry = { args, env: options.env, stopped: false };
      launched.push(entry);
      return {
        exited: new Promise<number>(() => undefined),
        stop: async () => {
          entry.stopped = true;
        },
      };
    },
    startFront: async (options) => {
      const entry = { options, closed: false };
      fronts.push(entry);
      return {
        loopbackPort: options.loopbackPort,
        close: async () => {
          entry.closed = true;
        },
      };
    },
    probe: async () => true,
    randomHex: hex,
    allocatePort: async () => nextPort++,
    portFree: async (port) => !busyPorts.has(port),
    sleep: async () => undefined,
    healthTimeoutMs: 50,
    ...overrides,
  };
  return new LocalServerController(deps);
}

const stackPath = () => path.join(root, "stack");
const env = () => readFile(path.join(stackPath(), STACK_ENV_FILE), "utf8");
const EXEC_PATH = "/Applications/Quant.app/Contents/MacOS/Quant";
const commands = () =>
  calls.map((call) =>
    call.command === EXEC_PATH ? "migrate" : [path.basename(call.command), call.args[0]].join(" "),
  );
const migrateCall = () => calls.find((call) => call.command === EXEC_PATH);

describe("local server start", () => {
  it("creates the database, migrates, and runs the API, worker and front", async () => {
    const stack = controller();
    const state = await stack.start(
      { kind: "set", access: { username: "me", password: "hunter2-pw" } },
      9090,
    );
    expect(state.phase).toBe("ready");
    expect(stack.ready()).toBe(true);

    expect(commands()).toEqual(["initdb -D", "pg_ctl status", "pg_ctl start", "migrate"]);
    const initdb = calls[0]!;
    expect(initdb.args).toContain("--locale=C");
    // The password file is gone once the cluster exists.
    const passwordFile = initdb.args.find((arg) => arg.startsWith("--pwfile="))!.slice(9);
    await expect(stat(passwordFile)).rejects.toThrow();
    const start = calls[2]!;
    expect(start.args.at(-1)).toBe(
      "-c listen_addresses=127.0.0.1 -c unix_socket_directories= -p 50000",
    );
    const migrate = migrateCall()!;
    expect(migrate.args).toEqual([
      path.join(root, "resources", "app", "migrate.mjs"),
      path.join(root, "resources", "migrations"),
    ]);
    expect(migrate.env.DATABASE_URL).toBe(`postgres://rakazo:${hex(16)}@127.0.0.1:50000/rakazo`);
    expect(migrate.env.ELECTRON_RUN_AS_NODE).toBe("1");

    expect(launched.map((entry) => path.basename(entry.args[0] ?? ""))).toEqual([
      "api.mjs",
      "worker.mjs",
    ]);
    const api = launched[0]!.env;
    expect(api).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      API_HOST: "127.0.0.1",
      API_PORT: "50001",
      SANDBOX_PROVIDER: "desktop",
      WEB_ORIGIN: "http://127.0.0.1:45173",
      DATA_DIR: path.join(root, "server", "data"),
      RAKAZO_DESKTOP_STACK_TOKEN: hex(32),
      BETTER_AUTH_SECRET: hex(32),
    });
    // The shell's own keys never reach the server.
    expect(api).not.toHaveProperty("OPENROUTER_API_KEY", "sk-shell-secret");

    expect(fronts).toHaveLength(1);
    expect(fronts[0]!.options).toMatchObject({
      apiUrl: "http://127.0.0.1:50001",
      loopbackPort: 45173,
      gate: {
        port: 9090,
        basic: Buffer.from("me:hunter2-pw").toString("base64"),
        token: hex(32),
      },
    });
    const written = await env();
    expect(written).toContain("QUANT_BASIC_USER=me\n");
    expect(written).toContain("QUANT_PORT=9090\n");
    expect(written).not.toContain("hunter2-pw");
    expect(written).not.toContain("RAKAZO_IMAGE_TAG");
    expect((await stat(path.join(stackPath(), STACK_ENV_FILE))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(stackPath(), STACK_TOKEN_FILE), "utf8")).toBe(`${hex(32)}\n`);
  });

  it("starts the virtual desktop supervisor only when Docker answers", async () => {
    await writeFile(path.join(root, "resources", "app", "supervisor.mjs"), "");
    const docker = { RAKAZO_DOCKER_BINARY: "/fake/docker", PATH: "/usr/bin" };
    const exists = (file: string) => file === "/fake/docker" || existsSync(file);
    await controller({ env: docker, exists }).start();
    expect(launched.map((entry) => path.basename(entry.args[0] ?? ""))).toEqual([
      "supervisor.mjs",
      "api.mjs",
      "worker.mjs",
    ]);
    const supervisor = launched[0]!.env;
    expect(supervisor).toMatchObject({
      SUPERVISOR_HOST: "127.0.0.1",
      SANDBOX_CONTROL_VIA_LOOPBACK: "true",
      RAKAZO_COMPUTER_IMAGE: COMPUTER_IMAGE,
    });
    expect(launched[1]!.env.SANDBOX_SUPERVISOR_URL).toBe(
      `http://127.0.0.1:${supervisor.SUPERVISOR_PORT}`,
    );

    launched = [];
    await controller({ env: docker, exists }, (command) =>
      command === "/fake/docker" ? { code: 1 } : undefined,
    ).start();
    expect(launched.map((entry) => path.basename(entry.args[0] ?? ""))).toEqual([
      "api.mjs",
      "worker.mjs",
    ]);
    expect(launched[0]!.env).not.toHaveProperty("SANDBOX_SUPERVISOR_URL");
  });

  it("starts the supervisor on the built-in VM when Docker is not running", async () => {
    await writeFile(path.join(root, "resources", "app", "supervisor.mjs"), "");
    const socket = "/vm/h/quant/sock/docker.sock";
    // No Docker binary on this computer.
    const exists = (file: string) => path.basename(file) !== "docker" && existsSync(file);
    const stack = controller({ exists, virtualDesktopSocket: () => socket });
    await stack.start();
    expect(launched.map((entry) => path.basename(entry.args[0] ?? ""))).toEqual([
      "supervisor.mjs",
      "api.mjs",
      "worker.mjs",
    ]);
    expect(launched[0]!.env).toMatchObject({ DOCKER_HOST: "", DOCKER_SOCKET: socket });
    expect(stack.supervisorEngine()).toBe("vm");
  });

  it("opens the gate on the suggested port when none is chosen", async () => {
    await controller().start({ kind: "set", access: { username: "me", password: "pw" } });
    await expect(readStackGate(stackPath())).resolves.toEqual({
      username: "me",
      port: GATE_DEFAULT_PORT,
    });
  });

  it("moves the gate to a new port without signing devices out", async () => {
    await controller().start({ kind: "set", access: { username: "me", password: "pw" } }, 8081);
    const token = envValue(await env(), "QUANT_GATE_TOKEN");
    const stack = controller({ randomHex: (bytes) => "cd".repeat(bytes) });
    await stack.start({ kind: "keep" }, 9091);
    await expect(readStackGate(stackPath())).resolves.toEqual({ username: "me", port: 9091 });
    expect(envValue(await env(), "QUANT_GATE_TOKEN")).toBe(token);
  });

  it("reuses the cluster and stops a server a crash left running", async () => {
    await controller().start();
    calls = [];
    await controller({}, (command, args) =>
      path.basename(command) === "pg_ctl" && args[0] === "status" ? { code: 0 } : undefined,
    ).start();
    expect(commands()).toEqual(["pg_ctl status", "pg_ctl stop", "pg_ctl start", "migrate"]);
  });

  it("keeps an existing .env and its secrets", async () => {
    await mkdir(stackPath(), { recursive: true });
    await writeFile(path.join(stackPath(), STACK_ENV_FILE), "POSTGRES_PASSWORD=keep-me\n");
    await controller().start();
    expect(await env()).toBe("POSTGRES_PASSWORD=keep-me\n");
    expect(migrateCall()?.env.DATABASE_URL).toContain(":keep-me@");
  });

  it("refuses a busy gate port before anything starts", async () => {
    busyPorts.add(9090);
    const state = await controller().start(
      { kind: "set", access: { username: "me", password: "pw" } },
      9090,
    );
    expect(state).toMatchObject({
      phase: "failed",
      message: "Port 9090 is busy. Choose another port in setup.",
    });
    expect(calls).toEqual([]);
    expect(launched).toEqual([]);
  });

  it("moves to another loopback port when the saved one is taken", async () => {
    busyPorts.add(45173);
    const stack = controller();
    await stack.start();
    expect(stack.webUrl()).toBe("http://127.0.0.1:50000");
    expect(fronts[0]!.options.loopbackPort).toBe(50000);
  });

  it("fails and takes everything down when migrations fail", async () => {
    const state = await controller({}, (command) =>
      command === EXEC_PATH ? { code: 1 } : undefined,
    ).start();
    expect(state).toMatchObject({
      phase: "failed",
      message: "Could not update the database. Check the output below, then retry.",
    });
    expect(launched).toEqual([]);
    expect(commands().at(-1)).toBe("pg_ctl stop");
  });

  it("fails when the API never answers", async () => {
    const state = await controller({ probe: async () => false }).start();
    expect(state.message).toBe(
      "The server started but did not answer. Retry, and check the output below.",
    );
    expect(launched.every((entry) => entry.stopped)).toBe(true);
    expect(fronts[0]!.closed).toBe(true);
  });

  it("explains a build without the bundled server", async () => {
    await rm(path.join(root, "resources", "app"), { recursive: true });
    const state = await controller().start();
    expect(state.message).toBe("This build has no local server. Reinstall Quant.");
  });

  it("stops every part on request", async () => {
    const stack = controller();
    await stack.start();
    const stopped = await stack.stop();
    expect(stopped.phase).toBe("idle");
    expect(launched.every((entry) => entry.stopped)).toBe(true);
    expect(fronts[0]!.closed).toBe(true);
    expect(commands().at(-1)).toBe("pg_ctl stop");
  });

  it("pushes every state change", async () => {
    const pushed: string[] = [];
    await controller({ onState: (state) => pushed.push(state.phase) }).start();
    expect([...new Set(pushed)]).toEqual(["preparing", "starting", "waiting-healthy", "ready"]);
  });
});

describe("moving an earlier Docker install into the app", () => {
  async function legacyStack() {
    await mkdir(stackPath(), { recursive: true });
    await writeFile(path.join(stackPath(), LEGACY_COMPOSE_FILE), "services: {}\n");
    await writeFile(
      path.join(stackPath(), STACK_ENV_FILE),
      `${renderStackEnv(TEMPLATE, hex)}QUANT_BASIC_USER=me\nQUANT_BASIC_B64=bWU6cHc=\n`,
    );
  }
  const docker = { RAKAZO_DOCKER_BINARY: "/fake/docker", PATH: "/usr/bin" };
  const exists = (file: string) => file === "/fake/docker" || existsSync(file);

  it("dumps the database and copies the files from the volumes, then imports once", async () => {
    await legacyStack();
    const stack = controller({ env: docker, exists }, (command, args) =>
      command === "/fake/docker" && args.includes("pg_dump")
        ? { stdout: "INSERT INTO t VALUES (1);\n" }
        : undefined,
    );
    const state = await stack.start();
    expect(state.phase).toBe("ready");
    const commands = calls
      .filter((call) => call.command === "/fake/docker")
      .map((call) => (call.args[0] === "compose" ? call.args.slice(7) : call.args).join(" "));
    const move = `quant-move-${hex(4)}`;
    expect(commands).toEqual([
      "volume inspect quant-desktop_pgdata",
      "stop",
      `run --detach --name ${move} --network none --mount type=volume,src=quant-desktop_pgdata,dst=/var/lib/postgresql/data --env POSTGRES_PASSWORD=unused postgres:16`,
      `exec ${move} pg_isready -U rakazo`,
      `exec ${move} pg_dump -U rakazo -d rakazo --no-owner --no-privileges --inserts --rows-per-insert=500`,
      `rm --force ${move}`,
      "volume inspect quant-desktop_appdata",
      expect.stringMatching(
        new RegExp(
          `^run --rm --network none --mount type=volume,src=quant-desktop_appdata,dst=/data,readonly --mount type=bind,src=${path.join(root, "server", "data")},dst=/out busybox:1 sh -c cp -R /data/\\. /out/`,
        ),
      ),
    ]);
    const migrate = migrateCall()!;
    const importFile = path.join(root, "server", "docker-import.sql");
    expect(migrate.args.slice(2)).toEqual(["--import", importFile]);
    await expect(stat(importFile)).rejects.toThrow();
    expect(await readFile(path.join(stackPath(), LEGACY_MOVED_FILE), "utf8")).toBe("moved\n");

    calls = [];
    await controller({ env: docker, exists }).start();
    expect(calls.some((call) => call.command === "/fake/docker")).toBe(false);
  });

  it("starts fresh when the stack's database volume is gone", async () => {
    await legacyStack();
    const state = await controller({ env: docker, exists }, (command, args) =>
      command === "/fake/docker" && args[0] === "volume"
        ? {
            code: 1,
            stderr: "Error response from daemon: get quant-desktop_pgdata: no such volume",
          }
        : undefined,
    ).start();
    expect(state.phase).toBe("ready");
    expect(migrateCall()?.args).not.toContain("--import");
    expect(await readFile(path.join(stackPath(), LEGACY_MOVED_FILE), "utf8")).toBe("nothing\n");
  });

  it("explains a Docker that is out of disk space", async () => {
    await legacyStack();
    const state = await controller({ env: docker, exists }, (command, args) => {
      if (command !== "/fake/docker") return undefined;
      if (args.includes("pg_isready")) return { code: 1, stderr: "container is not running" };
      if (args[0] === "logs") {
        return {
          stdout: 'FATAL: could not write lock file "postmaster.pid": No space left on device',
        };
      }
      return undefined;
    }).start();
    expect(state.message).toBe(
      "Docker is out of disk space, so Quant cannot read your existing data. Free some space in Docker, then retry.",
    );
    // One readiness check: a container that exited is not waited on.
    expect(calls.filter((call) => call.args.includes("pg_isready"))).toHaveLength(1);
    expect(calls.at(-1)?.args).toEqual(["rm", "--force", `quant-move-${hex(4)}`]);
  });

  it("stops the throwaway container even when the dump fails", async () => {
    await legacyStack();
    const state = await controller({ env: docker, exists }, (command, args) =>
      command === "/fake/docker" && args.includes("pg_dump") ? { code: 1 } : undefined,
    ).start();
    expect(state.message).toBe(
      "Quant could not move your existing data from Docker. Check the output below, then retry.",
    );
    expect(calls.at(-1)?.args).toEqual(["rm", "--force", `quant-move-${hex(4)}`]);
  });

  it("asks for Docker when it is not there to move the data", async () => {
    await legacyStack();
    const state = await controller({
      env: { ...docker, RAKAZO_DOCKER_BINARY: "/missing" },
    }).start();
    expect(state.message).toBe(
      "Quant could not reach Docker to move your existing data into the app. Start Docker, then retry.",
    );
    expect(calls).toEqual([]);
  });

  it("asks for Docker when its daemon is down", async () => {
    await legacyStack();
    const state = await controller({ env: docker, exists }, (command) =>
      command === "/fake/docker"
        ? { code: 1, stderr: "Cannot connect to the Docker daemon. Is the docker daemon running?" }
        : undefined,
    ).start();
    expect(state.message).toContain("Start Docker, then retry.");
  });

  it("applies a dump an earlier attempt took without asking Docker again", async () => {
    await legacyStack();
    await mkdir(path.join(root, "server"), { recursive: true });
    await writeFile(path.join(root, "server", "docker-import.sql"), "SELECT 1;\n");
    await controller({ env: docker, exists }).start();
    expect(calls.some((call) => call.command === "/fake/docker")).toBe(false);
    expect(migrateCall()?.args).toContain("--import");
  });

  it("never overwrites a database the app already runs", async () => {
    await legacyStack();
    await mkdir(path.join(root, "server", "postgres"), { recursive: true });
    await writeFile(path.join(root, "server", "postgres", "PG_VERSION"), "16\n");
    await controller({ env: docker, exists }).start();
    expect(calls.some((call) => call.command === "/fake/docker")).toBe(false);
    expect(await readFile(path.join(stackPath(), LEGACY_MOVED_FILE), "utf8")).toBe("kept\n");
  });
});

describe("stack settings", () => {
  it("accepts only an unprivileged whole port number", () => {
    expect(parseGatePort(8080)).toBe(8080);
    expect(parseGatePort(1023)).toBeNull();
    expect(parseGatePort(65536)).toBeNull();
    expect(parseGatePort(8080.5)).toBeNull();
    expect(parseGatePort("8080")).toBeNull();
  });

  it("keeps the gate when nothing is sent and refuses malformed credentials", () => {
    expect(parseGateChange(undefined)).toEqual({ kind: "keep" });
    expect(parseGateChange(null)).toEqual({ kind: "keep" });
    expect(parseGateChange({ username: "me", password: "pw" })).toEqual({
      kind: "set",
      access: { username: "me", password: "pw" },
    });
    expect(parseGateChange({ username: "me me", password: "pw" })).toBeNull();
    expect(parseGateChange({ username: "me", password: "" })).toBeNull();
    expect(parseGateChange("me:pw")).toBeNull();
  });

  it("only reports a gate that has a user, credentials and a valid port", () => {
    expect(gateFromEnv("QUANT_BASIC_USER=me\nQUANT_BASIC_B64=x\nQUANT_PORT=8080")).toEqual({
      username: "me",
      port: 8080,
    });
    expect(gateFromEnv("QUANT_BASIC_USER=me\nQUANT_BASIC_B64=\nQUANT_PORT=8080")).toBeNull();
    expect(gateFromEnv("QUANT_BASIC_USER=me\nQUANT_BASIC_B64=x\nQUANT_PORT=0")).toBeNull();
  });

  it("reads the .env the way Compose passes it", () => {
    expect(parseEnvFile("# note\nA=1\nB='$2a$x'\nC=\"q\"\nnot a line\nD=\n")).toEqual({
      A: "1",
      B: "$2a$x",
      C: "q",
      D: "",
    });
  });

  it("fills only the empty secrets and drops image pins", () => {
    const rendered = renderStackEnv(TEMPLATE, hex);
    expect(rendered).toContain(`POSTGRES_PASSWORD=${hex(16)}\n`);
    expect(rendered).toContain("QUANT_BASIC_USER=\n");
    expect(rendered).not.toContain("RAKAZO_IMAGE_TAG");
  });

  it("replaces a symlinked .env instead of trusting its target", async () => {
    await mkdir(stackPath(), { recursive: true });
    const target = path.join(root, "elsewhere");
    await writeFile(target, "SECRET=outside\n");
    await symlink(target, path.join(stackPath(), STACK_ENV_FILE));
    expect(await ensureStackEnv(stackPath(), TEMPLATE, hex)).toBe("created");
    expect(await readFile(target, "utf8")).toBe("SECRET=outside\n");
  });

  it("gives the server the stack .env, with the app's own settings on top", () => {
    const env = serverProcessEnv({
      platform: "darwin",
      inherited: { PATH: "/usr/bin", HOME: "/home/me", AWS_SECRET_ACCESS_KEY: "x" },
      stackEnv: { SANDBOX_PROVIDER: "docker", OPENROUTER_API_KEY: "sk-saved", SECRET_STORE: "" },
      databaseUrl: "postgres://db",
      apiPort: 1,
      webUrl: "http://127.0.0.1:2",
      dataDir: "/data",
      stackToken: "t",
      version: "0.1.50",
    });
    expect(env).toMatchObject({
      PATH: "/usr/bin:/opt/homebrew/bin:/usr/local/bin",
      HOME: "/home/me",
      OPENROUTER_API_KEY: "sk-saved",
      SANDBOX_PROVIDER: "desktop",
      SECRET_STORE: "encrypted",
      PHONE_CALLS_ENABLED: "true",
    });
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });

  it("lets the stack .env turn calls off", () => {
    const env = serverProcessEnv({
      platform: "linux",
      inherited: {},
      stackEnv: { PHONE_CALLS_ENABLED: "false" },
      databaseUrl: "postgres://db",
      apiPort: 1,
      webUrl: "http://127.0.0.1:2",
      dataDir: "/data",
      stackToken: "t",
      version: "0.1.50",
    });
    expect(env.PHONE_CALLS_ENABLED).toBe("false");
  });

  it("keeps a bounded output tail and leaves terminal phases only through prepare", () => {
    let state = reduceStackState({ phase: "idle", message: null, output: [] }, { type: "prepare" });
    for (let index = 0; index < STACK_OUTPUT_LINES + 5; index += 1) {
      state = reduceStackState(state, { type: "output", line: String(index) });
    }
    expect(state.output).toHaveLength(STACK_OUTPUT_LINES);
    state = reduceStackState(state, { type: "failed", message: "x" });
    expect(reduceStackState(state, { type: "ready" }).phase).toBe("failed");
    expect(reduceStackState(state, { type: "prepare" })).toEqual({
      phase: "preparing",
      message: null,
      output: [],
    });
  });
});
