/**
 * `react-native-view-shot` resolves its TurboModule at import time
 * (`TurboModuleRegistry.getEnforcing`). Any static import of it — from the
 * root layout's host components, for example — turns a runtime without the
 * native module (an OTA bundle shipped against an older binary) into a
 * synchronous startup crash, not a tool error. Everything that captures a
 * view therefore goes through this lazy wrapper: the module is required on
 * first use, and a missing module degrades into a thrown, explained error
 * inside the calling job instead of crashing the app.
 */

import { File } from "expo-file-system";

type ViewShotModule = typeof import("react-native-view-shot");
let cached: ViewShotModule | null | undefined;

function getViewShot(): ViewShotModule | null {
  if (cached === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- static specifier so Metro bundles it; the require is the only way to catch a missing native module without crashing at import time.
      cached = require("react-native-view-shot") as ViewShotModule;
    } catch {
      cached = null;
    }
  }
  return cached;
}

/**
 * Captures a view to a cache-directory tmpfile, or throws an explained error
 * when the native view-shot module is unavailable (older binary without the
 * module). `what` names the feature in that message ("View screenshots",
 * "This download", ...).
 */
export async function captureViewToTmpFile(
  target: Parameters<ViewShotModule["captureRef"]>[0],
  options: Parameters<ViewShotModule["captureRef"]>[1],
  what = "View capture",
): Promise<string> {
  const viewShot = getViewShot();
  if (!viewShot) {
    throw new Error(
      `${what} is not available on this build (the native view-shot module is missing). Update the app to the latest native build.`,
    );
  }
  return viewShot.captureRef(target, options);
}

/**
 * A capture smaller than this holds no rendered page: a blank or
 * single-colour bitmap compresses to a few KB, a real page to far more.
 */
export const BLANK_CAPTURE_MAX_BYTES = 15_000;

/**
 * True when a captured file cannot hold a rendered page. Guards against
 * handing the agent a white rectangle: a view that never painted (or a
 * WebView whose content stayed on the GPU) still produces a valid PNG,
 * just an empty one.
 */
export function isBlankCapture(uri: string): boolean {
  try {
    const size = new File(uri).size ?? 0;
    return size < BLANK_CAPTURE_MAX_BYTES;
  } catch {
    // Unreadable file: unknown, not blank.
    return false;
  }
}
