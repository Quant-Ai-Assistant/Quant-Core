import { describe, expect, it, vi } from "vitest";
import { createLiveCallFeed, LIVE_SPEAKING_TAIL_MS, LiveTranscript } from "./live-call-turns.js";

describe("live call transcript", () => {
  it("ends the caller's turn when the bot starts a real reply", () => {
    const transcript = new LiveTranscript();
    expect(transcript.heard("What is the ")).toBeNull();
    expect(transcript.heard("weather like?")).toBeNull();
    expect(transcript.said("It is sunny out, ")).toEqual({
      role: "user",
      text: "What is the weather like?",
    });
    expect(transcript.said("and warm today.")).toBeNull();
    expect(transcript.heard("Thanks")).toEqual({
      role: "bot",
      text: "It is sunny out, and warm today.",
    });
    expect(transcript.flush()).toEqual([{ role: "user", text: "Thanks" }]);
  });

  it("drops a listening sound made while the caller keeps talking", () => {
    const transcript = new LiveTranscript();
    transcript.heard("So I was thinking ");
    expect(transcript.said("Mm-hmm.")).toBeNull();
    expect(transcript.heard("about the trip.")).toBeNull();
    expect(transcript.takeUser()).toEqual({
      role: "user",
      text: "So I was thinking about the trip.",
    });
  });

  it("hands the caller's words to a task and starts a new turn after it", () => {
    const transcript = new LiveTranscript();
    transcript.heard("Remind me at five");
    expect(transcript.takeUser()).toEqual({ role: "user", text: "Remind me at five" });
    expect(transcript.takeUser()).toBeNull();
  });
});

describe("live call feed", () => {
  it("turns client events into captions, turns and the end of the call", () => {
    vi.useFakeTimers();
    const handlers = {
      onSpeaking: vi.fn(),
      onHeard: vi.fn(),
      onSaid: vi.fn(),
      onTurn: vi.fn(),
      onEnded: vi.fn(),
    };
    const feed = createLiveCallFeed(handlers);
    const send = (event: object) => feed.receive(JSON.stringify(event));
    send({ type: "session.input_transcript.delta", delta: "Book a table " });
    send({ type: "session.input_transcript.delta", delta: "for two" });
    expect(handlers.onHeard).toHaveBeenLastCalledWith("Book a table for two");
    send({ type: "session.output_transcript.delta", delta: "Sure, checking now." });
    expect(handlers.onTurn).toHaveBeenCalledWith({ role: "user", text: "Book a table for two" });
    expect(handlers.onSpeaking).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(LIVE_SPEAKING_TAIL_MS);
    expect(handlers.onSpeaking).toHaveBeenLastCalledWith(false);
    feed.receive("not json");
    send({ type: "session.closed", reason: "close_requested" });
    expect(handlers.onTurn).toHaveBeenLastCalledWith({ role: "bot", text: "Sure, checking now." });
    expect(handlers.onEnded).toHaveBeenCalledWith("close_requested");
    feed.stop();
    vi.useRealTimers();
  });
});
