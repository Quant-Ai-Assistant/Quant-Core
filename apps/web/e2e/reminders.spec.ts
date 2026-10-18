import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("a due reminder shows over the app until it is done or snoozed", async ({
  page,
}, testInfo) => {
  await signup(page, `reminder-${Date.now()}@rakazo.test`, "password12", "Reminder tester");
  await completeOnboarding(page);
  const bots = await rpc<Array<{ id: string; name: string }>>(page, "bots/list", {});
  const bot = bots[0];
  if (!bot) throw new Error("Missing test bot");
  let ringing = [
    {
      botId: bot.id,
      botName: bot.name,
      botColor: "",
      reminderId: "test-reminder",
      text: "Call the bank about the card",
      details: "The branch is open until four.",
      ringsAt: new Date().toISOString(),
    },
  ];
  const settled: Array<{ action: string }> = [];
  await page.route("**/rpc/threads/ringingReminders", (route) =>
    route.fulfill({ json: { json: ringing } }),
  );
  await page.route("**/rpc/threads/settleReminder", async (route) => {
    settled.push(route.request().postDataJSON().json);
    ringing = [];
    await route.fulfill({ json: { json: { ok: true } } });
  });

  const reminder = page.getByTestId("ringing-reminder");
  await expect(reminder).toBeVisible();
  await expect(reminder).toContainText("Call the bank about the card");
  await captureScreenshot(page, testInfo, "ringing-reminder");
  await reminder.getByRole("button", { name: "In 5 minutes" }).click();
  await expect(reminder).toHaveCount(0);
  expect(settled).toEqual([expect.objectContaining({ action: "snooze" })]);
});
