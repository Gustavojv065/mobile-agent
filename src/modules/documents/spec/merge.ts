function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Deep-merge `override` onto `base` and return a new value:
 * - plain objects are merged key by key (missing keys keep `base` values),
 * - arrays and primitives in `override` replace the base value,
 * - `undefined` values in `override` are skipped so partial specs stay intact.
 *
 * Shared by every document format spec so a partial user spec (parameter or
 * front-matter) always layers on top of the resolved defaults.
 */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) {
    return base;
  }

  if (Array.isArray(override) || !isPlainObject(override)) {
    return override as T;
  }

  const output: Record<string, unknown> = {
    ...(base as Record<string, unknown>),
  };

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }

    const baseValue = output[key];

    output[key] =
      isPlainObject(baseValue) && isPlainObject(value)
        ? deepMerge(baseValue, value)
        : value;
  }

  return output as T;
}