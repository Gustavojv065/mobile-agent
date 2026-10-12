/**
 * Minimal RIFF/WAVE (PCM) container writer.
 *
 * The system speech engine (see system-transcribe.ts) hands the recognizer a
 * *file* to transcribe, and `expo-speech-recognition` reads that file through
 * Android's `MediaExtractor`. The only format the library maintainer verified on
 * Android is "16000 Hz, 16-bit, 1-channel PCM WAV", which is exactly what the
 * hidden decode host already produces, so wrapping its output in a WAV header is
 * a lossless pass-through — and it lets `maxSeconds` trim the audio before the
 * recognizer ever sees it.
 *
 * Pure (no native imports) so it can be unit-tested in Node.
 */

const HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
const BLOCK_ALIGN = (CHANNELS * BITS_PER_SAMPLE) / 8;

function writeAscii(view: DataView, offset: number, text: string) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/**
 * Wraps mono signed 16-bit little-endian PCM in a minimal WAV container.
 * `samples` is written verbatim: 16-bit little-endian is what WAV expects and
 * what every Android/iOS React Native target already uses.
 */
export function encodeWavPcm16(
  samples: Int16Array,
  sampleRate: number,
): Uint8Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("A valid sample rate is required to build a WAV file.");
  }

  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size for PCM
  view.setUint16(20, 1, true); // PCM (uncompressed)
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BLOCK_ALIGN, true); // byte rate
  view.setUint16(32, BLOCK_ALIGN, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);

  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  new Uint8Array(buffer, HEADER_BYTES).set(
    new Uint8Array(samples.buffer as ArrayBuffer, samples.byteOffset, dataBytes),
  );

  return new Uint8Array(buffer);
}
