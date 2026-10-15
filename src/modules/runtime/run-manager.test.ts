import { describe, expect, it, vi } from "vitest";
import { createRunControllerRegistry } from "./run-manager";

describe("run provider lifetime", () => {
  it("aborts active runs and resolves pending interactions on teardown", () => {
    const registry = createRunControllerRegistry();
    const controller = new AbortController();
    registry.claim("run");
    registry.registerAbortController("run", controller);
    const approval = vi.fn(), question = vi.fn(), secret = vi.fn();
    registry.registerPendingApproval("run", "a", approval);
    registry.registerPendingQuestionnaire("run", "q", question);
    registry.registerPendingSecretRequest("run", "s", secret);
    registry.dispose();
    registry.dispose();
    expect(controller.signal.aborted).toBe(true);
    expect(registry.isDisposed()).toBe(true);
    expect(approval).toHaveBeenCalledExactlyOnceWith("abort");
    expect(question).toHaveBeenCalledExactlyOnceWith(null);
    expect(secret).toHaveBeenCalledExactlyOnceWith({ status: "aborted" });
    expect(registry.claim("another")).toBe(false);
  });

  it("cancels late registrations and cannot affect a fresh provider's registry", () => {
    const old = createRunControllerRegistry();
    old.dispose();
    const controller = new AbortController();
    old.registerAbortController("run", controller);
    const approval = vi.fn(), question = vi.fn(), secret = vi.fn();
    old.registerPendingApproval("run", "a", approval);
    old.registerPendingQuestionnaire("run", "q", question);
    old.registerPendingSecretRequest("run", "s", secret);
    expect(controller.signal.aborted).toBe(true);
    expect(approval).toHaveBeenCalledWith("abort");
    expect(question).toHaveBeenCalledWith(null);
    expect(secret).toHaveBeenCalledWith({ status: "aborted" });
    const fresh = createRunControllerRegistry();
    fresh.claim("run");
    old.clear("run");
    expect(fresh.owns("run")).toBe(true);
    expect(fresh.isDisposed()).toBe(false);
  });
});
