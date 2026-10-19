import { Maximize, Minimize, Pause, Play, RotateCcw, RotateCw } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { Slider } from "@/components/ui/slider";
import { formatPlayerTime } from "@/modules/preview/scene-player";

export type ScenePlayerChromeProps = {
  playing: boolean;
  time: number;
  duration: number;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  /** Called when a scrub starts/ends, so the page's `t` ticks don't fight the drag. */
  onScrubComplete?: (seconds: number) => void;
  onScrubStart?: () => void;
  /** Omitted hides the button entirely. */
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** True while the page is fetching/decoding the soundtrack (show pill). */
  audioLoading?: boolean;
};

/** How long controls stay on screen after the last interaction while playing. */
const AUTO_HIDE_MS = 2800;

/**
 * In-frame player chrome for scene previews, laid out to read exactly like
 * the native video player chrome (centered transport deck over the frame,
 * scrubber + times along the bottom). Only controls that work on an HTML
 * scene are rendered — second-jumps/play/scrub — so nothing here is a dead
 * button.
 *
 * The scrim is a soft gradient (darkest at the bottom fading up) instead of a
 * solid band, and the whole chrome auto-hides after a few seconds of playback
 * inactivity — tap the frame to bring it back. While hidden it is
 * `pointerEvents="none"`, so nothing blocks the scene underneath.
 */
export function ScenePlayerChrome({
  playing,
  time,
  duration,
  onTogglePlay,
  onSeek,
  onScrubComplete,
  onScrubStart,
  fullscreen = false,
  onToggleFullscreen,
  audioLoading = false,
}: ScenePlayerChromeProps) {
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Fullscreen is edge-to-edge, so the bottom controls would otherwise tuck
  // behind the system navigation bar (whose buttons swallow taps meant for the
  // minimize button). Lift them by the bottom inset — the drawer card already
  // clears the nav bar, so it needs no offset.
  const insets = useSafeAreaInsets();
  const bottomInset = fullscreen ? insets.bottom : 0;

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const restartHideTimer = useCallback(() => {
    clearHideTimer();
    if (!playing) return; // Paused: keep the controls on screen.
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setControlsVisible(false);
    }, AUTO_HIDE_MS);
  }, [clearHideTimer, playing]);

  useEffect(() => {
    restartHideTimer();
    return clearHideTimer;
  }, [clearHideTimer, playing, restartHideTimer]);

  /** Any control interaction: ensure visible and reset the hide clock. */
  const touch = useCallback(() => {
    if (!controlsVisible) setControlsVisible(true);
    restartHideTimer();
  }, [controlsVisible, restartHideTimer]);

  return (
    <View className="absolute inset-0" pointerEvents="box-none">
      {controlsVisible ? (
        <>
          {/* Tap-anywhere to dismiss the controls while they're up. Rendered
              first (behind every control) so the transport/scrubber buttons on
              top still win their own taps; only bare-frame taps reach it. */}
          <Pressable
            accessibilityLabel="Hide player controls"
            accessibilityRole="button"
            className="absolute inset-0"
            onPress={() => setControlsVisible(false)}
          />
          {/* Soft bottom scrim: darkest at the bottom, fading to transparent. */}
          <Svg
            className="absolute inset-x-0 bottom-0"
            height={132}
            pointerEvents="none"
            width="100%"
          >
            <Defs>
              <LinearGradient id="scenePlayerScrim" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#000000" stopOpacity={0} />
                <Stop offset="0.55" stopColor="#000000" stopOpacity={0.35} />
                <Stop offset="1" stopColor="#000000" stopOpacity={0.65} />
              </LinearGradient>
            </Defs>
            <Rect fill="url(#scenePlayerScrim)" height={132} width="100%" x={0} y={0} />
          </Svg>

          {/* Centered transport deck — mirrors the native player's layout. */}
          <View
            className="absolute inset-0 flex-row items-center justify-center gap-9"
            pointerEvents="box-none"
          >
            <SkipButton
              direction="back"
              label="Back 5 seconds"
              seconds={5}
              onPress={() => {
                touch();
                onSeek(time - 5);
              }}
            />
            <Pressable
              accessibilityLabel={playing ? "Pause scene" : "Play scene"}
              accessibilityRole="button"
              className="h-14 w-14 items-center justify-center rounded-full active:opacity-70"
              onPress={() => {
                touch();
                onTogglePlay();
              }}
              style={{ backgroundColor: "#FFFFFF" }}
            >
              {playing ? (
                <Pause color="#111111" size={26} />
              ) : (
                <Play color="#111111" size={26} />
              )}
            </Pressable>
            <SkipButton
              direction="forward"
              label="Forward 15 seconds"
              seconds={15}
              onPress={() => {
                touch();
                onSeek(time + 15);
              }}
            />
          </View>

          {audioLoading ? (
            // Soundtrack is still fetching/decoding; keep it visible even when
            // the controls are hidden, mirroring the fullscreen corner icon.
            <View
              className="absolute left-3 top-3 flex-row items-center gap-1 rounded-full"
              pointerEvents="none"
              style={{ backgroundColor: "rgba(0,0,0,0.55)", paddingVertical: 5, paddingHorizontal: 9 }}
            >
              <ActivityIndicator color="#FFFFFF" size="small" />
              <Text className="text-[13px] font-medium text-white">
                Loading audio
              </Text>
            </View>
          ) : null}

          {/* Bottom scrim: scrubber line + time row, like the native chrome. */}
          <View
            className="absolute inset-x-0 bottom-0 gap-1.5 px-4 pt-8"
            pointerEvents="box-none"
            style={{ paddingBottom: 12 + bottomInset }}
          >
            <View className="min-w-0 flex-1">
              <Slider
                accessibilityLabel="Scene time"
                maximumValue={duration}
                minimumValue={0}
                onSlidingComplete={onScrubComplete}
                onSlidingStart={onScrubStart}
                onValueChange={(seconds) => {
                  touch();
                  onSeek(seconds);
                }}
                step={0.05}
                value={Math.min(time, duration)}
              />
            </View>
            <View
              className="flex-row items-center gap-1.5"
              pointerEvents="box-none"
            >
              <Text className="font-sans text-xs font-semibold text-white">
                {formatPlayerTime(time)}
              </Text>
              <Text className="font-sans text-xs text-white/50">·</Text>
              <Text className="font-sans text-xs text-white/80">
                {formatPlayerTime(duration)}
              </Text>
            </View>
          </View>

          {/* Fullscreen sits in the bottom-right corner, off the time row so
              the scrubber stays low and the row stays compact — like the native
              player's corner icon. */}
          {onToggleFullscreen ? (
            <Pressable
              accessibilityLabel={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              accessibilityRole="button"
              className="absolute right-2 h-9 w-9 items-center justify-center active:opacity-70"
              style={{ bottom: 8 + bottomInset }}
              onPress={() => {
                touch();
                onToggleFullscreen();
              }}
            >
              {fullscreen ? (
                <Minimize color="#FFFFFF" size={20} strokeWidth={2.2} />
              ) : (
                <Maximize color="#FFFFFF" size={20} strokeWidth={2.2} />
              )}
            </Pressable>
          ) : null}
        </>
      ) : (
        /* Hidden: a full-card transparent catch that restores the controls;
           pointerEvents stays box-none on the root, so this is the one target. */
        <Pressable
          accessibilityLabel="Show player controls"
          accessibilityRole="button"
          className="absolute inset-0"
          onPress={() => {
            setControlsVisible(true);
            restartHideTimer();
          }}
        />
      )}
    </View>
  );
}

/**
 * A circular skip button: lucide's circular-arrow icon with the seconds
 * numeral centered inside — the native player's skip glyph looks exactly
 * like this (arrow ring + number).
 */
function SkipButton({
  direction,
  label,
  seconds,
  onPress,
}: {
  direction: "back" | "forward";
  label: string;
  seconds: number;
  onPress: () => void;
}) {
  const Icon = direction === "back" ? RotateCcw : RotateCw;
  return (
    <Pressable
      accessibilityHint="Skips in the scene"
      accessibilityLabel={label}
      accessibilityRole="button"
      className="h-10 w-10 items-center justify-center active:opacity-70"
      onPress={onPress}
    >
      <View className="items-center justify-center">
        <Icon color="#FFFFFF" size={34} strokeWidth={2.2} />
        <Text
          className="absolute font-sans text-[10px] font-bold text-white"
          style={{ marginTop: 1 }}
        >
          {seconds}
        </Text>
      </View>
    </Pressable>
  );
}
