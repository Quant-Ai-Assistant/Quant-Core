export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 4;
export const ARTIFACT_NAME_MAX_LENGTH = 255;
export const ARTIFACT_DESCRIPTION_MAX_LENGTH = 280;
/** Base64 expands payload by 4/3; cap before decode to reject oversize uploads cheaply. */
export const ATTACHMENT_MAX_BASE64_LENGTH = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4;

export const ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export const ATTACHMENT_FILE_MIME_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "application/json",
  "application/zip",
] as const;

/** Recordings a voice message may carry: what browsers, Electron and phones record. */
export const ATTACHMENT_AUDIO_MIME_TYPES = [
  "audio/mp4",
  "audio/aac",
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/wav",
] as const;

export const ATTACHMENT_ALLOWED_MIME_TYPES = [
  ...ATTACHMENT_IMAGE_MIME_TYPES,
  ...ATTACHMENT_FILE_MIME_TYPES,
  ...ATTACHMENT_AUDIO_MIME_TYPES,
] as const;

/** Longest voice message: the recorder stops here, well inside the attachment size limit. */
export const VOICE_MESSAGE_MAX_MS = 5 * 60_000;
/** Bars a voice message's waveform is drawn with. */
export const VOICE_WAVEFORM_BARS = 48;

/** `audio/webm;codecs=opus` → `audio/webm`, so recordings match the allowlist. */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
}

export type AttachmentMimeType = (typeof ATTACHMENT_ALLOWED_MIME_TYPES)[number];

export function isAttachmentImageMimeType(mimeType: string): boolean {
  return (ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function isAllowedAttachmentMimeType(mimeType: string): mimeType is AttachmentMimeType {
  return (ATTACHMENT_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function validateThreadsSendInput(input: {
  text?: string;
  artifactIds?: string[];
  voice?: unknown;
}): boolean {
  const text = input.text?.trim() ?? "";
  const artifactIds = input.artifactIds ?? [];
  return Boolean(text || artifactIds.length || input.voice);
}
