/** How long after it arrives a message still rises in, should its row mount late. */
export const APPEAR_WINDOW_MS = 1_000;

export type AppearState = {
  seen: Set<string>;
  /** Runs whose live text is on screen; their final message replaces it in place. */
  liveRuns: Set<string>;
  /** When each animating message arrived. */
  arrivedAt: Map<string, number>;
};

export function appearState(): AppearState {
  return { seen: new Set(), liveRuns: new Set(), arrivedAt: new Map() };
}

/**
 * Notes which messages just arrived and should rise in. The first load, a send that swaps in
 * for its bubble, and a reply that replaces its own live text stay still, so nothing on
 * screen moves twice.
 */
export function noteArrivals(
  state: AppearState,
  messages: ReadonlyArray<{ id: string; role: string; runId?: string; clientNonce?: string }>,
  options: { first: boolean; now: number },
) {
  for (const message of messages) {
    if (state.seen.has(message.id)) continue;
    state.seen.add(message.id);
    const live = message.id.startsWith("progress:");
    const replacesLive = !live && message.runId !== undefined && state.liveRuns.has(message.runId);
    if (live && message.runId) state.liveRuns.add(message.runId);
    if (options.first || replacesLive) continue;
    if (message.role === "user" && message.clientNonce) continue;
    state.arrivedAt.set(message.id, options.now);
  }
}

export function isArriving(state: AppearState, id: string, now: number): boolean {
  const at = state.arrivedAt.get(id);
  return at !== undefined && now - at < APPEAR_WINDOW_MS;
}
