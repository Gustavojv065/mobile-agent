import { FileText, X } from "lucide-react-native";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { getFilePreviewKind } from "@/components/ui/file-preview-dialog";
import { WorkspaceThumbnail } from "@/components/ui/workspace-thumbnail";
import { resolveWorkspaceFile } from "@/core/services/workspace-file-service";
import type { WorkspaceFile } from "@/core/types/app-state";
import { useTheme } from "@/hooks/use-theme";

/** Width of the non-image card, so a row of them keeps a stable rhythm. */
export const FILE_ATTACHMENT_CARD_WIDTH = 224;

export function isImageAttachment(file: WorkspaceFile) {
  return getFilePreviewKind(file) === "image";
}

export function isPreviewableAttachment(file: WorkspaceFile) {
  return Boolean(getFilePreviewKind(file));
}

export function formatFileSize(size: number | null | undefined) {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    return "Unknown size";
  }

  if (size < 1024) {
    return `${size} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 100 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 0)} ${units[unitIndex]}`;
}

/**
 * The single attachment card used everywhere a workspace file is shown next to
 * a message or the composer. Images render as a square thumbnail, everything
 * else as a labelled card. Kept in one place so the composer strip and the
 * sent message never drift apart.
 */
export function FileAttachmentCard({
  disabled = false,
  file,
  onPress,
  onRemove,
  opening = false,
}: {
  disabled?: boolean;
  file: WorkspaceFile;
  onPress?: () => void;
  onRemove?: () => void;
  opening?: boolean;
}) {
  const theme = useTheme();
  const interactive = !disabled && Boolean(onPress);

  if (isImageAttachment(file)) {
    return (
      <View className="relative h-16 w-16 shrink-0">
        <Pressable
          accessibilityLabel={`Preview ${file.displayName}`}
          accessibilityRole="button"
          className="h-16 w-16 overflow-hidden rounded-2xl border border-border bg-secondary dark:border-border-dark dark:bg-secondary-dark"
          disabled={!interactive}
          onPress={onPress}
          style={({ pressed }) => (pressed ? { opacity: 0.85 } : null)}
        >
          <WorkspaceThumbnail
            size={64}
            style={{ height: 64, width: 64 }}
            uri={resolveWorkspaceFile(file.relativePath).uri}
          />
        </Pressable>
        {opening ? (
          <View className="absolute inset-0 items-center justify-center rounded-2xl bg-black/40">
            <ActivityIndicator color="#ffffff" size="small" />
          </View>
        ) : onRemove ? (
          <Pressable
            accessibilityLabel={`Remove ${file.displayName}`}
            accessibilityRole="button"
            className="absolute right-1 top-1 h-6 w-6 items-center justify-center rounded-full bg-black/70"
            hitSlop={4}
            onPress={onRemove}
            style={({ pressed }) => (pressed ? { opacity: 0.7 } : null)}
          >
            <X color="#ffffff" size={13} />
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <View
      className="h-16 shrink-0 flex-row items-center gap-sp-2 rounded-2xl border border-border bg-card px-3 py-2 dark:border-border-dark dark:bg-card-dark"
      style={{ width: FILE_ATTACHMENT_CARD_WIDTH }}
    >
      <Pressable
        accessibilityLabel={`Preview ${file.displayName}`}
        accessibilityRole="button"
        className="min-w-0 flex-1 flex-row items-center gap-sp-2"
        disabled={!interactive}
        onPress={onPress}
        style={({ pressed }) => (pressed ? { opacity: 0.7 } : null)}
      >
        <FileText color={theme.textSecondary} size={16} />
        <View className="min-w-0 flex-1">
          <Text
            className="font-sans text-xs font-medium text-foreground dark:text-foreground-dark"
            numberOfLines={1}
          >
            {file.displayName}
          </Text>
          <Text
            className="font-sans text-[11px] text-muted-foreground dark:text-muted-foreground-dark"
            numberOfLines={1}
          >
            {formatFileSize(file.size)}
          </Text>
        </View>
      </Pressable>
      {opening ? (
        <ActivityIndicator color={theme.textSecondary} size="small" />
      ) : onRemove ? (
        <Pressable
          accessibilityLabel={`Remove ${file.displayName}`}
          accessibilityRole="button"
          className="h-6 w-6 items-center justify-center rounded-full bg-secondary dark:bg-secondary-dark"
          hitSlop={4}
          onPress={onRemove}
          style={({ pressed }) => (pressed ? { opacity: 0.6 } : null)}
        >
          <X color={theme.textSecondary} size={14} />
        </Pressable>
      ) : null}
    </View>
  );
}
