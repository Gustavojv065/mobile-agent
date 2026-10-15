import type { ToolExecutionRecord, ExternalFolderSession } from "@/core/types/app-state";

export type ExternalFolderToolFactoryParams = {
  onRecord?: (record: ToolExecutionRecord) => void;
  session: ExternalFolderSession;
  /**
   * Whether the active model accepts image input. Tools that can return
   * vision content use this to decide between inline image parts and a
   * text-only fallback. Defaults to true so existing call sites keep
   * current behavior.
   */
  supportsImageInput?: boolean;
  supportsAudioInput?: boolean;
  supportsVideoInput?: boolean;
};
