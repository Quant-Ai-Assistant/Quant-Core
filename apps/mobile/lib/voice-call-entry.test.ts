import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCallCallerName } from "./voice-call-entry";

describe("loadCallCallerName", () => {
  afterEach(() => vi.useRealTimers());

  it("uses the first name when the profile arrives promptly", async () => {
    vi.useFakeTimers();
    await expect(loadCallCallerName(async () => ({ name: "  Alex Example  " }))).resolves.toBe(
      "Alex",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues without a name after 500 ms even if the profile never arrives", async () => {
    vi.useFakeTimers();
    const result = loadCallCallerName(() => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a profile failure after the deadline", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const result = loadCallCallerName(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBeUndefined();
    reject(new Error("offline"));
    await Promise.resolve();
  });

  it("continues without a name on a failed or empty profile", async () => {
    await expect(
      loadCallCallerName(async () => {
        throw new Error("offline");
      }),
    ).resolves.toBeUndefined();
    await expect(loadCallCallerName(async () => ({ name: " " }))).resolves.toBeUndefined();
  });
});
