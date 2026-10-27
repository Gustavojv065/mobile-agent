import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeNotificationSettings,
} from "../settings";

describe("notification settings", () => {
  it("enables new announcement defaults for existing installs", () => {
    expect(
      normalizeNotificationSettings({
        approvalRequests: false,
        runFinished: true,
      }),
    ).toEqual({
      approvalRequests: false,
      runFinished: true,
      questionRequests: true,
      announcementEnabled: true,
      announcementMode: "background",
      announceFinished: true,
      announceQuestions: true,
      announcePermissions: true,
    });
  });

  it("keeps every supported explicit value", () => {
    expect(
      normalizeNotificationSettings({
        approvalRequests: false,
        runFinished: false,
        questionRequests: false,
        announcementEnabled: false,
        announcementMode: "always",
        announceFinished: false,
        announceQuestions: false,
        announcePermissions: false,
      }),
    ).toEqual({
      approvalRequests: false,
      runFinished: false,
      questionRequests: false,
      announcementEnabled: false,
      announcementMode: "always",
      announceFinished: false,
      announceQuestions: false,
      announcePermissions: false,
    });
  });

  it("does not re-enable question alerts for legacy users who disabled notifications", () => {
    expect(
      normalizeNotificationSettings({
        approvalRequests: false,
        runFinished: false,
      }).questionRequests,
    ).toBe(false);

    expect(
      normalizeNotificationSettings({
        approvalRequests: true,
        runFinished: false,
      }).questionRequests,
    ).toBe(true);

    expect(
      normalizeNotificationSettings({
        approvalRequests: false,
        questionRequests: true,
        runFinished: false,
      }).questionRequests,
    ).toBe(true);
  });

  it("falls back to background mode for unknown values", () => {
    expect(
      normalizeNotificationSettings({
        announcementMode: "sometimes" as never,
      }).announcementMode,
    ).toBe("background");
  });

  it("does not share the mutable default object", () => {
    const settings = normalizeNotificationSettings();
    settings.announcementEnabled = false;

    expect(DEFAULT_NOTIFICATION_SETTINGS.announcementEnabled).toBe(true);
  });
});
