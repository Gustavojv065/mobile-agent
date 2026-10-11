import PptxGenJS from "pptxgenjs";

import { parseMarkdownBlocks } from "@/modules/documents/markdown";
import type { DocumentBlock, InlineRun } from "@/modules/documents/types";

const CODE_FONT = "Courier New";

type SlidePlan = {
  blocks: DocumentBlock[];
  title: string;
};

function runsToTextObjects(
  runs: InlineRun[],
  options: {
    bullet?: boolean;
    breakLine?: boolean;
    isLast?: boolean;
  } = {},
) {
  const usable = runs.filter((run) => run.text.length > 0);
  const effective = usable.length > 0 ? usable : [{ text: " " }];

  return effective.map((run, index) => ({
    text: run.text,
    options: {
      bold: run.bold,
      italic: run.italic,
      fontFace: run.code ? CODE_FONT : undefined,
      bullet: options.bullet && index === 0 ? true : undefined,
      breakLine:
        (options.breakLine ?? true) && index === effective.length - 1
          ? true
          : false,
    },
  }));
}

function bodyItemsForBlocks(blocks: DocumentBlock[]) {
  const items: { options: Record<string, unknown>; text: string }[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "heading": {
        const runs: InlineRun[] = [{ text: block.text, bold: true }];
        items.push(
          ...runsToTextObjects(runs, { breakLine: true }).map((item) => ({
            text: item.text,
            options: { ...item.options, indentLevel: 0 },
          })),
        );
        break;
      }
      case "paragraph":
        items.push(
          ...runsToTextObjects(block.runs).map((item) => ({
            text: item.text,
            options: item.options,
          })),
        );
        break;
      case "list":
        block.items.forEach((item, index) => {
          const runs: InlineRun[] = block.ordered
            ? [{ text: `${index + 1}. ` }, ...item]
            : item;
          items.push(
            ...runsToTextObjects(runs, {
              bullet: !block.ordered,
              breakLine: true,
            }).map((entry) => ({
              text: entry.text,
              options: entry.options,
            })),
          );
        });
        break;
      case "code":
        block.text.split("\n").forEach((line) => {
          items.push({
            text: line || " ",
            options: { fontFace: CODE_FONT, breakLine: true },
          });
        });
        break;
      case "table":
      case "pageBreak":
        break;
      default:
        break;
    }
  }

  return items;
}

function collectTables(blocks: DocumentBlock[]) {
  return blocks.filter(
    (block): block is Extract<DocumentBlock, { type: "table" }> =>
      block.type === "table",
  );
}

function planSlides(
  blocks: DocumentBlock[],
  defaultTitle: string,
): SlidePlan[] {
  const slides: SlidePlan[] = [];
  let current: SlidePlan = { title: defaultTitle, blocks: [] };
  let started = false;

  const push = () => {
    if (current.blocks.length > 0 || current.title !== defaultTitle) {
      slides.push(current);
    }
  };

  for (const block of blocks) {
    if (block.type === "heading" && block.level <= 2) {
      if (started) {
        push();
      }

      current = { title: block.text, blocks: [] };
      started = true;
      continue;
    }

    if (block.type === "pageBreak") {
      push();
      current = { title: current.title, blocks: [] };
      started = true;
      continue;
    }

    started = true;
    current.blocks.push(block);
  }

  slides.push(current);

  return slides.filter(
    (slide) => slide.blocks.length > 0 || slide.title !== defaultTitle,
  );
}

function bodyFontSize(itemCount: number) {
  if (itemCount <= 5) {
    return 18;
  }

  if (itemCount <= 9) {
    return 15;
  }

  return 12;
}

export async function buildPptx(input: {
  content: string;
  fileName: string;
}): Promise<Uint8Array> {
  const blocks = parseMarkdownBlocks(input.content);
  const defaultTitle = input.fileName.replace(/\.pptx$/i, "");
  const slides = planSlides(blocks, defaultTitle);
  const plan = slides.length > 0 ? slides : [{ title: defaultTitle, blocks: [] }];

  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.title = defaultTitle;

  for (const slidePlan of plan) {
    const slide = pptx.addSlide();

    slide.addText(slidePlan.title || defaultTitle, {
      x: 0.5,
      y: 0.3,
      w: 9,
      h: 0.9,
      fontSize: 28,
      bold: true,
      color: "1A1A1A",
      valign: "middle",
    });

    const items = bodyItemsForBlocks(slidePlan.blocks);

    if (items.length > 0) {
      slide.addText(items, {
        x: 0.6,
        y: 1.35,
        w: 8.8,
        h: 4,
        fontSize: bodyFontSize(items.length),
        color: "333333",
        valign: "top",
      });
    }

    for (const table of collectTables(slidePlan.blocks)) {
      const tableSlide = pptx.addSlide();
      tableSlide.addText(`${slidePlan.title} - table`, {
        x: 0.5,
        y: 0.3,
        w: 9,
        h: 0.8,
        fontSize: 20,
        bold: true,
        color: "1A1A1A",
      });
      const rows = [table.headers, ...table.rows].map((row, rowIndex) =>
        table.headers.map((_header, columnIndex) => ({
          text: row[columnIndex]?.trim() ?? "",
          options: rowIndex === 0 ? { bold: true, fill: { color: "E8E8E8" } } : {},
        })),
      );
      tableSlide.addTable(rows, {
        x: 0.5,
        y: 1.3,
        w: 9,
        fontSize: 12,
        border: { pt: 0.5, color: "BFBFBF" },
      });
    }
  }

  const output = await pptx.write({ outputType: "uint8array" });

  if (output instanceof Uint8Array) {
    return output;
  }

  if (output instanceof ArrayBuffer) {
    return new Uint8Array(output);
  }

  throw new Error("Unexpected pptx output format.");
}
