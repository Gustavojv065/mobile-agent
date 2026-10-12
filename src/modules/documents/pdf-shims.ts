/**
 * Guarded polyfills for the small set of web globals PDF.js touches that may
 * be absent from older Hermes runtimes. Each shim only installs when the
 * global is missing, and they are installed lazily the first time a PDF is
 * actually read, so they never affect startup.
 *
 * PDF.js (via unpdf) already polyfills DOMMatrix, Promise.withResolvers and
 * FinalizationRegistry itself.
 *
 * The structuredClone wrapper is installed unconditionally (not just when the
 * global is missing): unpdf's LoopbackPort calls
 * `structuredClone(data, transfer ? { transfer } : null)`, and the
 * `@ungap/structured-clone` polyfill used on Hermes destructures its options
 * as `{ json, lossy } = {}`, which throws `Cannot read property 'json' of
 * null` when it receives `null`. Native implementations tolerate `null`, so
 * normalizing `null` to `undefined` restores parity.
 */

type WeakRefShimTarget = object;

class WeakRefShim<T extends WeakRefShimTarget> {
  readonly #target: T;

  constructor(target: T) {
    this.#target = target;
  }

  deref(): T | undefined {
    return this.#target;
  }
}

class FinalizationRegistryShim {
  register(): void {}
  unregister(): boolean {
    return false;
  }
}

function cloneStructured(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return value.slice(0);
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as Exclude<ArrayBufferView, DataView> | DataView;
    const buffer = (view.buffer as ArrayBuffer).slice(
      view.byteOffset,
      view.byteOffset + view.byteLength,
    );

    if (view instanceof DataView) {
      return new DataView(buffer);
    }

    const Constructor = view.constructor as new (buffer: ArrayBuffer) => typeof view;
    return new Constructor(buffer);
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>();

    for (const [key, entry] of value.entries()) {
      clone.set(cloneStructured(key), cloneStructured(entry));
    }

    return clone;
  }

  if (value instanceof Set) {
    const clone = new Set<unknown>();

    for (const entry of value.values()) {
      clone.add(cloneStructured(entry));
    }

    return clone;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => cloneStructured(entry));
  }

  const clone: Record<string, unknown> = {};

  for (const key of Object.keys(value as Record<string, unknown>)) {
    clone[key] = cloneStructured((value as Record<string, unknown>)[key]);
  }

  return clone;
}

/**
 * Normalize the `null` options argument unpdf's LoopbackPort passes when
 * there is no transfer list. Native `structuredClone` tolerates `null`, but
 * the `@ungap/structured-clone` polyfill destructures options with a
 * `= {}` default that only applies to `undefined`, throwing on `null`.
 */
function wrapStructuredClone(
  impl: (value: unknown, options?: StructuredSerializeOptions) => unknown,
): typeof structuredClone {
  const wrapped = ((value: unknown, options?: StructuredSerializeOptions | null) =>
    impl(value, options ?? undefined)) as typeof structuredClone & {
    __pdfNullTolerant?: boolean;
  };
  wrapped.__pdfNullTolerant = true;
  return wrapped;
}

/**
 * Install any missing globals PDF.js expects. Only called lazily before the
 * first PDF extraction. Idempotent: repeated calls never double-wrap
 * `structuredClone`.
 */
export function ensurePdfGlobals(): void {
  if (typeof globalThis.navigator === "undefined") {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { platform: "", userAgent: "" },
      writable: true,
    });
  }

  const globals = globalThis as typeof globalThis & {
    FinalizationRegistry?: unknown;
    WeakRef?: unknown;
    structuredClone?: unknown;
  };

  if (typeof globals.structuredClone !== "function") {
    globals.structuredClone = wrapStructuredClone((value: unknown) =>
      cloneStructured(value),
    );
  } else if (
    !(globals.structuredClone as { __pdfNullTolerant?: boolean })
      .__pdfNullTolerant
  ) {
    const original = globals.structuredClone as (
      value: unknown,
      options?: StructuredSerializeOptions,
    ) => unknown;
    const bound = original.bind(globalThis);
    globals.structuredClone = wrapStructuredClone((value, options) =>
      bound(value, options),
    );
  }

  if (typeof globals.WeakRef !== "function") {
    globals.WeakRef = WeakRefShim as unknown as typeof WeakRef;
  }

  if (typeof globals.FinalizationRegistry !== "function") {
    globals.FinalizationRegistry =
      FinalizationRegistryShim as unknown as typeof FinalizationRegistry;
  }
}