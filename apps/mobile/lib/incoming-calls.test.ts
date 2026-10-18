import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnswerDeps, IncomingCallDeps, Ringing } from "./incoming-calls";
import { answerIncomingCall, isStillRinging, syncIncomingCalls } from "./incoming-calls";

const platform = vi.hoisted(() => ({ OS: "android" }));
vi.mock("react-native", () => ({ Platform: platform, Alert: { alert: vi.fn() } }));
vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
vi.mock("./api", () => ({ currentApiBase: vi.fn(), rpc: vi.fn(), selectedSpaceId: vi.fn() }));
vi.mock("./session", () => ({ loadSessionToken: vi.fn() }));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
vi.mock("./live-notifications", () => ({
  incomingCallBlockers: vi.fn(),
  openFullScreenCallSettings: vi.fn(),
  requestUnrestrictedBattery: vi.fn(),
  setIncomingCalls: vi.fn(),
}));

function syncDeps(availability: () => Promise<Ringing>): IncomingCallDeps {
  return {
    loadAvailability: availability,
    apply: vi.fn(async () => {}),
    askOnce: vi.fn(async () => {}),
  };
}

afterEach(() => {
  platform.OS = "android";
});

describe("incoming calls on Android", () => {
  it("rings in the background for reminders, and for calls while the server offers them", async () => {
    const on = syncDeps(async () => ({ calls: true, reminders: true }));
    await syncIncomingCalls(on);
    expect(on.apply).toHaveBeenCalledWith({ calls: true, reminders: true });
    expect(on.askOnce).toHaveBeenCalled();

    const reminders = syncDeps(async () => ({ calls: false, reminders: true }));
    await syncIncomingCalls(reminders);
    expect(reminders.apply).toHaveBeenCalledWith({ calls: false, reminders: true });
    expect(reminders.askOnce).toHaveBeenCalled();

    const off = syncDeps(async () => ({ calls: false, reminders: false }));
    await syncIncomingCalls(off);
    expect(off.apply).toHaveBeenCalledWith({ calls: false, reminders: false });
    expect(off.askOnce).not.toHaveBeenCalled();
  });

  it("leaves the service as it was when the check fails, and does nothing on iOS", async () => {
    const flaky = syncDeps(async () => {
      throw new Error("offline");
    });
    await syncIncomingCalls(flaky);
    expect(flaky.apply).not.toHaveBeenCalled();

    platform.OS = "ios";
    const ios = syncDeps(async () => ({ calls: true, reminders: true }));
    await syncIncomingCalls(ios);
    expect(ios.apply).not.toHaveBeenCalled();
  });

  it("answers in the call's space, stops the ringing, and connects with the bot's opening", async () => {
    const deps: AnswerDeps = {
      selectedSpaceId: () => "space-a",
      selectSpace: vi.fn(async () => true),
      answer: vi.fn(async () => ({ opening: " Hi, it's Ada. " })),
      dismiss: vi.fn(async () => {}),
      start: vi.fn(),
    };
    await answerIncomingCall(
      { botId: "bot", botName: "Ada", callId: "c1", spaceId: "space-b" },
      deps,
    );
    expect(deps.selectSpace).toHaveBeenCalledWith("space-b");
    expect(deps.answer).toHaveBeenCalledWith("bot", "c1");
    expect(deps.dismiss).toHaveBeenCalledWith("c1");
    expect(deps.start).toHaveBeenCalledWith({
      botId: "bot",
      botName: "Ada",
      greeting: "Hi, it's Ada.",
      callId: "c1",
    });
  });

  it("recovers the call id from who is ringing when the notification's link lost it", async () => {
    const deps: AnswerDeps = {
      selectedSpaceId: () => "space-a",
      selectSpace: vi.fn(async () => true),
      ringing: vi.fn(async () => [
        { botId: "other", botName: "Max", botColor: "", callId: "c2", expiresAt: "" },
        { botId: "bot", botName: "Ada", botColor: "", callId: "c1", expiresAt: "" },
      ]),
      answer: vi.fn(async () => ({ opening: "" })),
      dismiss: vi.fn(async () => {}),
      start: vi.fn(),
    };
    await answerIncomingCall({ botId: "bot", botName: "Ada", callId: "" }, deps);
    expect(deps.answer).toHaveBeenCalledWith("bot", "c1");
    expect(deps.start).toHaveBeenCalledWith(expect.objectContaining({ callId: "c1" }));
  });

  it("does not send an id the server would reject when nothing is ringing", async () => {
    const deps: AnswerDeps = {
      selectedSpaceId: () => "space-a",
      selectSpace: vi.fn(),
      ringing: vi.fn(async () => []),
      answer: vi.fn(),
      dismiss: vi.fn(async () => {}),
      start: vi.fn(),
    };
    await expect(
      answerIncomingCall({ botId: "bot", botName: "Ada", callId: "call:bad" }, deps),
    ).rejects.toThrow("no longer ringing");
    expect(deps.answer).not.toHaveBeenCalled();
  });

  it("does not connect a call that stopped ringing before it was answered", async () => {
    const deps: AnswerDeps = {
      selectedSpaceId: () => "space-a",
      selectSpace: vi.fn(),
      answer: vi.fn(async () => {
        throw new Error("This call is no longer ringing.");
      }),
      dismiss: vi.fn(async () => {}),
      start: vi.fn(),
    };
    await expect(
      answerIncomingCall({ botId: "bot", botName: "Ada", callId: "c1" }, deps),
    ).rejects.toThrow("no longer ringing");
    expect(deps.selectSpace).not.toHaveBeenCalled();
    expect(deps.start).not.toHaveBeenCalled();
  });

  it("tells whether a call is still ringing", async () => {
    const list = async () => [
      { botId: "bot", botName: "Ada", botColor: "", callId: "c1", expiresAt: "" },
    ];
    expect(await isStillRinging("c1", list)).toBe(true);
    expect(await isStillRinging("c2", list)).toBe(false);
  });
});
