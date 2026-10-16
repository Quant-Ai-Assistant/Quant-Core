import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("this Mac turns assistants off one by one and all at once", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    let keepAwake = false;
    const state = () => ({ keepAwake, server: { running: true, port: 8443 } });
    Object.defineProperty(window, "rakazoDesktop", {
      value: {
        platform: "darwin",
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
        update: {
          state: async () => ({
            phase: "idle",
            currentVersion: "0.1.2",
            availableVersion: null,
            percent: null,
            message: null,
            checkedAt: null,
          }),
          check: async () => null,
          download: async () => null,
          install: async () => null,
        },
        host: {
          state: async () => state(),
          setKeepAwake: async (on: boolean) => {
            keepAwake = on;
            return state();
          },
          stopServer: async () => {},
        },
      },
    });
  });
  const stamp = Date.now();
  await signup(page, `host-settings-${stamp}@rakazo.test`, "password12", "Host settings");
  await completeOnboarding(page);

  const settings = await openUserSettings(page, "host");
  const panel = settings.getByTestId("host-settings");
  await expect(panel).toContainText("Running · port 8443");
  await panel.getByTestId("host-keep-awake-toggle").click();
  await expect(panel.getByTestId("host-keep-awake-toggle")).toBeChecked();
  await captureScreenshot(page, testInfo, "host-settings");

  await panel.getByTestId("stop-all-bots").click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Stop all assistants?");
  await captureScreenshot(page, testInfo, "host-settings-stop-all-confirm");
  await confirm.getByTestId("confirm-stop-all-bots").click();
  await expect(panel).toContainText("All assistants are off");

  await panel.getByTestId("start-all-bots").click();
  await expect(panel.getByTestId("stop-all-bots")).toBeVisible();
});
