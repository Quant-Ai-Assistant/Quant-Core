import type { LiveCallFeedHandlers } from "@rakazo/core";
import { createLiveCallFeed } from "@rakazo/core";
import { rpc } from "./api";

const ICE_GATHER_TIMEOUT_MS = 10_000;

export type LiveConnection = {
  setMuted: (muted: boolean) => void;
  close: () => void;
};

export type ConnectLiveCall = (
  call: { botId: string; callId: string; greeting?: string; language?: string },
  handlers: LiveCallFeedHandlers,
  signal: AbortSignal,
) => Promise<LiveConnection>;

/**
 * Connects a full-duplex call over WebRTC: the phone's voice-processing audio path cancels
 * the bot's echo, so the caller can talk over it and the provider hears every word as it is
 * said. The server set the session up and follows its transcript.
 */
export const connectLiveCall: ConnectLiveCall = async (call, handlers, signal) => {
  // Native module: loaded only when a live call starts.
  const { mediaDevices, RTCPeerConnection } = await import("react-native-webrtc");
  const microphone = await mediaDevices.getUserMedia({ audio: true, video: false });
  const peer = new RTCPeerConnection({});
  // The event channel must exist before the offer is made.
  const events = peer.createDataChannel("oai-events");
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
  };
  signal.addEventListener("abort", close, { once: true });

  for (const track of microphone.getAudioTracks()) peer.addTrack(track, microphone);
  events.onmessage = (event: unknown) => feed.receive(String((event as { data?: unknown }).data));
  events.onclose = () => {
    if (closed) return;
    handlers.onEnded("connection_lost");
    close();
  };

  try {
    const offer = await peer.createOffer({});
    await peer.setLocalDescription(offer);
    await iceGathered(peer as unknown as GatheringPeer);
    const offerSdp = peer.localDescription?.sdp;
    if (!offerSdp) throw new Error("Missing local SDP offer");
    const { answerSdp } = await rpc<{ answerSdp: string }>(
      "threads/startLiveCall",
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
};

type GatheringPeer = {
  iceGatheringState: string;
  onicegatheringstatechange: (() => void) | null;
};

function iceGathered(peer: GatheringPeer): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      peer.onicegatheringstatechange = null;
      reject(new Error("Timed out while connecting the call"));
    }, ICE_GATHER_TIMEOUT_MS);
    peer.onicegatheringstatechange = () => {
      if (peer.iceGatheringState !== "complete") return;
      clearTimeout(timeout);
      peer.onicegatheringstatechange = null;
      resolve();
    };
  });
}
