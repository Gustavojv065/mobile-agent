type InputCapabilities = {
  supportsImageInput?: boolean;
  supportsAudioInput?: boolean;
  supportsVideoInput?: boolean;
};

/** Tool results must obey the same modality restrictions as attachments. */
export function fileInputGuidance(
  mimeType: string,
  capabilities: InputCapabilities,
  externalFolder = false,
): string | null {
  const mime = mimeType.trim().toLowerCase().split(";")[0];
  if (mime.startsWith("image/") && mime !== "image/svg+xml" && capabilities.supportsImageInput === false) {
    return "Your model cannot display images. Use ocr for on-screen text, or ask the user what they see.";
  }
  const video = mime.startsWith("video/") && !capabilities.supportsVideoInput;
  const audio = mime.startsWith("audio/") && !capabilities.supportsAudioInput;
  if (!video && !audio) return null;
  return `Your model does not support ${video ? "video" : "audio"} input. No media bytes were sent. Do not retry viewFile for this media. ` +
    (externalFolder ? "First use importFolderFileToWorkspace and use the returned workspace fileId. " : "Use this workspace fileId. ") +
    (video ? "Inspect visuals with getVideoFrame; use transcribeAudio for speech or analyzeAudio for soundtrack features. " : "Use transcribeAudio for speech or analyzeAudio for soundtrack features. ") +
    "Continue the original task using those tool results; renderVideo is still available to produce the edited MP4.";
}
