import { describe, expect, it } from "vitest";
import { appearState, isArriving, noteArrivals } from "./appearing-messages.js";

describe("arriving messages", () => {
  it("keeps the first load still and lets new replies rise in", () => {
    const state = appearState();
    noteArrivals(state, [{ id: "a", role: "bot" }], { first: true, now: 0 });
    expect(isArriving(state, "a", 0)).toBe(false);
    noteArrivals(
      state,
      [
        { id: "a", role: "bot" },
        { id: "b", role: "bot" },
      ],
      {
        first: false,
        now: 100,
      },
    );
    expect(isArriving(state, "b", 200)).toBe(true);
    expect(isArriving(state, "b", 2_000)).toBe(false);
  });

  it("does not move a send that swaps in for its bubble", () => {
    const state = appearState();
    noteArrivals(state, [{ id: "u", role: "user", clientNonce: "n1" }], { first: false, now: 0 });
    expect(isArriving(state, "u", 0)).toBe(false);
  });

  it("lets live text rise once, then swaps the final reply in place", () => {
    const state = appearState();
    noteArrivals(state, [{ id: "progress:r1", role: "bot", runId: "r1" }], {
      first: false,
      now: 0,
    });
    expect(isArriving(state, "progress:r1", 0)).toBe(true);
    noteArrivals(state, [{ id: "m1", role: "bot", runId: "r1" }], { first: false, now: 10 });
    expect(isArriving(state, "m1", 10)).toBe(false);
  });
});
