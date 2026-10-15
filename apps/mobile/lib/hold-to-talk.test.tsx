// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HoldEngine, HoldToTalk } from "./hold-to-talk";
import { LOCK_DISTANCE, TAP_MS, useHoldToTalk } from "./hold-to-talk";

vi.mock("./api", () => ({ captureApiRequestContext: vi.fn() }));
vi.mock("./dictation", () => ({}));
vi.mock("./i18n", () => ({ t: (text: string) => text, getActiveUiLocale: () => "en" }));
vi.mock("./user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("expo-file-system", () => ({ File: class {} }));

function fakeEngine(text: string) {
  const engine: HoldEngine = {
    start: vi.fn(async () => {}),
    finish: vi.fn(async () => text),
    cancel: vi.fn(),
  };
  return engine;
}

describe("hold to talk", () => {
  let root: Root;
  let talk: HoldToTalk;
  let engine: HoldEngine;
  const onText = vi.fn();

  function Harness() {
    talk = useHoldToTalk({ transcribe: false, onText, engine: () => engine });
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    onText.mockClear();
    engine = fakeEngine("hello");
    root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("sends what was said when the finger lifts", async () => {
    act(() => talk.press());
    expect(engine.start).toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(TAP_MS + 10));
    await act(async () => talk.release());
    expect(onText).toHaveBeenCalledWith("hello");
    expect(talk.recording).toBeNull();
  });

  it("treats a quick tap as a question and shows how to hold", () => {
    act(() => talk.press());
    act(() => talk.release());
    expect(engine.cancel).toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
    expect(talk.notice).toBe("Hold to talk, release to send");
  });

  it("locks after sliding up, then sends or discards by hand", async () => {
    act(() => talk.press());
    act(() => talk.move(LOCK_DISTANCE));
    expect(talk.recording?.locked).toBe(true);
    act(() => talk.release());
    expect(engine.finish).not.toHaveBeenCalled();
    act(() => talk.cancel());
    expect(engine.cancel).toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
  });
});
