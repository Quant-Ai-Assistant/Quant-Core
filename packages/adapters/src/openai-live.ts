import type {
  AdapterContext,
  LiveCallControl,
  LiveCallEvent,
  LiveCallRequest,
  LiveCallSession,
} from "@rakazo/adapter-kit";
import { WebSocket } from "undici";
import { readVoiceJson, requireOk, voiceDeadline } from "./voice-http.js";

const API = "https://api.openai.com/v1";
const LIVE_MODEL = "gpt-live-1";
/** The provider caps history at 128 messages and 8,192 tokens; stay well inside both. */
const MAX_HISTORY = 24;
const MAX_HISTORY_CHARS = 600;
/** Context appends are capped at 500 tokens; split longer results into several. */
const MAX_APPEND_CHARS = 1_200;
const START_TIMEOUT_MS = 20_000;

/** The slice of a WebSocket the live control needs, so tests can drive it. */
export type LiveSocket = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
};

export type LiveDeps = {
  fetch: typeof fetch;
  openSocket: (url: string, headers: Record<string, string>) => LiveSocket;
};

const defaultDeps: LiveDeps = {
  fetch: (...args) => fetch(...args),
  openSocket: (url, headers) => new WebSocket(url, { headers }) as unknown as LiveSocket,
};

export async function startOpenAILiveCall(
  request: LiveCallRequest,
  context: AdapterContext,
  deps: LiveDeps = defaultDeps,
): Promise<LiveCallSession> {
  const headers = {
    authorization: `Bearer ${request.apiKey}`,
    "openai-safety-identifier": request.safetyId,
  };
  const res = await deps.fetch(`${API}/live/sessions`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      session: {
        model: LIVE_MODEL,
        instructions: request.instructions,
        input: liveInput(request),
        delegation: { type: "client" },
      },
      transport: { type: "webrtc", sdp: request.offerSdp },
    }),
    signal: voiceDeadline(context.signal, START_TIMEOUT_MS),
  });
  await requireOk(res, "OpenAI", "the live call");
  const body = (await readVoiceJson(res)) as {
    session?: { id?: string };
    transport?: { sdp?: string };
  } | null;
  const sessionId = body?.session?.id;
  const answerSdp = body?.transport?.sdp;
  if (!sessionId || !answerSdp) throw new Error("OpenAI returned no live session");
  // The attach endpoint replays only the last few seconds, so attach right away.
  const socket = deps.openSocket(
    `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`,
    headers,
  );
  return { sessionId, answerSdp, control: liveControl(socket) };
}

function liveInput(request: LiveCallRequest) {
  const history = request.history.slice(-MAX_HISTORY).map((message) => ({
    type: "message",
    role: message.role,
    content: [
      {
        type: message.role === "user" ? "input_text" : "output_text",
        text: message.text.slice(0, MAX_HISTORY_CHARS),
      },
    ],
  }));
  const greeting = request.greeting?.trim();
  if (!greeting) return history;
  return [
    ...history,
    {
      type: "message",
      role: "developer",
      content: [
        {
          type: "input_text",
          text: `Greet the caller now. Say this, in its language: "${greeting}" Then pause and listen.`,
        },
      ],
    },
  ];
}

/** Maps provider events to the provider-neutral ones; anything else is ignored. */
export function toLiveCallEvent(raw: unknown): LiveCallEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const event = raw as {
    type?: string;
    delta?: unknown;
    reason?: unknown;
    message?: unknown;
    error?: { message?: unknown };
    delegation?: { id?: unknown; target?: unknown };
  };
  switch (event.type) {
    case "session.input_transcript.delta":
      return typeof event.delta === "string" ? { type: "heard", text: event.delta } : null;
    case "session.output_transcript.delta":
      return typeof event.delta === "string" ? { type: "said", text: event.delta } : null;
    case "session.delegation.created":
      return typeof event.delegation?.id === "string" && event.delegation.target === "client"
        ? { type: "delegation", id: event.delegation.id }
        : null;
    case "session.closed":
      return { type: "closed", reason: typeof event.reason === "string" ? event.reason : "" };
    case "error": {
      const message = event.error?.message ?? event.message;
      return { type: "error", message: typeof message === "string" ? message : "Live call error" };
    }
    default:
      return null;
  }
}

/** Splits a result into appends under the provider's size cap, at sentence ends when it can. */
export function splitForAppend(text: string): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_APPEND_CHARS) {
    const window = rest.slice(0, MAX_APPEND_CHARS);
    const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
    const end = cut > MAX_APPEND_CHARS / 2 ? cut + 1 : MAX_APPEND_CHARS;
    parts.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function liveControl(socket: LiveSocket): LiveCallControl {
  const queue: LiveCallEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let opened = false;
  const pending: string[] = [];
  let sequence = 0;

  const push = (event: LiveCallEvent) => {
    queue.push(event);
    wake?.();
  };
  const finish = () => {
    done = true;
    wake?.();
  };
  const send = (payload: Record<string, unknown>) => {
    const data = JSON.stringify({ ...payload, event_id: `quant_${++sequence}` });
    if (opened) socket.send(data);
    else pending.push(data);
  };

  socket.addEventListener("open", () => {
    opened = true;
    for (const data of pending.splice(0)) socket.send(data);
  });
  socket.addEventListener("message", ({ data }) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return;
    }
    const event = toLiveCallEvent(parsed);
    if (!event) return;
    push(event);
    if (event.type === "closed") {
      finish();
      socket.close();
    }
  });
  socket.addEventListener("close", finish);
  socket.addEventListener("error", () => {
    push({ type: "error", message: "Live call connection failed" });
    finish();
  });

  return {
    events: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      },
    },
    answer: (delegationId, text) => {
      for (const content of splitForAppend(text)) {
        send({ type: "session.commentary.append", delegation_id: delegationId, content });
      }
    },
    note: (delegationId, text) => {
      for (const content of splitForAppend(text)) {
        send({ type: "session.thinking.append", delegation_id: delegationId, content });
      }
    },
    close: () => send({ type: "session.close" }),
    disconnect: () => {
      finish();
      socket.close();
    },
  };
}
