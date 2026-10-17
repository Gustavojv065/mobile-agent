import {
  Brain,
  Lightbulb,
  Mail,
  Palette,
  type LucideIcon,
} from "lucide-react-native";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";

import { useTheme } from "@/hooks/use-theme";

export const STARTER_PROMPTS: { icon: LucideIcon; prompt: string; title: string }[] = [
  {
    icon: Palette,
    prompt: "Design a landing page",
    title: "Design a page",
  },
  {
    icon: Mail,
    prompt: "Draft a professional email",
    title: "Draft an email",
  },
  {
    icon: Lightbulb,
    prompt: "Brainstorm ideas for a side project",
    title: "Brainstorm ideas",
  },
  {
    icon: Brain,
    prompt: "Remember that I prefer concise answers",
    title: "Remember a preference",
  },
];

function getGreeting(date: Date) {
  const hour = date.getHours();

  if (hour < 5) {
    return "Working late";
  }

  if (hour < 12) {
    return "Good morning";
  }

  if (hour < 18) {
    return "Good afternoon";
  }

  return "Good evening";
}

function getSubline(agentName: string) {
  if (agentName === "build") {
    return "What should we build today?";
  }

  if (agentName === "plan") {
    return "What are we planning today?";
  }

  return "What can I help you with?";
}

export function EmptyState({
  agentName,
  onSelectPrompt,
}: {
  agentName: string;
  onSelectPrompt: (prompt: string) => void;
}) {
  const theme = useTheme();
  const greeting = useMemo(() => getGreeting(new Date()), []);
  const subline = useMemo(() => getSubline(agentName), [agentName]);
  const promptRows = useMemo(
    () =>
      [
        STARTER_PROMPTS.slice(0, 2),
        STARTER_PROMPTS.slice(2, 4),
      ] as const,
    [],
  );

  return (
    <View
      accessibilityLiveRegion="polite"
      className="gap-sp-5 px-sp-2 pt-sp-8"
    >
      <View className="gap-sp-1">
        <Text className="font-sans text-2xl font-semibold text-foreground dark:text-foreground-dark">
          {greeting}
        </Text>
        <Text className="font-sans text-base text-muted-foreground dark:text-muted-foreground-dark">
          {subline}
        </Text>
      </View>

      <View className="gap-sp-2">
        {promptRows.map((row, rowIndex) => (
          <View className="flex-row gap-sp-2" key={`starter-row-${rowIndex}`}>
            {row.map(({ icon: Icon, prompt, title }) => (
              <Pressable
                accessibilityLabel={prompt}
                accessibilityRole="button"
                className="flex-1 gap-sp-2 rounded-ui border border-border bg-card px-sp-3 py-sp-3 dark:border-border-dark dark:bg-card-dark"
                key={prompt}
                onPress={() => {
                  onSelectPrompt(prompt);
                }}
                style={({ pressed }) => (pressed ? { opacity: 0.85 } : null)}
              >
                <View className="h-8 w-8 items-center justify-center rounded-full bg-secondary dark:bg-secondary-dark">
                  <Icon color={theme.text} size={16} />
                </View>
                <Text
                  className="font-sans text-sm font-medium text-foreground dark:text-foreground-dark"
                  numberOfLines={2}
                >
                  {title}
                </Text>
              </Pressable>
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}
