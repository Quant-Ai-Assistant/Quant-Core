import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type {
  JobPublisher,
  LiveCallControl,
  SecretStore,
  VoiceProvider,
} from "@rakazo/adapter-kit";
import { createVoiceProvider } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { LiveTurn } from "@rakazo/core";
import {
  callClientNonce,
  LIVE_CALL_VOICE_PROVIDER,
  LiveTranscript,
  speechFromBlocks,
} from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { appendEventInTransaction, createThreadMessageInTransaction, hasCallKey } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { callModelPin, loadCallKey } from "./call-settings.js";
import { sendThreadMessage, type ThreadTarget } from "./thread-target.js";
import { voiceContext } from "./voice.js";

const HISTORY_MESSAGES = 20;
/** Wait for the caller's last words to arrive before reading what a task is about. */
const DELEGATION_SETTLE_MS = 700;
const RUN_POLL_MS = 500;
/** A task the bot cannot finish in this time is left running; the call says so. */
const RUN_ANSWER_TIMEOUT_MS = 90_000;
/** How long a hang-up waits for the provider to confirm the call closed. */
const CLOSE_TIMEOUT_MS = 8_000;
/** Time for the voice model to say goodbye before a call the bot hung up closes. */
const FAREWELL_MS = 8_000;
const BUSY_RUN_STATUSES = new Set(["queued", "leased", "running"]);

export type LiveCallDeps = {
  prisma: PrismaClient;
  secrets: SecretStore;
  events: ThreadEvents;
  jobs: JobPublisher;
  voiceProvider?: (kind: string) => VoiceProvider;
};

type BotTarget = Extract<ThreadTarget, { kind: "bot" }>;

type LiveCall = {
  callId: string;
  control: LiveCallControl;
  /** Settles once the provider reported the call closed or the connection dropped. */
  ended: Promise<void>;
};

/** Live calls this API process is attached to, by user and call id. */
const liveCalls = new Map<string, LiveCall>();
const callKey = (actor: Actor, callId: string) => `${actor.userId}:${callId}`;

/** Whether calls are offered: the caller connected the calls OpenAI key. */
export async function liveCallAvailable(deps: LiveCallDeps, actor: Actor): Promise<boolean> {
  return hasCallKey(deps.prisma, actor.userId);
}

export function liveCallInstructions(input: {
  botName: string;
  title: string;
  description: string;
  instructions: string;
  language: string;
}): string {
  const about = [input.title, input.description].map((part) => part.trim()).filter(Boolean);
  const owner = input.instructions.trim().slice(0, 6_000);
  return [
    `You are ${input.botName}${about.length ? `, ${about.join(". ")}` : ""}. You are on a voice call with the person you assist.`,
    owner ? `Their standing instructions for you:\n${owner}` : "",
    `Speak ${input.language} unless the caller switches language. Talk like a person on the phone: short, warm, natural sentences, no lists or markdown.`,
    "Turn-taking: let the caller finish. A short pause mid-thought is not the end of their turn; answer once they have clearly finished speaking.",
    "Backchannel policy: Use few backchannels. Acknowledge naturally without competing with the caller.",
    "Interruption policy: Stop speaking when the caller interrupts. Listen to what they say.",
    [
      "Delegation policy:",
      "Backend tools:",
      `- ${input.botName}'s full assistant: knows the caller's memory and earlier chats, takes actions, uses tools and connected apps, searches the web, sets reminders and routines, and works with files.`,
      "Delegate to the backend when:",
      "- The request needs something you do not already know from this call, an action, current information, or careful reasoning.",
      "- A correction changes a task already requested.",
      "Do not delegate to the backend when:",
      "- The caller greets you, makes small talk, or asks you to repeat a result already provided.",
      "- You need a brief clarification to understand the request.",
      "Delegate before giving an answer that depends on backend work. Do not guess the result while waiting; say briefly that you are checking.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function callHistory(deps: LiveCallDeps, threadId: string) {
  const rows = await deps.prisma.message.findMany({
    where: { threadId, role: { in: ["user", "bot"] } },
    orderBy: { seq: "desc" },
    take: HISTORY_MESSAGES,
    select: { role: true, blocks: true },
  });
  return rows
    .reverse()
    .map((row) => ({
      role: row.role === "user" ? ("user" as const) : ("assistant" as const),
      text: speechFromBlocks(row.blocks as never).trim(),
    }))
    .filter((message) => message.text);
}

/** Opens a live call from the client's WebRTC offer and attaches this server to it. */
export async function startLiveCall(
  deps: LiveCallDeps,
  actor: Actor,
  target: BotTarget,
  input: { callId: string; offerSdp: string; greeting?: string; language?: string },
): Promise<{ answerSdp: string }> {
  const apiKey = await loadCallKey(deps, actor);
  if (!apiKey) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "Add an OpenAI key in Calls settings.",
    });
  }
  const provider = (deps.voiceProvider ?? createVoiceProvider)(LIVE_CALL_VOICE_PROVIDER);
  if (!provider.startLiveCall) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: "This voice provider has no live calls.",
    });
  }
  const bot = await deps.prisma.bot.findFirstOrThrow({
    where: { id: target.botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { name: true, title: true, description: true, instructions: true },
  });
  const session = await provider.startLiveCall(
    {
      apiKey,
      offerSdp: input.offerSdp,
      instructions: liveCallInstructions({
        botName: bot.name,
        title: bot.title,
        description: bot.description,
        instructions: bot.instructions,
        language: input.language || "the caller's language",
      }),
      history: await callHistory(deps, target.threadId),
      greeting: input.greeting,
      safetyId: createHash("sha256").update(actor.userId).digest("hex").slice(0, 32),
    },
    voiceContext(actor),
  );
  const key = callKey(actor, input.callId);
  liveCalls.get(key)?.control.disconnect();
  const call: LiveCall = {
    callId: input.callId,
    control: session.control,
    ended: Promise.resolve(),
  };
  call.ended = followLiveCall(deps, actor, target, call).finally(() => {
    if (liveCalls.get(key) === call) liveCalls.delete(key);
  });
  liveCalls.set(key, call);
  return { answerSdp: session.answerSdp };
}

/**
 * The caller hung up: end the live session and wait until its last words are filed, so the
 * call card closes over the whole conversation. A call this process is not attached to
 * (never live, or the API restarted) has nothing to wait for.
 */
export async function finishLiveCall(actor: Actor, callId: string): Promise<void> {
  const call = liveCalls.get(callKey(actor, callId));
  if (!call) return;
  call.control.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    call.ended,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        call.control.disconnect();
        resolve();
      }, CLOSE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
}

async function followLiveCall(
  deps: LiveCallDeps,
  actor: Actor,
  target: BotTarget,
  call: LiveCall,
): Promise<void> {
  const transcript = new LiveTranscript();
  /** Bot speech after a delegated answer repeats the run's reply, which is already filed. */
  let restatingAnswer = false;
  /** Turns are filed in the order they were spoken. */
  let filing = Promise.resolve();
  const file = (turn: LiveTurn | null) => {
    if (!turn) return;
    if (turn.role === "bot" && restatingAnswer) {
      restatingAnswer = false;
      return;
    }
    filing = filing
      .then(() => fileTurn(deps, actor, target, call.callId, turn))
      .catch((error) => getLogger().error("live call turn", error));
  };
  try {
    for await (const event of call.control.events) {
      if (event.type === "heard") file(transcript.heard(event.text));
      else if (event.type === "said") file(transcript.said(event.text));
      else if (event.type === "delegation") {
        void delegate(event.id).catch((error) => {
          getLogger().error("live call delegation", error);
          call.control.answer(event.id, "That did not work. Tell the caller to try again.");
        });
      } else if (event.type === "error")
        getLogger().warn("live call error", { message: event.message });
      else if (event.type === "closed") break;
    }
  } finally {
    for (const turn of transcript.flush()) file(turn);
    await filing;
  }

  async function delegate(delegationId: string) {
    await new Promise((resolve) => setTimeout(resolve, DELEGATION_SETTLE_MS));
    const turn = transcript.takeUser();
    const text = turn?.text || (await lastCallerWords(deps, target.threadId, call.callId));
    if (!text) {
      call.control.answer(delegationId, "Ask the caller to repeat the request.");
      return;
    }
    // The bot's run sees the call so far, so file what came before this request first.
    await filing;
    const modelPin = await callModelPin(deps, actor);
    const sent = await sendThreadMessage(deps, actor, target, {
      text,
      clientNonce: callClientNonce(call.callId),
      ...(modelPin ? { modelPin } : {}),
    });
    call.control.note(delegationId, "The assistant is working on it. No result yet.");
    const reply = await awaitRunReply(deps, sent.runId, sent.seq);
    restatingAnswer = true;
    const farewell = await botFarewell(deps, target.threadId, call.callId);
    if (farewell !== null) {
      // The bot hung up: say its goodbye, then end the call.
      call.control.answer(delegationId, farewell || reply || "Say goodbye to the caller.");
      setTimeout(() => call.control.close(), FAREWELL_MS);
      return;
    }
    call.control.answer(
      delegationId,
      reply || "The assistant is still working on it and will reply in the chat.",
    );
  }
}

async function fileTurn(
  deps: LiveCallDeps,
  actor: Actor,
  target: BotTarget,
  callId: string,
  turn: LiveTurn,
): Promise<void> {
  const blocks = [{ kind: "text" as const, text: turn.text }];
  const role = turn.role === "user" ? "user" : "bot";
  const seq = await deps.prisma.$transaction(async (tx) => {
    const message = await createThreadMessageInTransaction(tx, {
      threadId: target.threadId,
      role,
      ...(role === "bot" ? { botId: target.botId } : {}),
      blocks,
      clientNonce: callClientNonce(callId),
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      type: "thread.message.created",
      payload: { messageId: message.id, role, blocks, callId },
    });
    return event.seq;
  });
  await deps.events.notify(target.threadId, seq).catch((error) => {
    getLogger().error("live call realtime notification", error);
  });
}

/** The goodbye the bot hung up this call with, or null while the call is still on. */
async function botFarewell(
  deps: LiveCallDeps,
  threadId: string,
  callId: string,
): Promise<string | null> {
  const ended = await deps.prisma.event.findFirst({
    where: { threadId, type: "thread.call.ended", payload: { path: ["callId"], equals: callId } },
    select: { payload: true },
  });
  if (!ended) return null;
  const farewell = (ended.payload as { farewell?: unknown } | null)?.farewell;
  return typeof farewell === "string" ? farewell.trim() : "";
}

/** What the caller said most recently on this call, when a task arrived before its words. */
async function lastCallerWords(deps: LiveCallDeps, threadId: string, callId: string) {
  const row = await deps.prisma.message.findFirst({
    where: { threadId, role: "user", clientNonce: { startsWith: `call:${callId}:` } },
    orderBy: { seq: "desc" },
    select: { blocks: true },
  });
  return row ? speechFromBlocks(row.blocks as never).trim() : "";
}

/** Waits for the bot's run to finish or stop for the caller, then reads what it said. */
export async function awaitRunReply(
  deps: Pick<LiveCallDeps, "prisma">,
  runId: string,
  afterSeq: number,
  timeoutMs = RUN_ANSWER_TIMEOUT_MS,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await deps.prisma.run.findUnique({
      where: { id: runId },
      select: { status: true },
    });
    if (!run || !BUSY_RUN_STATUSES.has(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, RUN_POLL_MS));
  }
  const replies = await deps.prisma.message.findMany({
    where: { runId, role: "bot", seq: { gt: afterSeq } },
    orderBy: { seq: "asc" },
    select: { blocks: true },
  });
  return replies
    .map((reply) => speechFromBlocks(reply.blocks as never).trim())
    .filter(Boolean)
    .join("\n");
}
