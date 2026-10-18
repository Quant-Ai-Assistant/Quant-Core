import type { ActivityStatus } from "@rakazo/contracts";
import type { LiveCallFeedHandlers } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallDeps } from "./call-session";
import { endCall, getSnapshot, startCall, toggleMute } from "./call-session";

vi.mock("./call-sounds", () => ({ playCallCue: vi.fn(), stopCallCues: vi.fn() }));
vi.mock("./live-call", () => ({ connectLiveCall: vi.fn() }));
vi.mock("./api", () => ({ rpc: vi.fn() }));

function liveDeps() {
  let handlers: LiveCallFeedHandlers | null = null;
  const connection = { setMuted: vi.fn(), close: vi.fn() };
  const deps: CallDeps = {
    cue: vi.fn(async () => {}),
    endCall: vi.fn(async () => {}),
    activity: vi.fn(async () => ({
      tool: null as string | null,
      status: null as ActivityStatus | null,
    })),
    connectLive: vi.fn(async (_call, next) => {
      handlers = next;
      return connection;
    }),
  };
  return { deps, connection, handlers: () => handlers! };
}

afterEach(() => endCall());

describe("mobile call session", () => {
  it("talks through the live connection instead of the turn-by-turn loop", async () => {
    const { deps, connection, handlers } = liveDeps();
    const id = startCall({ botId: "bot", botName: "Ada", greeting: "Hi, Ada here." }, deps);
    await vi.waitFor(() => expect(deps.connectLive).toHaveBeenCalled());
    expect(deps.connectLive).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "bot", callId: id, greeting: "Hi, Ada here." }),
      expect.anything(),
      expect.any(AbortSignal),
    );
    await vi.waitFor(() => expect(getSnapshot()?.phase).toBe("listening"));
    expect(deps.cue).toHaveBeenCalledWith("start");

    handlers().onHeard("What's on today?");
    handlers().onSpeaking(true);
    handlers().onTurn({ role: "user", text: "What's on today?" });
    expect(getSnapshot()).toMatchObject({
      phase: "speaking",
      heard: "What's on today?",
      exchanges: [{ role: "user", text: "What's on today?" }],
    });

    toggleMute();
    expect(connection.setMuted).toHaveBeenLastCalledWith(true);

    endCall();
    expect(connection.close).toHaveBeenCalled();
    expect(deps.endCall).toHaveBeenCalledWith("bot", id, 0);
    expect(deps.cue).toHaveBeenLastCalledWith("end");
    // It stays a moment as "Call ended", then closes.
    expect(getSnapshot()?.endedAt).toEqual(expect.any(Number));
    await vi.waitFor(() => expect(getSnapshot()).toBeNull(), { timeout: 3_000 });
  });

  it("connects before the clock starts, then shows the tool the bot is using", async () => {
    const { deps } = liveDeps();
    vi.mocked(deps.activity).mockResolvedValue({ tool: "computer_act", status: null });
    startCall({ botId: "bot", botName: "Ada" }, deps);
    expect(getSnapshot()?.connectedAt).toBeNull();
    await vi.waitFor(() => expect(getSnapshot()?.connectedAt).toEqual(expect.any(Number)));
    await vi.waitFor(() => expect(getSnapshot()?.tool).toBe("computer_act"));
    expect(deps.activity).toHaveBeenCalledWith("bot");
  });

  it("ends the call when the provider closes it", async () => {
    const { deps, handlers } = liveDeps();
    startCall({ botId: "bot", botName: "Ada" }, deps);
    await vi.waitFor(() => expect(deps.connectLive).toHaveBeenCalled());
    handlers().onEnded("remote_hangup");
    expect(getSnapshot()?.endedAt ?? null).not.toBeNull();
  });
});
