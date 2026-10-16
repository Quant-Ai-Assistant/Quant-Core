// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceRecording } from "../../lib/voice-recorder";
import {
  CANCEL_DISTANCE_PX,
  HoldToTalkControls,
  HoldToTalkStrip,
  LOCK_DISTANCE_PX,
  type Recorder,
  TAP_MS,
  useHoldToTalk,
} from "./HoldToTalk";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

const RECORDING: VoiceRecording = {
  blob: new Blob(["audio"], { type: "audio/mp4" }),
  mimeType: "audio/mp4",
  durationMs: 2_000,
  waveform: [0.2, 1],
};

function fakeRecorder(): Recorder & { start: ReturnType<typeof vi.fn> } {
  return {
    onLevel: null,
    onLimit: null,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => RECORDING),
    cancel: vi.fn(),
  };
}

function Harness({
  recorder,
  onRecording,
}: {
  recorder: Recorder;
  onRecording: (recording: VoiceRecording) => void;
}) {
  const talk = useHoldToTalk({ recorder, onRecording });
  return (
    <div>
      <HoldToTalkStrip talk={talk} />
      <HoldToTalkControls talk={talk} />
    </div>
  );
}

describe("hold to record", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let recorder: ReturnType<typeof fakeRecorder>;
  const onRecording = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    recorder = fakeRecorder();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<Harness recorder={recorder} onRecording={onRecording} />));
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    vi.useRealTimers();
  });

  function button(name: string) {
    const found = container?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
    if (!found) throw new Error(`Missing button: ${name}`);
    return found;
  }

  function pointer(target: Element, type: string, clientX = 400, clientY = 400) {
    act(() => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY }));
    });
  }

  it("sends the whole recording when the hold is released", async () => {
    const mic = button("Record voice message");
    pointer(mic, "pointerdown");
    expect(recorder.start).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(TAP_MS + 100));
    pointer(mic, "pointerup");
    await act(async () => {});

    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(onRecording).toHaveBeenCalledWith(RECORDING);
    expect(container?.querySelector('[data-testid="hold-to-talk-strip"]')).toBeNull();
  });

  it("treats a quick tap as a tap: nothing is sent and the hint shows", () => {
    const mic = button("Record voice message");
    pointer(mic, "pointerdown");
    pointer(mic, "pointerup");

    expect(recorder.stop).not.toHaveBeenCalled();
    expect(recorder.cancel).toHaveBeenCalled();
    expect(container?.textContent).toContain("Hold to record, release to send");
  });

  it("throws the recording away when the hold slides left", () => {
    const mic = button("Record voice message");
    pointer(mic, "pointerdown", 400);
    pointer(mic, "pointermove", 400 - CANCEL_DISTANCE_PX - 1);

    expect(recorder.cancel).toHaveBeenCalled();
    expect(onRecording).not.toHaveBeenCalled();
    expect(container?.querySelector('[data-testid="hold-to-talk-strip"]')).toBeNull();
  });

  it("locks when the hold slides up, then sends only on Send", async () => {
    const mic = button("Record voice message");
    pointer(mic, "pointerdown", 400, 400);
    pointer(mic, "pointermove", 400, 400 - LOCK_DISTANCE_PX - 1);
    act(() => vi.advanceTimersByTime(TAP_MS + 100));
    pointer(mic, "pointerup", 400, 400 - LOCK_DISTANCE_PX - 1);
    expect(recorder.stop).not.toHaveBeenCalled();

    act(() => button("Send recording").click());
    await act(async () => {});
    expect(onRecording).toHaveBeenCalledWith(RECORDING);
  });

  it("discards a locked recording", () => {
    const mic = button("Record voice message");
    pointer(mic, "pointerdown", 400, 400);
    pointer(mic, "pointermove", 400, 400 - LOCK_DISTANCE_PX - 1);

    act(() => button("Discard recording").click());

    expect(recorder.cancel).toHaveBeenCalled();
    expect(onRecording).not.toHaveBeenCalled();
    expect(container?.querySelector('[data-testid="hold-to-talk-strip"]')).toBeNull();
  });

  it("starts locked from the keyboard, since a key cannot be held and slid", () => {
    act(() => {
      button("Record voice message").dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail: 0 }),
      );
    });

    expect(recorder.start).toHaveBeenCalledOnce();
    expect(button("Send recording")).toBeTruthy();
  });
});
