import type { NotificationSettings } from "@/core/types/app-state";

export type AnnouncementKind = "finished" | "questions" | "permissions";

export type AnnouncementAppState =
  | "active"
  | "background"
  | "inactive"
  | "unknown"
  | "extension";

export type AnnouncementPlatform = "android" | "ios" | "web";

export const ANNOUNCEMENT_COOLDOWN_MS = 15_000;

const lastAnnouncedAt = new Map<string, number>();

export function resetAnnouncementCooldowns() {
  lastAnnouncedAt.clear();
}

function cooldownKey(
  conversationId: string,
  kind: AnnouncementKind,
): string {
  return `${conversationId}:${kind}`;
}

/**
 * Automatic announcements follow the user's settings. An explicit request
 * from the chat ("announce when done") bypasses every announcement setting.
 *
 * Physical constraints still win: never talk over voice input, never
 * interrupt existing speech, and let iOS keep its background-TTS restriction.
 */
export function isAnnouncementAllowed(input: {
  appState: AnnouncementAppState;
  kind: AnnouncementKind;
  force: boolean;
  platform: AnnouncementPlatform;
  settings: NotificationSettings;
  speechActive: boolean;
  voiceInputActive: boolean;
}): boolean {
  if (input.platform === "web") {
    return false;
  }

  if (input.voiceInputActive || input.speechActive) {
    return false;
  }

  if (!input.force) {
    if (!input.settings.announcementEnabled) {
      return false;
    }

    if (input.kind === "finished" && !input.settings.announceFinished) {
      return false;
    }

    if (input.kind === "questions" && !input.settings.announceQuestions) {
      return false;
    }

    if (input.kind === "permissions" && !input.settings.announcePermissions) {
      return false;
    }

    if (
      input.settings.announcementMode === "background" &&
      input.appState === "active"
    ) {
      return false;
    }
  }

  // iOS suspends JS audio once the app is not active. Speaking then can play
  // stale audio when the user unlocks the device, so the notification is the
  // only reliable fallback there.
  if (input.platform === "ios" && input.appState !== "active") {
    return false;
  }

  return true;
}

/** Claim the cooldown slot so a burst of triggers produces one utterance. */
export function claimAnnouncement(
  input: {
    appState: AnnouncementAppState;
    conversationId: string;
    kind: AnnouncementKind;
    force: boolean;
    platform: AnnouncementPlatform;
    settings: NotificationSettings;
    speechActive: boolean;
    voiceInputActive: boolean;
  },
  now = Date.now(),
): boolean {
  if (!isAnnouncementAllowed(input)) {
    return false;
  }

  const key = cooldownKey(input.conversationId, input.kind);
  const last = lastAnnouncedAt.get(key) ?? 0;

  if (now - last < ANNOUNCEMENT_COOLDOWN_MS) {
    return false;
  }

  lastAnnouncedAt.set(key, now);
  return true;
}

function stripNegatedRequests(text: string) {
  return text
    .replace(
      /\b(?:do not|don'?t|no need to)\s+(?:announce|notify|tell me|let me know|ping me|alert me)\b/gi,
      " ",
    )
    .replace(/\bi(?:'ll| will)\s+let you know\b/gi, " ");
}

/**
 * Conservative fallback for when the model does not call the
 * `announceWhenDone` tool. Only matches an explicit request to be told when
 * the work is finished, and rejects the common negations.
 */
export function detectExplicitAnnouncementRequest(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return false;
  }

  const withoutNegations = stripNegatedRequests(normalized);

  if (
    /\b(?:announce|notify me|let me know|tell me|ping me|alert me)\b[^.!?\n]{0,80}\b(?:when|once|after)\b[^.!?\n]{0,40}\b(?:done|ready|finish(?:ed|es)?|complete(?:d|s)?|end(?:s)?)\b/i.test(
      withoutNegations,
    )
  ) {
    return true;
  }

  return /\b(?:announce|notify me)\b[^.!?\n]{0,40}\b(?:done|ready|finish(?:ed|es)?|complete(?:d|s)?)\b/i.test(
    withoutNegations,
  );
}
