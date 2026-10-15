import { describe, expect, it, vi } from "vitest";

vi.mock("expo-updates", () => ({}));
vi.mock("./api", () => ({ currentApiBase: vi.fn() }));

import type { OtaDeps } from "./ota-update";
import { checkForOtaUpdate, installOtaUpdate } from "./ota-update";

function deps(overrides: Partial<OtaDeps> = {}): OtaDeps {
  return {
    isEnabled: () => true,
    apiBase: () => "https://quant.example.test:8443/",
    gateHeader: () => "Basic abc",
    setSource: vi.fn(),
    check: vi.fn(async () => ({ isAvailable: true })),
    fetch: vi.fn(async () => ({ isNew: true })),
    reload: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("over-the-air updates", () => {
  it("asks the app's own server, with its gate credential and base", async () => {
    const d = deps();
    expect(await checkForOtaUpdate(d)).toBe(true);
    expect(d.setSource).toHaveBeenCalledWith({
      updateUrl: "https://quant.example.test:8443/api/mobile-updates/manifest",
      requestHeaders: {
        "x-quant-base": "https://quant.example.test:8443",
        "x-quant-auth": "Basic abc",
      },
    });
  });

  it("does nothing in a build without updates", async () => {
    const d = deps({ isEnabled: () => false });
    expect(await checkForOtaUpdate(d)).toBe(false);
    expect(d.check).not.toHaveBeenCalled();
  });

  it("restarts into the downloaded update", async () => {
    const d = deps();
    await installOtaUpdate(d);
    expect(d.fetch).toHaveBeenCalled();
    expect(d.reload).toHaveBeenCalled();
  });
});
