import type { ActivityStatus } from "@rakazo/contracts";
import { LIVE_TOOL_POLL_MS, sameActivityStatus } from "@rakazo/core";
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
  /** When the bot answered and the clock started; null while the call is connecting. */
  connectedAt: number | null;
  /** When the call ended; it stays on screen a moment so the caller sees how long it ran. */
  endedAt: number | null;
  /** The tool the bot is using right now, such as `computer_act`. */
  tool: string | null;
  /** What that tool is doing, in the shared status vocabulary. */
  activity: ActivityStatus | null;
  /** Why the call could not connect. */
  error: string | null;
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
  /** The tool the bot is using right now. */
  activity: (botId: string) => Promise<{ tool: string | null; status: ActivityStatus | null }>;
};

/** How long an ended call stays on screen. */
export const CALL_ENDED_MS = 1_500;

let state: CallState | null = null;
/** Groups the call's turns in the thread and names it to the server. */
let callId = "";
let deps: CallDeps = productionDeps();
let connecting: AbortController | null = null;
let live: LiveConnection | null = null;
let toolPoll: ReturnType<typeof setInterval> | null = null;
let closing: ReturnType<typeof setTimeout> | null = null;
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
    /** The bot rang and the user answered: the call keeps the id it rang with. */
    callId?: string;
  },
  overrides: Partial<CallDeps> = {},
): string {
  endCall();
  if (closing) clearTimeout(closing);
  closing = null;
  deps = { ...productionDeps(), ...overrides };
  callId = call.callId ?? randomId();
  state = {
    botId: call.botId,
    botName: call.botName,
    botColor: call.botColor ?? "",
    phase: "thinking",
    muted: false,
    connectedAt: null,
    endedAt: null,
    tool: null,
    activity: null,
    error: null,
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
        connection.setMuted(state.muted);
        set({ phase: "listening", connectedAt: Date.now() });
        watchTool(call.botId, thisCallId);
      },
      (error: unknown) => {
        if (controller.signal.aborted || callId !== thisCallId) return;
        set({ error: errorText(error, t("Could not connect the call.")) });
      },
    );
  return callId;
}

/** Asks what the bot is using while the call is connected, for the call's tool badge. */
function watchTool(botId: string, thisCallId: string) {
  if (toolPoll) clearInterval(toolPoll);
  const poll = () => {
    void deps.activity(botId).then(
      ({ tool, status }) => {
        if (callId !== thisCallId || !state || state.endedAt) return;
        const same =
          state.activity === status ||
          (state.activity !== null &&
            status !== null &&
            sameActivityStatus(state.activity, status));
        if (state.tool === tool && same) return;
        set({ tool, activity: status });
      },
      () => undefined,
    );
  };
  poll();
  toolPoll = setInterval(poll, LIVE_TOOL_POLL_MS);
}

export function endCall(): void {
  if (!state || state.endedAt !== null) return;
  const { connectedAt } = state;
  // The server files the call's last words and its card, then lets the bot finish what was
  // asked. A second close of the same call is a no-op there.
  const durationSeconds =
    connectedAt === null ? undefined : Math.max(0, Math.round((Date.now() - connectedAt) / 1000));
  void deps.endCall(state.botId, callId, durationSeconds).catch(() => undefined);
  connecting?.abort();
  connecting = null;
  live?.close();
  live = null;
  if (toolPoll) clearInterval(toolPoll);
  toolPoll = null;
  stopCallCues();
  void deps.cue("end").catch(() => undefined);
  // A call that never connected just closes; one that ran says how long, then closes.
  if (connectedAt === null) {
    state = null;
    emit();
    return;
  }
  set({ endedAt: Date.now(), tool: null, activity: null });
  closing = setTimeout(() => {
    closing = null;
    if (state?.endedAt) {
      state = null;
      emit();
    }
  }, CALL_ENDED_MS);
}

export function toggleMute(): void {
  if (!state) return;
  const muted = !state.muted;
  set({ muted, heard: "" });
  live?.setMuted(muted);
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
    activity: async (botId) => {
      const result = await rpc<{ tool: string | null; status?: ActivityStatus | null }>(
        "threads/activity",
        { botId },
      );
      // An older server answers without a status; the badge then names the tool only.
      return { tool: result.tool, status: result.status ?? null };
    },
  };
}

function randomId(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
