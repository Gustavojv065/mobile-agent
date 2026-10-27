import { describe, expect, it } from "vitest";

import {
  joinSharedText,
  mergeSelectedFileIds,
  toImportAssets,
  type SharedContent,
} from "@/modules/share/shared-content";

function shared(overrides: Partial<SharedContent> = {}): SharedContent {
  return {
    text: null,
    subject: null,
    type: null,
    files: [],
    ...overrides,
  };
}

describe("toImportAssets", () => {
  it("maps native files to picker-compatible assets", () => {
    const assets = toImportAssets([
      shared({
        files: [
          {
            uri: "file:///cache/share-inbox/a/photo.jpg",
            name: "photo.jpg",
            mimeType: "image/jpeg",
            size: 2_048,
          },
        ],
      }),
    ]);

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      uri: "file:///cache/share-inbox/a/photo.jpg",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      size: 2_048,
    });
    expect(typeof assets[0]?.lastModified).toBe("number");
  });

  it("drops unknown sizes and mimes instead of sending null downstream", () => {
    const assets = toImportAssets([
      shared({
        files: [
          {
            uri: "file:///cache/share-inbox/a/archive.zip",
            name: "archive.zip",
            mimeType: null,
            size: null,
          },
        ],
      }),
    ]);

    expect(assets[0]).not.toHaveProperty("mimeType");
    expect(assets[0]).not.toHaveProperty("size");
  });

  it("deduplicates the same stream coming from EXTRA_STREAM and ClipData", () => {
    const file = {
      uri: "file:///cache/share-inbox/a/photo.jpg",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      size: 100,
    };

    expect(
      toImportAssets([shared({ files: [file] }), shared({ files: [file] })]),
    ).toHaveLength(1);
  });

  it("falls back to a generated name when the provider sends none", () => {
    const assets = toImportAssets([
      shared({
        files: [
          {
            uri: "file:///cache/share-inbox/a/unnamed",
            name: "  ",
            mimeType: null,
            size: null,
          },
        ],
      }),
    ]);

    expect(assets[0]?.name).toBe("shared-file-1");
  });

  it("keeps files from a multi-share in order", () => {
    const assets = toImportAssets([
      shared({
        files: [
          {
            uri: "file:///cache/share-inbox/a/one.pdf",
            name: "one.pdf",
            mimeType: "application/pdf",
            size: 1,
          },
          {
            uri: "file:///cache/share-inbox/b/two.pdf",
            name: "two.pdf",
            mimeType: "application/pdf",
            size: 2,
          },
        ],
      }),
    ]);

    expect(assets.map((asset) => asset.name)).toEqual(["one.pdf", "two.pdf"]);
  });
});

describe("joinSharedText", () => {
  it("trims, drops blanks, and joins multiple shares", () => {
    expect(
      joinSharedText([
        shared({ text: "  https://example.com/article  " }),
        shared({ text: "look at this" }),
        shared({ text: "   " }),
      ]),
    ).toBe("https://example.com/article\n\nlook at this");
  });

  it("does not repeat identical text", () => {
    expect(
      joinSharedText([
        shared({ text: "same" }),
        shared({ text: "same" }),
      ]),
    ).toBe("same");
  });

  it("returns null when no payload has text", () => {
    expect(joinSharedText([shared()])).toBeNull();
  });
});

describe("mergeSelectedFileIds", () => {
  it("appends without dropping or duplicating ids", () => {
    expect(mergeSelectedFileIds(["a", "b"], ["b", "c"])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("ignores empty ids", () => {
    expect(mergeSelectedFileIds([], ["", "a"])).toEqual(["a"]);
  });
});
