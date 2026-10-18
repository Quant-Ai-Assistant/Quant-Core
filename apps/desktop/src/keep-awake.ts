import path from "node:path";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

const KEEP_AWAKE_FILE = "keep-awake.json";

/** The part of Electron's powerSaveBlocker this uses. */
export interface PowerSaveBlocker {
  start(type: "prevent-display-sleep"): number;
  stop(id: number): void;
}

/**
 * Keeps the display awake while the app runs. macOS locks the screen when the display sleeps,
 * so this is what keeps it from asking for the password while a bot works unattended.
 */
export class KeepAwake {
  private blockerId: number | null = null;

  constructor(private readonly blocker: PowerSaveBlocker) {}

  on(): boolean {
    return this.blockerId !== null;
  }

  set(on: boolean): void {
    if (on === this.on()) return;
    if (on) {
      this.blockerId = this.blocker.start("prevent-display-sleep");
      return;
    }
    if (this.blockerId !== null) this.blocker.stop(this.blockerId);
    this.blockerId = null;
  }
}

export async function readKeepAwake(userDataDir: string): Promise<boolean> {
  const raw = await readPrivateFile(path.join(userDataDir, KEEP_AWAKE_FILE), 1024);
  if (raw === null) return false;
  try {
    return (JSON.parse(raw) as { on?: unknown }).on === true;
  } catch {
    return false;
  }
}

export async function writeKeepAwake(userDataDir: string, on: boolean): Promise<void> {
  await writePrivateFile(path.join(userDataDir, KEEP_AWAKE_FILE), JSON.stringify({ on }));
}
