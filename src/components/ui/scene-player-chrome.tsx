import { Pause, Play, RotateCcw, RotateCw } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";

import { Slider } from "@/components/ui/slider";
import { formatPlayerTime } from "@/modules/preview/scene-player";

export type ScenePlayerChromeProps = {
  playing: boolean;
  time: number;
  duration: number;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
};

/**
 * In-frame player chrome for scene previews, laid out to read exactly like
 * the native video player chrome (centered transport deck over the frame,
 * scrubber + times along the bottom). Only controls that work on an HTML
 * scene are rendered — second-jumps/play/scrub — so nothing here is a dead
 * button: the gear (playback speed) and fullscreen of the native deck are
 * deliberately absent.
 *
 * The whole overlay is `box-none`: taps fall through to the WebView except
 * on the controls themselves.
 */
export function ScenePlayerChrome({
  playing,
  time,
  duration,
  onTogglePlay,
  onSeek,
}: ScenePlayerChromeProps) {
  return (
    <View className="absolute inset-0" pointerEvents="box-none">
      {/* Centered transport deck — mirrors the native player's layout. */}
      <View
        className="absolute inset-0 flex-row items-center justify-center gap-9"
        pointerEvents="box-none"
      >
        <SkipButton
          direction="back"
          label="Back 5 seconds"
          seconds={5}
          onPress={() => onSeek(time - 5)}
        />
        <Pressable
          accessibilityLabel={playing ? "Pause scene" : "Play scene"}
          accessibilityRole="button"
          className="h-14 w-14 items-center justify-center rounded-full active:opacity-70"
          onPress={onTogglePlay}
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
          onPress={() => onSeek(time + 15)}
        />
      </View>

      {/* Bottom scrim: scrubber line + time row, like the native chrome. */}
      <View
        className="absolute inset-x-0 bottom-0 gap-2 px-4 pb-3 pt-8"
        style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
        pointerEvents="box-none"
      >
        <View
          className="flex-row items-center gap-3"
          pointerEvents="box-none"
        >
          <View className="min-w-0 flex-1">
            <Slider
              accessibilityLabel="Scene time"
              maximumValue={duration}
              minimumValue={0}
              onValueChange={onSeek}
              step={0.05}
              value={Math.min(time, duration)}
            />
          </View>
        </View>
        <View
          className="flex-row items-center justify-between"
          pointerEvents="box-none"
        >
          <Text className="font-sans text-xs font-semibold text-white">
            {formatPlayerTime(time)}
          </Text>
          <Text className="font-sans text-xs text-white/80">
            {formatPlayerTime(duration)}
          </Text>
        </View>
      </View>
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
