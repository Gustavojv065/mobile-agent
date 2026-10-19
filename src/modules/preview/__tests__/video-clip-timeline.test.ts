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
  pause(): void;
  play(): void;
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
    pause(this: FakeVideo) {
      this.paused = true;
    },
    play(this: FakeVideo) {
      this.paused = false;
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

  it("fails loud naming the clip when the frame never decodes", async () => {
    vi.useFakeTimers();
    const { api, register } = install();
    const el = makeVideo({ readyState: 1 });
    register("#a", el);
    const timeline = api.attach({
      fps: 30,
      clips: [{ el: "#a", start: 0, end: 10 }],
    });
    const pending = timeline!.prepareFrame(5);
    const expectation = expect(pending).rejects.toThrow(/did not decode/);
    await vi.advanceTimersByTimeAsync(16_000);
    await expectation;
  });
});

describe("clip timeline validation and attach", () => {
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
