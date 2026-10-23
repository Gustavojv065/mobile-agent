import { describe, expect, it } from "vitest";
import { VIDEO_RUNTIME_GUIDANCE, withVideoRuntimeGuidance } from "../video-runtime-guidance";

describe("current video runtime guidance", () => {
  it("precedes stale installed instructions without modifying them", () => {
    const skill = { title: "html-video", instructions: "Clips are driven entirely by scene JS currentTime." };
    const original = { ...skill };
    expect(withVideoRuntimeGuidance(skill)).toBe(`${VIDEO_RUNTIME_GUIDANCE}\n---\n\n${skill.instructions}`);
    expect(skill).toEqual(original);
    expect(VIDEO_RUNTIME_GUIDANCE).toContain("MP4/MOV/WebM video files are accepted");
    expect(VIDEO_RUNTIME_GUIDANCE).toContain("audio: false");
  });

  it("also protects renamed video skills but leaves unrelated skills alone", () => {
    expect(withVideoRuntimeGuidance({ title: "My editor", instructions: "Use MOBILE_AGENT_VIDEO" })).toContain(VIDEO_RUNTIME_GUIDANCE);
    expect(withVideoRuntimeGuidance({ title: "Research", instructions: "Search sources." })).toBe("Search sources.");
  });
});
