import * as XLSX from "xlsx";

import { inlineRunsToPlainText, parseMarkdownBlocks } from "@/modules/documents/markdown";
import type { DocumentBlock } from "@/modules/documents/types";

const MAX_COLUMN_WIDTH = 60;
const MIN_COLUMN_WIDTH = 10;
const MAX_SHEET_NAME_LENGTH = 31;

function sanitizeSheetName(name: string, fallbackIndex: number) {
  const cleaned = (name || `Sheet${fallbackIndex}`)
    .replace(/[\\/?*[\]:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SHEET_NAME_LENGTH);

  return cleaned || `Sheet${fallbackIndex}`;
}

function columnWidths(rows: string[][]) {
  const columnCount = rows.reduce(
    (max, row) => Math.max(max, row.length),
    0,
  );

  return Array.from({ length: columnCount }, (_value, columnIndex) => {
    const width = rows.reduce((max, row) => {
      const length = (row[columnIndex] ?? "").length;
      return Math.max(max, length);
    }, MIN_COLUMN_WIDTH);

    return { wch: Math.min(MAX_COLUMN_WIDTH, width + 2) };
  });
}

function tableToSheet(table: Extract<DocumentBlock, { type: "table" }>) {
  const rows = [table.headers, ...table.rows];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = columnWidths(rows);
  return sheet;
}

function isDelimited(content: string) {
  const firstLine =
    content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";

  if (!firstLine || /^[#>*\-|]/.test(firstLine)) {
    return false;
  }

  return firstLine.includes(",") || firstLine.includes("\t");
}

function textToSheet(content: string) {
  const rows = [["Content"], ...content.split("\n").map((line) => [line])];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [{ wch: 80 }];
  return sheet;
}

function nonTableText(blocks: DocumentBlock[]) {
  return blocks
    .flatMap((block) => {
      if (block.type === "heading") {
        return [`${"#".repeat(block.level)} ${block.text}`];
      }

      if (block.type === "paragraph") {
        return [inlineRunsToPlainText(block.runs)];
      }

      if (block.type === "list") {
        return block.items.map((item) => inlineRunsToPlainText(item));
      }

      return [];
    })
    .filter(Boolean)
    .join("\n");
}

export async function buildXlsx(input: {
  content: string;
  fileName: string;
}): Promise<Uint8Array> {
  const workbook = XLSX.utils.book_new();
  const baseName = input.fileName.replace(/\.xlsx$/i, "");
  const blocks = parseMarkdownBlocks(input.content);
  const tables = blocks.filter(
    (block): block is Extract<DocumentBlock, { type: "table" }> =>
      block.type === "table",
  );

  if (tables.length > 0) {
    tables.forEach((table, index) => {
      const sheet = tableToSheet(table);
      const name = sanitizeSheetName(
        tables.length === 1 ? baseName : `${baseName} ${index + 1}`,
        index + 1,
      );
      XLSX.utils.book_append_sheet(workbook, sheet, name);
    });

    const prose = nonTableText(blocks);

    if (prose.trim()) {
      XLSX.utils.book_append_sheet(
        workbook,
        textToSheet(prose),
        sanitizeSheetName("Notes", tables.length + 1),
      );
    }
  } else if (isDelimited(input.content)) {
    const delimiter = input.content.includes("\t") ? "\t" : ",";
    const parsed = XLSX.read(input.content, { type: "string", FS: delimiter });
    const firstSheetName = parsed.SheetNames[0];
    const sheet = firstSheetName ? parsed.Sheets[firstSheetName] : undefined;

    if (sheet) {
      XLSX.utils.book_append_sheet(
        workbook,
        sheet,
        sanitizeSheetName(baseName, 1),
      );
    } else {
      XLSX.utils.book_append_sheet(
        workbook,
        textToSheet(input.content),
        sanitizeSheetName(baseName, 1),
      );
    }
  } else {
    XLSX.utils.book_append_sheet(
      workbook,
      textToSheet(input.content),
      sanitizeSheetName(baseName, 1),
    );
  }

  const output = XLSX.write(workbook, { type: "array", bookType: "xlsx" });

  if (output instanceof Uint8Array) {
    return output;
  }

  if (output instanceof ArrayBuffer) {
    return new Uint8Array(output);
  }

  if (Array.isArray(output)) {
    return Uint8Array.from(output as number[]);
  }

  throw new Error("Unexpected xlsx output format.");
}
