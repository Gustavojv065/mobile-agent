import { describe, expect, it, vi } from "vitest";

import {
  buildScenePlayerScript,
  formatPlayerTime,
  getSceneDuration,
  SCENE_PLAYER_MESSAGE_TYPE,
} from "@/modules/preview/scene-player";

const SCENE = `window.MOBILE_AGENT_VIDEO = { duration: 21, fps: 30 };`;

function makeHarness(options?: {
  render?: (t: number, canvas: unknown, ctx: unknown, audio: never, speech: never) => void;
  duration?: number;
}) {
  const posts: unknown[] = [];
  const render = vi.fn(
    options?.render ??
      ((_t: number, _c: unknown, _x: unknown, _a: never, _s: never) => {}),
  );
  let rafCallback: ((now: number) => void) | null = null;
  const sandbox: Record<string, unknown> = {
    Date,
    JSON,
    Math,
    window: {
      MOBILE_AGENT_VIDEO: {
        duration: options?.duration ?? 21,
        fps: 30,
        canvasId: "scene",
        render,
      },
      ReactNativeWebView: {
        postMessage: (payload: string) => {
          posts.push(JSON.parse(payload));
        },
      },
    },
    document: {
      getElementById: (id: string) =>
        id === "scene" ? canvasMock : null,
      querySelector: () => canvasMock,
    },
    requestAnimationFrame: (callback: (now: number) => void) => {
      rafCallback = callback;
      return 1;
    },
    cancelAnimationFrame: () => {
      rafCallback = null;
    },
  };
  const canvasMock = {
    getContext: () => ({ fillRect: () => {} }),
  };
  const run = (script: string) => {
    const fn = new Function(
      "window",
      "document",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "Date",
      "JSON",
      "Math",
      `${script}\nreturn window.__mobileAgentPlayer;`,
    );
    return fn(
      sandbox.window,
      sandbox.document,
      sandbox.requestAnimationFrame,
      sandbox.cancelAnimationFrame,
      sandbox.Date,
      sandbox.JSON,
      sandbox.Math,
    ) as {
      play: () => boolean;
      pause: () => void;
      seek: (t: number) => void;
      state: () => { t: number; playing: boolean; duration: number };
    };
  };
  const step = (now: number) => {
    const callback = rafCallback;
    rafCallback = null;
    callback?.(now);
  };
  return { sandbox, posts, render, run, step };
}

describe("formatPlayerTime", () => {
  it("formats m:ss floored", () => {
    expect(formatPlayerTime(0)).toBe("0:00");
    expect(formatPlayerTime(7.9)).toBe("0:07");
    expect(formatPlayerTime(65.2)).toBe("1:05");
    expect(formatPlayerTime(-3)).toBe("0:00");
  });
});

describe("getSceneDuration", () => {
  it("reads the contract duration and rejects non-scenes", () => {
    expect(getSceneDuration(SCENE)).toBe(21);
    expect(getSceneDuration("<html><body>plain</body></html>")).toBeNull();
  });
});

describe("scene player script", () => {
  it("is safe to inject (no backticks or interpolation leftovers)", () => {
    const script = buildScenePlayerScript();
    expect(script).not.toContain("`");
    expect(script).not.toContain("${");
    expect(script).toContain(SCENE_PLAYER_MESSAGE_TYPE);
  });

  it("plays forward in real time and posts throttled updates", () => {
    const harness = makeHarness();
    const player = harness.run(buildScenePlayerScript());
    expect(player.play()).toBe(true);

    harness.step(1000);
    harness.step(1500);
    harness.step(2000);
    const calls = harness.render.mock.calls.map((call) => call[0] as number);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // t advanced ~0.5s per frame after the anchoring frame.
    expect(calls[calls.length - 1]).toBeGreaterThan(calls[0]);

    const times = harness.posts.filter(
      (post) =>
        (post as { type?: unknown }).type === SCENE_PLAYER_MESSAGE_TYPE,
    );
    expect(times.length).toBeGreaterThan(0);
    player.pause();
    expect(player.state().playing).toBe(false);
  });

  it("passes silent stub audio and speech so scenes cannot throw", () => {
    const harness = makeHarness();
    const player = harness.run(buildScenePlayerScript());
    player.seek(5);
    const [, , , audio, speech] = harness.render.mock.calls[0] as unknown as [
      unknown,
      unknown,
      unknown,
      Record<string, (...args: never[]) => number | string> & {
        ready: boolean;
        beats: unknown[];
      },
      Record<string, (...args: never[]) => number | string | null> & {
        ready: boolean;
      },
    ];
    expect(audio.ready).toBe(false);
    expect(audio.level()).toBe(0);
    expect(audio.beatPulse()).toBe(0);
    expect(audio.beats).toEqual([]);
    expect(speech.ready).toBe(false);
    expect(speech.activeText()).toBe("");
  });

  it("clamps seeks and restarts from zero at the end", () => {
    const harness = makeHarness();
    const player = harness.run(buildScenePlayerScript());
    player.seek(99);
    expect(player.state().t).toBe(21);
    player.seek(-5);
    expect(player.state().t).toBe(0);
    player.play();
    expect(player.state().t).toBe(0);
    expect(player.state().playing).toBe(true);
  });

  it("does not pause an active reused clip because another appearance is inactive", () => {
    const harness = makeHarness({ duration: 90 });
    const el = { paused: true, readyState: 2, currentTime: 0,
      play: vi.fn(function () { el.paused = false; }),
      pause: vi.fn(function () { el.paused = true; }),
    };
    Object.assign(harness.sandbox.window as object, {
      __mobileAgentClips: { attach: () => ({ stateAt: () => [
        { el, active: false, target: 0 },
        { el, active: true, target: 7 },
        { el, active: false, target: 0 },
      ] }) },
    });
    const player = harness.run(buildScenePlayerScript());
    player.seek(70);
    player.play();
    harness.step(1000);
    harness.step(1200);
    expect(el.currentTime).toBe(7);
    expect(el.paused).toBe(false);
    expect(el.pause).not.toHaveBeenCalled();
    player.pause();
  });

  it("stops and reports a throwing render instead of dying silently", () => {
    const harness = makeHarness({
      render: () => {
        throw new Error("boom");
      },
    });
    const player = harness.run(buildScenePlayerScript());
    player.seek(2);
    const errors = harness.posts.filter(
      (post) => (post as { error?: unknown }).error != null,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(player.state().playing).toBe(false);
  });
});
