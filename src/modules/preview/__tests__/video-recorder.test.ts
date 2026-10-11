import { describe, expect, it } from "vitest";

import {
  buildVideoExportDocument,
  VIDEO_EXPORT_SCRIPT,
} from "@/modules/preview/video-recorder";
import {
  bytesToBase64,
  bytesToHex,
  extractCsdFromAnnexB,
  splitNals,
  stripCsdFromAnnexB,
  toAnnexB,
} from "@/modules/preview/h264-nals";

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("buildVideoExportDocument", () => {
  it("injects the recorder script before a lowercase closing body tag", () => {
    const document = buildVideoExportDocument("<html><body><p>x</p></body></html>");

    expect(document.match(/<script>/g)).toHaveLength(1);
    expect(document.match(/<\/script>/g)).toHaveLength(1);
    expect(document.indexOf(VIDEO_EXPORT_SCRIPT)).toBeGreaterThan(0);
    expect(document).toContain("<p>x</p>");
    expect(document.endsWith("</script>\n</body></html>")).toBe(true);
  });

  it("injects before an uppercase closing body tag", () => {
    const document = buildVideoExportDocument("<BODY><p>x</p></BODY>");

    expect(document.indexOf(VIDEO_EXPORT_SCRIPT)).toBeGreaterThan(0);
    expect(document).toContain("</BODY>");
  });

  it("appends the script when the document has no body tag", () => {
    const document = buildVideoExportDocument("<p>x</p>");

    expect(document.startsWith("<p>x</p>")).toBe(true);
    expect(document).toContain(VIDEO_EXPORT_SCRIPT);
  });
});

describe("toAnnexB", () => {
  it("passes Annex-B input through unchanged", () => {
    const input = Uint8Array.from([0, 0, 0, 1, 0x65, 0x01, 0x02]);

    expect(toAnnexB(input)).toEqual(input);
  });

  it("converts length-prefixed (AVCC) input into start codes", () => {
    const avcc = Uint8Array.from([
      0, 0, 0, 2, 0x65, 0x01,
      0, 0, 0, 3, 0x67, 0xaa, 0xbb,
    ]);
    const expected = Uint8Array.from([
      0, 0, 0, 1, 0x65, 0x01,
      0, 0, 0, 1, 0x67, 0xaa, 0xbb,
    ]);

    expect(toAnnexB(avcc)).toEqual(expected);
  });

  it("returns the input unchanged when no length header parses", () => {
    const garbage = Uint8Array.from([1, 2, 3, 4, 5]);

    expect(toAnnexB(garbage)).toEqual(garbage);
  });
});

describe("extractCsdFromAnnexB / stripCsdFromAnnexB", () => {
  const sps = Uint8Array.from([0x67, 0x42, 0x00, 0x1f, 0x96]);
  const pps = Uint8Array.from([0x68, 0xce, 0x3c, 0x80]);
  const idr = Uint8Array.from([0x65, 0x88, 0x84, 0x00]);
  const stream = concat([
    Uint8Array.from([0, 0, 0, 1]),
    sps,
    Uint8Array.from([0, 0, 0, 1]),
    pps,
    Uint8Array.from([0, 0, 0, 1]),
    idr,
  ]);

  it("splits the stream into its NAL units", () => {
    expect(splitNals(stream)).toHaveLength(3);
  });

  it("finds the SPS/PPS hex for the media format", () => {
    expect(extractCsdFromAnnexB(stream)).toEqual({
      spsHex: bytesToHex(sps),
      ppsHex: bytesToHex(pps),
    });
  });

  it("returns null when SPS or PPS is missing", () => {
    expect(
      extractCsdFromAnnexB(
        concat([Uint8Array.from([0, 0, 0, 1]), Uint8Array.from([0x65, 1])]),
      ),
    ).toBeNull();
  });

  it("strips SPS/PPS NAL units but keeps the slice data", () => {
    expect(stripCsdFromAnnexB(stream)).toEqual(
      Uint8Array.from([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00]),
    );
  });
});

describe("bytesToHex", () => {
  it("zero-pads single-digit bytes", () => {
    expect(bytesToHex(Uint8Array.from([0x67, 0x00, 0x09, 0x1f]))).toBe(
      "6700091f",
    );
  });
});

describe("bytesToBase64", () => {
  it("round-trips with Node's base64 for large buffers", () => {
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;

    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});