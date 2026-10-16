import type { LiveCallFeedHandlers } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickUp } from "./call-pickup.js";
import { endCall, getSnapshot, startCall, toggleMute } from "./call-session";
import { connectLiveCall } from "./live-call.js";
import { rpc } from "./rpc.js";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));
vi.mock("./call-pickup.js", () => ({ pickUp: vi.fn(async () => undefined) }));
vi.mock("./live-call.js", () => ({ connectLiveCall: vi.fn() }));
vi.mock("./rpc.js", () => ({
  rpc: {
    threads: {
      endCall: vi.fn(async () => ({ ok: true })),
      activity: vi.fn(async () => ({ tool: null as string | null })),
    },
  },
}));

let handlers: LiveCallFeedHandlers;
const connection = { setMuted: vi.fn(), close: vi.fn() };

beforeEach(() => {
  vi.stubGlobal("navigator", { language: "ru-RU" });
  vi.mocked(connectLiveCall).mockImplementation(async (_call, next) => {
    handlers = next;
    return connection;
  });
});

afterEach(() => {
  endCall();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("web call session", () => {
  it("rings, then connects a live conversation and shows both sides", async () => {
    startCall({ botId: "bot", botName: "Ada" });
    expect(getSnapshot()?.phase).toBe("ringing");
    expect(pickUp).toHaveBeenCalledWith(expect.any(AbortSignal), { ring: true });
    await vi.waitFor(() => expect(getSnapshot()?.phase).toBe("listening"));
    expect(connectLiveCall).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "bot", language: "ru-RU", greeting: undefined }),
      expect.anything(),
      expect.any(AbortSignal),
    );

    handlers.onHeard("Any news?");
    handlers.onTurn({ role: "user", text: "Any news?" });
    handlers.onSpeaking(true);
    handlers.onSaid("Two new emails.");
    expect(getSnapshot()).toMatchObject({
      phase: "speaking",
      heard: "Any news?",
      caption: "Two new emails.",
      exchanges: [{ role: "user", text: "Any news?" }],
    });

    toggleMute();
    expect(connection.setMuted).toHaveBeenLastCalledWith(true);
  });

  it("answers a bot's call without ringing, and the bot opens", async () => {
    startCall({ botId: "bot", botName: "Ada", answered: { callId: "call1", opening: "Hi! " } });
    expect(pickUp).toHaveBeenCalledWith(expect.any(AbortSignal), { ring: false });
    await vi.waitFor(() => expect(connectLiveCall).toHaveBeenCalled());
    expect(connectLiveCall).toHaveBeenCalledWith(
      expect.objectContaining({ callId: "call1", greeting: "Hi!" }),
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it("hangs up through the server with how long the call was connected", async () => {
    startCall({ botId: "bot", botName: "Ada", answered: { callId: "call2", opening: "" } });
    await vi.waitFor(() => expect(getSnapshot()?.phase).toBe("listening"));
    endCall();
    expect(connection.close).toHaveBeenCalled();
    expect(rpc.threads.endCall).toHaveBeenCalledWith({
      botId: "bot",
      callId: "call2",
      durationSeconds: 0,
    });
    // It stays a moment as "Call ended", then closes.
    expect(getSnapshot()?.endedAt).toEqual(expect.any(Number));
    await vi.waitFor(() => expect(getSnapshot()).toBeNull(), { timeout: 3_000 });
  });

  it("connects before the clock starts, then shows the tool the bot is using", async () => {
    vi.mocked(rpc.threads.activity).mockResolvedValue({ tool: "computer_act" });
    startCall({ botId: "bot", botName: "Ada" });
    expect(getSnapshot()?.connectedAt).toBeNull();
    await vi.waitFor(() => expect(getSnapshot()?.connectedAt).toEqual(expect.any(Number)));
    await vi.waitFor(() => expect(getSnapshot()?.tool).toBe("computer_act"));
    expect(rpc.threads.activity).toHaveBeenCalledWith({ botId: "bot" });
    vi.mocked(rpc.threads.activity).mockResolvedValue({ tool: null });
  });

  it("ends when the provider closes the call, and shows a failed connection", async () => {
    startCall({ botId: "bot", botName: "Ada" });
    await vi.waitFor(() => expect(getSnapshot()?.phase).toBe("listening"));
    handlers.onEnded("remote_hangup");
    expect(getSnapshot()?.endedAt).toEqual(expect.any(Number));

    vi.mocked(connectLiveCall).mockRejectedValueOnce(new Error("No access to gpt-live-1"));
    startCall({ botId: "bot", botName: "Ada" });
    await vi.waitFor(() => expect(getSnapshot()?.error).toBe("No access to gpt-live-1"));
  });
});
