import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { getItemAsync } from "expo-secure-store";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { playCallCue, stopCallCues } from "./call-sounds";

// Metro resolves bundled audio assets to numeric IDs.
const assets = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(`${process.cwd()}/package.json`);
  const originalLoader = require.extensions[".m4a"];
  require.extensions[".m4a"] = (assetModule) => {
    assetModule.exports = 1;
  };
  return { require, originalLoader };
});
vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(async () => null) }));
vi.mock("expo-audio", () => ({
  createAudioPlayer: vi.fn(),
  setAudioModeAsync: vi.fn(),
}));

const player = {
  volume: 1,
  play: vi.fn(),
  pause: vi.fn(),
  remove: vi.fn(),
  addListener: vi.fn(() => ({ remove: vi.fn() })),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getItemAsync).mockResolvedValue(null);
  vi.useFakeTimers();
  vi.mocked(createAudioPlayer).mockReturnValue(
    player as unknown as ReturnType<typeof createAudioPlayer>,
  );
});
afterEach(() => {
  stopCallCues();
  vi.useRealTimers();
});
afterAll(() => {
  if (assets.originalLoader) assets.require.extensions[".m4a"] = assets.originalLoader;
  else delete assets.require.extensions[".m4a"];
});

it.each(["start", "end"] as const)(
  "plays the %s cue without changing the audio mode",
  async (cue) => {
    const playing = playCallCue(cue);
    await vi.advanceTimersByTimeAsync(1600);
    await playing;

    expect(player.play).toHaveBeenCalledOnce();
    expect(player.remove).toHaveBeenCalledOnce();
    expect(setAudioModeAsync).not.toHaveBeenCalled();
  },
);

it("cancels a cue pending its settings read at hang-up", async () => {
  let resolve!: (value: string | null) => void;
  vi.mocked(getItemAsync).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const playing = playCallCue("start");
  stopCallCues();
  resolve(null);
  await playing;
  expect(createAudioPlayer).not.toHaveBeenCalled();
});

it("stops and removes a playing cue immediately at hang-up", async () => {
  const playing = playCallCue("end");
  await vi.advanceTimersByTimeAsync(0);
  expect(player.play).toHaveBeenCalledOnce();
  stopCallCues();
  expect(player.pause).toHaveBeenCalledOnce();
  expect(player.remove).toHaveBeenCalledOnce();
  await playing;
  expect(player.remove).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("still plays a settings preview after call cleanup", async () => {
  stopCallCues();
  const playing = playCallCue("start");
  await vi.advanceTimersByTimeAsync(1600);
  await playing;
  expect(player.play).toHaveBeenCalledOnce();
  expect(player.remove).toHaveBeenCalledOnce();
});

it("cancels a cue pending its audio import at hang-up", async () => {
  vi.resetModules();
  let finishImport!: () => void;
  let importStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    importStarted = resolve;
  });
  const pendingImport = new Promise<void>((resolve) => {
    finishImport = resolve;
  });
  vi.doMock("expo-audio", async () => {
    importStarted();
    await pendingImport;
    return { createAudioPlayer, setAudioModeAsync };
  });
  try {
    const sounds = await import("./call-sounds");
    const playing = sounds.playCallCue("start");
    await started;
    sounds.stopCallCues();
    finishImport();
    await playing;
    expect(createAudioPlayer).not.toHaveBeenCalled();
  } finally {
    vi.doMock("expo-audio", () => ({ createAudioPlayer, setAudioModeAsync }));
    vi.resetModules();
  }
});
