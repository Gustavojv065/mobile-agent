import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guard the UI wiring too: a bounded loader cannot prevent an eager map
// from mounting hundreds of native images. RN layout is tested on device.
describe("large attachment list regression guards", () => {
  it("virtualizes selected attachments and keeps picker images out of closed drawers", () => {
    const source = readFileSync(new URL("../../../app/(root)/index.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("selectedFiles.map(");
    expect(source).not.toContain("filteredWorkspaceFiles.map(");
    expect(source).toContain("data={selectedFiles}");
    expect(source).toContain("data={filesDrawerOpen ? filteredWorkspaceFiles : []}");
    expect(source).toContain("initialNumToRender={6}");
    expect(source).toContain("windowSize={3}");
  });

  it("virtualizes All/Docs in the library without an enclosing ScrollView", () => {
    const source = readFileSync(new URL("../../../app/(root)/library.tsx", import.meta.url), "utf8");
    expect(source).toContain("scroll={false}");
    expect(source).toContain("data={filteredFiles}");
    expect(source).not.toContain("filteredFiles.map(");
  });

  it("does not load full-resolution originals a second time in the image grid", () => {
    const source = readFileSync(new URL("../../../components/ui/library-image-grid.tsx", import.meta.url), "utf8");
    expect(source).toContain("useWorkspaceThumbnail(uri, 512)");
    expect(source).toContain("source={thumbnail}");
    expect(source).not.toContain("source={{ uri }}");
  });

  it("virtualizes attachment cards inside each virtualized chat message", () => {
    const source = readFileSync(new URL("../../../components/ui/chat-message.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("attachedFiles.map(");
    expect(source).toContain("data={attachedFiles}");
    expect(source).toContain("initialNumToRender={6}");
    expect(source).toContain("windowSize={3}");
    expect(source).toContain("<FileAttachmentCard");
  });
});
