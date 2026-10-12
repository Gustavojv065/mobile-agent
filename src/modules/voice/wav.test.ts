import { describe, expect, it } from "vitest";

import { encodeWavPcm16 } from "./wav";

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function u32(bytes: Uint8Array, offset: number) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true);
}

function u16(bytes: Uint8Array, offset: number) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint16(offset, true);
}

describe("encodeWavPcm16", () => {
  it("writes a valid mono 16-bit PCM header", () => {
    const samples = new Int16Array(8000);
    const bytes = encodeWavPcm16(samples, 16000);

    expect(bytes.byteLength).toBe(44 + 8000 * 2);
    expect(ascii(bytes, 0, 4)).toBe("RIFF");
    expect(u32(bytes, 4)).toBe(36 + 8000 * 2);
    expect(ascii(bytes, 8, 4)).toBe("WAVE");
    expect(ascii(bytes, 12, 4)).toBe("fmt ");
    expect(u32(bytes, 16)).toBe(16); // fmt chunk size
    expect(u16(bytes, 20)).toBe(1); // PCM
    expect(u16(bytes, 22)).toBe(1); // mono
    expect(u32(bytes, 24)).toBe(16000); // sample rate
    expect(u32(bytes, 28)).toBe(32000); // byte rate
    expect(u16(bytes, 32)).toBe(2); // block align
    expect(u16(bytes, 34)).toBe(16); // bits per sample
    expect(ascii(bytes, 36, 4)).toBe("data");
    expect(u32(bytes, 40)).toBe(8000 * 2);
  });

  it("copies the samples verbatim as little-endian", () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768]);
    const bytes = encodeWavPcm16(samples, 16000);
    const payload = bytes.slice(44);

    expect(new Int16Array(payload.buffer)).toEqual(samples);
    // -1 as little-endian bytes, proving the order rather than the platform.
    expect(Array.from(payload.slice(4, 6))).toEqual([0xff, 0xff]);
  });

  it("honors the sample rate in the header", () => {
    const bytes = encodeWavPcm16(new Int16Array(0), 8000);
    expect(bytes.byteLength).toBe(44);
    expect(u32(bytes, 24)).toBe(8000);
    expect(u32(bytes, 28)).toBe(16000);
  });

  it("rejects an invalid sample rate", () => {
    expect(() => encodeWavPcm16(new Int16Array(1), 0)).toThrow(/sample rate/);
    expect(() => encodeWavPcm16(new Int16Array(1), NaN)).toThrow(/sample rate/);
  });
});
