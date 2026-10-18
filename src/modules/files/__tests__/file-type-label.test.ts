import { describe, expect, it } from "vitest";

import { formatFileKindLabel } from "@/modules/files/file-type-label";

describe("formatFileKindLabel", () => {
  it("reads the extension first — exporters label mimes untrustworthy", () => {
    expect(
      formatFileKindLabel({
        displayName: "report.docx",
        mimeType: "application/octet-stream",
      }),
    ).toBe("Word document");
    expect(
      formatFileKindLabel({ displayName: "photo.heic", mimeType: null }),
    ).toBe("HEIC image");
  });

  it("labels the vendor mime soup people cannot read", () => {
    const cases: Array<[string, string]> = [
      [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Word document",
      ],
      [
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "PowerPoint presentation",
      ],
      [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Excel spreadsheet",
      ],
      ["application/vnd.oasis.opendocument.text", "OpenDocument text"],
      ["application/x-abiword", "AbiWord document"],
    ];

    for (const [mimeType, expected] of cases) {
      expect(
        formatFileKindLabel({ displayName: "file", mimeType }),
      ).toBe(expected);
    }
  });

  it("matches vendor patterns even when the exact id varies", () => {
    expect(
      formatFileKindLabel({
        displayName: "notes",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      }),
    ).toBe("Word document");
  });

  it("knows exact mimes when the file has no usable extension", () => {
    expect(
      formatFileKindLabel({ displayName: "notes", mimeType: "text/markdown" }),
    ).toBe("Markdown");
    expect(
      formatFileKindLabel({
        displayName: "download",
        mimeType: "application/pdf",
      }),
    ).toBe("PDF document");
  });

  it("strips mime parameters like charset", () => {
    expect(
      formatFileKindLabel({
        displayName: " plain",
        mimeType: "text/plain; charset=utf-8",
      }),
    ).toBe("Text file");
  });

  it("falls back to family labels without ever printing a mime type", () => {
    for (const [mimeType, expected] of [
      ["video/x-nonsense-codec", "Video file"],
      ["audio/x-nonsense-codec", "Audio file"],
      ["model/gltf-binary", "File"],
      ["application/x-some-tool", "File"],
      ["*/*", "Unknown type"],
      [null, "Unknown type"],
    ] as Array<[string | null, string]>) {
      const label = formatFileKindLabel({
        displayName: "imported-file",
        mimeType,
      });
      expect(label).toBe(expected);
      expect(label).not.toMatch(/\//);
    }
  });

  it("is case-insensitive and tolerant to whitespace", () => {
    expect(
      formatFileKindLabel({
        displayName: "report.PDF",
        mimeType: "Application/PDF",
      }),
    ).toBe("PDF document");
  });
});
