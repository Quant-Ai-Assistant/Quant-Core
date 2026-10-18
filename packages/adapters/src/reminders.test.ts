import type { BackgroundJob } from "@rakazo/adapter-kit";
import { REMINDER_RING_MS, REMINDER_SNOOZE_MS } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { advanceReminderMessage, reconcileReminders, remindUser } from "./reminders.js";

const NOW = Date.parse("2026-10-18T14:30:00Z");
const run = {
  id: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  threadId: "thread-1",
  botId: "bot-1",
};

function harness(
  options: { status?: string; ringsAt?: string; updated?: number; ownChat?: boolean } = {},
) {
  const blocks = [
    {
      kind: "reminder",
      reminderId: "rem-1",
      text: "Call the bank",
      status: options.status ?? "ringing",
      ringsAt: options.ringsAt ?? new Date(NOW).toISOString(),
      rings: 1,
    },
  ];
  const tx = {
    $queryRaw: vi.fn(async () => []),
    thread: {
      findFirst: vi.fn(async () => (options.ownChat === false ? null : { id: "thread-1" })),
      update: vi.fn(async () => ({ nextEventSeq: 1, nextSeq: 1 })),
    },
    event: { create: vi.fn(async () => ({ seq: 7 })) },
    run: { findUnique: vi.fn(async () => ({ status: "running", startedAt: new Date(NOW) })) },
    message: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "message-1",
        ...data,
      })),
      findMany: vi.fn(async () => [{ threadId: "thread-1", blocks }]),
      findUnique: vi.fn(async () => ({
        id: "message-1",
        blocks,
        botId: "bot-1",
        thread: { spaceId: "space-1" },
      })),
      updateMany: vi.fn(async () => ({ count: options.updated ?? 1 })),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    events: { notify: vi.fn(async (_threadId: string, _seq: number) => undefined) },
    jobs: {
      enqueue: vi.fn(async (_job: BackgroundJob) => undefined),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
  };
  return { deps, tx };
}

describe("remind_user", () => {
  it("rings from the bot's own chat and sets the ring's timer", async () => {
    const { deps, tx } = harness();
    await expect(remindUser(deps, run, { text: "  Call the bank  " }, NOW)).resolves.toEqual({
      ok: true,
      status: "ringing",
    });
    const created = vi.mocked(tx.message.create).mock.calls[0]?.[0].data;
    expect(created).toMatchObject({
      role: "bot",
      blocks: [{ kind: "reminder", text: "Call the bank", status: "ringing", rings: 1 }],
    });
    expect(String(created?.clientNonce)).toMatch(/^reminder:/);
    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "reminder.tick",
        availableAt: new Date(NOW + REMINDER_RING_MS),
      }),
    );
  });

  it("refuses an empty reminder and a chat that is not the bot's own", async () => {
    await expect(remindUser(harness().deps, run, { text: " " }, NOW)).resolves.toEqual({
      error: "text is required.",
    });
    const { deps, tx } = harness({ ownChat: false });
    await expect(remindUser(deps, run, { text: "Call" }, NOW)).resolves.toMatchObject({
      error: expect.stringMatching(/one-to-one/),
    });
    expect(tx.message.create).not.toHaveBeenCalled();
  });
});

describe("advancing a reminder", () => {
  it("snoozes for five minutes and tells the thread", async () => {
    const { deps, tx } = harness();
    const next = await advanceReminderMessage(
      deps,
      { threadId: "thread-1", reminderId: "rem-1", event: "snooze" },
      NOW,
    );
    expect(next).toMatchObject({ status: "snoozed" });
    expect(tx.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "thread.message.updated" }),
      }),
    );
    expect(deps.events.notify).toHaveBeenCalledWith("thread-1", 7);
    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ availableAt: new Date(NOW + REMINDER_SNOOZE_MS) }),
    );
  });

  it("settles once when two devices answer together", async () => {
    const { deps, tx } = harness({ updated: 0 });
    await expect(
      advanceReminderMessage(
        deps,
        { threadId: "thread-1", reminderId: "rem-1", event: "done" },
        NOW,
      ),
    ).resolves.toBeNull();
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("leaves a finished reminder alone", async () => {
    const { deps, tx } = harness({ status: "done" });
    await expect(
      advanceReminderMessage(
        deps,
        { threadId: "thread-1", reminderId: "rem-1", event: "tick" },
        NOW,
      ),
    ).resolves.toBeNull();
    expect(tx.message.updateMany).not.toHaveBeenCalled();
  });

  it("restores the timer of every reminder still going", async () => {
    const { deps } = harness({ status: "snoozed", ringsAt: new Date(NOW + 60_000).toISOString() });
    await reconcileReminders(deps);
    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "reminder.tick",
        payload: { threadId: "thread-1", reminderId: "rem-1" },
        availableAt: new Date(NOW + 60_000),
      }),
    );
  });
});
