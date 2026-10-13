import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

export type LocalTtsVoice = {
  /** BCP-47 tag such as "en-US". */
  locale: string;
  name: string;
  /** `Voice.QUALITY_*` (500 very high … 100 very low). */
  quality: number;
  /** `Voice.LATENCY_*` (500 very high … 100 very low). */
  latency: number;
  networkRequired: boolean;
};

export type LocalTtsSynthesis = {
  /** `file://` URI of the rendered WAV in the app cache. */
  uri: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
};

export type LocalTtsSynthesizeOptions = {
  /** BCP-47 tag such as "en" or "es-ES". Omit for the device default. */
  language?: string;
  /** 0.25–4, default 1. */
  rate?: number;
  /** 0.25–4, default 1. */
  pitch?: number;
};

export type LocalTtsNativeModule = {
  getVoices(): Promise<LocalTtsVoice[]>;
  synthesize(
    text: string,
    options?: LocalTtsSynthesizeOptions,
  ): Promise<LocalTtsSynthesis>;
};

const LocalTts =
  Platform.OS === "android"
    ? requireOptionalNativeModule<LocalTtsNativeModule>("LocalTts")
    : null;

export function getLocalTtsModule(): LocalTtsNativeModule | null {
  return LocalTts;
}
