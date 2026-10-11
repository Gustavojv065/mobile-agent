import { describe, expect, it } from "vitest";

import {
  defaultXlsxSpec,
  parseXlsxSpec,
} from "@/modules/documents/spec/xlsx-spec";

describe("xlsx spec", () => {
  it("resolves full defaults for an empty spec", () => {
    const spec = parseXlsxSpec({});

    expect(spec.sheet).toMatchObject({
      defaultColumnWidth: 12,
      showGridLines: true,
      freezeHeaderRow: true,
      autoFilter: true,
      orientation: "portrait",
      paperSize: "A4",
      merges: [],
    });
    expect(spec.body.font).toMatchObject({ family: "Calibri", sizePt: 11 });
    expect(spec.header.font.bold).toBe(true);
    expect(spec.header.fill).toEqual({ pattern: "solid", color: "F2F2F2" });
    expect(spec.body.numberFormat).toBe("General");
    expect(spec.stripes.enabled).toBe(false);
    expect(spec.columns).toEqual([]);
  });

  it("defaults match the exported defaultXlsxSpec", () => {
    expect(parseXlsxSpec({})).toEqual(defaultXlsxSpec());
  });

  it("merges partial specs onto defaults", () => {
    const spec = parseXlsxSpec({
      body: { font: { family: "Georgia", sizePt: 12 } },
      header: { fill: { color: "#1f4e78" } },
      sheet: { orientation: "landscape" },
    });

    expect(spec.body.font.family).toBe("Georgia");
    expect(spec.body.font.sizePt).toBe(12);
    // Untouched font fields survive the merge.
    expect(spec.body.font.color).toBe("000000");
    expect(spec.header.fill.color).toBe("1F4E78");
    expect(spec.sheet.orientation).toBe("landscape");
    expect(spec.sheet.paperSize).toBe("A4");
  });

  it("keeps per-column overrides sparse", () => {
    const spec = parseXlsxSpec({
      columns: [{ width: 30, numberFormat: "#,##0.00" }, { headerFill: "FFFF00" }],
    });

    expect(spec.columns).toHaveLength(2);
    expect(spec.columns[0]).toMatchObject({
      width: 30,
      numberFormat: "#,##0.00",
    });
    expect(spec.columns[1].headerFill).toBe("FFFF00");
    expect(spec.columns[1].width).toBeUndefined();
  });

  it("rejects invalid specs with a clear message", () => {
    expect(() => parseXlsxSpec({ sheet: { orientation: "diagonal" } })).toThrow(
      /Invalid xlsx spec/,
    );
    expect(() =>
      parseXlsxSpec({ colors: "red" }),
    ).not.toThrow(); // unknown keys are stripped
  });

  it("normalizes colors by stripping # and uppercasing", () => {
    const spec = parseXlsxSpec({ body: { fill: { color: "#abcdef" } } });
    expect(spec.body.fill.color).toBe("ABCDEF");
  });
});
