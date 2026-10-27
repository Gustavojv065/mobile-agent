let voiceInputActive = false;

/**
 * Set by the composer's dictation hook. Announcements never speak while the
 * microphone is open, because playback would be transcribed as user speech.
 */
export function setVoiceInputActive(active: boolean) {
  voiceInputActive = active;
}

export function isVoiceInputActive() {
  return voiceInputActive;
}
