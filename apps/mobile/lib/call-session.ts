import { useSyncExternalStore } from "react";
import { rpc } from "./api";
import type { CallCue } from "./call-sounds";
import { playCallCue, stopCallCues } from "./call-sounds";
import { getActiveUiLocale, t } from "./i18n";
import type { ConnectLiveCall, LiveConnection } from "./live-call";
import { connectLiveCall } from "./live-call";
import { errorText } from "./user-error";

export type CallPhase = "listening" | "thinking" | "speaking";
export type CallExchange = { role: "user" | "bot"; text: string };

export type CallState = {
  botId: string;
  botName: string;
  botColor: string;
  phase: CallPhase;
  muted: boolean;
  transcriptOpen: boolean;
  /** What the bot is saying now. */
  caption: string;
  /** What the caller is saying now. */
  heard: string;
  exchanges: CallExchange[];
};

/** Everything that touches the device or the server, so the session stays testable. */
export type CallDeps = {
  /** A full-duplex conversation with the voice provider. */
  connectLive: ConnectLiveCall;
  /** Tells the server the caller hung up, so it files the call card and the wrap-up run. */
  endCall: (botId: string, callId: string, durationSeconds?: number) => Promise<void>;
  /** The cue as the call connects and as it ends. */
  cue: (cue: CallCue) => Promise<void>;
};

let state: CallState | null = null;
/** Groups the call's turns in the thread and names it to the server. */
let callId = "";
let connectedAt: number | null = null;
let deps: CallDeps = productionDeps();
let connecting: AbortController | null = null;
let live: LiveConnection | null = null;
const watchers = new Set<() => void>();

export function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

export function getSnapshot(): CallState | null {
  return state;
}

export function useCallSession(): CallState | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function emit() {
  for (const watcher of [...watchers]) watcher();
}

function set(patch: Partial<CallState>) {
  if (!state) return;
  state = { ...state, ...patch };
  emit();
}

/**
 * Calls a bot as a live, full-duplex conversation: the microphone and the bot's voice travel
 * to the voice provider, which the server set up and follows. Returns the call id.
 */
export function startCall(
  call: {
    botId: string;
    botName: string;
    botColor?: string;
    /** What the bot says as the call connects, before the caller speaks. */
    greeting?: string;
  },
  overrides: Partial<CallDeps> = {},
): string {
  endCall();
  deps = { ...productionDeps(), ...overrides };
  callId = randomId();
  connectedAt = null;
  state = {
    botId: call.botId,
    botName: call.botName,
    botColor: call.botColor ?? "",
    phase: "thinking",
    muted: false,
    transcriptOpen: false,
    caption: "",
    heard: "",
    exchanges: [],
  };
  emit();
  const controller = new AbortController();
  connecting = controller;
  const thisCallId = callId;
  void deps.cue("start").catch(() => undefined);
  deps
    .connectLive(
      {
        botId: call.botId,
        callId: thisCallId,
        greeting: call.greeting,
        language: getActiveUiLocale(),
      },
      {
        onSpeaking: (speaking) => set({ phase: speaking ? "speaking" : "listening" }),
        onHeard: (heard) => set({ heard }),
        onSaid: (caption) => set({ caption }),
        onTurn: (turn) => {
          if (state) set({ exchanges: [...state.exchanges, turn] });
        },
        onEnded: () => {
          if (callId === thisCallId) endCall();
        },
      },
      controller.signal,
    )
    .then(
      (connection) => {
        if (controller.signal.aborted || callId !== thisCallId || !state) {
          connection.close();
          return;
        }
        live = connection;
        connectedAt = Date.now();
        connection.setMuted(state.muted);
        set({ phase: "listening" });
      },
      (error: unknown) => {
        if (controller.signal.aborted || callId !== thisCallId) return;
        set({ caption: errorText(error, t("Could not connect the call.")) });
      },
    );
  return callId;
}

export function endCall(): void {
  if (!state) return;
  // The server files the call's last words and its card, then lets the bot finish what was
  // asked. A second close of the same call is a no-op there.
  const durationSeconds =
    connectedAt === null ? undefined : Math.max(0, Math.round((Date.now() - connectedAt) / 1000));
  void deps.endCall(state.botId, callId, durationSeconds).catch(() => undefined);
  connecting?.abort();
  connecting = null;
  live?.close();
  live = null;
  connectedAt = null;
  stopCallCues();
  void deps.cue("end").catch(() => undefined);
  state = null;
  emit();
}

export function toggleMute(): void {
  if (!state) return;
  const muted = !state.muted;
  set({ muted, heard: "" });
  live?.setMuted(muted);
}

export function toggleTranscript(): void {
  if (!state) return;
  set({ transcriptOpen: !state.transcriptOpen });
}

function productionDeps(): CallDeps {
  return {
    connectLive: connectLiveCall,
    endCall: async (botId, id, durationSeconds) => {
      await rpc("threads/endCall", {
        botId,
        callId: id,
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
      });
    },
    cue: playCallCue,
  };
}

function randomId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
