import * as SecureStore from "expo-secure-store";
import { Alert, Platform } from "react-native";
import type { MobileMe } from "./api";
import { currentApiBase, rpc, selectedSpaceId } from "./api";
import { t } from "./i18n";
import {
  incomingCallBlockers,
  openFullScreenCallSettings,
  requestUnrestrictedBattery,
  setIncomingCalls,
} from "./live-notifications";
import { loadSessionToken } from "./session";

const ASKED_KEY = "quant.incoming-calls-asked";

/** What may ring this phone in the background. */
export type Ringing = { calls: boolean; reminders: boolean };

export type IncomingCallDeps = {
  loadAvailability: () => Promise<Ringing>;
  apply: (ringing: Ringing) => Promise<void>;
  askOnce: () => Promise<void>;
};

/**
 * Android: rings in the background while signed in, so bots' reminders wake the phone, and
 * takes calls too while the server offers them (calls on, and the OpenAI voice connection they
 * need). Safe to call on every launch and resume.
 */
export async function syncIncomingCalls(deps: IncomingCallDeps = productionDeps()): Promise<void> {
  if (Platform.OS !== "android") return;
  const ringing = await deps.loadAvailability().catch(() => null);
  // A failed check leaves the service as it was: a flaky network must not silence calls.
  if (ringing === null) return;
  await deps.apply(ringing);
  if (ringing.calls || ringing.reminders) await deps.askOnce();
}

function productionDeps(): IncomingCallDeps {
  return {
    loadAvailability: async () => {
      if (!(await loadSessionToken())) return { calls: false, reminders: false };
      const [me, voice] = await Promise.all([
        rpc<MobileMe>("me"),
        rpc<{ live?: boolean }>("voice/status"),
      ]);
      return { calls: Boolean(me.phoneCallsEnabled && voice.live), reminders: true };
    },
    apply: async (ringing) =>
      setIncomingCalls(
        ringing,
        currentApiBase(),
        await loadSessionToken(),
        selectedSpaceId() ?? "",
      ),
    askOnce: askToRingWhenLocked,
  };
}

/** Once per install: a call or reminder can only wake a locked, idle phone with these allowed. */
async function askToRingWhenLocked(): Promise<void> {
  if (await SecureStore.getItemAsync(ASKED_KEY)) return;
  await SecureStore.setItemAsync(ASKED_KEY, "1");
  const blockers = await incomingCallBlockers();
  if (blockers.battery) await requestUnrestrictedBattery().catch(() => undefined);
  if (!blockers.fullScreen) return;
  Alert.alert(t("Let bots' calls and reminders show on the lock screen?"), undefined, [
    { text: t("Not now"), style: "cancel" },
    { text: t("Allow"), onPress: () => void openFullScreenCallSettings().catch(() => undefined) },
  ]);
}

/** The shape the server accepts for a call id. */
const CALL_ID = /^[^:]{1,200}$/;

export type RingingCall = {
  botId: string;
  botName: string;
  botColor: string;
  callId: string;
  expiresAt: string;
};

export type AnswerDeps = {
  selectedSpaceId: () => string | null;
  selectSpace: (spaceId: string) => Promise<unknown>;
  /** Who is ringing now, to recover the call when the notification's link lost its id. */
  ringing?: () => Promise<RingingCall[]>;
  answer: (botId: string, callId: string) => Promise<{ opening: string }>;
  dismiss: (callId: string) => Promise<void>;
  start: (call: { botId: string; botName: string; greeting?: string; callId: string }) => void;
};

/** Picks up a bot's call on this phone: the other devices stop ringing on the server's word. */
export async function answerIncomingCall(
  call: { botId: string; botName: string; callId: string; spaceId?: string },
  deps: AnswerDeps,
): Promise<void> {
  if (call.spaceId && call.spaceId !== deps.selectedSpaceId()) await deps.selectSpace(call.spaceId);
  let callId = call.callId.trim();
  if (!CALL_ID.test(callId) && deps.ringing) {
    callId = (await deps.ringing()).find((ringing) => ringing.botId === call.botId)?.callId ?? "";
  }
  if (!CALL_ID.test(callId)) throw new Error(t("This call is no longer ringing."));
  const { opening } = await deps.answer(call.botId, callId);
  await deps.dismiss(callId).catch(() => undefined);
  if (callId !== call.callId) await deps.dismiss(call.callId).catch(() => undefined);
  deps.start({
    botId: call.botId,
    botName: call.botName,
    greeting: opening.trim() || undefined,
    callId,
  });
}

/** Whether a call is still ringing for this user, for the screen to close when it stops. */
export async function isStillRinging(
  callId: string,
  list: () => Promise<RingingCall[]> = () => rpc<RingingCall[]>("threads/ringingCalls"),
): Promise<boolean> {
  return (await list()).some((call) => call.callId === callId);
}
