// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  controls: vi.fn(),
  stop: vi.fn(),
  setPaused: vi.fn(),
  setAllPaused: vi.fn(),
  closeDialog: () => undefined as void,
  translate: (parts: TemplateStringsArray, ...values: string[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));

vi.mock("../lib/rpc", () => ({
  rpc: {
    bots: {
      controls: api.controls,
      stop: api.stop,
      setPaused: api.setPaused,
      setAllPaused: api.setAllPaused,
    },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: api.translate }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Button = ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />;
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Button,
    AlertDialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children?: ReactNode;
    }) => {
      api.closeDialog = () => onOpenChange(false);
      return open ? <div role="alertdialog">{children}</div> : null;
    },
    AlertDialogContent: Passthrough,
    AlertDialogHeader: Passthrough,
    AlertDialogFooter: Passthrough,
    AlertDialogTitle: Passthrough,
    AlertDialogDescription: Passthrough,
    AlertDialogCancel: (props: ComponentProps<"button">) => (
      <button type="button" {...props} onClick={() => api.closeDialog()} />
    ),
    AlertDialogAction: Button,
    BotAvatar: () => <span />,
    Label: (props: ComponentProps<"label">) => (
      // biome-ignore lint/a11y/noLabelWithoutControl: test stand-in for the shared Label
      <label {...props} />
    ),
    Switch: ({
      checked,
      onCheckedChange,
      ...props
    }: Omit<ComponentProps<"input">, "onChange"> & {
      onCheckedChange: (checked: boolean) => void;
    }) => (
      <input
        type="checkbox"
        {...props}
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
    ),
  };
});

import { HostSettingsPanel } from "./HostSettingsPanel";

let container: HTMLDivElement;
let root: Root;

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
}

async function render() {
  await act(async () => {
    root.render(<HostSettingsPanel avatarStyle="robot" />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.stop.mockResolvedValue({ ok: true });
  api.setPaused.mockResolvedValue({ ok: true });
  api.setAllPaused.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("HostSettingsPanel", () => {
  it("asks before stopping every assistant", async () => {
    api.controls.mockResolvedValue([
      { id: "bot-a", name: "Nika", color: "#D4537E", status: "running", paused: false },
      { id: "bot-b", name: "Mail", color: "#1D9E75", status: "idle", paused: false },
    ]);
    await render();

    await act(async () => button("Stop all").click());
    expect(container.querySelector("[role=alertdialog]")).not.toBeNull();
    await act(async () => button("No").click());
    expect(container.querySelector("[role=alertdialog]")).toBeNull();
    expect(api.setAllPaused).not.toHaveBeenCalled();

    await act(async () => button("Stop all").click());
    await act(async () => button("Yes, stop").click());
    expect(api.setAllPaused).toHaveBeenCalledWith({ paused: true });
  });

  it("offers to start them all once every one is off", async () => {
    api.controls.mockResolvedValue([
      { id: "bot-a", name: "Nika", color: "#D4537E", status: "idle", paused: true },
    ]);
    await render();

    expect(container.textContent).toContain("All assistants are off");
    await act(async () => button("Start all").click());
    expect(api.setAllPaused).toHaveBeenCalledWith({ paused: false });
  });

  it("interrupts a working assistant and turns one off", async () => {
    api.controls.mockResolvedValue([
      { id: "bot-a", name: "Nika", color: "#D4537E", status: "running", paused: false },
      { id: "bot-b", name: "Mail", color: "#1D9E75", status: "idle", paused: false },
    ]);
    await render();

    // Only the assistant that is working can be interrupted.
    expect(container.querySelectorAll("button").length).toBe(2);
    await act(async () => button("Interrupt").click());
    expect(api.stop).toHaveBeenCalledWith({ botId: "bot-a" });

    const mail = container.querySelector<HTMLInputElement>("input[aria-label=Mail]");
    await act(async () => mail?.click());
    expect(api.setPaused).toHaveBeenCalledWith({ botId: "bot-b", paused: true });
  });
});
