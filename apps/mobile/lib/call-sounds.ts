import type { AudioPlayer } from "expo-audio";
import * as SecureStore from "expo-secure-store";

export const CALL_SOUNDS_KEY = "rakazo.call-sounds";

export type CallCue = "start" | "end";

const CUE_ASSETS: Record<CallCue, number> = {
  start: require("../assets/sounds/warm-start.m4a"),
  end: require("../assets/sounds/warm-end.m4a"),
};

/** Bound playback when no completion event arrives. */
const CUE_MAX_MS = 1600;

export async function loadCallSoundsEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(CALL_SOUNDS_KEY)) !== "0";
}

export async function saveCallSoundsEnabled(on: boolean): Promise<void> {
  if (on) await SecureStore.deleteItemAsync(CALL_SOUNDS_KEY);
  else await SecureStore.setItemAsync(CALL_SOUNDS_KEY, "0");
}

export async function playCallCue(cue: CallCue): Promise<void> {
  const epoch = cueEpoch;
  if (!(await loadCallSoundsEnabled().catch(() => true))) return;
  if (epoch !== cueEpoch) return;
  const { createAudioPlayer } = await import("expo-audio");
  if (epoch !== cueEpoch) return;
  const player = createAudioPlayer(CUE_ASSETS[cue]);
  let finish: () => void = () => undefined;
  cuePlayers.set(player, () => finish());
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => finish(), CUE_MAX_MS);
      const subscription = player.addListener("playbackStatusUpdate", (status) => {
        if (status.didJustFinish) finish();
      });
      let finished = false;
      finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        subscription.remove();
        resolve();
      };
      player.play();
    });
  } finally {
    finish();
    if (cuePlayers.delete(player)) player.remove();
  }
}

const cuePlayers = new Map<AudioPlayer, () => void>();
/** A hang-up cancels cues still loading; a later preview starts a new epoch. */
let cueEpoch = 0;

/** Hang-up: stop and free any cue still playing or loading. */
export function stopCallCues(): void {
  cueEpoch += 1;
  for (const [player, finish] of cuePlayers) {
    finish();
    player.pause();
    player.remove();
  }
  cuePlayers.clear();
}
