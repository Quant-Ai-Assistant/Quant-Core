import { describe, expect, it, vi } from "vitest";

vi.mock("../components/native-action-button", () => ({ NativeActionButton: () => null }));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("./app-update", () => ({}));
vi.mock("./ota-update", () => ({}));
vi.mock("./native", () => ({}));
vi.mock("./user-error", () => ({}));
vi.mock("./i18n", () => ({}));
vi.mock("react-native", () => ({}));

const { checkedLabel, versionFromTag } = await import("../components/app-update-card");
const t = (text: string, values: Record<string, string> = {}) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

describe("update card", () => {
  it("shows release tags as plain versions", () => {
    expect(versionFromTag("v0.1.21")).toBe("0.1.21");
  });

  it("says just now within a minute, then the time of the check", () => {
    const at = Date.UTC(2026, 9, 16, 14, 5);
    expect(checkedLabel(at, at + 30_000, t, "en-GB")).toBe("checked just now");
    expect(checkedLabel(at, at + 120_000, t, "en-GB")).toMatch(/^checked at \d{2}:\d{2}$/);
  });
});
