import type { AudioRecorder } from "expo-audio";
import { File } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";
import { captureApiRequestContext } from "./api";
import * as dictation from "./dictation";
import { getActiveUiLocale, t } from "./i18n";
import { errorText } from "./user-error";

/** How far the finger travels up before the recording locks hands-free. */
export const LOCK_DISTANCE = 64;
/** A press shorter than this is a tap: nothing was said, so it only shows the hint. */
export const TAP_MS = 350;
const NOTICE_MS = 2_500;

/** Sends a recording to the voice provider's transcription. */
async function transcribeClip(
  clip: { base64: string; mimeType: string },
  signal: AbortSignal,
): Promise<string> {
  const { apiBase, headers } = await captureApiRequestContext();
  const res = await fetch(`${apiBase}/api/voice/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "rakazo://", ...headers },
    body: JSON.stringify({ audioBase64: clip.base64, mimeType: clip.mimeType }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(errorText(body.error ?? "", t("Could not transcribe that.")));
  return body.text ?? "";
}

/** One held recording: started on press, finished into text on release. */
export type HoldEngine = {
  start: (onInterim: (text: string) => void) => Promise<void>;
  finish: () => Promise<string>;
  cancel: () => void;
};

/** The phone's own recognizer: live words while holding, no server round trip. */
export function deviceEngine(): HoldEngine {
  let heard = "";
  return {
    start: async (onInterim) => {
      heard = "";
      await dictation.listen({
        lang: getActiveUiLocale(),
        onInterim: (text) => {
          heard = text;
          onInterim(text);
        },
        onFinal: (text) => {
          heard = text;
        },
      });
    },
    finish: async () => {
      dictation.submit();
      return heard.trim();
    },
    cancel: () => dictation.stop(),
  };
}

/** Records until release and lets the voice provider transcribe it. */
export function providerEngine(): HoldEngine {
  let recorder: AudioRecorder | undefined;
  let controller: AbortController | null = null;
  async function release() {
    recorder?.release();
    recorder = undefined;
    const { setAudioModeAsync } = await import("expo-audio");
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
  }
  return {
    start: async () => {
      const { AudioModule, RecordingPresets, setAudioModeAsync } = await import("expo-audio");
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error(t("Allow microphone access to dictate."));
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      const next = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
      recorder = next;
      await next.prepareToRecordAsync();
      // Released while preparing: the press was cancelled.
      if (recorder !== next) return;
      next.record();
    },
    finish: async () => {
      const current = recorder;
      if (!current) return "";
      controller = new AbortController();
      try {
        await current.stop();
        const uri = current.uri;
        if (!uri) return "";
        const file = new File(uri);
        const base64 = await file.base64();
        try {
          file.delete();
        } catch {
          // The clip is disposable; a leftover in the cache is fine.
        }
        return (await transcribeClip({ base64, mimeType: "audio/m4a" }, controller.signal)).trim();
      } finally {
        controller = null;
        await release();
      }
    },
    cancel: () => {
      controller?.abort();
      const current = recorder;
      if (current) void current.stop().catch(() => undefined);
      void release();
    },
  };
}

export type HoldToTalk = {
  /** Recording now; `locked` once the hold was slid up and the finger can lift. */
  recording: { locked: boolean; startedAt: number } | null;
  transcribing: boolean;
  transcript: string;
  /** The finger's travel toward the lock, 0 to LOCK_DISTANCE. */
  lift: number;
  notice: string | null;
  press: () => void;
  move: (travel: number) => void;
  release: () => void;
  submit: () => void;
  cancel: () => void;
};

/**
 * Telegram-style dictation: hold to talk and release to send the text; slide up while
 * holding to lock, then send or discard by hand.
 */
export function useHoldToTalk({
  transcribe,
  disabled,
  onText,
  engine,
}: {
  /** The voice provider transcribes: record and send it there instead of the device recognizer. */
  transcribe: boolean;
  disabled?: boolean;
  onText: (text: string) => void;
  engine?: () => HoldEngine;
}): HoldToTalk {
  const [recording, setRecording] = useState<HoldToTalk["recording"]>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [lift, setLift] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const recordingRef = useRef(recording);
  const active = useRef<HoldEngine | null>(null);
  const pressedAt = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  const reset = useCallback(() => {
    active.current = null;
    recordingRef.current = null;
    setRecording(null);
    setTranscribing(false);
    setTranscript("");
    setLift(0);
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
    setTranscribing(true);
    void current
      .finish()
      .then((text) => {
        if (active.current !== current) return;
        reset();
        if (text) onTextRef.current(text);
        else showNotice(t("Nothing was heard."));
      })
      .catch((error: unknown) => {
        if (active.current !== current) return;
        reset();
        showNotice(errorText(error, t("Could not transcribe that.")));
      });
  }, [reset, showNotice]);

  const press = useCallback(() => {
    if (disabled || recordingRef.current) return;
    const next = (engine ?? (transcribe ? providerEngine : deviceEngine))();
    active.current = next;
    pressedAt.current = Date.now();
    const state = { locked: false, startedAt: Date.now() };
    recordingRef.current = state;
    setRecording(state);
    setTranscript("");
    setNotice(null);
    next
      .start((text) => {
        if (active.current === next) setTranscript(text);
      })
      .catch((error: unknown) => {
        if (active.current !== next) return;
        next.cancel();
        reset();
        showNotice(errorText(error, t("Could not start the microphone.")));
      });
  }, [disabled, engine, reset, showNotice, transcribe]);

  const move = useCallback((travel: number) => {
    const current = recordingRef.current;
    if (!current || current.locked) return;
    if (travel < LOCK_DISTANCE) {
      setLift(Math.max(0, travel));
      return;
    }
    const locked = { ...current, locked: true };
    recordingRef.current = locked;
    setRecording(locked);
    setLift(0);
  }, []);

  const release = useCallback(() => {
    const current = recordingRef.current;
    setLift(0);
    if (!current || current.locked) return;
    if (Date.now() - pressedAt.current < TAP_MS) {
      cancel();
      showNotice(t("Hold to talk, release to send"));
      return;
    }
    submit();
  }, [cancel, showNotice, submit]);

  return {
    recording,
    transcribing,
    transcript,
    lift,
    notice,
    press,
    move,
    release,
    submit,
    cancel,
  };
}
