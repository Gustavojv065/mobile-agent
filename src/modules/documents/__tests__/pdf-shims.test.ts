import { afterEach, describe, expect, it } from "vitest";

import { ensurePdfGlobals } from "@/modules/documents/pdf-shims";

const originalStructuredClone = globalThis.structuredClone;

afterEach(() => {
  // jsdom/node `structuredClone` is read-only on some runtimes; restore via
  // defineProperty so tests never leak a stub into other suites.
  Object.defineProperty(globalThis, "structuredClone", {
    configurable: true,
    value: originalStructuredClone,
    writable: true,
  });
  // Re-apply the null-tolerant wrapper to the restored native so later PDF
  // extractions in this process keep the production behavior.
  ensurePdfGlobals();
});

describe("ensurePdfGlobals structuredClone", () => {
  it("tolerates the null options unpdf LoopbackPort passes without transfer", () => {
    // Mimics @ungap/structured-clone: `serialize(value, { json } = {})`
    // throws when options is null because the default only covers undefined.
    const buggy = ((value: unknown, { json: _ignored }: { json?: boolean } = {}) => {
      void _ignored;
      return value;
    }) as unknown as typeof structuredClone;

    Object.defineProperty(globalThis, "structuredClone", {
      configurable: true,
      value: buggy,
      writable: true,
    });

    ensurePdfGlobals();

    const input = { a: 1, nested: { b: [1, 2] } };
    expect(() => globalThis.structuredClone(input, null as never)).not.toThrow();
    expect(globalThis.structuredClone(input, null as never)).toBe(input);
    expect(globalThis.structuredClone(input, undefined)).toBe(input);
  });

  it("is idempotent and preserves normal clone behavior", () => {
    ensurePdfGlobals();
    const first = globalThis.structuredClone;
    ensurePdfGlobals();
    expect(globalThis.structuredClone).toBe(first);

    const input = { x: [1, { y: "z" }] };
    const cloned = globalThis.structuredClone(input);
    expect(cloned).toEqual(input);
    expect(cloned).not.toBe(input);
  });

  it("installs a working fallback when structuredClone is missing", () => {
    Object.defineProperty(globalThis, "structuredClone", {
      configurable: true,
      value: undefined,
      writable: true,
    });

    ensurePdfGlobals();

    expect(typeof globalThis.structuredClone).toBe("function");
    const input = { a: [1, 2], b: { c: "hi" } };
    expect(globalThis.structuredClone(input, null as never)).toEqual(input);
  });
});
