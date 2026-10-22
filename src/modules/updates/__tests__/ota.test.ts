import { describe, expect, it } from "vitest";

import { type OtaUiState, getOtaUiPhase } from "../ota";

function state(overrides: Partial<OtaUiState> = {}): OtaUiState {
  return {
    acknowledgedUpdateId: null,
    enabled: true,
    isEmbeddedLaunch: true,
    updateId: null,
    ...overrides,
  };
}

describe("getOtaUiPhase", () => {
  it("stays hidden while the embedded build is running", () => {
    expect(getOtaUiPhase(state())).toBe("hidden");
  });

  it("shows the drawer once an update the user has not seen is running", () => {
    expect(
      getOtaUiPhase({
        ...state(),
        acknowledgedUpdateId: "update-1",
        isEmbeddedLaunch: false,
        updateId: "update-2",
      }),
    ).toBe("applied");
  });

  it("never repeats the drawer for an acknowledged update", () => {
    expect(
      getOtaUiPhase(state({
        acknowledgedUpdateId: "update-1",
        isEmbeddedLaunch: false,
        updateId: "update-1",
      })),
    ).toBe("hidden");
  });

  it("stays hidden when expo-updates is disabled (dev builds)", () => {
    expect(
      getOtaUiPhase(state({ enabled: false, isEmbeddedLaunch: false, updateId: "update-1" })),
    ).toBe("hidden");
  });

  it("stays hidden until the downloaded bundle actually runs", () => {
    // expo-updates applies pending bundles on the next cold start; the drawer
    // is an "already updated" notice, not an install prompt.
    expect(
      getOtaUiPhase(state({ acknowledgedUpdateId: "update-1", isEmbeddedLaunch: true })),
    ).toBe("hidden");
  });

  it("treats a missing update id as the embedded launch", () => {
    expect(
      getOtaUiPhase(state({ isEmbeddedLaunch: false, updateId: undefined })),
    ).toBe("hidden");
  });
});
