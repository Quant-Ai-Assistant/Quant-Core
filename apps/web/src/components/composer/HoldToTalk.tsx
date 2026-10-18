import { useLingui } from "@lingui/react/macro";
import { Button, cn } from "@rakazo/ui-web";
import { ArrowUp, ChevronLeft, ChevronUp, Lock, Mic, Trash2 } from "lucide-react";
import type { PointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceRecorder, type VoiceRecording } from "../../lib/voice-recorder";

/** How far the finger travels up before the recording locks hands-free. */
export const LOCK_DISTANCE_PX = 64;
/** How far the finger travels left before the recording is thrown away. */
export const CANCEL_DISTANCE_PX = 96;
/** A press shorter than this is a tap: nothing was said, so it only shows the hint. */
export const TAP_MS = 350;
const HINT_MS = 2_500;
/** Bars the live meter keeps while recording. */
const LIVE_BARS = 40;

/** What the composer needs from a recorder; tests pass a stand-in. */
export type Recorder = Pick<VoiceRecorder, "start" | "stop" | "cancel" | "onLevel" | "onLimit">;

export type HoldToTalk = {
  /** Recording now; `locked` once the hold was slid up and the finger can lift. */
  recording: { locked: boolean; startedAt: number } | null;
  /** Recent loudness, oldest first, for the live meter. */
  levels: number[];
  /** The finger's travel toward the lock, 0 to LOCK_DISTANCE_PX. */
  lift: number;
  /** The finger's travel toward cancel, 0 to CANCEL_DISTANCE_PX. */
  slide: number;
  notice: string | null;
  submit: () => void;
  cancel: () => void;
  buttonProps: {
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
    onPointerCancel: () => void;
    onClick: (event: { detail: number }) => void;
    onContextMenu: (event: { preventDefault: () => void }) => void;
  };
};

/**
 * Telegram-style voice messages: hold to record and release to send the recording; slide up
 * while holding to lock, slide left to throw it away. Keyboard activation starts locked,
 * since a key cannot be held and slid. The recording itself is sent, so nothing said before
 * the release is lost to a transcriber that had not caught up.
 */
export function useHoldToTalk({
  disabled,
  browserTranscript,
  onRecording,
  recorder: injected,
}: {
  disabled?: boolean;
  /** Also let the browser transcribe, for servers that cannot. */
  browserTranscript?: boolean;
  onRecording: (recording: VoiceRecording) => void;
  recorder?: Recorder;
}): HoldToTalk {
  const { t } = useLingui();
  const [recording, setRecording] = useState<HoldToTalk["recording"]>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [lift, setLift] = useState(0);
  const [slide, setSlide] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const recorder = useRef<Recorder | null>(injected ?? null);
  const recordingRef = useRef(recording);
  const onRecordingRef = useRef(onRecording);
  useEffect(() => {
    onRecordingRef.current = onRecording;
  }, [onRecording]);
  const gesture = useRef<{ startX: number; startY: number; startedAt: number } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), HINT_MS);
  }, []);

  const reset = useCallback(() => {
    gesture.current = null;
    recordingRef.current = null;
    setRecording(null);
    setLevels([]);
    setLift(0);
    setSlide(0);
  }, []);

  const cancel = useCallback(() => {
    recorder.current?.cancel();
    reset();
  }, [reset]);

  const submit = useCallback(() => {
    const active = recorder.current;
    if (!recordingRef.current || !active) return;
    reset();
    void active.stop().then(
      (done) => {
        if (done) onRecordingRef.current(done);
      },
      () => showNotice(t`Could not record`),
    );
  }, [reset, showNotice, t]);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      if (recordingRef.current) recorder.current?.cancel();
    },
    [],
  );

  const start = useCallback(
    (locked: boolean) => {
      setNotice(null);
      recorder.current ??= new VoiceRecorder();
      const active = recorder.current;
      active.onLevel = (level) => setLevels((current) => [...current, level].slice(-LIVE_BARS));
      // The length limit sends what was recorded rather than dropping it.
      active.onLimit = () => submit();
      const next = { locked, startedAt: Date.now() };
      recordingRef.current = next;
      setRecording(next);
      active.start({ transcribeInBrowser: Boolean(browserTranscript) }).catch(() => {
        reset();
        showNotice(t`Allow the microphone to record`);
      });
    },
    [browserTranscript, reset, showNotice, submit, t],
  );

  const lock = useCallback(() => {
    gesture.current = null;
    setLift(0);
    setSlide(0);
    const current = recordingRef.current;
    if (!current) return;
    const next = { ...current, locked: true };
    recordingRef.current = next;
    setRecording(next);
  }, []);

  return {
    recording,
    levels,
    lift,
    slide,
    notice,
    submit,
    cancel,
    buttonProps: {
      onPointerDown: (event) => {
        if (disabled || event.button !== 0 || recordingRef.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        gesture.current = { startX: event.clientX, startY: event.clientY, startedAt: Date.now() };
        start(false);
      },
      onPointerMove: (event) => {
        const hold = gesture.current;
        if (!hold || !recordingRef.current || recordingRef.current.locked) return;
        const up = Math.max(0, hold.startY - event.clientY);
        const left = Math.max(0, hold.startX - event.clientX);
        if (left >= CANCEL_DISTANCE_PX) {
          cancel();
          return;
        }
        if (up >= LOCK_DISTANCE_PX) {
          lock();
          return;
        }
        setLift(up);
        setSlide(left);
      },
      onPointerUp: () => {
        const hold = gesture.current;
        gesture.current = null;
        setLift(0);
        setSlide(0);
        if (!hold || !recordingRef.current || recordingRef.current.locked) return;
        if (Date.now() - hold.startedAt < TAP_MS) {
          cancel();
          showNotice(t`Hold to record, release to send`);
          return;
        }
        submit();
      },
      onPointerCancel: () => {
        if (!gesture.current) return;
        gesture.current = null;
        if (!recordingRef.current?.locked) cancel();
      },
      onClick: (event) => {
        // detail 0 is a keyboard press; pointer presses are handled above.
        if (event.detail !== 0 || disabled || recordingRef.current) return;
        start(true);
      },
      onContextMenu: (event) => event.preventDefault(),
    },
  };
}

function useSeconds(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** Takes the text field's place while recording: a live dot, the time, and the meter. */
export function HoldToTalkStrip({ talk }: { talk: HoldToTalk }) {
  const { t } = useLingui();
  const startedAt = talk.recording?.startedAt ?? Date.now();
  const seconds = useSeconds(startedAt);
  if (!talk.recording) return null;
  return (
    <div
      data-testid="hold-to-talk-strip"
      className="flex min-h-6 min-w-0 flex-1 items-center gap-2.5 py-0.5 text-[15px]"
    >
      {talk.recording.locked ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label={t`Discard recording`}
          onClick={talk.cancel}
          className="-ms-1.5 size-7 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
        >
          <Trash2 size={16} strokeWidth={1.8} />
        </Button>
      ) : null}
      <span
        aria-hidden="true"
        className="size-2 shrink-0 animate-pulse rounded-full bg-destructive"
      />
      <span className="shrink-0 tabular-nums text-foreground/80">
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      </span>
      {talk.recording.locked ? (
        <span
          aria-hidden="true"
          className="flex h-6 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden text-muted-foreground"
        >
          {talk.levels.map((level, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional and never reorder
              key={index}
              className="w-[3px] shrink-0 rounded-full bg-current"
              style={{ height: `${Math.max(3, Math.round(level * 22))}px` }}
            />
          ))}
        </span>
      ) : (
        <span
          className="flex min-w-0 flex-1 items-center justify-center gap-1 truncate text-muted-foreground transition-transform"
          style={{ transform: `translateX(${-talk.slide}px)` }}
        >
          <ChevronLeft size={15} strokeWidth={1.8} aria-hidden="true" />
          {t`Slide to cancel`}
        </span>
      )}
    </div>
  );
}

/** The microphone button, plus the lock target above it and Send once locked. */
export function HoldToTalkControls({ talk, disabled }: { talk: HoldToTalk; disabled?: boolean }) {
  const { t } = useLingui();
  const { recording } = talk;
  if (recording?.locked) {
    return (
      <Button
        size="icon"
        aria-label={t`Send recording`}
        onClick={talk.submit}
        className="size-8 shrink-0 rounded-full shadow-sm"
      >
        <ArrowUp size={16} strokeWidth={2.2} />
      </Button>
    );
  }
  return (
    <span className="relative inline-flex">
      {recording ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full start-1/2 mb-3 flex flex-col items-center gap-0.5 rounded-full border border-border bg-card px-2 py-2 text-muted-foreground shadow-md transition-transform"
          style={{ transform: `translate(-50%, ${-talk.lift}px)` }}
        >
          <Lock size={14} strokeWidth={1.8} />
          <ChevronUp size={14} strokeWidth={1.8} className="animate-bounce" />
        </span>
      ) : null}
      {talk.notice && !recording ? (
        <span
          role="status"
          className="pointer-events-none absolute bottom-full end-0 mb-2 w-max max-w-64 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[12.5px] text-foreground shadow-md"
        >
          {talk.notice}
        </span>
      ) : null}
      <Button
        variant="outline"
        size="icon"
        aria-label={t`Record voice message`}
        title={t`Hold to record, release to send`}
        disabled={disabled}
        {...talk.buttonProps}
        className={cn(
          "size-8 shrink-0 touch-none select-none rounded-full text-foreground/75 [-webkit-touch-callout:none]",
          recording &&
            "scale-125 border-destructive bg-destructive text-destructive-foreground hover:bg-destructive",
        )}
      >
        <Mic size={16} strokeWidth={1.8} />
      </Button>
    </span>
  );
}
