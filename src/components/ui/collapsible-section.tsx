import { ChevronDown } from "lucide-react-native";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { cn } from "@/core/utils";
import { useTheme } from "@/hooks/use-theme";

/** Animated disclosure chevron: rotates 180° with timing when toggled. */
export function CollapsibleChevron({
  color,
  expanded,
}: {
  color: string;
  expanded: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const rotation = useSharedValue(expanded ? 180 : 0);

  useEffect(() => {
    rotation.value = withTiming(expanded ? 180 : 0, {
      duration: reduceMotion ? 0 : 180,
      easing: Easing.inOut(Easing.quad),
    });

    return () => cancelAnimation(rotation);
  }, [expanded, reduceMotion, rotation]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View
      className="h-3.5 w-3.5 shrink-0 items-center justify-center"
      style={animatedStyle}
    >
      <ChevronDown color={color} size={14} />
    </Animated.View>
  );
}

export type CollapsibleSectionProps = {
  /** Text shown in the always-visible header row. */
  label: string;
  /** Optional leading icon rendered before the label. */
  icon?: ReactNode;
  /** Optional trailing node rendered after the chevron. */
  accessory?: ReactNode;
  /** Controlled expanded state. Omit to let the section manage its own. */
  expanded?: boolean;
  /** Initial state when uncontrolled. */
  defaultExpanded?: boolean;
  /** Called with the next state whenever the header is pressed. */
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
  headerClassName?: string;
  labelClassName?: string;
  contentClassName?: string;
  children?: ReactNode;
};

/**
 * A pressable header with an animated chevron and a collapsible body.
 *
 * Follows the shadcn `Collapsible` pattern: works controlled (`expanded` +
 * `onExpandedChange`) or uncontrolled (`defaultExpanded`). Chat message rows
 * keep the state themselves via `useRecyclingState` and pass it in controlled
 * so expansion survives FlashList recycling.
 */
export function CollapsibleSection({
  label,
  icon,
  accessory,
  expanded,
  defaultExpanded = false,
  onExpandedChange,
  className,
  headerClassName,
  labelClassName,
  contentClassName,
  children,
}: CollapsibleSectionProps) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const controlled = expanded !== undefined;
  const isExpanded = controlled ? expanded : internalExpanded;

  const toggle = () => {
    const next = !isExpanded;

    if (!controlled) {
      setInternalExpanded(next);
    }

    onExpandedChange?.(next);
  };

  return (
    <View className={cn("gap-sp-2", className)}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: isExpanded }}
        className={cn(
          "self-start flex-row items-center gap-sp-2",
          headerClassName,
        )}
        onPress={toggle}
        style={({ pressed }) => (pressed ? { opacity: 0.72 } : null)}
      >
        {icon}
        <Text
          className={cn(
            "font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark",
            labelClassName,
          )}
        >
          {label}
        </Text>
        <CollapsibleChevron color={theme.textSecondary} expanded={isExpanded} />
        {accessory}
      </Pressable>
      {isExpanded ? (
        <Animated.View
          className={contentClassName}
          entering={reduceMotion ? undefined : FadeIn.duration(180)}
        >
          {children}
        </Animated.View>
      ) : null}
    </View>
  );
}
