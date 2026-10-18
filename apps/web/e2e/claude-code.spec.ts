import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

test("Claude Code has its own sign-in and per-bot model and effort", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `claude-code-${stamp}@rakazo.test`, "password12", "Claude Code");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  const settings = await openUserSettings(page, "claude-code");
  const panel = settings.getByTestId("claude-code-settings");
  await expect(panel.getByRole("button", { name: "Sign in with Claude" })).toBeVisible();
  await expect(panel.getByText("Or use an Anthropic API key")).toBeVisible();
  await captureScreenshot(page, testInfo, "claude-code-settings");
  await page.keyboard.press("Escape");

  await page.getByTestId("bot-settings-trigger").click();
  const botSettings = page.getByTestId("bot-settings");
  await expect(botSettings).toBeVisible();
  await botSettings.getByTestId("bot-claude-code").click();
  await botSettings.getByTestId("bot-claude-code-model").selectOption("opus");
  await botSettings.getByTestId("bot-claude-code-effort").selectOption("high");
  await captureScreenshot(page, testInfo, "claude-code-bot-settings");

  await expect
    .poll(
      async () =>
        (
          await rpc<{ claudeCode: { enabled: boolean; model: string; effort: string } }>(
            page,
            "bots/get",
            { botId },
          )
        ).claudeCode,
      { timeout: 15_000 },
    )
    .toEqual({ enabled: true, model: "opus", effort: "high" });
});
