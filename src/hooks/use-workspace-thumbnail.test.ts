import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceThumbnail } from "./use-workspace-thumbnail";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  effect: null as (() => (() => void)) | null,
  setState: vi.fn(),
}));
vi.mock("react", () => ({
  useEffect: (effect: () => (() => void)) => { mocks.effect = effect; },
  useState: () => [null, mocks.setState],
}));
vi.mock("expo-image", () => ({ Image: { loadAsync: mocks.load } }));

describe("thumbnail ownership", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("bounds decode size and releases a loaded reference on unmount", async () => {
    const image = { release: vi.fn() };
    mocks.load.mockResolvedValue(image);
    useWorkspaceThumbnail("file:///photo.jpg", 192);
    const cleanup = mocks.effect!();
    await vi.waitFor(() => expect(mocks.setState).toHaveBeenCalled());
    expect(mocks.load).toHaveBeenCalledWith(
      { uri: "file:///photo.jpg", isAnimated: false },
      { maxWidth: 192, maxHeight: 192 },
    );
    cleanup();
    expect(image.release).toHaveBeenCalledTimes(1);
  });

  it("releases late completion without updating an unmounted row", async () => {
    const image = { release: vi.fn() };
    let finish!: (image: unknown) => void;
    mocks.load.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    useWorkspaceThumbnail("file:///late.jpg", 192);
    const cleanup = mocks.effect!();
    await vi.waitFor(() => expect(mocks.load).toHaveBeenCalled());
    cleanup();
    finish(image);
    await vi.waitFor(() => expect(image.release).toHaveBeenCalledTimes(1));
    expect(mocks.setState).not.toHaveBeenCalled();
  });
});
