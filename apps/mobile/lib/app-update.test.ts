import { describe, expect, it, vi } from "vitest";
import { checkForAppUpdate, releaseVersionCode } from "./app-update";

vi.mock("expo-application", () => ({
  nativeBuildVersion: "20",
  nativeApplicationVersion: "0.1.20",
}));
vi.mock("expo-file-system", () => ({ DownloadTask: class {}, File: class {}, Paths: {} }));
vi.mock("expo-intent-launcher", () => ({ startActivityAsync: vi.fn() }));

function release(tag: string, size?: number) {
  return (async () =>
    new Response(
      JSON.stringify({
        tag_name: tag,
        assets: [
          { name: "quant.apk", browser_download_url: "https://example.test/quant.apk", size },
        ],
      }),
    )) as unknown as typeof fetch;
}

describe("app update", () => {
  it("reads the build number from a release tag", () => {
    expect(releaseVersionCode("v0.1.21")).toBe(21);
    expect(releaseVersionCode("edge")).toBeNull();
  });

  it("offers a newer release with its size", async () => {
    await expect(checkForAppUpdate(release("v0.1.21", 156_000_000))).resolves.toMatchObject({
      available: true,
      current: 20,
      tag: "v0.1.21",
      size: 156_000_000,
    });
  });

  it("is current when the release is the installed build", async () => {
    await expect(checkForAppUpdate(release("v0.1.20"))).resolves.toEqual({
      available: false,
      current: 20,
    });
  });

  it("reports a failed check instead of calling the app current", async () => {
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(checkForAppUpdate(down)).rejects.toThrow("503");
  });
});
