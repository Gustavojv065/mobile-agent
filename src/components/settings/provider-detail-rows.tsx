import { Check } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { cn } from "@/core/utils";

export function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="min-h-14 flex-row items-center gap-sp-3 px-sp-4 py-sp-3">
      <Text className="flex-1 font-sans text-base text-foreground dark:text-foreground-dark">
        {label}
      </Text>
      <Text className="max-w-40 text-right font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
        {value}
      </Text>
    </View>
  );
}

export function ProviderModelRow({
  capabilityBadges,
  checkColor,
  current = false,
  disabled = false,
  label,
  modelId,
  onPress,
  stateLabel,
}: {
  capabilityBadges: string[];
  checkColor: string;
  current?: boolean;
  disabled?: boolean;
  label: string;
  modelId: string;
  onPress: () => void;
  stateLabel: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: current, disabled }}
      disabled={disabled}
      className="min-h-14 flex-row items-center gap-sp-3 px-sp-4 py-sp-3"
      onPress={onPress}
      style={({ pressed }) => (pressed ? { opacity: 0.82 } : null)}
    >
      <View className="flex-1 gap-1">
        <Text className="font-sans text-base text-foreground dark:text-foreground-dark">
          {label}
        </Text>
        <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">
          {modelId}
        </Text>
        {capabilityBadges.length > 0 ? (
          <View className="flex-row flex-wrap gap-1 pt-1">
            {capabilityBadges.map((badge) => (
              <View
                key={badge}
                className="rounded-full border border-border px-2 py-1 dark:border-border-dark"
              >
                <Text className="font-sans text-[11px] text-muted-foreground dark:text-muted-foreground-dark">
                  {badge}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
      <Text
        className={cn(
          "font-sans text-sm",
          current
            ? "text-foreground dark:text-foreground-dark"
            : "text-muted-foreground dark:text-muted-foreground-dark",
        )}
      >
        {stateLabel}
      </Text>
      {current ? <Check color={checkColor} size={18} /> : null}
    </Pressable>
  );
}
