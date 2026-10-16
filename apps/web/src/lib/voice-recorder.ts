import { baseMimeType, VOICE_MESSAGE_MAX_MS, VOICE_WAVEFORM_BARS } from "@rakazo/contracts";
import { getActiveUiLocale } from "./i18n.js";
import type { UiLocale } from "./ui-locale.js";

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export interface SpeechRecognitionLike {
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

export function speechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const host = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition;
}

export type VoiceRecording = {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  waveform: number[];
  /** What this browser heard, for servers that cannot transcribe the recording. */
  transcript?: string;
};

/** AAC first: macOS speech recognition and every provider read it; WebM is the fallback. */
const RECORDING_TYPES = [
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
];
const LEVEL_INTERVAL_MS = 80;
/** How long a stop waits for the browser's recognizer to hand over its last words. */
const FINAL_WORDS_MS = 2_500;

export function recordingMimeType(
  supports: (type: string) => boolean = (type) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
): string | undefined {
  return RECORDING_TYPES.find((type) => supports(type));
}

/** Averages raw loudness samples into `bars` values scaled so the loudest bar is 1. */
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

/**
 * Records one voice message. Stopping waits for the recorder's final chunk, so the last
 * words are always in the message.
 */
export class VoiceRecorder {
  private media: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private audio: AudioContext | null = null;
  private chunks: Blob[] = [];
  private levels: number[] = [];
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private recognition: SpeechRecognitionLike | null = null;
  private heard = "";
  private recognitionEnded: Promise<void> = Promise.resolve();
  /** The microphone request in flight, so a quick release still gets its recording. */
  private starting: Promise<void> | null = null;
  /** Bumped by every start and cancel, so a late microphone grant knows it was dropped. */
  private generation = 0;

  /** Called with each new loudness value while recording, for a live meter. */
  onLevel: ((level: number) => void) | null = null;
  /** Called when the length limit stops the recording on its own. */
  onLimit: (() => void) | null = null;

  start(options: { transcribeInBrowser: boolean }): Promise<void> {
    this.cancel();
    const generation = this.generation;
    const starting = this.begin(options, generation);
    this.starting = starting;
    return starting;
  }

  private async begin(options: { transcribeInBrowser: boolean }, generation: number) {
    const mimeType = recordingMimeType();
    if (!mimeType) throw new Error("This browser cannot record audio.");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    if (generation !== this.generation) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;
    this.chunks = [];
    this.levels = [];
    this.heard = "";
    const media = new MediaRecorder(stream, { mimeType });
    media.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data);
    };
    this.media = media;
    media.start();
    this.startedAt = Date.now();
    this.meter(stream);
    this.limitTimer = setTimeout(() => this.onLimit?.(), VOICE_MESSAGE_MAX_MS);
    if (options.transcribeInBrowser && webSpeechAvailable()) this.listen();
  }

  private meter(stream: MediaStream) {
    try {
      const audio = new AudioContext();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      audio.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      this.audio = audio;
      this.levelTimer = setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
        this.levels.push(level);
        this.onLevel?.(level);
      }, LEVEL_INTERVAL_MS);
    } catch {
      // No meter: the message still records, with a flat waveform.
    }
  }

  private listen() {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = speechLocaleTag(getActiveUiLocale()) ?? navigator.language;
    recognition.onresult = (event) => {
      this.heard = Array.from(event.results, (result) => result?.[0]?.transcript ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    };
    this.recognitionEnded = new Promise((resolve) => {
      recognition.onend = () => resolve();
      recognition.onerror = () => resolve();
    });
    try {
      recognition.start();
      this.recognition = recognition;
    } catch {
      this.recognitionEnded = Promise.resolve();
    }
  }

  /** Finishes the recording; null when nothing was captured. */
  async stop(): Promise<VoiceRecording | null> {
    await this.starting?.catch(() => undefined);
    const media = this.media;
    if (!media) return null;
    const durationMs = Date.now() - this.startedAt;
    const flushed = new Promise<void>((resolve) => {
      media.onstop = () => resolve();
    });
    if (media.state !== "inactive") media.stop();
    const recognition = this.recognition;
    recognition?.stop();
    await flushed;
    if (recognition) {
      await Promise.race([
        this.recognitionEnded,
        new Promise((resolve) => setTimeout(resolve, FINAL_WORDS_MS)),
      ]);
    }
    const mimeType = baseMimeType(media.mimeType || this.chunks[0]?.type || "audio/webm");
    const blob = new Blob(this.chunks, { type: mimeType });
    const recording: VoiceRecording = {
      blob,
      mimeType,
      durationMs,
      waveform: waveformBars(this.levels),
      ...(this.heard ? { transcript: this.heard } : {}),
    };
    this.release();
    return blob.size ? recording : null;
  }

  cancel() {
    this.generation += 1;
    if (this.media && this.media.state !== "inactive") {
      this.media.onstop = null;
      try {
        this.media.stop();
      } catch {
        // already stopped
      }
    }
    try {
      this.recognition?.abort();
    } catch {
      // already stopped
    }
    this.release();
  }

  private release() {
    if (this.levelTimer) clearInterval(this.levelTimer);
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.levelTimer = null;
    this.limitTimer = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.audio?.close().catch(() => undefined);
    this.audio = null;
    this.stream = null;
    this.media = null;
    this.recognition = null;
    this.starting = null;
    this.chunks = [];
  }
}
