import { describe, expect, it, vi } from "vitest";
import type { PermissionProbe, PermissionState } from "./app-permissions";
import { loadPermissions, nextToRequest, permissionProbes } from "./app-permissions";

function probe(
  key: PermissionProbe["key"],
  required: boolean,
  check: PermissionProbe["check"],
): PermissionProbe {
  return { key, required, check, request: vi.fn(async () => undefined), opensSettings: false };
}

describe("permissions", () => {
  it("lists the lock screen, background and updates on Android only", () => {
    const android = permissionProbes("android").map((entry) => entry.key);
    const ios = permissionProbes("ios").map((entry) => entry.key);
    expect(android).toEqual([
      "notifications",
      "lockScreen",
      "background",
      "microphone",
      "camera",
      "photos",
      "updates",
    ]);
    expect(ios).toEqual(["notifications", "microphone", "camera", "photos"]);
  });

  it("drops what the phone lacks and counts a failed check as not allowed", async () => {
    const states = await loadPermissions([
      probe("notifications", true, async () => true),
      probe("updates", false, async () => null),
      probe("camera", false, async () => {
        throw new Error("no camera module");
      }),
    ]);
    expect(states).toEqual([
      { key: "notifications", required: true, granted: true },
      { key: "camera", required: false, granted: false },
    ]);
  });

  it("asks for required ones first and never twice in one pass", () => {
    const states: PermissionState[] = [
      { key: "camera", required: false, granted: false },
      { key: "notifications", required: true, granted: true },
      { key: "background", required: true, granted: false },
    ];
    expect(nextToRequest(states, new Set())).toBe("background");
    expect(nextToRequest(states, new Set(["background"]))).toBe("camera");
    expect(nextToRequest(states, new Set(["background", "camera"]))).toBeNull();
  });
});
