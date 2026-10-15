import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { MacScreen, type MacScreenDriverRunner, readableRole } from "./mac-screen.js";
import { MAC_SCREEN_DRIVER } from "./mac-screen-driver.js";

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const SCREEN = {
  width: 1512,
  height: 982,
  cursor: { x: 10, y: 20 },
  application: { pid: 42, name: "Notes", bundleId: "com.apple.Notes" },
  windowTitle: "Shopping",
  elements: [
    {
      id: 1,
      role: "AXButton",
      label: "New Note",
      rect: { x: 100, y: 40, w: 30, h: 20 },
      path: [0, 3],
    },
    {
      id: 2,
      role: "AXSecureTextField",
      secure: true,
      focused: true,
      rect: { x: 200, y: 300, w: 180, h: 24 },
      path: [0, 5, 1],
    },
  ],
};

/** Plays the driver: writes a frame for observe and records every request. */
function fakeDriver(
  reply: (request: Record<string, unknown>) => Record<string, unknown> = () => ({}),
) {
  const requests: Record<string, unknown>[] = [];
  const run: MacScreenDriverRunner = async (request) => {
    requests.push(request);
    if (request.op === "observe") {
      await writeFile(String(request.outputPath), Buffer.from([0xff, 0xd8, requests.length]));
      return { ...SCREEN, ...reply(request) };
    }
    return { completed: (request.actions as unknown[]).length, ...reply(request) };
  };
  return { run, requests };
}

describe("mac screen", () => {
  it("returns a JPEG frame with the frontmost app and its elements", async () => {
    const driver = fakeDriver();
    const observation = await new MacScreen(driver.run).observe("bot-a");
    expect(observation.mimeType).toBe("image/jpeg");
    expect(observation).toMatchObject({
      width: 1512,
      height: 982,
      cursor: { x: 10, y: 20 },
      activeWindow: { id: "com.apple.Notes", title: "Notes — Shopping" },
    });
    expect(observation.elements).toEqual([
      { id: 1, role: "button", label: "New Note", x: 100, y: 40, width: 30, height: 20 },
      {
        id: 2,
        role: "secure text field",
        x: 200,
        y: 300,
        width: 180,
        height: 24,
        focused: true,
        secure: true,
      },
    ]);
    expect(driver.requests[0]).toMatchObject({ op: "observe", marks: true, maxEdge: 1568 });
  });

  it("sends each element's path from that computer's last observation", async () => {
    const driver = fakeDriver();
    const screen = new MacScreen(driver.run);
    await screen.observe("bot-a");
    await screen.act("bot-a", [{ kind: "element", element: 1, action: "click" }], {
      observe: false,
    });
    expect(driver.requests[1]).toMatchObject({
      op: "act",
      elements: { "1": { id: 1, pid: 42, path: [0, 3], role: "AXButton", label: "New Note" } },
    });
    await expect(
      screen.act("bot-b", [{ kind: "element", element: 1, action: "click" }], { observe: false }),
    ).rejects.toThrow(/observe again/);
  });

  it("observes again after acting and reports partial batches", async () => {
    const driver = fakeDriver((request) =>
      request.op === "act" ? { completed: 1, error: "unsupported key hyper" } : {},
    );
    const screen = new MacScreen(driver.run);
    await expect(
      screen.act(
        "bot-a",
        [
          { kind: "key", key: "a" },
          { kind: "key", key: "hyper" },
        ],
        { observe: true, settleMs: 0 },
      ),
    ).rejects.toThrow("unsupported key hyper (completed 1 of 2 actions)");

    const ok = new MacScreen(fakeDriver().run);
    const result = await ok.act("bot-a", [{ kind: "wait", ms: 1 }], {
      observe: true,
      settleMs: 0,
    });
    expect(result.completed).toBe(1);
    expect(result.observation?.elements).toHaveLength(2);
  });

  it("explains a missing macOS permission", async () => {
    const screen = new MacScreen(
      fakeDriver(() => ({ completed: 0, error: "permission:accessibility" })).run,
    );
    await expect(
      screen.act("bot-a", [{ kind: "wait", ms: 1 }], { observe: false }),
    ).rejects.toThrow(/Accessibility permission/);
  });

  it("names roles the way people read them", () => {
    expect(readableRole("AXPopUpButton")).toBe("pop up button");
    expect(readableRole("AXLink")).toBe("link");
  });

  it("keeps the inline driver a plain string", () => {
    expect(MAC_SCREEN_DRIVER).not.toContain("`");
    expect(MAC_SCREEN_DRIVER).not.toContain("${");
    expect(MAC_SCREEN_DRIVER).toContain("function run(argv)");
  });
});

describe("desktop sandbox with the Mac screen", () => {
  const root = mkdtempSync(path.join(tmpdir(), "quant-mac-screen-"));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports a graphical computer with elements only when it has a screen", () => {
    const withScreen = new DesktopSandboxProvider({
      root,
      screen: new MacScreen(fakeDriver().run),
    });
    expect(withScreen.describe().capabilities).toMatchObject({ graphical: true, elements: true });
    expect(new DesktopSandboxProvider({ root }).describe().capabilities).toMatchObject({
      graphical: false,
      elements: false,
    });
  });

  it("opens workspace paths from the bot home and refuses paths outside it", async () => {
    const driver = fakeDriver();
    const desktop = new DesktopSandboxProvider({ root, screen: new MacScreen(driver.run) });
    const computer = await desktop.provision({ botId: "opener", homePath: "/tmp/opener" }, ctx);
    await desktop.act(
      computer,
      {
        actions: [
          { kind: "open", path: "notes/list.txt" },
          { kind: "open", path: "https://example.test" },
        ],
        observe: false,
      },
      ctx,
    );
    expect(driver.requests[0]?.actions).toEqual([
      { kind: "open", path: path.join(computer.providerRef ?? "", "notes/list.txt") },
      { kind: "open", path: "https://example.test" },
    ]);
    await expect(
      desktop.act(
        computer,
        { actions: [{ kind: "open", path: "/etc/hosts" }], observe: false },
        ctx,
      ),
    ).rejects.toThrow(/outside this computer's home/);
  });
});
