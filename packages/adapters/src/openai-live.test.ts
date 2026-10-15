import type { AdapterContext, LiveCallEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { LiveSocket } from "./openai-live.js";
import { splitForAppend, startOpenAILiveCall, toLiveCallEvent } from "./openai-live.js";

const context: AdapterContext = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

function fakeSocket() {
  const listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  const sent: string[] = [];
  const socket: LiveSocket = {
    send: (data) => sent.push(data),
    close: vi.fn(),
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  const emit = (type: string, data?: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener({ data });
  };
  return { socket, sent, emit };
}

describe("OpenAI live calls", () => {
  it("creates a client-delegated WebRTC session and attaches to it", async () => {
    const fake = fakeSocket();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            session: { id: "live_1" },
            transport: { type: "webrtc", sdp: "answer" },
          }),
          { status: 201 },
        ),
    );
    const openSocket = vi.fn(() => fake.socket);
    const session = await startOpenAILiveCall(
      {
        apiKey: "sk-test",
        offerSdp: "offer",
        instructions: "Be brief.",
        history: [{ role: "user", text: "Hi" }],
        greeting: "Hello, Ada here.",
        safetyId: "caller",
      },
      context,
      { fetch: fetch as unknown as typeof globalThis.fetch, openSocket },
    );
    expect(session).toMatchObject({ sessionId: "live_1", answerSdp: "answer" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/live/sessions");
    const body = JSON.parse(String(init.body));
    expect(body.session.delegation).toEqual({ type: "client" });
    expect(body.session.instructions).toBe("Be brief.");
    expect(body.transport).toEqual({ type: "webrtc", sdp: "offer" });
    expect(body.session.input[0].content[0]).toEqual({ type: "input_text", text: "Hi" });
    expect(body.session.input.at(-1).role).toBe("developer");
    expect(body.session.input.at(-1).content[0].text).toContain("Hello, Ada here.");
    expect(openSocket).toHaveBeenCalledWith(
      "wss://api.openai.com/v1/live/sessions/live_1/attach",
      expect.objectContaining({ authorization: "Bearer sk-test" }),
    );
  });

  it("queues commands until the attach socket opens and reports events in order", async () => {
    const fake = fakeSocket();
    const fetch = async () =>
      new Response(JSON.stringify({ session: { id: "live_2" }, transport: { sdp: "a" } }));
    const { control } = await startOpenAILiveCall(
      { apiKey: "k", offerSdp: "o", instructions: "", history: [], safetyId: "s" },
      context,
      { fetch: fetch as unknown as typeof globalThis.fetch, openSocket: () => fake.socket },
    );
    control.answer("item_1", "It is sunny.");
    expect(fake.sent).toEqual([]);
    fake.emit("open");
    expect(JSON.parse(fake.sent[0] ?? "{}")).toMatchObject({
      type: "session.commentary.append",
      delegation_id: "item_1",
      content: "It is sunny.",
    });
    fake.emit("message", JSON.stringify({ type: "session.input_transcript.delta", delta: "Hi" }));
    fake.emit(
      "message",
      JSON.stringify({
        type: "session.delegation.created",
        delegation: { id: "item_2", target: "client" },
      }),
    );
    fake.emit("message", JSON.stringify({ type: "session.closed", reason: "close_requested" }));
    const events: LiveCallEvent[] = [];
    for await (const event of control.events) events.push(event);
    expect(events).toEqual([
      { type: "heard", text: "Hi" },
      { type: "delegation", id: "item_2" },
      { type: "closed", reason: "close_requested" },
    ]);
  });

  it("ignores events it does not use and splits long results under the append cap", () => {
    expect(toLiveCallEvent({ type: "session.updated" })).toBeNull();
    expect(
      toLiveCallEvent({
        type: "session.delegation.created",
        delegation: { id: "x", target: "responses" },
      }),
    ).toBeNull();
    const parts = splitForAppend(`${"A sentence. ".repeat(200)}`);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 1_200)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe("A sentence. ".repeat(200).trim());
  });
});
