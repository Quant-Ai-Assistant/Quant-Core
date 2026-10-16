import { t } from "@lingui/core/macro";
import { LIVE_TOOL_POLL_MS } from "@rakazo/core";
import { useSyncExternalStore } from "react";
import { pickUp } from "./call-pickup.js";
import type { LiveConnection } from "./live-call.js";
import { connectLiveCall } from "./live-call.js";
import { rpc } from "./rpc.js";
import { errorText } from "./user-error";

/** `ringing` until the call picks up; the rest describe the conversation. */
export type CallPhase = "ringing" | "listening" | "thinking" | "speaking";
export type CallExchange = { role: "user" | "bot"; text: string };

export interface CallState {
  botId: string;
  botName: string;
  botColor: string;
  startedAt: number;
  /** When the bot answered and the clock started; null while the call is connecting. */
  connectedAt: number | null;
  /** When the call ended; it stays on screen a moment so the caller sees how long it ran. */
  endedAt: number | null;
  /** The tool the bot is using right now, such as `computer_act`. */
  tool: string | null;
  /** Why the call could not connect. */
  error: string | null;
  phase: CallPhase;
  muted: boolean;
  /** The call window is tucked away; the call keeps running. */
  minimized: boolean;
  /** What the bot is saying now. */
  caption: string;
  /** What the caller is saying now. */
  heard: string;
  exchanges: CallExchange[];
}

let state: CallState | null = null;
/** Groups the call's turns in the thread and names it to the server. */
let callId = "";
/** Rings, then connects; aborting it ends a call that has not finished connecting. */
let connecting: AbortController | null = null;
let live: LiveConnection | null = null;
let toolPoll: ReturnType<typeof setInterval> | null = null;
let closing: ReturnType<typeof setTimeout> | null = null;
/** How long an ended call stays on screen. */
export const CALL_ENDED_MS = 1_500;
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
 * Calls a bot as a live, full-duplex conversation: it rings, then the microphone and the
 * bot's voice travel to the voice provider, which the server set up and follows.
 */
export function startCall(call: {
  botId: string;
  botName: string;
  botColor?: string;
  /** The bot called and the user picked up: no ringing, and the bot speaks first. */
  answered?: { callId: string; opening: string };
}): void {
  endCall();
  if (closing) clearTimeout(closing);
  closing = null;
  callId = call.answered?.callId ?? randomId();
  state = {
    botId: call.botId,
    botName: call.botName,
    botColor: call.botColor ?? "",
    startedAt: Date.now(),
    connectedAt: null,
    endedAt: null,
    tool: null,
    error: null,
    phase: "ringing",
    muted: false,
    minimized: false,
    caption: "",
    heard: "",
    exchanges: [],
  };
  emit();
  const controller = new AbortController();
  connecting = controller;
  const thisCallId = callId;
  void pickUp(controller.signal, { ring: !call.answered })
    .then(() => {
      if (controller.signal.aborted || callId !== thisCallId) return;
      set({ phase: "thinking" });
      return connectLiveCall(
        {
          botId: call.botId,
          callId: thisCallId,
          greeting: call.answered?.opening.trim() || undefined,
          language: navigator.language,
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
      );
    })
    .then(
      (connection) => {
        if (!connection) return;
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
        set({ error: errorText(error, t`Could not connect the call.`) });
      },
    );
}

/** Asks what the bot is using while the call is connected, for the call's tool badge. */
function watchTool(botId: string, thisCallId: string) {
  if (toolPoll) clearInterval(toolPoll);
  const poll = () => {
    void rpc.threads.activity({ botId }).then(
      ({ tool }) => {
        if (callId === thisCallId && state && !state.endedAt && state.tool !== tool) set({ tool });
      },
      () => undefined,
    );
  };
  poll();
  toolPoll = setInterval(poll, LIVE_TOOL_POLL_MS);
}

export function endCall(): void {
  if (!state || state.endedAt !== null) return;
  const { botId, connectedAt } = state;
  // The server files the call's last words and its card, then lets the bot finish what was
  // asked. A second close of the same call is a no-op there.
  const durationSeconds =
    connectedAt === null ? undefined : Math.max(0, Math.round((Date.now() - connectedAt) / 1000));
  void rpc.threads
    .endCall({ botId, callId, ...(durationSeconds === undefined ? {} : { durationSeconds }) })
    .catch(() => undefined);
  connecting?.abort();
  connecting = null;
  live?.close();
  live = null;
  if (toolPoll) clearInterval(toolPoll);
  toolPoll = null;
  // A call that never connected just closes; one that ran says how long, then closes.
  if (connectedAt === null) {
    state = null;
    emit();
    return;
  }
  set({ endedAt: Date.now(), tool: null });
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
  set({ muted });
  live?.setMuted(muted);
}

export function setCallMinimized(minimized: boolean): void {
  if (!state) return;
  set({ minimized });
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random()}`;
}
