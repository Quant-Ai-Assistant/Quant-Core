import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SPEECH_TIMEOUT_MS = 90_000;

/** Recordings AVFoundation can open. WebM and Ogg need a voice provider instead. */
const READABLE_AUDIO: Record<string, string> = {
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
};

/**
 * JavaScript for Automation that transcribes one audio file with the Mac's own speech
 * recognizer, on the device when the language supports it. It ships inline so bundled
 * builds need no extra file, and must not contain a backtick or a template placeholder.
 */
export const MAC_SPEECH_DRIVER = String.raw`
ObjC.import("Foundation");
ObjC.import("Speech");

function spin(check, ms) {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  }
}

function run(argv) {
  try {
    const request = JSON.parse(argv[0]);
    let status = Number($.SFSpeechRecognizer.authorizationStatus);
    if (status === 0) {
      let asked = false;
      $.SFSpeechRecognizer.requestAuthorization(function (next) {
        status = Number(next);
        asked = true;
      });
      spin(function () { return asked; }, 60000);
    }
    if (status !== 3) return JSON.stringify({ error: "permission:speech" });
    const locale = $.NSLocale.alloc.initWithLocaleIdentifier(request.locale);
    const recognizer = $.SFSpeechRecognizer.alloc.initWithLocale(locale);
    if (!recognizer || recognizer.isNil() || !recognizer.isAvailable) {
      return JSON.stringify({ error: "unavailable" });
    }
    const task = $.SFSpeechURLRecognitionRequest.alloc.initWithURL(
      $.NSURL.fileURLWithPath(request.path),
    );
    task.shouldReportPartialResults = false;
    if (recognizer.supportsOnDeviceRecognition) task.requiresOnDeviceRecognition = true;
    let text = null;
    let failure = null;
    let done = false;
    recognizer.recognitionTaskWithRequestResultHandler(task, function (result, error) {
      if (error && !error.isNil()) {
        failure = ObjC.unwrap(error.localizedDescription);
        done = true;
        return;
      }
      if (result && !result.isNil() && result.isFinal) {
        text = ObjC.unwrap(result.bestTranscription.formattedString);
        done = true;
      }
    });
    spin(function () { return done; }, 80000);
    if (failure) return JSON.stringify({ error: failure });
    return JSON.stringify({ text: text || "" });
  } catch (error) {
    return JSON.stringify({ error: String(error && error.message ? error.message : error) });
  }
}
`;

export type MacSpeechRunner = (
  request: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Transcribes recordings with macOS speech recognition. Nothing is downloaded or sent out. */
export class MacSpeech {
  constructor(private readonly runDriver: MacSpeechRunner = runSpeechDriver) {}

  /** Whether this machine can transcribe a recording of this type at all. */
  static supports(mimeType: string, platform: string = process.platform): boolean {
    return platform === "darwin" && mimeType in READABLE_AUDIO;
  }

  async transcribe(input: {
    audio: Uint8Array;
    mimeType: string;
    locale: string;
  }): Promise<string> {
    const extension = READABLE_AUDIO[input.mimeType];
    if (!extension) throw new Error(`macOS cannot read ${input.mimeType} recordings`);
    const directory = await mkdtemp(path.join(tmpdir(), "quant-speech-"));
    try {
      const file = path.join(directory, `voice${extension}`);
      await writeFile(file, input.audio);
      const result = await this.runDriver({ path: file, locale: input.locale });
      if (typeof result.error === "string") throw new Error(result.error);
      return typeof result.text === "string" ? result.text.trim() : "";
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Runs the driver with `osascript`, reading the script from stdin. */
function runSpeechDriver(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-", JSON.stringify(request)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), SPEECH_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        reject(new Error(stderr.trim() || `speech driver exited with code ${code}`));
      }
    });
    child.stdin.end(MAC_SPEECH_DRIVER);
  });
}
