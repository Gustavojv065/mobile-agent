import { strFromU8, unzipSync } from "fflate";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { parseXlsxSpec } from "@/modules/documents/spec/xlsx-spec";
import { buildXlsx } from "@/modules/documents/xlsx";

const TABLE = `# Planets

| Planet | Moons |
| --- | --- |
| Jupiter | 95 |
| Saturn | 146 |
`;

function parts(bytes: Uint8Array): Record<string, string> {
  const zip = unzipSync(bytes);
  const output: Record<string, string> = {};

  for (const [name, data] of Object.entries(zip)) {
    output[name] = strFromU8(data);
  }

  return output;
}

function firstSheet(bytes: Uint8Array) {
  const workbook = XLSX.read(bytes, { type: "array" });
  const name = workbook.SheetNames[0]!;
  return { workbook, name, sheet: workbook.Sheets[name]! };
}

describe("xlsx writer", () => {
  it("writes a valid package with default styling", async () => {
    const bytes = await buildXlsx({
      content: TABLE,
      fileName: "planets.xlsx",
      spec: parseXlsxSpec({}),
    });

    expect(new TextDecoder().decode(bytes.subarray(0, 2))).toBe("PK");

    const { name, sheet } = firstSheet(bytes);
    expect(name).toBe("planets");
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
    expect(rows[0]).toEqual(["Planet", "Moons"]);
    expect(rows[1]).toEqual(["Jupiter", 95]);
    expect(rows[2]).toEqual(["Saturn", 146]);

    const xml = parts(bytes);
    expect(xml["xl/styles.xml"]).toContain("Calibri");
    expect(xml["xl/styles.xml"]).toContain("FFF2F2F2");
    expect(xml["xl/workbook.xml"]).toContain('name="planets"');
    expect(xml["xl/worksheets/sheet1.xml"]).toContain("<pane ");
    expect(xml["xl/worksheets/sheet1.xml"]).toContain(
      '<autoFilter ref="A1:B3"/>',
    );
  });

  it("applies custom fonts, header fill, borders and zebra stripes", async () => {
    const bytes = await buildXlsx({
      content: TABLE,
      fileName: "planets.xlsx",
      spec: parseXlsxSpec({
        body: { font: { family: "Georgia", sizePt: 12 } },
        header: {
          fill: { color: "#1f4e78" },
          font: { color: "FFFFFF", bold: true },
          alignment: { horizontal: "center" },
        },
        stripes: { enabled: true, fill: { color: "EEEEEE" } },
        sheet: { freezeHeaderRow: true, freezeColumns: 1 },
      }),
    });

    const styles = parts(bytes)["xl/styles.xml"]!;
    expect(styles).toContain("Georgia");
    expect(styles).toContain('val="12"');
    expect(styles).toContain("FF1F4E78");
    expect(styles).toContain("FFEEEEEE");
    expect(styles).toContain('horizontal="center"');
    expect(styles).toContain('style="thin"');

    const sheet = parts(bytes)["xl/worksheets/sheet1.xml"]!;
    expect(sheet).toContain('xSplit="1"');
    expect(sheet).toContain('ySplit="1"');
    expect(sheet).toContain('activePane="bottomRight"');
    expect(sheet).toContain('topLeftCell="B2"');
  });

  it("applies per-column widths and number formats", async () => {
    const bytes = await buildXlsx({
      content: `| Item | Price | Share | Date |
| --- | --- | --- | --- |
| Widget | 1234.5 | 25% | 2026-10-12 |
`,
      fileName: "sales.xlsx",
      spec: parseXlsxSpec({
        columns: [
          { width: 24 },
          { numberFormat: "#,##0.00", horizontal: "right" },
          { numberFormat: "0%" },
          { numberFormat: "yyyy-mm-dd" },
        ],
      }),
    });

    const { sheet } = firstSheet(bytes);
    expect(sheet.A2.v).toBe("Widget");
    expect(sheet.B2.v).toBe(1234.5);
    expect(sheet.C2.v).toBeCloseTo(0.25);
    // Date converted to an Excel serial number with a custom date format.
    expect(sheet.D2.t).toBe("n");
    expect(sheet.D2.v).toBe(Date.UTC(2026, 9, 12) / 86_400_000 + 25_569);

    const xml = parts(bytes);
    const styles = xml["xl/styles.xml"]!;
    // Built-in formats: 4 = #,##0.00, 9 = 0%.
    expect(styles).toContain('numFmtId="4"');
    expect(styles).toContain('numFmtId="9"');
    expect(styles).toContain('formatCode="yyyy-mm-dd"');
    expect(xml["xl/worksheets/sheet1.xml"]).toContain(
      '<col min="1" max="1" width="24" customWidth="1"/>',
    );
  });

  it("supports merges, page setup and multiple table sheets", async () => {
    const bytes = await buildXlsx({
      content: `${TABLE}

| Team | Wins |
| --- | --- |
| A | 3 |
`,
      fileName: "report.xlsx",
      spec: parseXlsxSpec({
        sheet: {
          orientation: "landscape",
          paperSize: "LETTER",
          merges: ["A1:B1"],
          fitToWidth: true,
        },
      }),
    });

    const xml = parts(bytes);
    const sheet1 = xml["xl/worksheets/sheet1.xml"]!;
    expect(sheet1).toContain('<mergeCell ref="A1:B1"/>');
    expect(sheet1).toContain('orientation="landscape"');
    expect(sheet1).toContain('paperSize="1"');
    expect(sheet1).toContain('fitToWidth="1"');
    expect(xml["xl/worksheets/sheet2.xml"]).toBeDefined();

    const workbook = XLSX.read(bytes, { type: "array" });
    // Two table sheets plus a "Notes" sheet for the non-table prose.
    expect(workbook.SheetNames.length).toBe(3);
  });

  it("parses delimited content into typed cells", async () => {
    const bytes = await buildXlsx({
      content: "name,score\nAda,10\nLin,9",
      fileName: "scores.xlsx",
      spec: parseXlsxSpec({}),
    });

    const { sheet } = firstSheet(bytes);
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
    expect(rows[0]).toEqual(["name", "score"]);
    expect(rows[1]).toEqual(["Ada", 10]);
  });

  it("falls back to a single content sheet for prose", async () => {
    const bytes = await buildXlsx({
      content: "# Notes\n\nBody text.",
      fileName: "notes.xlsx",
      spec: parseXlsxSpec({}),
    });

    const { sheet } = firstSheet(bytes);
    const csv = XLSX.utils.sheet_to_csv(sheet);
    expect(csv).toContain("Notes");
    expect(csv).toContain("Body text.");
  });
});
