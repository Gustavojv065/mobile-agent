/**
 * On-device OCR via the expo-text-extractor native module (Google ML Kit on
 * Android, Apple Vision on iOS). The module is imported lazily and guarded:
 * on a build that does not include the native module (for example Expo Go or
 * a development build created before the dependency was added) importing it
 * throws, and we surface a readable error instead of crashing.
 */
export type OcrRecognition = {
  available: boolean;
  lines: string[];
  reason?: string;
  text: string;
};

export async function recognizeImageText(uri: string): Promise<OcrRecognition> {
  let module: typeof import("expo-text-extractor");

  try {
    module = await import("expo-text-extractor");
  } catch (error) {
    return {
      available: false,
      lines: [],
      reason: `On-device OCR is not available in this build (${error instanceof Error ? error.message : String(error)}). Rebuild the app with the expo-text-extractor native module to use OCR.`,
      text: "",
    };
  }

  if (!module.isSupported) {
    return {
      available: false,
      lines: [],
      reason: "On-device OCR is not supported on this device.",
      text: "",
    };
  }

  const lines = await module.extractTextFromImage(uri);

  return {
    available: true,
    lines,
    text: lines.join("\n"),
  };
}