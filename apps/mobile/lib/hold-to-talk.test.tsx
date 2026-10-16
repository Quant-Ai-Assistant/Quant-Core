// @vitest-environment jsdom

import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClipRecorder, HoldToTalk, VoiceClip } from "./hold-to-talk";
import {
  CANCEL_DISTANCE,
  LOCK_DISTANCE,
  levelFromDecibels,
  TAP_MS,
  useHoldToTalk,
  waveformBars,
} from "./hold-to-talk";

vi.mock("./i18n", () => ({ t: (text: string) => text }));
vi.mock("./user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));

const CLIP: VoiceClip = { uri: "file:///voice.m4a", durationMs: 2_000, waveform: [0.4, 1] };

function fakeRecorder() {
  const recorder: ClipRecorder = {
    start: vi.fn(async () => {}),
    finish: vi.fn(async () => CLIP),
    cancel: vi.fn(),
  };
  return recorder;
}

describe("hold to record", () => {
  let root: Root;
  let talk: HoldToTalk;
  let recorder: ClipRecorder;
  const onClip = vi.fn();

  function Harness() {
    talk = useHoldToTalk({ onClip, recorder: () => recorder });
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    onClip.mockClear();
    recorder = fakeRecorder();
    root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("sends the whole recording when the finger lifts", async () => {
    act(() => talk.press());
    expect(recorder.start).toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(TAP_MS + 10));
    await act(async () => talk.release());
    expect(onClip).toHaveBeenCalledWith(CLIP);
    expect(talk.recording).toBeNull();
  });

  it("treats a quick tap as a question and shows how to hold", () => {
    act(() => talk.press());
    act(() => talk.release());
    expect(recorder.cancel).toHaveBeenCalled();
    expect(onClip).not.toHaveBeenCalled();
    expect(talk.notice).toBe("Hold to record, release to send");
  });

  it("throws the recording away when the finger slides left", () => {
    act(() => talk.press());
    act(() => talk.move(0, CANCEL_DISTANCE));
    expect(recorder.cancel).toHaveBeenCalled();
    expect(talk.recording).toBeNull();
  });

  it("locks after sliding up, then sends or discards by hand", () => {
    act(() => talk.press());
    act(() => talk.move(LOCK_DISTANCE, 0));
    expect(talk.recording?.locked).toBe(true);
    act(() => talk.release());
    expect(recorder.finish).not.toHaveBeenCalled();
    act(() => talk.cancel());
    expect(recorder.cancel).toHaveBeenCalled();
    expect(onClip).not.toHaveBeenCalled();
  });
});

describe("voice levels", () => {
  it("maps metering decibels onto 0 to 1", () => {
    expect(levelFromDecibels(-160)).toBe(0);
    expect(levelFromDecibels(-25)).toBe(0.5);
    expect(levelFromDecibels(0)).toBe(1);
    expect(levelFromDecibels(undefined)).toBe(0);
  });

  it("averages loudness into bars scaled to the loudest", () => {
    expect(waveformBars([0.1, 0.1, 0.4, 0.4], 2)).toEqual([0.25, 1]);
  });
});
