import { requireOptionalNativeModule } from "expo-modules-core";
import * as SecureStore from "expo-secure-store";
import type { MobileBot, MobileMessage } from "./api";
import { copyableMobileMessageText } from "./api";

type NativeAssistant = {
  isDefaultAssistant(): Promise<boolean>;
  openAssistantSettings(): Promise<void>;
  screenshot(): Promise<string | null>;
  close(): Promise<void>;
};

/** Android's digital-assistant hooks; null on iOS and in builds without the module. */
const nativeAssistant = requireOptionalNativeModule<NativeAssistant>("QuantAssistant");

const ASSISTANT_BOT_KEY = "quant.assistant-bot";

export function assistantSupported(): boolean {
  return nativeAssistant !== null;
}

export async function isDefaultAssistant(): Promise<boolean | null> {
  return nativeAssistant ? nativeAssistant.isDefaultAssistant() : null;
}

export async function openAssistantSettings(): Promise<void> {
  await nativeAssistant?.openAssistantSettings();
}

/** The screen that was open when the assistant was called, as a file URI. */
export async function assistantScreenshot(): Promise<string | null> {
  const path = await nativeAssistant?.screenshot();
  return path ? `file://${path}` : null;
}

export async function closeAssistant(): Promise<void> {
  await nativeAssistant?.close();
}

export async function loadAssistantBotId(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(ASSISTANT_BOT_KEY);
  } catch {
    return null;
  }
}

export async function saveAssistantBotId(botId: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(ASSISTANT_BOT_KEY, botId);
  } catch {
    // The choice is a convenience; the first bot is the fallback.
  }
}

/** The bot the assistant talks to: the last one chosen while it still exists, else the first. */
export function pickAssistantBot(bots: MobileBot[], savedId: string | null): MobileBot | null {
  const active = bots.filter((bot) => !bot.archivedAt);
  return active.find((bot) => bot.id === savedId) ?? active[0] ?? null;
}

/** The bot's answer to the message this sheet sent: its replies after that message, joined. */
export function assistantReply(messages: MobileMessage[], clientNonce: string | null): string {
  if (!clientNonce) return "";
  const sent = messages.findIndex((message) => message.clientNonce === clientNonce);
  if (sent < 0) return "";
  return messages
    .slice(sent + 1)
    .filter((message) => message.role === "bot")
    .map(copyableMobileMessageText)
    .filter(Boolean)
    .join("\n\n");
}
