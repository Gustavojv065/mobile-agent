/**
 * Byte-level helpers for normalizing H.264 encoder output into an Annex-B
 * start-code stream and extracting SPS/PPS from the first key frame.
 *
 * These are the Node-testable mirror of the functions embedded verbatim in
 * `VIDEO_EXPORT_SCRIPT` (see video-recorder.ts). The in-page copy is the
 * runtime source of truth — keep the two implementations in sync.
 */

export type CsdMetadata = { spsHex: string; ppsHex: string };

export function readStartCode(bytes: Uint8Array, offset: number): 0 | 3 | 4 {
  if (
    offset + 3 < bytes.length &&
    bytes[offset] === 0 &&
    bytes[offset + 1] === 0 &&
    bytes[offset + 2] === 0 &&
    bytes[offset + 3] === 1
  ) {
    return 4;
  }
  if (
    offset + 2 < bytes.length &&
    bytes[offset] === 0 &&
    bytes[offset + 1] === 0 &&
    bytes[offset + 2] === 1
  ) {
    return 3;
  }
  return 0;
}

export function splitNals(annexB: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let i = 0;
  while (i < annexB.length) {
    const startCode = readStartCode(annexB, i);
    if (startCode === 0) {
      i += 1;
      continue;
    }
    const start = i + startCode;
    let end = start;
    while (end < annexB.length && readStartCode(annexB, end) === 0) end += 1;
    if (end > start) nals.push(annexB.subarray(start, end));
    i = end;
  }
  return nals;
}

export function toAnnexB(bytes: Uint8Array): Uint8Array {
  if (readStartCode(bytes, 0) > 0) return bytes;
  // Length-prefixed (AVCC) input: 4-byte big-endian length per NAL unit.
  const parts: Uint8Array[] = [];
  let i = 0;
  while (i + 4 <= bytes.length) {
    const length =
      (bytes[i] << 24) |
      (bytes[i + 1] << 16) |
      (bytes[i + 2] << 8) |
      bytes[i + 3];
    if (length <= 0 || i + 4 + length > bytes.length) break;
    parts.push(Uint8Array.from([0, 0, 0, 1]));
    parts.push(bytes.subarray(i + 4, i + 4 + length));
    i += 4 + length;
  }
  if (parts.length === 0) return bytes;
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function extractCsdFromAnnexB(annexB: Uint8Array): CsdMetadata | null {
  const nals = splitNals(annexB);
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  for (const nal of nals) {
    const type = nal.length > 0 ? nal[0] & 0x1f : 0;
    if (type === 7 && !sps) sps = nal;
    else if (type === 8 && !pps) pps = nal;
  }
  if (!sps || !pps) return null;
  return { spsHex: bytesToHex(sps), ppsHex: bytesToHex(pps) };
}

export function stripCsdFromAnnexB(annexB: Uint8Array): Uint8Array {
  const kept = splitNals(annexB).filter((nal) => {
    const type = nal.length > 0 ? nal[0] & 0x1f : 0;
    return type !== 7 && type !== 8;
  });
  const total = kept.reduce((sum, nal) => sum + nal.length + 4, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const nal of kept) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 1;
    offset += 4;
    out.set(nal, offset);
    offset += nal.length;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    const hex = bytes[i].toString(16);
    out += hex.length === 1 ? `0${hex}` : hex;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(
      String.fromCharCode.apply(
        null,
        Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))),
      ),
    );
  }
  return btoa(parts.join(""));
}