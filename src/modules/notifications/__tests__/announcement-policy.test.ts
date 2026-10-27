import { beforeEach, describe, expect, it } from "vitest";

import type { NotificationSettings } from "@/core/types/app-state";

import {
  ANNOUNCEMENT_COOLDOWN_MS,
  claimAnnouncement,
  detectExplicitAnnouncementRequest,
  isAnnouncementAllowed,
  resetAnnouncementCooldowns,
  type AnnouncementAppState,
  type AnnouncementKind,
} from "../announcement-policy";
import { normalizeNotificationSettings } from "../settings";

const baseSettings: NotificationSettings = {
  ...normalizeNotificationSettings(),
  announceFinished: true,
  announcePermissions: true,
  announceQuestions: true,
};

function allowed(
  overrides: Partial<{
    appState: AnnouncementAppState;
    force: boolean;
    kind: AnnouncementKind;
    platform: "android" | "ios" | "web";
    settings: NotificationSettings;
    speechActive: boolean;
    voiceInputActive: boolean;
  }> = {},
) {
  return isAnnouncementAllowed({
    appState: "background",
    force: false,
    kind: "finished",
    platform: "android",
    settings: baseSettings,
    speechActive: false,
    voiceInputActive: false,
    ...overrides,
  });
}

describe("announcement policy", () => {
  beforeEach(() => {
    resetAnnouncementCooldowns();
  });

  it("honors the automatic settings", () => {
    expect(allowed()).toBe(true);
    expect(
      allowed({
        settings: { ...baseSettings, announcementEnabled: false },
      }),
    ).toBe(false);
    expect(
      allowed({
        appState: "active",
        settings: { ...baseSettings, announcementMode: "background" },
      }),
    ).toBe(false);
    expect(
      allowed({
        appState: "active",
        settings: { ...baseSettings, announcementMode: "always" },
      }),
    ).toBe(true);
    expect(
      allowed({
        settings: { ...baseSettings, announceFinished: false },
      }),
    ).toBe(false);
    expect(
      allowed({
        kind: "questions",
        settings: { ...baseSettings, announceQuestions: false },
      }),
    ).toBe(false);
    expect(
      allowed({
        kind: "permissions",
        settings: { ...baseSettings, announcePermissions: false },
      }),
    ).toBe(false);
  });

  it("lets an explicit request override every announcement setting", () => {
    expect(
      allowed({
        appState: "active",
        force: true,
        settings: {
          ...baseSettings,
          announcementEnabled: false,
          announcementMode: "background",
          announceFinished: false,
        },
      }),
    ).toBe(true);
  });

  it("still respects voice input, playback, web, and iOS background", () => {
    expect(allowed({ force: true, voiceInputActive: true })).toBe(false);
    expect(allowed({ force: true, speechActive: true })).toBe(false);
    expect(allowed({ force: true, platform: "web" })).toBe(false);
    expect(
      allowed({ force: true, platform: "ios", appState: "background" }),
    ).toBe(false);
    expect(
      allowed({ force: true, platform: "ios", appState: "active" }),
    ).toBe(true);
  });

  it("coalesces bursts for the same conversation and kind", () => {
    const now = Date.now();
    const input = {
      appState: "background" as const,
      conversationId: "chat-1",
      force: true,
      kind: "finished" as const,
      platform: "android" as const,
      settings: baseSettings,
      speechActive: false,
      voiceInputActive: false,
    };

    expect(claimAnnouncement(input, now)).toBe(true);
    expect(claimAnnouncement(input, now + 1_000)).toBe(false);
    expect(
      claimAnnouncement(input, now + ANNOUNCEMENT_COOLDOWN_MS + 1),
    ).toBe(true);
    expect(
      claimAnnouncement({ ...input, kind: "questions" }, now + 1_100),
    ).toBe(true);
  });
});

describe("explicit announcement detection", () => {
  it.each([
    "Refactor the parser and announce when you're done.",
    "Let me know when you're finished.",
    "Tell me when it's complete.",
    "notify me when the build finishes",
    "Let me know when it's ready.",
    "announce when done",
    "Don't forget to announce when done.",
    "Can you tell me when the task is done?",
  ])("matches %s", (text) => {
    expect(detectExplicitAnnouncementRequest(text)).toBe(true);
  });

  it.each([
    "Don't announce when done.",
    "Do not notify me when finished.",
    "No need to tell me when it's complete.",
    "I'll let you know when done.",
    "Refactor the parser.",
    "",
  ])("rejects %s", (text) => {
    expect(detectExplicitAnnouncementRequest(text)).toBe(false);
  });
});
