// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../lib/rpc";
import { RingingReminder } from "./RingingReminder";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      "message" in parts ? parts.message : String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: { threads: { ringingReminders: vi.fn(), settleReminder: vi.fn() } },
}));

const reminder = {
  botId: "bot-1",
  botName: "Nova",
  botColor: "",
  reminderId: "rem-1",
  text: "Call the bank",
  details: "They close at four.",
  ringsAt: "2026-10-18T14:30:00.000Z",
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const notify = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "Notification",
    class {
      static permission = "granted";
      close = vi.fn();
      constructor(...args: unknown[]) {
        notify(...args);
      }
    },
  );
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => "hidden");
  vi.clearAllMocks();
  vi.mocked(rpc.threads.ringingReminders).mockResolvedValue([reminder]);
  vi.mocked(rpc.threads.settleReminder).mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render() {
  await act(async () => {
    root.render(<RingingReminder bots={[]} />);
    await Promise.resolve();
  });
}

function button(label: string) {
  const found = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  );
  if (!found) throw new Error(`No ${label} button`);
  return found;
}

it("shows a due reminder over the app and once in the system tray when hidden", async () => {
  await render();
  expect(container.textContent).toContain("Call the bank");
  expect(container.textContent).toContain("They close at four.");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith("Call the bank", expect.objectContaining({ body: "Nova" }));
});

it("snoozes for five minutes and goes away until the next ring", async () => {
  await render();
  await act(async () => {
    button("In 5 minutes").click();
    await Promise.resolve();
  });
  expect(rpc.threads.settleReminder).toHaveBeenCalledWith({
    botId: "bot-1",
    reminderId: "rem-1",
    action: "snooze",
  });
  expect(container.querySelector("[data-testid=ringing-reminder]")).toBeNull();
  // The snoozed reminder rings again with a new start time.
  vi.mocked(rpc.threads.ringingReminders).mockResolvedValue([
    { ...reminder, ringsAt: "2026-10-18T14:35:00.000Z" },
  ]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(container.textContent).toContain("Call the bank");
});

it("closes when the reminder is answered on another device", async () => {
  await render();
  vi.mocked(rpc.threads.ringingReminders).mockResolvedValue([]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(container.querySelector("[data-testid=ringing-reminder]")).toBeNull();
});

it("marks it done", async () => {
  await render();
  await act(async () => {
    button("Done").click();
    await Promise.resolve();
  });
  expect(rpc.threads.settleReminder).toHaveBeenCalledWith(
    expect.objectContaining({ action: "done" }),
  );
});
