import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { cn } from "@/core/utils";

export type ChatMediaCardProps = {
  accessibilityHint?: string;
  accessibilityLabel?: string;
  children: ReactNode;
  className?: string;
  /** When set, the card is a button that opens the media preview. */
  onPress?: () => void;
};

/**
 * The single framed card shown around media in chat — bubble images, videos,
 * generated images and drawer previews all render inside one. Owns the frame
 * (radius, border, pressed fade) so every media surface stays identical;
 * callers provide the content and, when tappable, the preview handler.
 */
export function ChatMediaCard({
  accessibilityHint,
  accessibilityLabel,
  children,
  className,
  onPress,
}: ChatMediaCardProps) {
  const frameClassName = cn(
    "overflow-hidden rounded-card border border-border bg-secondary dark:border-border-dark dark:bg-secondary-dark",
    className,
  );

  if (!onPress) {
    return <View className={frameClassName}>{children}</View>;
  }

  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      className={frameClassName}
      onPress={onPress}
      style={({ pressed }) => (pressed ? { opacity: 0.9 } : null)}
    >
      {children}
    </Pressable>
  );
}
