import type { AdapterContext, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { runContinueJob, watchCheckJob, watchCheckJobKey } from "@rakazo/adapter-kit";
import {
  appendWatchedBotUpdate,
  buildBotWatchWakePrompt,
  buildCommandWatchWakePrompt,
  isBackgroundRunTrigger,
  renderWatchedBotUpdate,
  resolveBotAddress,
  WATCH_COMMAND_DEFAULT_INTERVAL_SECONDS,
  WATCH_COMMAND_MAX_INTERVAL_SECONDS,
  WATCH_COMMAND_MAX_LENGTH,
  WATCH_COMMAND_MIN_INTERVAL_SECONDS,
  WATCH_DEFAULT_EXPIRY_MINUTES,
  WATCH_GOAL_MAX_LENGTH,
  WATCH_MAX_ACTIVE_PER_BOT,
  WATCH_MAX_EXPIRY_MINUTES,
  WATCH_MAX_FIRES,
  type WatchedBotEvent,
} from "@rakazo/core";
import { type Prisma, type PrismaClient, parseComputerMode } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { loadBotMessageContext } from "./bot-messages.js";
import { touchRunningComputer } from "./computer-idle.js";
import { toComputerRef } from "./computer-lifecycle.js";
import { resolveBotWorkspaceCwd } from "./computer-support.js";
import { NO_RESPONSE } from "./silent-reply.js";

export const WATCH_TOOL_NAMES = new Set(["watch_create", "watch_list", "watch_cancel"]);

const WATCH_CHECK_TIMEOUT_MS = 30_000;
const WATCH_CHECK_OUTPUT_MAX_CHARS = 4_000;
/** A check job that should have run this long ago was lost; the reconciler re-enqueues it. */
const WATCH_CHECK_OVERDUE_MS = 60_000;

export interface WatchDeps {
  prisma: PrismaClient;
  jobs: JobPublisher;
}

function wholeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

/** Validate a watch_create call. Exactly one of a teammate bot or a check command is watched. */
export function resolveWatchInput(input: {
  name?: unknown;
  goal?: unknown;
  bot_id?: unknown;
  confirm_name?: unknown;
  command?: unknown;
  intervalSeconds?: unknown;
  expiresInMinutes?: unknown;
}):
  | {
      ok: true;
      name: string;
      goal: string;
      bot?: { botId?: string; name?: string };
      command?: { command: string; intervalSeconds: number };
      expiresInMinutes: number;
    }
  | { ok: false; error: string } {
  const goal = String(input.goal ?? "").trim();
  if (!goal) return { ok: false, error: "goal is required: say what you are waiting for." };
  if (goal.length > WATCH_GOAL_MAX_LENGTH) {
    return { ok: false, error: `goal exceeds ${WATCH_GOAL_MAX_LENGTH} characters` };
  }
  const name = String(input.name ?? "").trim() || goal.slice(0, 60);
  const botId = String(input.bot_id ?? "").trim();
  const botName = String(input.confirm_name ?? "").trim();
  const command = String(input.command ?? "").trim();
  const watchesBot = Boolean(botId || botName);
  if (watchesBot === Boolean(command)) {
    return {
      ok: false,
      error: "Watch exactly one thing: a teammate bot (bot_id or confirm_name) or a check command.",
    };
  }
  if (command.length > WATCH_COMMAND_MAX_LENGTH) {
    return { ok: false, error: `command exceeds ${WATCH_COMMAND_MAX_LENGTH} characters` };
  }
  const expiresInMinutes = wholeNumber(input.expiresInMinutes) ?? WATCH_DEFAULT_EXPIRY_MINUTES;
  if (
    !Number.isInteger(expiresInMinutes) ||
    expiresInMinutes < 1 ||
    expiresInMinutes > WATCH_MAX_EXPIRY_MINUTES
  ) {
    return {
      ok: false,
      error: `expiresInMinutes must be a whole number from 1 to ${WATCH_MAX_EXPIRY_MINUTES}.`,
    };
  }
  if (watchesBot) {
    return {
      ok: true,
      name,
      goal,
      bot: { botId: botId || undefined, name: botName || undefined },
      expiresInMinutes,
    };
  }
  const intervalSeconds =
    wholeNumber(input.intervalSeconds) ?? WATCH_COMMAND_DEFAULT_INTERVAL_SECONDS;
  if (
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < WATCH_COMMAND_MIN_INTERVAL_SECONDS ||
    intervalSeconds > WATCH_COMMAND_MAX_INTERVAL_SECONDS
  ) {
    return {
      ok: false,
      error: `intervalSeconds must be a whole number from ${WATCH_COMMAND_MIN_INTERVAL_SECONDS} to ${WATCH_COMMAND_MAX_INTERVAL_SECONDS}.`,
    };
  }
  return { ok: true, name, goal, command: { command, intervalSeconds }, expiresInMinutes };
}

export async function createWatchFromTool(
  deps: WatchDeps,
  input: {
    spaceId: string;
    botId: string;
    userId: string;
    threadId: string;
    args: Record<string, unknown>;
  },
) {
  const resolved = resolveWatchInput(input.args);
  if (!resolved.ok) return { error: resolved.error };

  const now = new Date();
  const activeCount = await deps.prisma.watch.count({
    where: { botId: input.botId, active: true, expiresAt: { gt: now } },
  });
  if (activeCount >= WATCH_MAX_ACTIVE_PER_BOT) {
    return {
      error: `You already have ${WATCH_MAX_ACTIVE_PER_BOT} active watches. Cancel one with watch_cancel first.`,
    };
  }

  let watchedBot: { id: string; name: string } | undefined;
  if (resolved.bot) {
    const candidates = await deps.prisma.bot.findMany({
      where: { spaceId: input.spaceId, userId: input.userId, archivedAt: null },
      select: { id: true, name: true },
    });
    watchedBot = resolveBotAddress(candidates, resolved.bot);
    if (!watchedBot) return { error: "no bot found with that id or name" };
    if (watchedBot.id === input.botId) return { error: "a bot cannot watch itself" };
  }

  const expiresAt = new Date(now.getTime() + resolved.expiresInMinutes * 60_000);
  const nextCheckAt = resolved.command
    ? new Date(now.getTime() + resolved.command.intervalSeconds * 1_000)
    : null;
  const row = await deps.prisma.watch.create({
    data: {
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      threadId: input.threadId,
      name: resolved.name,
      goal: resolved.goal,
      watchedBotId: watchedBot?.id ?? null,
      command: resolved.command?.command ?? null,
      intervalSeconds: resolved.command?.intervalSeconds ?? null,
      nextCheckAt,
      expiresAt,
    },
  });
  if (nextCheckAt) {
    try {
      await deps.jobs.enqueue(watchCheckJob(row.id, nextCheckAt));
    } catch (error) {
      // The reconciler re-enqueues overdue checks, so the watch stays live.
      getLogger().error("watch check enqueue", error);
    }
  }
  return {
    ok: true as const,
    watchId: row.id,
    name: row.name,
    ...(watchedBot ? { watching: watchedBot.name } : { command: row.command }),
    expiresAt: expiresAt.toISOString(),
    note: watchedBot
      ? `Each update ${watchedBot.name} posts in its chat wakes you. Stay silent on the ones that do not matter, and cancel the watch when you are done. Do not also schedule polling.`
      : "The server runs the check for you and wakes you once when it passes or the watch expires. Do not also schedule polling.",
  };
}

export async function listWatchesFromTool(
  deps: Pick<WatchDeps, "prisma">,
  input: { spaceId: string; botId: string; userId: string },
) {
  const now = new Date();
  const rows = await deps.prisma.watch.findMany({
    where: { spaceId: input.spaceId, botId: input.botId, userId: input.userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { watchedBot: { select: { name: true } } },
  });
  return {
    watches: rows.map((row) => ({
      watchId: row.id,
      name: row.name,
      goal: row.goal,
      ...(row.watchedBot ? { watching: row.watchedBot.name } : { command: row.command }),
      active: row.active && row.expiresAt > now,
      fired: row.fireCount,
      expiresAt: row.expiresAt.toISOString(),
    })),
  };
}

export async function cancelWatchFromTool(
  deps: WatchDeps,
  input: { spaceId: string; botId: string; userId: string; watchId?: string; name?: string },
) {
  const watchId = input.watchId?.trim();
  const name = input.name?.trim();
  if (!watchId && !name) return { error: "Provide watchId or the exact watch name to cancel." };
  const existing = await deps.prisma.watch.findFirst({
    where: {
      spaceId: input.spaceId,
      botId: input.botId,
      userId: input.userId,
      active: true,
      ...(watchId ? { id: watchId } : { name }),
    },
    orderBy: { createdAt: "desc" },
  });
  if (!existing) return { error: "No active watch with that id or name." };
  await deps.prisma.watch.update({
    where: { id: existing.id },
    data: { active: false, nextCheckAt: null },
  });
  if (existing.command) {
    await deps.jobs.cancel(watchCheckJobKey(existing.id)).catch(() => undefined);
  }
  return { ok: true as const, watchId: existing.id, name: existing.name };
}

/**
 * Queue the watcher's wake in its thread. An update that lands while an earlier
 * wake has not started yet joins that wake instead of queueing a second turn.
 * Returns the run to enqueue, or null when it joined a queued one.
 */
async function wakeWatcherInTransaction(
  tx: Prisma.TransactionClient,
  watch: { id: string; spaceId: string; botId: string; userId: string; threadId: string },
  prompt: string,
  update?: string,
): Promise<string | null> {
  if (update) {
    const queued = await tx.run.findFirst({
      where: { watchId: watch.id, status: "queued" },
      select: { id: true, taskId: true },
    });
    if (queued) {
      // Hold the run row so it cannot be leased while its prompt grows.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM runs WHERE id = ${queued.id} AND status = 'queued' FOR UPDATE`;
      if (locked.length === 1) {
        const task = await tx.task.findUniqueOrThrow({
          where: { id: queued.taskId },
          select: { prompt: true },
        });
        const joined = appendWatchedBotUpdate(task.prompt, update);
        if (joined) {
          await tx.task.update({ where: { id: queued.taskId }, data: { prompt: joined } });
          return null;
        }
      }
    }
  }
  const task = await tx.task.create({
    data: {
      spaceId: watch.spaceId,
      botId: watch.botId,
      threadId: watch.threadId,
      userId: watch.userId,
      prompt: update ? `${prompt}\n\n${update}` : prompt,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: watch.spaceId,
      botId: watch.botId,
      threadId: watch.threadId,
      taskId: task.id,
      userId: watch.userId,
      status: "queued",
      trigger: "watch",
      watchId: watch.id,
    },
    select: { id: true },
  });
  return run.id;
}

async function enqueueWake(jobs: JobPublisher, runId: string | null) {
  if (!runId) return;
  await jobs.enqueue(runContinueJob(runId)).catch((error) => {
    // The queued run is durable; the job reconciler repairs a missed wake.
    getLogger().error("watch wake enqueue", error);
  });
}

/**
 * Wake every bot watching this one. Called when the watched bot posts a visible
 * update or its turn ends. A turn that was itself started by a watch never fires
 * watches, so two bots watching each other cannot wake each other forever.
 * Never throws: the watched bot's turn must not fail because a watcher could not wake.
 */
export async function fireBotWatches(
  deps: WatchDeps,
  input: Parameters<typeof fireBotWatchesOrThrow>[1],
): Promise<void> {
  await fireBotWatchesOrThrow(deps, input).catch((error) => {
    getLogger().error("bot watch fire", error);
  });
}

async function fireBotWatchesOrThrow(
  deps: WatchDeps,
  input: {
    run: {
      spaceId: string;
      userId: string;
      botId: string;
      trigger: string;
      sourceMessageId?: string | null;
    };
    botName: string;
    event: WatchedBotEvent;
    text: string;
  },
): Promise<void> {
  const { run } = input;
  if (run.trigger === "watch" || isBackgroundRunTrigger(run.trigger)) return;
  if (!input.text.trim()) return;
  const now = new Date();
  const watches = await deps.prisma.watch.findMany({
    where: {
      spaceId: run.spaceId,
      userId: run.userId,
      watchedBotId: run.botId,
      active: true,
      expiresAt: { gt: now },
      bot: { archivedAt: null },
    },
    select: {
      id: true,
      spaceId: true,
      botId: true,
      userId: true,
      threadId: true,
      name: true,
      goal: true,
    },
  });
  if (watches.length === 0) return;
  // The bot that delegated this turn already gets its outcome back as a message.
  const delegator =
    run.trigger === "bot_message" && input.event !== "update"
      ? (await loadBotMessageContext(deps.prisma, run.sourceMessageId))?.fromBotId
      : undefined;
  const update = renderWatchedBotUpdate({
    botName: input.botName,
    event: input.event,
    text: input.text,
    at: now,
  });
  for (const watch of watches) {
    if (watch.botId === delegator) continue;
    const runId = await deps.prisma
      .$transaction(async (tx) => {
        const claimed = await tx.watch.updateMany({
          where: { id: watch.id, active: true, fireCount: { lt: WATCH_MAX_FIRES } },
          data: { fireCount: { increment: 1 }, lastFiredAt: now },
        });
        if (claimed.count !== 1) return null;
        await tx.watch.updateMany({
          where: { id: watch.id, fireCount: { gte: WATCH_MAX_FIRES } },
          data: { active: false },
        });
        return wakeWatcherInTransaction(
          tx,
          watch,
          buildBotWatchWakePrompt({ watch, noResponse: NO_RESPONSE }),
          update,
        );
      })
      .catch((error) => {
        getLogger().error("bot watch fire", error);
        return null;
      });
    await enqueueWake(deps.jobs, runId);
  }
}

async function runCheckCommand(
  sandbox: Pick<SandboxProvider, "execute">,
  computer: Parameters<typeof toComputerRef>[0],
  request: { command: string; cwd?: string },
  context: AdapterContext,
): Promise<{ code: number; output: string }> {
  let output = "";
  let code = 1;
  for await (const event of sandbox.execute(
    toComputerRef(computer),
    {
      argv: ["bash", "-lc", request.command],
      cwd: request.cwd,
      timeoutMs: WATCH_CHECK_TIMEOUT_MS,
    },
    context,
  )) {
    if (event.type === "exit") code = event.code;
    else output = `${output}${event.data}`.slice(-WATCH_CHECK_OUTPUT_MAX_CHARS);
  }
  return { code, output };
}

/**
 * One check of a command watch. The server runs it, never the model, so waiting
 * on a download costs no turns and posts nothing until it is done.
 */
export async function checkCommandWatch(
  deps: WatchDeps & { sandbox: SandboxProvider },
  watchId: string,
): Promise<void> {
  const watch = await deps.prisma.watch.findUnique({
    where: { id: watchId },
    include: { bot: { include: { computer: true } } },
  });
  if (!watch?.active || !watch.command || !watch.nextCheckAt) return;
  const claim = { id: watch.id, active: true, nextCheckAt: watch.nextCheckAt };
  if (watch.bot.archivedAt) {
    await deps.prisma.watch.updateMany({
      where: claim,
      data: { active: false, nextCheckAt: null },
    });
    return;
  }
  const now = new Date();
  const fire = async (prompt: string) => {
    const runId = await deps.prisma.$transaction(async (tx) => {
      const claimed = await tx.watch.updateMany({
        where: claim,
        data: { active: false, nextCheckAt: null, fireCount: { increment: 1 }, lastFiredAt: now },
      });
      if (claimed.count !== 1) return null;
      return wakeWatcherInTransaction(tx, watch, prompt);
    });
    await enqueueWake(deps.jobs, runId);
  };
  const command = { id: watch.id, name: watch.name, goal: watch.goal, command: watch.command };
  if (watch.expiresAt <= now) {
    await fire(
      buildCommandWatchWakePrompt({
        watch: command,
        outcome: { passed: false, expiredAt: watch.expiresAt },
      }),
    );
    return;
  }

  const computer = watch.bot.computer;
  const providerRef = computer?.providerRef;
  // A stopped computer is not woken just to check; the next tick looks again.
  if (computer && providerRef && computer.state === "running") {
    try {
      await touchRunningComputer(deps, { ...computer, providerRef });
      const result = await runCheckCommand(
        deps.sandbox,
        computer,
        {
          command: watch.command,
          cwd: resolveBotWorkspaceCwd(parseComputerMode(computer.scope), watch.botId, undefined),
        },
        {
          operationId: `watch.check:${watch.id}`,
          traceId: `watch.check:${watch.id}`,
          spaceId: watch.spaceId,
          userId: watch.userId,
          botId: watch.botId,
          signal: AbortSignal.timeout(WATCH_CHECK_TIMEOUT_MS + 5_000),
        },
      );
      if (result.code === 0) {
        await fire(
          buildCommandWatchWakePrompt({
            watch: command,
            outcome: { passed: true, output: result.output },
          }),
        );
        return;
      }
    } catch (error) {
      getLogger().warn("watch check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const intervalMs = (watch.intervalSeconds ?? WATCH_COMMAND_DEFAULT_INTERVAL_SECONDS) * 1_000;
  const next = new Date(Math.min(Date.now() + intervalMs, watch.expiresAt.getTime()));
  const rescheduled = await deps.prisma.watch.updateMany({
    where: claim,
    data: { nextCheckAt: next },
  });
  if (rescheduled.count === 1) await deps.jobs.enqueue(watchCheckJob(watch.id, next));
}

/** Re-enqueue command checks whose job was lost, so a watch cannot silently stall. */
export async function reconcileCommandWatches(deps: WatchDeps): Promise<void> {
  const overdue = await deps.prisma.watch.findMany({
    where: {
      active: true,
      command: { not: null },
      nextCheckAt: { lte: new Date(Date.now() - WATCH_CHECK_OVERDUE_MS) },
    },
    orderBy: { nextCheckAt: "asc" },
    take: 100,
    select: { id: true, nextCheckAt: true },
  });
  for (const watch of overdue) {
    if (watch.nextCheckAt) await deps.jobs.enqueue(watchCheckJob(watch.id, watch.nextCheckAt));
  }
}
