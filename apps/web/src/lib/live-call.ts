import type { LiveCallFeedHandlers } from "@rakazo/core";
import { createLiveCallFeed } from "@rakazo/core";
import { rpc } from "./rpc.js";

const ICE_GATHER_TIMEOUT_MS = 10_000;

export type LiveCallHandlers = LiveCallFeedHandlers;

export type LiveConnection = {
  setMuted: (muted: boolean) => void;
  close: () => void;
};

/**
 * Connects a full-duplex call: the microphone and the bot's voice travel over WebRTC to the
 * voice provider, which the server set up and follows. The browser's echo cancellation keeps
 * the bot from hearing itself, so the caller can talk over it.
 */
export async function connectLiveCall(
  call: { botId: string; callId: string; greeting?: string; language?: string },
  handlers: LiveCallHandlers,
  signal: AbortSignal,
): Promise<LiveConnection> {
  const microphone = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const peer = new RTCPeerConnection();
  // The event channel must exist before the offer is made.
  const events = peer.createDataChannel("oai-events");
  const audio = new Audio();
  audio.autoplay = true;
  let closed = false;
  const feed = createLiveCallFeed({
    ...handlers,
    onEnded: (reason) => {
      handlers.onEnded(reason);
      close();
    },
  });

  const close = () => {
    if (closed) return;
    closed = true;
    feed.stop();
    for (const track of microphone.getTracks()) track.stop();
    events.close();
    peer.close();
    audio.srcObject = null;
  };
  signal.addEventListener("abort", close, { once: true });

  peer.addEventListener("track", (event) => {
    audio.srcObject = new MediaStream([event.track]);
    void audio.play().catch(() => undefined);
  });
  for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
  events.addEventListener("message", ({ data }) => feed.receive(String(data)));
  events.addEventListener("close", () => {
    if (closed) return;
    handlers.onEnded("connection_lost");
    close();
  });

  try {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await iceGathered(peer);
    const offerSdp = peer.localDescription?.sdp;
    if (!offerSdp) throw new Error("Missing local SDP offer");
    const { answerSdp } = await rpc.threads.startLiveCall(
      {
        botId: call.botId,
        callId: call.callId,
        offerSdp,
        greeting: call.greeting,
        language: call.language,
      },
      { signal },
    );
    await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
  } catch (error) {
    close();
    throw error;
  }

  return {
    setMuted: (muted) => {
      for (const track of microphone.getAudioTracks()) track.enabled = !muted;
    },
    close,
  };
}

function iceGathered(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      peer.removeEventListener("icegatheringstatechange", onState);
      reject(new Error("Timed out while connecting the call"));
    }, ICE_GATHER_TIMEOUT_MS);
    function onState() {
      if (peer.iceGatheringState !== "complete") return;
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", onState);
      resolve();
    }
    peer.addEventListener("icegatheringstatechange", onState);
  });
}
