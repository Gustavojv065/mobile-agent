/**
 * Drawer state for OTA (expo-updates) bundles.
 *
 * expo-updates checks and downloads in the background at launch, then applies
 * the bundle on the next cold start — nothing for the user to approve. The
 * drawer is therefore an "already updated" notice only: it appears once this
 * session is running a downloaded bundle, never while one is still
 * transferring or waiting to be applied.
 *
 * The acknowledged id is persisted so the drawer shows once per update instead
 * of on every launch.
 */
export type OtaUiPhase = "hidden" | "applied";

export type OtaUiState = {
  /** Update id the user already pressed Done on (or `null` if never). */
  acknowledgedUpdateId: string | null;
  /** `Updates.isEnabled` — false in dev builds and on misconfigured installs. */
  enabled: boolean;
  isEmbeddedLaunch: boolean;
  /** Id of the OTA bundle this session is running, if not the embedded one. */
  updateId?: string | null;
};

export function getOtaUiPhase({
  acknowledgedUpdateId,
  enabled,
  isEmbeddedLaunch,
  updateId,
}: OtaUiState): OtaUiPhase {
  if (!enabled) return "hidden";

  const runningId = isEmbeddedLaunch ? null : (updateId ?? null);

  return runningId && runningId !== acknowledgedUpdateId ? "applied" : "hidden";
}
