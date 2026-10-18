import { useEffect, useRef, useState } from "react";
import { PanResponder, View } from "react-native";

import { computeSliderValue } from "@/components/ui/slider-math";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/core/utils";

export function Slider({
  accessibilityLabel,
  disabled = false,
  maximumValue = 1,
  minimumValue = 0,
  onSlidingComplete,
  onSlidingStart,
  onValueChange,
  step = 0.01,
  value,
}: {
  accessibilityLabel?: string;
  disabled?: boolean;
  maximumValue?: number;
  minimumValue?: number;
  onSlidingComplete?: (value: number) => void;
  onSlidingStart?: () => void;
  onValueChange: (value: number) => void;
  step?: number;
  value: number;
}) {
  const theme = useTheme();
  const trackWidthRef = useRef(0);
  const trackLeftRef = useRef(0);
  const [trackWidth, setTrackWidth] = useState(0);

  // The pan handlers are created once below, so they read everything except
  // geometry through this ref: props/state captured directly closed over the
  // first render (notably trackWidth === 0), which made drags jump to the end
  // and taps seek the wrong place.
  const latest = useRef({ disabled, maximumValue, minimumValue, onValueChange, onSlidingComplete, onSlidingStart, step });
  useEffect(() => {
    latest.current = { disabled, maximumValue, minimumValue, onValueChange, onSlidingComplete, onSlidingStart, step };
  });
  const lastValueRef = useRef(value);
  const nodeRef = useRef<View | null>(null);

  const applyFromPageX = (pageX: number) => {
    const props = latest.current;
    if (props.disabled) return;
    // The ref callback measures after layout, so geometry is normally cached;
    // grant (below) re-measures, keeping this safe after layout shifts.
    const relative = pageX - trackLeftRef.current;
    const next = computeSliderValue(relative, trackWidthRef.current, props);
    lastValueRef.current = next;
    props.onValueChange(next);
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !latest.current.disabled,
      onMoveShouldSetPanResponder: () => !latest.current.disabled,
      onPanResponderGrant: (event) => {
        const props = latest.current;
        if (props.disabled) return;
        props.onSlidingStart?.();
        // Re-measure at grant: layout may have moved since the callback ran.
        nodeRef.current?.measureInWindow((x, _y, width) => {
          if (width > 0) trackWidthRef.current = width;
          if (x >= 0) trackLeftRef.current = x;
          applyFromPageX(event.nativeEvent.pageX);
        });
      },
      onPanResponderMove: (event) => {
        applyFromPageX(event.nativeEvent.pageX);
      },
      onPanResponderRelease: () => {
        latest.current.onSlidingComplete?.(lastValueRef.current);
      },
      onPanResponderTerminate: () => {
        latest.current.onSlidingComplete?.(lastValueRef.current);
      },
    }),
  ).current;

  const progress =
    maximumValue === minimumValue ? 0 : (value - minimumValue) / (maximumValue - minimumValue);
  const normalized = Math.max(0, Math.min(1, progress));
  const thumbRadius = 10;
  const fillWidth = normalized * trackWidth;
  const thumbLeft = Math.max(
    thumbRadius,
    Math.min(trackWidth - thumbRadius, trackWidth * normalized),
  );

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="adjustable"
      className="py-sp-2"
    >
      <View
        ref={(node) => {
          nodeRef.current = node;
          if (node) {
            node.measureInWindow((x, _y, measuredWidth) => {
              if (measuredWidth > 0 && measuredWidth !== trackWidthRef.current) {
                trackWidthRef.current = measuredWidth;
                setTrackWidth(measuredWidth);
              }
              trackLeftRef.current = x;
            });
          }
        }}
        {...panResponder.panHandlers}
        className={cn(
          "relative h-6 justify-center",
          disabled && "opacity-50",
        )}
      >
        <View className="h-1.5 w-full rounded-full bg-border dark:bg-border-dark" />
        <View
          pointerEvents="none"
          className="absolute h-1.5 rounded-full bg-accent dark:bg-accent"
          style={{ width: fillWidth }}
        />
        <View
          pointerEvents="none"
          className="absolute h-5 w-5 rounded-full shadow-md"
          style={{
            backgroundColor: theme.accent,
            left: thumbLeft - thumbRadius,
            borderColor: theme.accentForeground,
          }}
        />
      </View>
    </View>
  );
}
