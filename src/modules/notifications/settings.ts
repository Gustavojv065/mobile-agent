import type { NotificationSettings } from "@/core/types/app-state";

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  approvalRequests: true,
  runFinished: true,
  questionRequests: true,
  announcementEnabled: true,
  announcementMode: "background",
  announceFinished: true,
  announceQuestions: true,
  announcePermissions: true,
};

/**
 * Notification settings are persisted as a single JSON blob. Older installs
 * only have the two notification toggles, so every read fills in the
 * announcement fields with their defaults instead of treating them as off.
 */
export function normalizeNotificationSettings(
  input?: Partial<NotificationSettings> | null,
): NotificationSettings {
  // Question/secret alerts are new. For an existing install, follow whatever
  // the user already chose for notifications instead of re-enabling alerts
  // they had turned off. Fresh installs default to on.
  const legacyNotificationsEnabled =
    !input ||
    input.approvalRequests !== false ||
    input.runFinished !== false;
  const questionRequests =
    typeof input?.questionRequests === "boolean"
      ? input.questionRequests
      : legacyNotificationsEnabled;

  return {
    approvalRequests: input?.approvalRequests !== false,
    runFinished: input?.runFinished !== false,
    questionRequests,
    announcementEnabled: input?.announcementEnabled !== false,
    announcementMode:
      input?.announcementMode === "always" ? "always" : "background",
    announceFinished: input?.announceFinished !== false,
    announceQuestions: input?.announceQuestions !== false,
    announcePermissions: input?.announcePermissions !== false,
  };
}
