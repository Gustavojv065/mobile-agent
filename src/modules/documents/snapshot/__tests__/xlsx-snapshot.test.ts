import { describe, expect, it } from "vitest";

import { parseXlsxSpec } from "@/modules/documents/spec/xlsx-spec";
import { snapshotXlsxSpec } from "@/modules/documents/snapshot/xlsx-snapshot";
import { buildXlsx } from "@/modules/documents/xlsx";

const TABLE = `| Item | Price | Share |
| --- | --- | --- |
| Widget | 1234.5 | 25% |
`;

describe("xlsx snapshot", () => {
  it("returns null for bytes that are not an xlsx package", async () => {
    expect(await snapshotXlsxSpec(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it("recovers the default styling of its own output", async () => {
    const bytes = await buildXlsx({
      content: TABLE,
      fileName: "default.xlsx",
      spec: parseXlsxSpec({}),
    });

    const snapshot = await snapshotXlsxSpec(bytes);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.header.fill).toEqual({ pattern: "solid", color: "F2F2F2" });
    expect(snapshot!.body.fill.pattern).toBe("none");
    expect(snapshot!.body.border.top.style).toBe("thin");
    expect(snapshot!.body.font.family).toBe("Calibri");
    expect(snapshot!.body.font.sizePt).toBe(11);
    expect(snapshot!.sheet.freezeHeaderRow).toBe(true);
    expect(snapshot!.sheet.autoFilter).toBe(true);
    expect(snapshot!.sheet.tabColor).toBe("4472C4");
  });

  it("recovers custom fonts, header style, columns and sheet setup", async () => {
    const spec = parseXlsxSpec({
      body: { font: { family: "Georgia", sizePt: 12, color: "333333" } },
      header: {
        fill: { color: "1F4E78" },
        font: { color: "FFFFFF", bold: true },
        alignment: { horizontal: "center" },
      },
      columns: [
        { width: 24 },
        { numberFormat: "#,##0.00" },
        { numberFormat: "0%" },
      ],
      sheet: {
        freezeHeaderRow: true,
        freezeColumns: 1,
        autoFilter: true,
        showGridLines: false,
        tabColor: "00B050",
        orientation: "landscape",
        paperSize: "LETTER",
        merges: ["A1:C1"],
      },
    });

    const bytes = await buildXlsx({
      content: TABLE,
      fileName: "styled.xlsx",
      spec,
    });

    const snapshot = await snapshotXlsxSpec(bytes);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.body.font.family).toBe("Georgia");
    expect(snapshot!.body.font.sizePt).toBe(12);
    expect(snapshot!.body.font.color).toBe("333333");

    expect(snapshot!.header.fill).toEqual({ pattern: "solid", color: "1F4E78" });
    expect(snapshot!.header.font.color).toBe("FFFFFF");
    expect(snapshot!.header.font.bold).toBe(true);
    expect(snapshot!.header.alignment.horizontal).toBe("center");

    expect(snapshot!.columns[0].width).toBe(24);
    expect(snapshot!.columns[1].numberFormat).toBe("#,##0.00");
    expect(snapshot!.columns[2].numberFormat).toBe("0%");

    expect(snapshot!.sheet.freezeHeaderRow).toBe(true);
    expect(snapshot!.sheet.freezeColumns).toBe(1);
    expect(snapshot!.sheet.autoFilter).toBe(true);
    expect(snapshot!.sheet.showGridLines).toBe(false);
    expect(snapshot!.sheet.tabColor).toBe("00B050");
    expect(snapshot!.sheet.orientation).toBe("landscape");
    expect(snapshot!.sheet.paperSize).toBe("LETTER");
    expect(snapshot!.sheet.merges).toEqual(["A1:C1"]);
  });

  it("produces a spec that regenerates a comparable workbook", async () => {
    const original = parseXlsxSpec({
      body: { font: { family: "Georgia", sizePt: 12 } },
      header: { fill: { color: "1F4E78" }, font: { color: "FFFFFF" } },
      columns: [{ width: 24 }, { numberFormat: "#,##0.00" }],
    });

    const first = await buildXlsx({
      content: TABLE,
      fileName: "roundtrip.xlsx",
      spec: original,
    });

    const snapshot = await snapshotXlsxSpec(first);
    const second = await buildXlsx({
      content: TABLE,
      fileName: "roundtrip.xlsx",
      spec: snapshot ?? original,
    });

    // Snapshotting the regenerated file should be stable.
    const stable = await snapshotXlsxSpec(second);
    expect(stable).toEqual(snapshot);
  });
});
