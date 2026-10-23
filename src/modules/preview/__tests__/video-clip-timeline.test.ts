import { afterEach, describe, expect, it, vi } from "vitest";

import { VIDEO_CLIP_TIMELINE_SCRIPT } from "@/modules/preview/video-clip-timeline";

type ClipListener = (event?: unknown) => void;

type FakeVideo = {
  tagName: string;
  muted: boolean;
  paused: boolean;
  seeking: boolean;
  readyState: number;
  duration: number;
  currentTime: number;
  videoWidth: number;
  currentSrc: string;
  seeks: number[];
  loadCalls: number;
  pause(): void;
  play(): void;
  load(): void;
  addEventListener(type: string, listener: ClipListener): void;
  removeEventListener(type: string, listener: ClipListener): void;
  fire(type: string): void;
};

type ClipApi = {
  declare(entries: unknown[], options?: { fps?: number }): ClipTimeline;
  attach(contract: unknown): ClipTimeline | null;
  timeline(): ClipTimeline | null;
  issues(): string[];
  version: number;
};

type ClipState = {
  el: FakeVideo;
  label: string;
  active: boolean;
  local: number;
  target: number;
  held: boolean;
  wrapped: boolean;
  rect: number[] | null;
  alpha: number | undefined;
};

type ClipTimeline = {
  stateAt(t: number): ClipState[];
  prepareFrame(t: number): Promise<void>;
  draw(ctx: unknown, t: number): FakeVideo[];
  ownedElements(): FakeVideo[];
  fps: number;
};

function makeVideo(overrides: Partial<FakeVideo> = {}): FakeVideo {
  const listeners = new Map<string, ClipListener[]>();
  const video = {
    tagName: "VIDEO",
    muted: false,
    paused: true,
    seeking: false,
    readyState: 2,
    duration: 10,
    videoWidth: 640,
    currentSrc: "http://localhost/clip-a.mp4",
    seeks: [] as number[],
    loadCalls: 0,
    pause(this: FakeVideo) {
      this.paused = true;
    },
    play(this: FakeVideo) {
      this.paused = false;
    },
    // Follows the spec: load() aborts the current resource (readyState back
    // to HAVE_NOTHING) and re-runs resource selection — the decoder instance
    // the element held is returned to the device pool.
    load(this: FakeVideo) {
      this.loadCalls += 1;
      this.readyState = 0;
    },
    addEventListener(type: string, listener: ClipListener) {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type: string, listener: ClipListener) {
      const list = listeners.get(type) ?? [];
      const at = list.indexOf(listener);
      if (at >= 0) list.splice(at, 1);
      listeners.set(type, list);
    },
    fire(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    ...overrides,
  } as FakeVideo;
  let time = overrides.currentTime ?? 0;
  Object.defineProperty(video, "currentTime", {
    get: () => time,
    // Follows the real element: an assignment fires the 'seeked' event once
    // the stub's data is ready (synchronously here, because readyState is
    // controllable per test).
    set: (value: number) => {
      time = value;
      video.seeks.push(value);
      if (video.readyState >= 2) video.fire("seeked");
    },
    configurable: true,
  });
  return video;
}

async function tick(times = 4) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const g = () => globalThis as Record<string, unknown>;

function install(): {
  api: ClipApi;
  register(selector: string, el: FakeVideo): void;
} {
  const registry: Record<string, FakeVideo> = {};
  g().window = {};
  g().document = {
    querySelector(selector: string) {
      return registry[selector] ?? null;
    },
  };
  g().__selectors = registry;
  new Function(VIDEO_CLIP_TIMELINE_SCRIPT)();
  const api = (g().window as { __mobileAgentClips: ClipApi })
    .__mobileAgentClips;
  expect(api.version).toBeGreaterThan(0);
  return { api, register: (s, el) => (registry[s] = el) };
}

afterEach(() => {
  vi.useRealTimers();
  const global = g();
  delete global.window;
  delete global.document;
  delete global.__selectors;
});

describe("clip timeline stateAt", () => {
  it("maps absolute t onto the clip window, half-open at end", () => {
    const { api, register } = install();
    register("#a", makeVideo());
    const timeline = api.attach({
      fps: 30,
      clips: [{ el: "#a", start: 4, end: 8, from: 1 }],
    });
    expect(timeline).not.toBeNull();
    const atStart = timeline!.stateAt(4)[0];
    const inside = timeline!.stateAt(5)[0];
    const atEnd = timeline!.stateAt(8)[0];
    expect(atStart.active).toBe(true);
    expect(atStart.local).toBe(1); // from + (4 - 4)
    expect(inside.active).toBe(true);
    expect(inside.local).toBe(2); // from + (5 - 4)
    // t == end is already OUTSIDE the window: segment seams at a clip's end
    // paint it on exactly one side.
    expect(atEnd.active).toBe(false);
  });

  it("clamps a short clip to its final frame (hold) and reports it", () => {
    const { api, register } = install();
    register("#a", makeVideo({ duration: 3 }));
    const timeline = api.attach({
      fps: 30,
      clips: [{ el: "#a", start: 0, end: 10 }],
    });
    const held = timeline!.stateAt(8)[0];
    expect(held.held).toBe(true);
    expect(held.target).toBeCloseTo(3 - 1 / 30, 6);
    expect(timeline!.stateAt(8)[1]).toBeUndefined();
    expect(api.issues().some((note) => note.includes("holding"))).toBe(true);
  });

  it("wraps a looping clip modulo its source length", () => {
    const { api, register } = install();
    register("#a", makeVideo({ duration: 3 }));
    const timeline = api.attach({
      fps: 30,
      clips: [{ el: "#a", start: 0, end: 10, loop: true }],
    });
    const state = timeline!.stateAt(5)[0];
    expect(state.wrapped).toBe(true);
    expect(state.target).toBeCloseTo(2, 6);
    expect(state.held).toBe(false);
  });

  it("leaves an inactive clip unheld and without a target move", () => {
    const { api, register } = install();
    register("#a", makeVideo({ duration: 3 }));
    const timeline = api.attach({
      fps: 30,
      clips: [{ el: "#a", start: 0, end: 2 }],
    });
    const state = timeline!.stateAt(5)[0];
    expect(state.active).toBe(false);
    expect(api.issues()).toEqual([]);
  });
});

describe("clip timeline prepareFrame", () => {
  it("seeks only clips active at t and waits until decoded", async () => {
    const { api, register } = install();
    const active = makeVideo({ readyState: 1 }); // metadata only, not decoded
    const idle = makeVideo();
    register("#a", active);
    register("#b", idle);
    const timeline = api.attach({
      fps: 30,
      clips: [{ el: "#a", start: 0, end: 10 }],
    });
    const pending = timeline!.prepareFrame(5);
    await tick();
    // Assigned the mapped offset while waiting for decode...
    expect(active.seeks).toEqual([5]);
    expect(idle.seeks).toEqual([]); // inactive clips are not touched
    expect(active.paused).toBe(true);
    // ...and resolve once data is decodable ('loadeddata' completes the wait).
    active.readyState = 2;
    active.fire("loadeddata");
    await pending;
  });

  it("resolves a clip already at target with no seek", async () => {
    const { api, register } = install();
    const el = makeVideo({ currentTime: 2 });
    register("#a", el);
    const timeline = api.attach({
      fps: 30,
      clips: [{ el: "#a", start: 0, end: 10 }],
    });
    await timeline!.prepareFrame(2);
    expect(el.seeks).toEqual([]); // fast path: already exactly at t
  });

  it("restarts a reused person element in every appearance without unloading an active window", async () => {
    const { api, register } = install();
    const person = makeVideo({ duration: 30.421 });
    register("#person", person);
    const starts = [18, 63, 108, 153, 198, 243, 288, 328];
    const timeline = api.attach({
      fps: 30,
      clips: starts.map((start) => ({ el: "#person", start, end: start + 15, from: 0 })),
    })!;
    for (const start of starts) {
      await timeline.prepareFrame(start + 7);
      expect(person.currentTime).toBe(7);
      expect(person.readyState).toBe(2);
    }
    expect(person.loadCalls).toBe(0);
    expect(timeline.ownedElements()).toEqual([person]);
  });

  it("suspends idle source attributes once and restores them before a later appearance or backward seek", async () => {
    const { api, register } = install();
    const attrs = new Map<string, string>([["preload", "auto"]]);
    const sourceAttrs = new Map([["src", "http://localhost/person.mp4"]]);
    const source = {
      getAttribute: (key: string) => sourceAttrs.get(key) ?? null,
      setAttribute: (key: string, value: string) => { sourceAttrs.set(key, value); },
      removeAttribute: (key: string) => { sourceAttrs.delete(key); },
    };
    const person = Object.assign(makeVideo(), {
      getAttribute: (key: string) => attrs.get(key) ?? null,
      setAttribute: (key: string, value: string) => { attrs.set(key, value); },
      removeAttribute: (key: string) => { attrs.delete(key); },
      querySelectorAll: () => [source],
    });
    register("#person", person);
    const timeline = api.attach({ clips: [
      { el: "#person", start: 18, end: 33 },
      { el: "#person", start: 63, end: 78 },
    ] })!;

    await timeline.prepareFrame(40);
    await timeline.prepareFrame(41);
    expect(person.loadCalls).toBe(1);
    expect(sourceAttrs.has("src")).toBe(false);
    expect(attrs.get("preload")).toBe("none");

    const pending = timeline.prepareFrame(70);
    await tick();
    expect(person.loadCalls).toBe(2);
    expect(sourceAttrs.get("src")).toBe("http://localhost/person.mp4");
    expect(attrs.get("preload")).toBe("auto");
    person.readyState = 2;
    person.fire("loadedmetadata");
    await pending;
    expect(person.currentTime).toBe(7);

    await timeline.prepareFrame(25);
    expect(person.currentTime).toBe(7);
    expect(person.loadCalls).toBe(2);
  });

  it("holds the last decodable frame at the exact source endpoint", () => {
    const { api, register } = install();
    register("#a", makeVideo({ duration: 3 }));
    const timeline = api.attach({ fps: 30, clips: [{ el: "#a", start: 0, end: 10 }] })!;
    expect(timeline.stateAt(3)[0].target).toBeCloseTo(3 - 1 / 30);
  });

  it("reloads a stalled clip once, then fails loud naming it", async () => {
    vi.useFakeTimers();
    const { api, register } = install();
    const el = makeVideo({ readyState: 1 });
    register("#a", el);
    const timeline = api.attach({
      fps: 30,
      clips: [{ el: "#a", start: 0, end: 10 }],
    });
    const pending = timeline!.prepareFrame(5);
    let settled = false;
    void pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    // First watchdog: instead of dying, the element is reloaded — both
    // researched stall modes (stuck readyState-1 seek, refused decoder
    // allocation) clear when resource selection re-runs.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(settled).toBe(false);
    expect(el.loadCalls).toBe(1);

    // Second watchdog: the reload did not help — the loud, clip-named
    // failure survives so the export can never hang silently.
    const expectation = expect(pending).rejects.toThrow(/did not decode/);
    await vi.advanceTimersByTimeAsync(16_000);
    await expectation;
    await expect(
      pending.catch((error: Error) => error.message),
    ).resolves.toMatch(/Reloaded once and it still stalled/);
    expect(el.loadCalls).toBe(1);
  });

  it("recovers a stalled clip by reloading it", async () => {
    vi.useFakeTimers();
    const { api, register } = install();
    const el = makeVideo({ readyState: 1 });
    register("#a", el);
    const timeline = api.attach({
      fps: 30,
      clips: [{ el: "#a", start: 0, end: 10 }],
    });
    const pending = timeline!.prepareFrame(5);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(el.loadCalls).toBe(1);

    // The reload re-runs resource selection: metadata arrives, the mapped
    // seek runs, decode completes — the export continues.
    el.readyState = 2;
    el.fire("loadedmetadata");
    await pending;
    expect(el.seeks).toEqual([5]);
    expect(api.issues().some((note) => note.includes("reloaded"))).toBe(true);
  });

  it("unloads clips whose window is over before preparing active ones", async () => {
    const { api, register } = install();
    const finished = makeVideo(); // decoded during its [0, 4) window
    const next = makeVideo({ readyState: 1 });
    register("#a", finished);
    register("#b", next);
    const timeline = api.attach({
      fps: 30,
      clips: [
        { el: "#a", start: 0, end: 4 },
        { el: "#b", start: 4, end: 8 },
      ],
    });

    const pending = timeline!.prepareFrame(5);
    await tick();
    // The finished clip returns its device decoder instead of holding it
    // for the rest of the export...
    expect(finished.loadCalls).toBe(1);
    expect(finished.readyState).toBe(0);
    // ...while the active clip still gets prepared (its local offset: 5 - 4).
    expect(next.seeks).toEqual([1]);
    next.readyState = 2;
    next.fire("loadeddata");
    await pending;

    // A released clip stays released: no reload loop on later frames.
    await timeline!.prepareFrame(5);
    expect(finished.loadCalls).toBe(1);
  });

  it("prepares active clips one at a time instead of bursting decoder inits", async () => {
    const { api, register } = install();
    const first = makeVideo({ readyState: 1 });
    const second = makeVideo({ readyState: 1 });
    register("#a", first);
    register("#b", second);
    const timeline = api.attach({
      fps: 30,
      clips: [
        { el: "#a", start: 0, end: 10 },
        { el: "#b", start: 0, end: 10 },
      ],
    });

    const pending = timeline!.prepareFrame(5);
    await tick();
    expect(first.seeks).toEqual([5]);
    // The second clip's decoder init does not start while the first is
    // still acquiring — a parallel burst is what races the codec cap.
    expect(second.seeks).toEqual([]);

    first.readyState = 2;
    first.fire("loadeddata");
    await tick();
    expect(second.seeks).toEqual([5]);
    second.readyState = 2;
    second.fire("loadeddata");
    await pending;
  });
});

describe("clip timeline validation and attach", () => {
  it("rejects overlapping windows sharing an element but permits touching seams", () => {
    const { api, register } = install();
    register("#a", makeVideo());
    expect(() => api.attach({ clips: [
      { el: "#a", start: 0, end: 4 }, { el: "#a", start: 3, end: 8 },
    ] })).toThrow(/overlapping windows/);
    expect(() => api.attach({ clips: [
      { el: "#a", start: 0, end: 4 }, { el: "#a", start: 4, end: 8 },
    ] })).not.toThrow();
  });
  it("rejects a window with end not after start", () => {
    const { api, register } = install();
    register("#a", makeVideo());
    expect(() =>
      api.attach({ clips: [{ el: "#a", start: 5, end: 5 }] }),
    ).toThrow(/end.*start/);
  });

  it("rejects a selector that matches nothing", () => {
    const { api } = install();
    expect(() =>
      api.attach({ clips: [{ el: "#missing", start: 0, end: 4 }] }),
    ).toThrow(/matched no element/);
  });

  it("rejects non-video elements", () => {
    const { api, register } = install();
    register("#img", makeVideo({ tagName: "IMG" }));
    expect(() =>
      api.attach({ clips: [{ el: "#img", start: 0, end: 4 }] }),
    ).toThrow(/not a <video>/);
  });

  it("forces muted and paused on declare", () => {
    const { api, register } = install();
    const el = makeVideo({ muted: false, paused: false });
    register("#a", el);
    api.attach({ clips: [{ el: "#a", start: 0, end: 4 }] });
    expect(el.muted).toBe(true);
    expect(el.paused).toBe(true);
  });

  it("memoizes per contract object and revalidates a new one", () => {
    const { api, register } = install();
    register("#a", makeVideo());
    const contract = { clips: [{ el: "#a", start: 0, end: 4 }] };
    const first = api.attach(contract);
    const second = api.attach(contract);
    expect(first).toBe(first); // identity stable (sanity)
    expect(second).toBe(first);
    register("#b", makeVideo());
    const updated = api.attach({ clips: [{ el: "#b", start: 0, end: 4 }] });
    expect(updated!.ownedElements()[0]).not.toBe(first!.ownedElements()[0]);
  });

  it("returns null for a contract without clips and keeps declare visible", () => {
    const { api, register } = install();
    register("#a", makeVideo());
    expect(api.attach({ clips: [] })).toBeNull();
    expect(api.attach({})).toBeNull();
    const viaDeclare = api.declare([{ el: "#a", start: 0, end: 4 }]);
    expect(api.timeline()).toBe(viaDeclare);
    // A clips-carrying contract later wins the installed slot for itself.
    const fromContract = api.attach({
      clips: [{ el: "#a", start: 1, end: 4 }],
    });
    expect(api.timeline()).toBe(fromContract);
  });
});

describe("clip timeline draw", () => {
  function makeCtx() {
    const calls: { el: FakeVideo; args: unknown[]; alpha: number }[] = [];
    return {
      calls,
      globalAlpha: 1,
      save() {},
      restore() {
        calls.forEach((c) => (c.alpha = c.alpha));
      },
      drawImage(el: FakeVideo, ...args: unknown[]) {
        calls.push({ el, args, alpha: this.globalAlpha });
      },
    };
  }

  it("draws active and ready clips with rect and alpha, skips the rest", () => {
    const { api, register } = install();
    const ready = makeVideo();
    const notReady = makeVideo({ readyState: 1 });
    register("#a", ready);
    register("#b", notReady);
    const timeline = api.attach({
      clips: [
        { el: "#a", start: 0, end: 10, x: 10, y: 20, w: 30, h: 40, alpha: 0.5 },
        { el: "#b", start: 0, end: 10 },
      ],
    });
    const ctx = makeCtx();
    const drawn = timeline!.draw(ctx, 2);
    expect(drawn).toEqual([ready]);
    expect(ctx.calls.length).toBe(1);
    expect(ctx.calls[0].el).toBe(ready);
    expect(ctx.calls[0].args).toEqual([10, 20, 30, 40]);
    expect(ctx.calls[0].alpha).toBe(0.5);
  });
});
