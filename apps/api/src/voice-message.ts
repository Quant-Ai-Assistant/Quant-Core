import type { ArtifactStore } from "@rakazo/adapter-kit";
import { MacSpeech } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { baseMimeType } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { getSpaceArtifactById } from "./artifacts.js";
import { transcribeVoice, type VoiceDeps } from "./voice.js";

/** BCP-47 tags for the macOS recognizer, from the short language hint clients send. */
const SPEECH_LOCALES: Record<string, string> = {
  en: "en-US",
  ru: "ru-RU",
  de: "de-DE",
  es: "es-ES",
  fr: "fr-FR",
  hi: "hi-IN",
  ko: "ko-KR",
  pt: "pt-BR",
  tr: "tr-TR",
  zh: "zh-CN",
};

/**
 * Turns a recorded voice message into text: the connected voice provider first, then this
 * Mac's own speech recognition, then the transcript the device made. Empty when none can.
 */
export async function transcribeVoiceMessage(
  deps: VoiceDeps & { artifacts: ArtifactStore; macSpeech?: MacSpeech },
  actor: Actor,
  voice: { artifactId: string; transcript?: string; language?: string },
): Promise<string> {
  const artifact = await getSpaceArtifactById(deps, actor, { artifactId: voice.artifactId });
  const audio = new Uint8Array(Buffer.from(artifact.contentBase64, "base64"));
  const mimeType = baseMimeType(artifact.mimeType);
  const language = voice.language?.split("-")[0]?.toLowerCase();
  try {
    const { text } = await transcribeVoice(deps, actor, { audio, mimeType, language });
    if (text.trim()) return text.trim();
  } catch (error) {
    getLogger().info("voice message provider transcription skipped", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (MacSpeech.supports(mimeType)) {
    try {
      const locale = (language && SPEECH_LOCALES[language]) || "en-US";
      const text = await (deps.macSpeech ?? new MacSpeech()).transcribe({
        audio,
        mimeType,
        locale,
      });
      if (text) return text;
    } catch (error) {
      getLogger().error("voice message macOS transcription", error);
    }
  }
  return voice.transcript?.trim() ?? "";
}
