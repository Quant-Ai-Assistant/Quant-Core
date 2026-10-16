import { VOICE_MESSAGE_MAX_MS, VOICE_WAVEFORM_BARS } from "@rakazo/contracts";
import type { AudioRecorder } from "expo-audio";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { errorText } from "./user-error";

/** How far the finger travels up before the recording locks hands-free. */
export const LOCK_DISTANCE = 64;
/** How far the finger travels left before the recording is thrown away. */
export const CANCEL_DISTANCE = 96;
/** A press shorter than this is a tap: nothing was said, so it only shows the hint. */
export const TAP_MS = 350;
const NOTICE_MS = 2_500;
const LEVEL_INTERVAL_MS = 80;
/** Bars the live meter keeps while recording. */
const LIVE_BARS = 32;

/** A finished voice message, still on the phone. */
export type VoiceClip = { uri: string; durationMs: number; waveform: number[] };

/** One held recording; tests pass a stand-in. */
export type ClipRecorder = {
  start: (onLevel: (level: number) => void) => Promise<void>;
  finish: () => Promise<VoiceClip | null>;
  cancel: () => void;
};

/** Averages loudness samples into `bars` values scaled so the loudest bar is 1. */
export function waveformBars(levels: number[], bars = VOICE_WAVEFORM_BARS): number[] {
  if (!levels.length) return Array.from({ length: bars }, () => 0);
  const out: number[] = [];
  for (let bar = 0; bar < bars; bar += 1) {
    const from = Math.floor((bar * levels.length) / bars);
    const to = Math.max(from + 1, Math.floor(((bar + 1) * levels.length) / bars));
    const slice = levels.slice(from, Math.min(to, levels.length));
    out.push(slice.length ? slice.reduce((sum, value) => sum + value, 0) / slice.length : 0);
  }
  const peak = Math.max(...out);
  return out.map((value) => (peak > 0 ? Math.round((value / peak) * 100) / 100 : 0));
}

/** Metering is in decibels, -160 (silence) to 0; the waveform wants 0 to 1. */
export function levelFromDecibels(db: number | undefined): number {
  if (typeof db !== "number" || !Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db + 50) / 50));
}

/** Records AAC with expo-audio: every provider and macOS speech recognition read it. */
export function audioClipRecorder(): ClipRecorder {
  let recorder: AudioRecorder | undefined;
  let meter: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;
  const levels: number[] = [];
  async function release() {
    if (meter) clearInterval(meter);
    meter = undefined;
    recorder?.release();
    recorder = undefined;
    const { setAudioModeAsync } = await import("expo-audio");
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
  }
  return {
    start: async (onLevel) => {
      const { AudioModule, RecordingPresets, setAudioModeAsync } = await import("expo-audio");
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error(t("Allow the microphone to record"));
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      const next = new AudioModule.AudioRecorder({
        ...RecordingPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });
      recorder = next;
      await next.prepareToRecordAsync();
      // Released while preparing: the press was cancelled.
      if (recorder !== next) return;
      next.record({ forDuration: VOICE_MESSAGE_MAX_MS / 1000 });
      startedAt = Date.now();
      levels.length = 0;
      meter = setInterval(() => {
        const level = levelFromDecibels(next.getStatus().metering);
        levels.push(level);
        onLevel(level);
      }, LEVEL_INTERVAL_MS);
    },
    finish: async () => {
      const current = recorder;
      if (!current) return null;
      try {
        await current.stop();
        const uri = current.uri;
        return uri
          ? { uri, durationMs: Date.now() - startedAt, waveform: waveformBars(levels) }
          : null;
      } finally {
        await release();
      }
    },
    cancel: () => {
      const current = recorder;
      if (current) void current.stop().catch(() => undefined);
      void release();
    },
  };
}

export type HoldToTalk = {
  /** Recording now; `locked` once the hold was slid up and the finger can lift. */
  recording: { locked: boolean; startedAt: number } | null;
  /** Recent loudness, oldest first, for the live meter. */
  levels: number[];
  /** The finger's travel toward the lock, 0 to LOCK_DISTANCE. */
  lift: number;
  /** The finger's travel toward cancel, 0 to CANCEL_DISTANCE. */
  slide: number;
  notice: string | null;
  press: () => void;
  move: (up: number, left: number) => void;
  release: () => void;
  submit: () => void;
  cancel: () => void;
};

/**
 * Telegram-style voice messages: hold to record and release to send the recording; slide up
 * while holding to lock, slide left to throw it away. The recording itself is sent, so the
 * last words are never lost to a transcriber that had not caught up.
 */
export function useHoldToTalk({
  disabled,
  onClip,
  recorder,
}: {
  disabled?: boolean;
  onClip: (clip: VoiceClip) => void;
  recorder?: () => ClipRecorder;
}): HoldToTalk {
  const [recording, setRecording] = useState<HoldToTalk["recording"]>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [lift, setLift] = useState(0);
  const [slide, setSlide] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const recordingRef = useRef(recording);
  const active = useRef<ClipRecorder | null>(null);
  const pressedAt = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onClipRef = useRef(onClip);
  useEffect(() => {
    onClipRef.current = onClip;
  }, [onClip]);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  const reset = useCallback(() => {
    active.current = null;
    recordingRef.current = null;
    setRecording(null);
    setLevels([]);
    setLift(0);
    setSlide(0);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      active.current?.cancel();
    },
    [],
  );

  const cancel = useCallback(() => {
    active.current?.cancel();
    reset();
  }, [reset]);

  const submit = useCallback(() => {
    const current = active.current;
    if (!current || !recordingRef.current) return;
    reset();
    void current.finish().then(
      (clip) => {
        if (clip) onClipRef.current(clip);
      },
      (error: unknown) => showNotice(errorText(error, t("Could not record"))),
    );
  }, [reset, showNotice]);

  const press = useCallback(() => {
    if (disabled || recordingRef.current) return;
    const next = (recorder ?? audioClipRecorder)();
    active.current = next;
    pressedAt.current = Date.now();
    const state = { locked: false, startedAt: Date.now() };
    recordingRef.current = state;
    setRecording(state);
    setNotice(null);
    next
      .start((level) => {
        if (active.current === next) setLevels((current) => [...current, level].slice(-LIVE_BARS));
      })
      .catch((error: unknown) => {
        if (active.current !== next) return;
        next.cancel();
        reset();
        showNotice(errorText(error, t("Could not start the microphone.")));
      });
  }, [disabled, recorder, reset, showNotice]);

  const move = useCallback(
    (up: number, left: number) => {
      const current = recordingRef.current;
      if (!current || current.locked) return;
      if (left >= CANCEL_DISTANCE) {
        cancel();
        return;
      }
      if (up >= LOCK_DISTANCE) {
        const locked = { ...current, locked: true };
        recordingRef.current = locked;
        setRecording(locked);
        setLift(0);
        setSlide(0);
        return;
      }
      setLift(Math.max(0, up));
      setSlide(Math.max(0, left));
    },
    [cancel],
  );

  const release = useCallback(() => {
    const current = recordingRef.current;
    setLift(0);
    setSlide(0);
    if (!current || current.locked) return;
    if (Date.now() - pressedAt.current < TAP_MS) {
      cancel();
      showNotice(t("Hold to record, release to send"));
      return;
    }
    submit();
  }, [cancel, showNotice, submit]);

  return { recording, levels, lift, slide, notice, press, move, release, submit, cancel };
}
