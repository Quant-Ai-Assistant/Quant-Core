import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  permissions: ["microphone"],
});

/** Reports the OpenAI voice connection that calls need, without a real OpenAI key. */
async function reportLiveCalls(page: Page) {
  await page.route("**/rpc/voice/status", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.json.live = true;
    await route.fulfill({ response, json: body });
  });
}

test("voice settings connect a key, speak a reply, and open a call", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "SpeechRecognition", { value: undefined });
    Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined });
  });
  const stamp = Date.now();
  const userName = `Voice ${stamp}`;
  await signup(page, `voice-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await expect(
    page.getByTestId("composer-bar").getByRole("button", { name: "Voice", exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByTestId("composer-bar")
      .getByRole("button", { name: "Record voice message", exact: true }),
  ).toHaveCount(1);
  // Calls are live conversations: without the OpenAI voice connection there is no call button.
  await expect(page.getByTestId("call-button")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "voice-composer");
  await openUserSettings(page, "voice");
  await expect(page.getByTestId("voice-settings")).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Dictate", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "voice-settings");
  await page.getByRole("button", { name: "Close voice settings" }).click();
  await expect(page.getByTestId("voice-settings")).toHaveCount(0);

  const preparedOff = await rpc<{ ready: boolean }>(page, "voice/prepare", {
    text: "Hello there.",
  });
  expect(preparedOff.ready).toBe(false);

  await openUserSettings(page, "voice");
  await expect(page.getByTestId("voice-settings")).toBeVisible();
  await page.getByRole("button", { name: /Scripted/ }).click();
  const apiKeyInput = page.getByPlaceholder(/Paste your API key/);
  await expect(apiKeyInput).toHaveAttribute("autocomplete", "new-password");
  await apiKeyInput.fill("fake-scripted-voice-key");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Replace key" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "voice-settings-connected");

  const spoken = page.waitForResponse(
    (response) => response.url().includes("/api/voice/speak") && response.ok(),
  );
  await page.getByRole("button", { name: "Hear a sample" }).click();
  const clip = await spoken;
  expect(clip.headers()["content-type"]).toContain("audio/mpeg");

  const credentials = await rpc<Array<{ hasKey: boolean; provider: string }>>(
    page,
    "voice/credentials",
    {},
  );
  expect(credentials).toEqual([expect.objectContaining({ hasKey: true, provider: "scripted" })]);
  expect(JSON.stringify(credentials)).not.toContain("fake-scripted-voice-key");

  await page.getByRole("button", { name: "Close voice settings" }).click();

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("say hello");
  await page.keyboard.press("Enter");
  // A reply can render more than one text bubble; speak the latest one.
  const speakReply = page.getByRole("button", { name: "Speak this reply" }).last();
  await expect(speakReply).toBeVisible({
    timeout: 30_000,
  });

  const replySpoken = page.waitForResponse(
    (response) => response.url().includes("/api/voice/speak") && response.ok(),
  );
  await speakReply.click();
  await replySpoken;

  await openUserSettings(page, "voice");
  await expect(page.getByRole("button", { name: "Replace key" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close voice settings" }).click();
  // A speak-only voice still offers no calls.
  await expect(page.getByTestId("call-button")).toHaveCount(0);

  await reportLiveCalls(page);
  // The live session needs a real provider; leave its start pending so the call stays up.
  await page.route("**/rpc/threads/startLiveCall", () => undefined);
  await page.reload();
  await page.getByTestId("call-button").click();
  await expect(page.getByTestId("call-view")).toBeVisible();
  await expect(page.getByTestId("call-view").getByText("Calling…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Hang up" })).toBeVisible();
  await captureScreenshot(page, testInfo, "outgoing-ringing");
  await expect(page.getByTestId("call-view").getByText("Calling…")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "voice-call");
  await page.getByRole("button", { name: "Minimize call" }).click();
  await expect(page.getByTestId("call-view")).toHaveCount(0);
  await expect(page.getByTestId("call-button")).toHaveAccessibleName("Open call");
  await captureScreenshot(page, testInfo, "call-minimized");
  await page.getByTestId("call-return-bar").click();
  await expect(page.getByTestId("call-view")).toBeVisible();
  await page.getByRole("button", { name: "Hang up" }).click();
  await expect(page.getByTestId("call-view")).toHaveCount(0);
  await expect(page.getByTestId("call-return-bar")).toHaveCount(0);

  const mic = page.getByRole("button", { name: "Record voice message", exact: true });
  const micBounds = await mic.boundingBox();
  if (!micBounds) throw new Error("Missing composer microphone");
  await page.mouse.move(micBounds.x + micBounds.width / 2, micBounds.y + micBounds.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId("hold-to-talk-strip")).toBeVisible();
  await captureScreenshot(page, testInfo, "composer-voice-recording");
  // Lock and discard so the screenshot's recording never sends a chat message.
  await page.mouse.move(micBounds.x + micBounds.width / 2, micBounds.y - 100);
  await page.mouse.up();
  await page.getByRole("button", { name: "Discard recording" }).click();
  await expect(page.getByTestId("hold-to-talk-strip")).toHaveCount(0);

  // Hold, speak and release: the recording itself lands in the chat as a voice message.
  await page.mouse.move(micBounds.x + micBounds.width / 2, micBounds.y + micBounds.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(1_500);
  await page.mouse.up();
  await expect(page.getByTestId("transcript").getByTestId("voice-message")).toBeVisible();
  await captureScreenshot(page, testInfo, "voice-message");

  await openUserSettings(page, "voice");
  const settings = page.getByTestId("voice-settings");
  await settings.getByPlaceholder(/Paste a replacement key/).fill("leftover-voice-key");
  await settings.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(settings.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
  await expect(settings.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(rpc<Array<{ provider: string }>>(page, "voice/credentials", {})).resolves.toEqual(
    [],
  );
});

test("incoming calls keep failed actions available for retry", async ({ page }, testInfo) => {
  await signup(page, `incoming-call-${Date.now()}@rakazo.test`, "password12", "Call tester");
  await completeOnboarding(page);
  const bots = await rpc<Array<{ id: string }>>(page, "bots/list", {});
  const bot = bots[0];
  if (!bot) throw new Error("Missing test bot");
  await reportLiveCalls(page);
  const incomingCall = {
    callId: "test-incoming-call",
    reason: "Review the sample report",
    opening: "Ready to review?",
    expiresAt: new Date(Date.now() + 45_000).toISOString(),
  };
  await page.route("**/rpc/spaces/list", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.json.current.bots = body.json.current.bots.map((row: { id: string }) =>
      row.id === bot.id ? { ...row, incomingCall } : row,
    );
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/threads/answerCall", (route) =>
    route.fulfill({
      status: 503,
      json: { json: { code: "SERVICE_UNAVAILABLE", message: "Try again" } },
    }),
  );
  await page.route("**/rpc/threads/declineCall", (route) =>
    route.fulfill({ json: { json: { ok: true } } }),
  );
  const incoming = page.getByTestId("incoming-call");
  await expect(incoming).toBeVisible();
  await captureScreenshot(page, testInfo, "incoming-call");
  await incoming.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(incoming.getByRole("alert")).toBeVisible();
  await expect(incoming.getByRole("button", { name: "Answer", exact: true })).toBeEnabled();
  await incoming.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(incoming).toHaveCount(0);
});
