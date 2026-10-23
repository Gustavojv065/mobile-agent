import { Image } from "expo-image";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Rect } from "react-native-svg";

import { sceneExportGeometry, type SceneExportPhase } from "@/modules/preview/scene-export-layout";

/** Static poster only: no live WebView/decoder or player chrome during export. */
export function SceneExportOverlay({
  phase,
  progress,
  posterUri,
}: {
  phase: SceneExportPhase;
  progress: number;
  posterUri?: string | null;
}) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [failedPoster, setFailedPoster] = useState<string | null>(null);
  const geometry = sceneExportGeometry(box.width, box.height, progress);
  const label = phase === "preparing" ? "Preparing export" : phase === "finishing" ? "Saving video…" : "Exporting video";

  return (
    <View
      accessibilityLabel={`${label}, ${geometry.percent} percent`}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: geometry.percent }}
      onLayout={({ nativeEvent: { layout } }) => setBox((previous) =>
        previous.width === layout.width && previous.height === layout.height
          ? previous : { width: layout.width, height: layout.height },
      )}
      style={[
        phase === "preparing" ? StyleSheet.absoluteFill : { flex: 1, width: "100%", height: "100%" },
        { backgroundColor: "#101217", overflow: "hidden" },
      ]}
    >
      {posterUri && failedPoster !== posterUri ? (
        <Image
          accessible={false}
          blurRadius={14}
          cachePolicy="none"
          contentFit="cover"
          onError={() => setFailedPoster(posterUri)}
          source={{ uri: posterUri }}
          style={{ position: "absolute", inset: -16, opacity: 0.45 }}
        />
      ) : null}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(7,9,13,0.45)" }]} pointerEvents="none" />
      {geometry.perimeter > 0 ? (
        <Svg height={box.height} width={box.width} style={{ position: "absolute", inset: 0 }} pointerEvents="none">
          {geometry.length > 0 ? (
            <Rect
              fill="none"
              x={geometry.inset} y={geometry.inset}
              width={geometry.width} height={geometry.height} rx={geometry.radius}
              stroke="#FFFFFF" strokeLinecap="round" strokeWidth={geometry.strokeWidth}
              strokeDasharray={`${geometry.length} ${geometry.perimeter}`}
            />
          ) : null}
        </Svg>
      ) : null}
      <View
        style={{ flex: 1, alignItems: "center", justifyContent: "center", elevation: 2 }}
        pointerEvents="none"
      >
        <Text
          style={{ color: "#FFFFFF", fontSize: 40, lineHeight: 48, fontWeight: "600", includeFontPadding: false, fontVariant: ["tabular-nums"] }}
        >
          {geometry.percent === 100 ? "100" : geometry.percent.toFixed(1)}%
        </Text>
      </View>
    </View>
  );
}
