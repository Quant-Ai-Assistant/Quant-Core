import type { MessageBlock } from "@rakazo/contracts";
import { callRequestBlock } from "./call-request.js";
import { speechFromBlocks } from "./speech-text.js";

/** The fields grouping reads; web `ThreadMessage` and mobile `MobileMessage` both satisfy it. */
export type VoiceChatMessage = {
  id: string;
  role: string;
  runId?: string;
  callId?: string;
  createdAt?: string;
  blocks: MessageBlock[];
};

export type VoiceChatGroup<T extends VoiceChatMessage = VoiceChatMessage> = {
  kind: "voiceChat";
  /**
   * List key: `call:<callId>` for a call's first group, `call:<callId>:<n>` for the
   * later segments a typed message split it into. Keying off the first message would
   * change when an older page extends a segment, remounting the card.
   */
  key: string;
  callId: string;
  messages: T[];
  /** The `voice_call` message the bot left when it hung up; it closes the group. */
  marker?: T;
};
export type ThreadItem<T extends VoiceChatMessage = VoiceChatMessage> =
  | { kind: "message"; message: T }
  | VoiceChatGroup<T>;

const SUMMARY_MAX = 120;

/**
 * Collapses each run of consecutive call messages into one group: a user
 * message carrying the call's `callId`, or a bot reply to a run already in the
 * group. Anything else ends the run — a typed user message breaks the group
 * even when it reuses the run of a call turn. The bot's `voice_call` marker
 * closes the group, so the work it does after hanging up renders as chat.
 */
export function groupVoiceChats<T extends VoiceChatMessage>(messages: T[]): ThreadItem<T>[] {
  const items: ThreadItem<T>[] = [];
  let open: VoiceChatGroup<T> | undefined;
  let openRunIds = new Set<string>();
  const segments = new Map<string, number>();
  for (const message of messages) {
    if (open) {
      const joinsByRun = Boolean(
        message.role === "bot" && message.runId && openRunIds.has(message.runId),
      );
      if (message.callId === open.callId || joinsByRun) {
        open.messages.push(message);
        if (isCallMarker(message)) {
          open.marker = message;
          open = undefined;
          continue;
        }
        if (
          message.callId === open.callId &&
          message.runId &&
          message.blocks[0]?.kind !== "call_request"
        )
          openRunIds.add(message.runId);
        continue;
      }
      open = undefined;
    }
    if (message.callId) {
      const segment = (segments.get(message.callId) ?? 0) + 1;
      segments.set(message.callId, segment);
      open = {
        kind: "voiceChat",
        key: segment === 1 ? `call:${message.callId}` : `call:${message.callId}:${segment}`,
        callId: message.callId,
        messages: [message],
      };
      // A request belongs to the calling run, not to a spoken turn.
      openRunIds = new Set(
        message.runId && message.blocks[0]?.kind !== "call_request" ? [message.runId] : [],
      );
      items.push(open);
      continue;
    }
    items.push({ kind: "message", message });
  }
  return items;
}

function isCallMarker(message: VoiceChatMessage): boolean {
  return message.role === "bot" && message.blocks[0]?.kind === "voice_call";
}

/** The title the bot hung up with, else the first sentence of its first spoken reply. */
export function voiceChatSummary(group: VoiceChatGroup): string {
  const marker = group.marker?.blocks[0];
  const title = marker?.kind === "voice_call" ? marker.title.trim() : "";
  if (title) return title;
  const reply = group.messages.find(
    (message) => message.role === "bot" && message !== group.marker,
  );
  const spoken = reply ? speechFromBlocks(reply.blocks).trim() : "";
  if (!spoken) return "";
  const end = spoken.search(/[.!?](\s|$)/u);
  const sentence = end === -1 ? spoken : spoken.slice(0, end + 1);
  return sentence.length > SUMMARY_MAX
    ? `${sentence.slice(0, SUMMARY_MAX - 1).trimEnd()}…`
    : sentence;
}

/** The connected time the caller recorded, else whole seconds between the first and last message. */
export function voiceChatDuration(group: VoiceChatGroup): number {
  const marker = group.marker?.blocks[0];
  if (marker?.kind === "voice_call" && marker.durationSeconds !== undefined) {
    return marker.durationSeconds;
  }
  const request = group.messages[0]?.blocks[0];
  if (request?.kind === "call_request" && request.durationSeconds !== undefined) {
    return request.durationSeconds;
  }
  const first = group.messages[0];
  const last = group.messages[group.messages.length - 1];
  if (!first || !last) return 0;
  const seconds = (Date.parse(last.createdAt ?? "") - Date.parse(first.createdAt ?? "")) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
}

export type VoiceChatEntry = {
  /** The caller placed it (`outgoing`) or the bot rang them (`incoming`). */
  direction: "outgoing" | "incoming";
  outcome: "answered" | "ringing" | "missed" | "declined" | "cancelled";
  seconds: number;
  startedAt?: string;
  /** Who said what, in order; lines with no words are kept so a jump can find them. */
  transcript: Array<{ id: string; role: string; text: string }>;
};

/**
 * What a call reads as in the chat, like a phone's call log: its direction, how it went,
 * how long it ran, and its transcript (the bot's reason and opening included).
 */
export function describeVoiceChat(group: VoiceChatGroup, now = Date.now()): VoiceChatEntry {
  const request = callRequestBlock(group.messages[0]?.blocks);
  const seconds = voiceChatDuration(group);
  const ringing = request?.status === "ringing" && Date.parse(request.expiresAt) > now;
  // A call that rang out reads as missed even before the server's ring-out lands.
  const outcome: VoiceChatEntry["outcome"] = request
    ? ringing
      ? "ringing"
      : request.status === "declined"
        ? "declined"
        : request.status === "missed" || request.status === "ringing"
          ? "missed"
          : "answered"
    : seconds === 0
      ? "cancelled"
      : "answered";
  const unanswered = outcome !== "answered";
  const transcript = [
    ...(request?.reason && unanswered
      ? [{ id: `${group.key}:reason`, role: "bot", text: request.reason }]
      : []),
    ...(request?.opening && !unanswered
      ? [{ id: `${group.key}:opening`, role: "bot", text: request.opening }]
      : []),
    ...group.messages.map((message) => ({
      id: message.id,
      role: message.role,
      // The request and the marker are the entry's own lines, never transcript turns.
      text:
        message === group.marker || callRequestBlock(message.blocks)
          ? ""
          : speechFromBlocks(message.blocks).trim(),
    })),
  ];
  return {
    direction: request ? "incoming" : "outgoing",
    outcome,
    seconds,
    startedAt: group.messages[0]?.createdAt,
    transcript,
  };
}
