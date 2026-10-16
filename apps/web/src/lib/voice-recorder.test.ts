import { describe, expect, it } from "vitest";
import { recordingMimeType, waveformBars } from "./voice-recorder";

describe("voice recorder", () => {
  it("prefers AAC, which macOS speech recognition reads, then WebM", () => {
    expect(recordingMimeType(() => true)).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(recordingMimeType((type) => type.startsWith("audio/webm"))).toBe(
      "audio/webm;codecs=opus",
    );
    expect(recordingMimeType(() => false)).toBeUndefined();
  });

  it("averages loudness into bars scaled to the loudest", () => {
    expect(waveformBars([0.1, 0.1, 0.4, 0.4], 2)).toEqual([0.25, 1]);
    expect(waveformBars([], 3)).toEqual([0, 0, 0]);
  });
});
