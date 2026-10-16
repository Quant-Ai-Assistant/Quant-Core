/**
 * The voice connection that makes calls possible: calls are live conversations, and only
 * this provider has them. Without its key the app offers dictation but no calls.
 */
export const LIVE_CALL_VOICE_PROVIDER = "openai";

export type LiveTurn = { role: "user" | "bot"; text: string };

/** Bot speech shorter than this, said over the caller, is a listening sound, not a turn. */
const BACKCHANNEL_CHARS = 12;

/**
 * Folds a full-duplex call's transcript fragments into turns. Both sides can talk at once,
 * so each keeps its own buffer: the caller's turn ends when the bot starts a real reply
 * (not an "mm-hmm") or when the caller's words are taken for a task; the bot's turn ends
 * when the caller speaks again.
 */
export class LiveTranscript {
  private user = "";
  private bot = "";

  /** A fragment of the caller; returns the bot turn it closed, if any. */
  heard(fragment: string): LiveTurn | null {
    const bot = this.bot.trim();
    // A short sound made while the caller is still mid-turn is listening, not replying.
    const backchannel = bot.length < BACKCHANNEL_CHARS && this.user.trim() !== "";
    const closed = bot && !backchannel ? this.takeBot() : null;
    if (backchannel) this.bot = "";
    this.user += fragment;
    return closed;
  }

  /** A fragment of the bot; returns the caller turn it closed, if any. */
  said(fragment: string): LiveTurn | null {
    this.bot += fragment;
    if (!this.user.trim() || this.bot.trim().length < BACKCHANNEL_CHARS) return null;
    return this.takeUser();
  }

  /** The caller's words so far, ending their turn: what a delegated task is about. */
  takeUser(): LiveTurn | null {
    const text = this.user.trim();
    this.user = "";
    return text ? { role: "user", text } : null;
  }

  /** Everything still open, caller first, for the end of the call. */
  flush(): LiveTurn[] {
    return [this.takeUser(), this.takeBot()].filter((turn): turn is LiveTurn => turn !== null);
  }

  private takeBot(): LiveTurn | null {
    const text = this.bot.trim();
    this.bot = "";
    return text ? { role: "bot", text } : null;
  }
}

/** The bot holds the floor until its transcript has been quiet this long. */
export const LIVE_SPEAKING_TAIL_MS = 900;

export type LiveCallFeedHandlers = {
  /** Who holds the floor, from the bot's transcript. */
  onSpeaking: (speaking: boolean) => void;
  /** The caller's words so far in their current turn. */
  onHeard: (text: string) => void;
  /** The bot's words so far in its current turn. */
  onSaid: (text: string) => void;
  /** A finished turn, for the call's transcript. */
  onTurn: (turn: LiveTurn) => void;
  onEnded: (reason: string) => void;
};

/**
 * Reads a live call's client event channel into captions and turns. Shared by every
 * client, so web and mobile show the same conversation.
 */
export function createLiveCallFeed(handlers: LiveCallFeedHandlers): {
  receive: (data: string) => void;
  stop: () => void;
} {
  const transcript = new LiveTranscript();
  let heard = "";
  let said = "";
  let speakingTimer: ReturnType<typeof setTimeout> | null = null;
  const report = (turn: LiveTurn | null) => {
    if (turn) handlers.onTurn(turn);
  };
  return {
    receive: (data) => {
      let event: { type?: string; delta?: unknown; reason?: unknown };
      try {
        event = JSON.parse(data);
      } catch {
        return;
      }
      if (event.type === "session.input_transcript.delta" && typeof event.delta === "string") {
        const turn = transcript.heard(event.delta);
        if (turn) {
          report(turn);
          said = "";
          handlers.onSaid("");
        }
        heard += event.delta;
        handlers.onHeard(heard.trim());
      } else if (
        event.type === "session.output_transcript.delta" &&
        typeof event.delta === "string"
      ) {
        const turn = transcript.said(event.delta);
        if (turn) {
          report(turn);
          heard = "";
          handlers.onHeard("");
        }
        said += event.delta;
        handlers.onSaid(said.trim());
        handlers.onSpeaking(true);
        if (speakingTimer) clearTimeout(speakingTimer);
        speakingTimer = setTimeout(() => handlers.onSpeaking(false), LIVE_SPEAKING_TAIL_MS);
      } else if (event.type === "session.closed") {
        for (const turn of transcript.flush()) report(turn);
        handlers.onEnded(typeof event.reason === "string" ? event.reason : "");
      }
    },
    stop: () => {
      if (speakingTimer) clearTimeout(speakingTimer);
    },
  };
}

/** What a call shows for the tool the bot is using; new tools fall back to `other`. */
export type LiveToolKind = "computer" | "web" | "page" | "files" | "terminal" | "memory" | "other";

export function liveToolKind(tool: string): LiveToolKind {
  if (tool.startsWith("computer_")) return "computer";
  if (tool === "web_search" || tool === "web_fetch") return "web";
  if (tool.startsWith("browser_")) return "page";
  if (["read_file", "write_file", "list_files", "attach_file", "open_path"].includes(tool)) {
    return "files";
  }
  if (tool === "shell") return "terminal";
  if (tool === "remember" || tool === "save_shared_memory") return "memory";
  return "other";
}

/** How often a call asks what the bot is using while it is connected. */
export const LIVE_TOOL_POLL_MS = 1_500;
