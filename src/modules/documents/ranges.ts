export type IndexRange = {
  /** Inclusive first index of the range. */
  end: number;
  /** Inclusive last index of the range. */
  start: number;
};

/**
 * Parse an index-range spec such as "1-3,5,7-9", "2", "1-", "-3" or "all" into
 * inclusive ranges validated against `itemCount` items. `label` names the unit
 * for error messages ("page", "section", ...). Ranges are 1-based by default so
 * pdf page ranges keep working; pass `{ zeroBased: true }` for 0-based indices
 * such as document sections.
 */
export function parseIndexRanges(
  spec: string,
  itemCount: number,
  label: string,
  options: { zeroBased?: boolean } = {},
): IndexRange[] {
  const base = options.zeroBased ? 0 : 1;
  const last = base + itemCount - 1;
  const trimmed = spec.trim().toLowerCase();

  if (!trimmed) {
    throw new Error(`The ${label} ranges are required.`);
  }

  if (itemCount < 1) {
    throw new Error(`There are no ${label}s to split.`);
  }

  if (trimmed === "all") {
    return [{ start: base, end: last }];
  }

  const ranges: IndexRange[] = [];

  for (const rawToken of trimmed.split(",")) {
    const token = rawToken.trim();

    if (!token) {
      throw new Error(`Invalid ${label} range: "${rawToken}".`);
    }

    let start: number | null = null;
    let end: number | null = null;

    if (/^\d+$/.test(token)) {
      start = Number.parseInt(token, 10);
      end = start;
    } else if (/^\d+-\d+$/.test(token)) {
      const [startPart, endPart] = token.split("-");
      start = Number.parseInt(startPart ?? "", 10);
      end = Number.parseInt(endPart ?? "", 10);
    } else if (/^\d+-$/.test(token)) {
      start = Number.parseInt(token.slice(0, -1), 10);
      end = last;
    } else if (/^-\d+$/.test(token)) {
      start = base;
      end = Number.parseInt(token.slice(1), 10);
    } else {
      throw new Error(
        `Invalid ${label} range: "${rawToken}". Use N, N-M, N-, -M or "all".`,
      );
    }

    if (start < base || end > last || start > end) {
      throw new Error(
        `${label[0]!.toUpperCase()}${label.slice(1)} range "${token}" is outside the ${label}s (${base}-${last}).`,
      );
    }

    ranges.push({ start, end });
  }

  return ranges;
}
