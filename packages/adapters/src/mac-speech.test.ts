import { describe, expect, it, vi } from "vitest";
import { MacSpeech } from "./mac-speech.js";

describe("MacSpeech", () => {
  it("reads the recordings AVFoundation opens, only on macOS", () => {
    expect(MacSpeech.supports("audio/mp4", "darwin")).toBe(true);
    expect(MacSpeech.supports("audio/webm", "darwin")).toBe(false);
    expect(MacSpeech.supports("audio/mp4", "linux")).toBe(false);
  });

  it("hands the driver a file and the locale, and returns its words", async () => {
    const driver = vi.fn(async (request: Record<string, unknown>) => {
      expect(String(request.path)).toMatch(/voice\.m4a$/);
      return { text: "  buy milk  " };
    });
    const speech = new MacSpeech(driver);
    await expect(
      speech.transcribe({ audio: new Uint8Array([1, 2]), mimeType: "audio/mp4", locale: "ru-RU" }),
    ).resolves.toBe("buy milk");
    expect(driver).toHaveBeenCalledWith(expect.objectContaining({ locale: "ru-RU" }));
  });

  it("reports what the driver could not do", async () => {
    const speech = new MacSpeech(async () => ({ error: "permission:speech" }));
    await expect(
      speech.transcribe({ audio: new Uint8Array([1]), mimeType: "audio/mp4", locale: "en-US" }),
    ).rejects.toThrow("permission:speech");
  });
});
