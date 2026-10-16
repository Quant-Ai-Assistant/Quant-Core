import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { cn } from "@rakazo/ui-web";
import { Pause, Play } from "lucide-react";
import type { PointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { useArtifactImage } from "../../lib/use-artifact-image";

type VoiceBlock = Extract<MessageBlock, { kind: "voice" }>;

/** The words of a voice message: its text blocks, which hold the transcript. */
export function voiceTranscript(blocks: MessageBlock[]): string {
  return blocks
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

export function formatVoiceTime(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * A voice message: play button, waveform across the bubble, and "Aa" that opens the
 * transcript underneath. `localSrc` plays a recording that is still being sent.
 */
export function VoiceMessageBubble({
  target,
  block,
  transcript,
  fromUser,
  localSrc,
  sending,
}: {
  target?: ArtifactTarget;
  block: Pick<VoiceBlock, "artifactId" | "durationMs" | "waveform">;
  transcript?: string;
  fromUser: boolean;
  localSrc?: string;
  sending?: boolean;
}) {
  const { t } = useLingui();
  const [wanted, setWanted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [showText, setShowText] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const downloaded = useArtifactImage(target, block.artifactId, wanted && !localSrc);
  const src = localSrc ?? downloaded;

  useEffect(() => {
    if (wanted && src && audio.current && audio.current.paused) {
      void audio.current.play().catch(() => setPlaying(false));
    }
  }, [wanted, src]);

  function toggle() {
    const element = audio.current;
    if (playing && element) {
      element.pause();
      return;
    }
    setWanted(true);
    if (element && src) void element.play().catch(() => setPlaying(false));
  }

  function seek(event: PointerEvent<HTMLDivElement>) {
    const element = audio.current;
    if (!element || !src) return;
    const box = event.currentTarget.getBoundingClientRect();
    const share = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    element.currentTime = (share * block.durationMs) / 1000;
    setPositionMs(share * block.durationMs);
  }

  const played = block.durationMs > 0 ? positionMs / block.durationMs : 0;
  const bars = block.waveform.length ? block.waveform : [0];
  const hasText = Boolean(transcript?.trim());

  return (
    <div
      data-testid="voice-message"
      className={cn(
        "w-[min(300px,100%)] rounded-[20px] px-3 py-2.5",
        fromUser ? "bg-chat-user text-chat-user-foreground" : "bg-muted text-foreground",
      )}
    >
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label={playing ? t`Pause voice message` : t`Play voice message`}
          onClick={toggle}
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-full",
            fromUser ? "bg-chat-user-foreground text-chat-user" : "bg-foreground text-background",
          )}
        >
          {playing ? (
            <Pause size={16} fill="currentColor" />
          ) : (
            <Play size={16} fill="currentColor" />
          )}
        </button>
        <div
          role="presentation"
          onPointerDown={seek}
          className="flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-between gap-px"
        >
          {bars.map((level, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional and never reorder
              key={index}
              className={cn(
                "w-[3px] shrink-0 rounded-full bg-current transition-opacity",
                index / bars.length >= played && "opacity-40",
              )}
              style={{ height: `${Math.max(3, Math.round(level * 24))}px` }}
            />
          ))}
        </div>
        {hasText ? (
          <button
            type="button"
            aria-label={showText ? t`Hide transcript` : t`Show transcript`}
            aria-expanded={showText}
            onClick={() => setShowText((open) => !open)}
            className={cn(
              "shrink-0 rounded-md border border-current px-1.5 text-[11px] leading-[18px] opacity-80",
              showText &&
                (fromUser
                  ? "bg-chat-user-foreground text-chat-user opacity-100"
                  : "bg-foreground text-background opacity-100"),
            )}
          >
            Aa
          </button>
        ) : null}
      </div>
      <div className="mt-1 text-[12px] tabular-nums opacity-70">
        {sending
          ? t`Sending…`
          : playing || positionMs > 0
            ? `${formatVoiceTime(positionMs)} / ${formatVoiceTime(block.durationMs)}`
            : formatVoiceTime(block.durationMs)}
      </div>
      {showText && hasText ? (
        <div
          className="mt-2 border-t border-current/20 pt-2 text-[14px] leading-[1.45] whitespace-pre-wrap"
          dir="auto"
        >
          {transcript}
        </div>
      ) : null}
      {src ? (
        // biome-ignore lint/a11y/useMediaCaption: a voice message's caption is its transcript
        <audio
          ref={audio}
          src={src}
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPositionMs(0);
          }}
          onTimeUpdate={(event) => setPositionMs(event.currentTarget.currentTime * 1000)}
          className="hidden"
        />
      ) : null}
    </div>
  );
}
