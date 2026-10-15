import { readBoundedResponseBytes } from "@rakazo/core";
import { getActiveUiLocale } from "./i18n.js";
import { selectedSpaceId, withSpaceHeaders } from "./rpc.js";
import type { UiLocale } from "./ui-locale.js";
import { errorText } from "./user-error.js";

export type DictationSnapshot = {
  status: "idle" | "listening" | "transcribing";
  transcript: string;
  error?: string;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { resultIndex: number; results: SpeechRecognitionResultList }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

const IDLE: DictationSnapshot = { status: "idle", transcript: "" };
export const TRANSCRIPTION_RESPONSE_TIMEOUT_MS = 70_000;
export const MAX_TRANSCRIPTION_RESPONSE_BYTES = 64 * 1024;
/** Web Speech codes that mean the cloud recognizer cannot be used. */
const WEB_SPEECH_SERVICE_ERRORS = new Set(["network", "service-not-allowed"]);

export function webSpeechAvailable(): boolean {
  return Boolean(speechRecognitionCtor()) && !electronSpeechHost();
}

/**
 * Electron exposes webkitSpeechRecognition without a speech-service key, so
 * recognition fails with `network`. Don't treat that API as available there.
 */
function electronSpeechHost(): boolean {
  if (typeof window !== "undefined") {
    const host = window as Window & { rakazoDesktop?: unknown };
    if (host.rakazoDesktop) return true;
  }
  if (typeof navigator === "undefined") return false;
  const agent = navigator.userAgent;
  return typeof agent === "string" && agent.includes("Electron");
}

/**
 * Phones cannot hold a speech session open: `start()` replays the system tone on every
 * restart and the session ends at each pause, so Web Speech there means one beep per
 * phrase and a transcript that keeps getting cut. Server transcription records silently,
 * so prefer it on mobile browsers wherever a provider can transcribe.
 */
export function prefersServerDictation(): boolean {
  if (typeof navigator === "undefined") return false;
  const agent = typeof navigator.userAgent === "string" ? navigator.userAgent : "";
  if (/android|iphone|ipod|ipad|mobile/i.test(agent)) return true;
  // iPadOS 13+ reports a desktop Safari user agent, so fall back to touch support.
  const touchPoints = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  return touchPoints > 1 && /macintosh/i.test(agent);
}

/** Connected server transcription should take over after Web Speech cannot run. */
export function webSpeechNeedsServerFallback(
  error: string | undefined,
  transcribe: boolean,
): boolean {
  return transcribe && typeof error === "string" && WEB_SPEECH_SERVICE_ERRORS.has(error);
}

/** Web Speech wants a BCP-47 tag; the app's UI locale is a short code. */
const SPEECH_LOCALE_TAGS: Record<UiLocale, string> = {
  en: "en-US",
  de: "de-DE",
  es: "es-ES",
  fr: "fr-FR",
  hi: "hi-IN",
  ko: "ko-KR",
  "pt-BR": "pt-BR",
  ru: "ru-RU",
  tr: "tr-TR",
  "zh-CN": "zh-CN",
};

/** The tag the recognizer needs for a UI locale, when we know one. */
export function speechLocaleTag(locale: UiLocale): string | undefined {
  return SPEECH_LOCALE_TAGS[locale];
}

/**
 * Language hint for server transcription: the primary subtag of the app's own locale
 * (`es`, `pt`, `zh`). Undefined leaves detection to the provider.
 */
export function transcriptionLanguage(): string | undefined {
  const tag = speechLocaleTag(getActiveUiLocale());
  return tag ? tag.split("-")[0]?.toLowerCase() : undefined;
}

function normalizedTranscript(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function speechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const host = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition;
}

export class Dictation {
  private snapshot: DictationSnapshot = IDLE;
  private watchers = new Set<(s: DictationSnapshot) => void>();
  private recognition: SpeechRecognitionLike | null = null;
  private media: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private token = 0;
  private transcribeAbort: AbortController | null = null;
  private onFinal: ((text: string) => void) | null = null;

  subscribe(fn: (s: DictationSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => {
      this.watchers.delete(fn);
    };
  }

  get state(): DictationSnapshot {
    return this.snapshot;
  }

  private set(next: DictationSnapshot) {
    this.snapshot = next;
    for (const watcher of [...this.watchers]) watcher(next);
  }

  stop(reason: "submit" | "cancel" | "replace" = "cancel") {
    this.token += 1;
    this.transcribeAbort?.abort();
    this.transcribeAbort = null;
    const rec = this.recognition;
    this.recognition = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        if (reason === "submit") rec.stop();
        else rec.abort();
      } catch {
        // already stopped
      }
    }
    const media = this.media;
    this.media = null;
    if (media && media.state !== "inactive") {
      try {
        media.stop();
      } catch {
        // already stopped
      }
    }
    this.chunks = [];
    this.onFinal = null;
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
  }

  /** Listens while the caller holds the microphone; `submitHold` delivers the text. */
  async listen(opts: { transcribe?: boolean; onFinal: (text: string) => void }): Promise<void> {
    this.stop("replace");
    const mine = this.token;
    const spaceId = selectedSpaceId();
    this.onFinal = opts.onFinal;
    this.set({ status: "listening", transcript: "" });
    const transcribe = Boolean(opts.transcribe);
    // An unknown capability is not a refusal: a device whose browser cannot hold the
    // microphone open goes to the server even before the voice status has loaded.
    if (prefersServerDictation() && opts.transcribe !== false) {
      await this.listenRecorder(mine, spaceId);
      return;
    }
    if (webSpeechAvailable()) {
      this.listenWebSpeech(mine, transcribe, spaceId);
      return;
    }
    if (transcribe) {
      await this.listenRecorder(mine, spaceId);
      return;
    }
    this.set({
      ...IDLE,
      error:
        "This browser has no on-device dictation. Connect a voice provider with transcription, or use Chrome / the desktop app.",
    });
  }

  private listenWebSpeech(mine: number, transcribe: boolean, spaceId: string | null) {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    let live = true;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (event) => {
      if (!live || this.token !== mine) return;
      // Each result index is a separate phrase. Matching text within this session
      // may be a real repetition; only deduplicate against a previous session.
      const transcript = normalizedTranscript(
        Array.from(event.results, (result) => result?.[0]?.transcript ?? "").join(" "),
      );
      this.set({ status: "listening", transcript });
    };
    rec.onerror = (event) => {
      if (!live || this.token !== mine) return;
      if (event.error === "aborted" || event.error === "no-speech") return;
      if (webSpeechNeedsServerFallback(event.error, transcribe)) {
        live = false;
        this.fallbackToServer(rec, mine, spaceId);
        return;
      }
      live = false;
      this.set({
        ...IDLE,
        error: event.error ? `Dictation failed: ${event.error}` : "Dictation failed.",
      });
    };
    // Chrome ends a session on its own after a pause; while holding, that is the end.
    rec.onend = () => {
      if (!live || this.token !== mine) return;
      if (this.snapshot.status !== "listening") return;
      this.finish(this.snapshot.transcript, mine);
    };
    this.recognition = rec;
    try {
      rec.start();
    } catch {
      if (!live || this.token !== mine) return;
      if (transcribe) {
        live = false;
        this.fallbackToServer(rec, mine, spaceId);
        return;
      }
      live = false;
      this.releaseRecognition(rec);
      this.set({ ...IDLE, error: "Dictation failed." });
    }
  }

  private fallbackToServer(rec: SpeechRecognitionLike, mine: number, spaceId: string | null) {
    const recognized = normalizedTranscript(this.snapshot.transcript);
    this.releaseRecognition(rec);
    if (this.token !== mine) return;
    this.set({ status: "listening", transcript: recognized });
    void this.listenRecorder(mine, spaceId);
  }

  private releaseRecognition(rec: SpeechRecognitionLike) {
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    if (this.recognition === rec) this.recognition = null;
    try {
      rec.abort();
    } catch {
      // already stopped
    }
  }

  private async listenRecorder(mine: number, spaceId: string | null) {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      this.failListening(mine, errorText(error, "Microphone failed"));
      return;
    }
    if (this.token !== mine) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    let media: MediaRecorder | undefined;
    try {
      media = new MediaRecorder(stream);
      this.media = media;
      this.chunks = [];
      media.ondataavailable = (event) => {
        if (this.token !== mine) return;
        if (event.data.size) this.chunks.push(event.data);
      };
      media.onstop = () => {
        for (const track of stream.getTracks()) track.stop();
        if (this.token !== mine) return;
        void this.transcribeChunks(mine, spaceId);
      };
      media.start();
    } catch (error) {
      if (media) {
        media.ondataavailable = null;
        media.onstop = null;
      }
      for (const track of stream.getTracks()) track.stop();
      if (this.media === media) this.media = null;
      if (this.token !== mine) return;
      this.failListening(mine, errorText(error, "Dictation failed."));
    }
  }

  private async transcribeChunks(mine: number, spaceId: string | null) {
    if (this.token !== mine) return;
    const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || "audio/webm" });
    this.chunks = [];
    if (!blob.size) {
      const prefix = normalizedTranscript(this.snapshot.transcript);
      if (!prefix) {
        this.set(IDLE);
        return;
      }
      this.finish(prefix, mine);
      return;
    }
    this.set({ status: "transcribing", transcript: this.snapshot.transcript });
    const abort = new AbortController();
    this.transcribeAbort = abort;
    const timer = setTimeout(
      () => abort.abort(new Error("Transcription request timed out.")),
      TRANSCRIPTION_RESPONSE_TIMEOUT_MS,
    );
    try {
      const audioBase64 = await blobToBase64(blob);
      if (this.token !== mine) return;
      const res = await withAbort(
        fetch("/api/voice/transcribe", {
          method: "POST",
          headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
          credentials: "include",
          body: JSON.stringify({
            audioBase64,
            mimeType: blob.type,
            language: transcriptionLanguage(),
          }),
          signal: abort.signal,
        }),
        abort.signal,
      );
      if (this.token !== mine) {
        cancelResponse(res);
        return;
      }
      const body = await readTranscriptionBody(res, abort.signal);
      if (this.token !== mine) return;
      if (!res.ok) {
        this.failListening(mine, body.error ?? "Could not transcribe that recording.");
        return;
      }
      // The recorder captures fresh audio, so matching words are intentional repetitions.
      const prefix = normalizedTranscript(this.snapshot.transcript);
      const text = body.text ?? "";
      this.finish(
        prefix ? [prefix, normalizedTranscript(text)].filter(Boolean).join(" ") : text,
        mine,
      );
    } catch (error) {
      // User cancel bumps token in stop() before aborting, so a matching token
      // means the deadline timer fired. Browsers may reject fetch as AbortError
      // instead of signal.reason; surface the timeout either way.
      if (this.token !== mine) return;
      const timedOut =
        (abort.signal.reason instanceof Error &&
          abort.signal.reason.message === "Transcription request timed out.") ||
        (error instanceof Error && error.message === "Transcription request timed out.");
      if (timedOut || (error instanceof Error && error.name === "AbortError")) {
        this.failListening(mine, "Transcription request timed out.");
        return;
      }
      this.failListening(mine, errorText(error, "Could not transcribe that recording."));
    } finally {
      clearTimeout(timer);
      if (this.transcribeAbort === abort) this.transcribeAbort = null;
    }
  }

  submitHold() {
    if (this.media && this.media.state !== "inactive") {
      this.media.stop();
      return;
    }
    this.finish(this.snapshot.transcript, this.token);
  }

  private failListening(mine: number, message: string, showError = false) {
    if (this.token !== mine) return;
    const prefix = normalizedTranscript(this.snapshot.transcript);
    if (prefix) {
      this.finish(prefix, mine, showError ? message : undefined);
      return;
    }
    this.set({ ...IDLE, error: message });
  }

  private finish(text: string, mine: number, error?: string) {
    if (this.token !== mine) return;
    const trimmed = text.trim();
    const onFinal = this.onFinal;
    this.stop("submit");
    if (error) this.set({ ...IDLE, error });
    if (trimmed) onFinal?.(trimmed);
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function readTranscriptionBody(
  response: Response,
  signal: AbortSignal,
): Promise<{ text?: string; error?: string }> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_TRANSCRIPTION_RESPONSE_BYTES) {
    cancelResponse(response);
    throw new Error("Transcription response is too large.");
  }
  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: MAX_TRANSCRIPTION_RESPONSE_BYTES,
    tooLargeMessage: "Transcription response is too large.",
    read: (operation) => withAbort(operation(), signal),
  });
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as { text?: string; error?: string })
      : {};
  } catch {
    return {};
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Request aborted."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Request aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        // Prefer abort reason over a bare AbortError from fetch/read.
        reject(signal.aborted ? (signal.reason ?? error) : error);
      },
    );
  });
}

function cancelResponse(response: Response): void {
  try {
    void Promise.resolve(response.body?.cancel()).catch(() => undefined);
  } catch {
    // Response cleanup is best-effort.
  }
}

export const dictation = new Dictation();
