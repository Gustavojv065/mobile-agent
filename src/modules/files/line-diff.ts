/**
 * Bounded line diff for tool-trace rows: "what was added, what was removed"
 * for a single `edit` call. Skips oversized files and caps the emitted hunks
 * so a big rewrite can never ship a giant string into message metadata.
 */

const MAX_DIFF_LINES = 500;
const HUNK_CONTEXT_LINES = 3;
const MAX_HUNKS = 8;
const MAX_DIFF_CHARS = 2000;

export type LineDiffCounts = {
  added: number;
  removed: number;
};

export type LineDiff = LineDiffCounts & {
  hunkCount: number;
  /**
   * Unified-style `@@`-prefixed hunks with a few context lines each; `+`added,
   * `-`removed. Empty when nothing was emitted.
   */
  hunkText: string;
  /** `true` when the diff hit a cap and doesn't show the whole edit. */
  truncated: boolean;
};

export function buildLineDiff(before: string, after: string): LineDiff | null {
  if (before === after) {
    return null;
  }

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  if (
    beforeLines.length > MAX_DIFF_LINES ||
    afterLines.length > MAX_DIFF_LINES
  ) {
    return null;
  }

  const ops = diffOps(beforeLines, afterLines);
  const hunks = groupHunks(ops);

  if (hunks.length === 0) {
    return null;
  }

  // Full-edit counts, taken over every hunk before any emission cap: the stat
  // on the row describes the whole edit even when hunks are truncated.
  const added = hunks.reduce((total, hunk) => total + hunk.added, 0);
  const removed = hunks.reduce((total, hunk) => total + hunk.removed, 0);

  const lines: string[] = [];
  let emitted = 0;
  let truncated = false;

  for (const hunk of hunks) {
    const hunkLines = formatHunk(hunk);

    if (
      emitted >= MAX_HUNKS ||
      lines.join("\n").length + hunkLines.join("\n").length > MAX_DIFF_CHARS
    ) {
      truncated = true;
      break;
    }

    lines.push(...hunkLines);
    emitted += 1;
  }

  if (emitted < hunks.length) {
    const hidden = hunks.slice(emitted);
    lines.push(
      `… ${hidden.reduce((total, hunk) => total + hunk.added, 0)} more added and ` +
        `${hidden.reduce((total, hunk) => total + hunk.removed, 0)} more removed lines not shown`,
    );
    truncated = true;
  }

  return {
    added,
    removed,
    hunkCount: hunks.length,
    hunkText: lines.join("\n"),
    truncated,
  };
}

type DiffOp = {
  kind: "add" | "del" | "keep";
  text: string;
};

function diffOps(beforeLines: string[], afterLines: string[]): DiffOp[] {
  const rows = beforeLines.length;
  const columns = afterLines.length;

  // Longest-common-subsequence table over lines; largest edits accepted are
  // 2 × MAX_DIFF_LINES² cells (~250k Uint32) which stays constant-time-ish.
  const table: Uint32Array[] = [];
  for (let i = 0; i <= rows; i += 1) {
    table.push(new Uint32Array(columns + 1));
  }
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      table[i][j] =
        beforeLines[i] === afterLines[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (beforeLines[i] === afterLines[j]) {
      ops.push({ kind: "keep", text: beforeLines[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: "del", text: beforeLines[i] });
      i += 1;
    } else {
      ops.push({ kind: "add", text: afterLines[j] });
      j += 1;
    }
  }
  while (i < rows) {
    ops.push({ kind: "del", text: beforeLines[i] });
    i += 1;
  }
  while (j < columns) {
    ops.push({ kind: "add", text: afterLines[j] });
    j += 1;
  }

  return ops;
}

type Hunk = {
  beforeStart: number;
  operations: DiffOp[];
  added: number;
  removed: number;
};

/**
 * Groups the op sequence into hunks: each run of changes surrounded by a few
 * context lines, merging neighbours closer than 2 × context apart.
 */
function groupHunks(ops: DiffOp[]): Hunk[] {
  const changeIndexes = ops
    .map((op, index) => (op.kind === "keep" ? -1 : index))
    .filter((index) => index >= 0);

  if (changeIndexes.length === 0) {
    return [];
  }

  const clusters: [number, number][] = [];
  let first = changeIndexes[0];
  let last = changeIndexes[0];
  for (const index of changeIndexes.slice(1)) {
    if (index - last <= HUNK_CONTEXT_LINES * 2) {
      last = index;
    } else {
      clusters.push([first, last]);
      first = index;
      last = index;
    }
  }
  clusters.push([first, last]);

  const delOrKeepBefore = (index: number) =>
    ops.slice(0, index).filter((op) => op.kind !== "add").length;

  return clusters.map(([clusterFirst, clusterLast]) => {
    // Walk back over contiguous "keep" lines only.
    let hunkStart = clusterFirst;
    let context = 0;
    while (hunkStart > 0 && context < HUNK_CONTEXT_LINES) {
      if (ops[hunkStart - 1].kind !== "keep") {
        break;
      }
      hunkStart -= 1;
      context += 1;
    }

    let hunkEnd = clusterLast;
    context = 0;
    while (hunkEnd < ops.length - 1 && context < HUNK_CONTEXT_LINES) {
      if (ops[hunkEnd + 1].kind !== "keep") {
        break;
      }
      hunkEnd += 1;
      context += 1;
    }

    const operations = ops.slice(hunkStart, hunkEnd + 1);

    return {
      added: operations.filter((op) => op.kind === "add").length,
      beforeStart: delOrKeepBefore(hunkStart) + 1,
      operations,
      removed: operations.filter((op) => op.kind === "del").length,
    };
  });
}

function formatHunk(hunk: Hunk): string[] {
  const lines = [`@@ line ${hunk.beforeStart} @@`];

  for (const op of hunk.operations) {
    if (op.kind === "add") {
      lines.push(`+${op.text}`);
    } else if (op.kind === "del") {
      lines.push(`-${op.text}`);
    } else {
      lines.push(` ${op.text}`);
    }
  }

  return lines;
}

/** Counts of `+`/`-` content lines across a rendered diff string. */
export function countDiffLines(diff: string): LineDiffCounts {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}
