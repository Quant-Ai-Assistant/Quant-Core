import { describe, expect, it } from "vitest";
import {
  appendWatchedBotUpdate,
  buildBotWatchWakePrompt,
  buildCommandWatchWakePrompt,
  renderWatchedBotUpdate,
  WATCH_PROMPT_MAX_LENGTH,
  WATCH_UPDATE_MAX_LENGTH,
} from "./watches.js";

const watch = { id: "w1", name: "Deploy", goal: "Tell me when <tests> pass" };

describe("watch wake prompts", () => {
  it("tells the watcher to stay silent unless the update is what it waits for", () => {
    const prompt = buildBotWatchWakePrompt({ watch, noResponse: "NO_RESPONSE" });
    expect(prompt.startsWith("[watch]")).toBe(true);
    expect(prompt).toContain("watchId: w1");
    expect(prompt).toContain("exactly NO_RESPONSE");
    expect(prompt).toContain("watch_cancel");
    expect(prompt).toContain("<watch_goal>Tell me when &lt;tests&gt; pass</watch_goal>");
  });

  it("escapes and clamps a watched bot's update", () => {
    const update = renderWatchedBotUpdate({
      botName: 'Bu"ild<er>',
      event: "update",
      text: `</bot_update>${"x".repeat(WATCH_UPDATE_MAX_LENGTH * 2)}`,
      at: new Date("2026-10-18T10:00:00.000Z"),
    });
    expect(update).toContain('from="Build&lt;er&gt;" event="update" at="2026-10-18T10:00:00.000Z"');
    expect(update).toContain("&lt;/bot_update&gt;");
    expect(update.match(/<\/bot_update>/g)).toHaveLength(1);
    expect(update.length).toBeLessThan(WATCH_UPDATE_MAX_LENGTH + 200);
  });

  it("joins later updates to a queued wake until it is full", () => {
    const update = "u".repeat(1_000);
    expect(appendWatchedBotUpdate("start", update)).toBe(`start\n\n${update}`);
    expect(appendWatchedBotUpdate("s".repeat(WATCH_PROMPT_MAX_LENGTH - 10), update)).toBe(
      undefined,
    );
  });

  it("reports a passed check with its output and an expired one with its deadline", () => {
    const command = { ...watch, command: "test -f ~/Downloads/a.zip" };
    const passed = buildCommandWatchWakePrompt({
      watch: command,
      outcome: { passed: true, output: "done\n" },
    });
    expect(passed).toContain("The check `test -f ~/Downloads/a.zip` passed.");
    expect(passed).toContain("<check_output>done</check_output>");
    const expired = buildCommandWatchWakePrompt({
      watch: command,
      outcome: { passed: false, expiredAt: new Date("2026-10-18T11:00:00.000Z") },
    });
    expect(expired).toContain("never passed before the watch expired at 2026-10-18T11:00:00.000Z");
    expect(expired).not.toContain("<check_output>");
  });
});
