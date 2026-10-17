import { useLocalSearchParams, useRouter } from "expo-router";
import { ChevronLeft } from "lucide-react-native";
import { Text, View } from "react-native";

import { Container } from "@/components/shared/container";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/components/ui/markdown-view";
import { useConfig } from "@/hooks/use-config";
import { useTheme } from "@/hooks/use-theme";
import { isBinaryMimeType } from "@/modules/skills/skill-files";

const MAX_TEXT_PREVIEW = 50_000;

export default function SkillFileScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { path, skillId } = useLocalSearchParams<{
    path: string;
    skillId: string;
  }>();
  const { skills } = useConfig();

  const skill = skills.find((item) => item.id === skillId);
  const file = skill?.skillFiles.find((item) => item.path === path);
  const binary = file ? isBinaryMimeType(file.mimeType) : false;
  const isMarkdown = Boolean(file?.path.toLowerCase().endsWith(".md"));

  if (!skill || !file) {
    return (
      <Container
        scroll
        contentClassName="gap-sp-4 py-sp-4"
        includeBottomTabInset={false}
      >
        <Header title="Skill file" onBack={() => router.back()} theme={theme.text} />
        <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
          File not found.
        </Text>
      </Container>
    );
  }

  const preview = file.content.length > MAX_TEXT_PREVIEW
    ? `${file.content.slice(0, MAX_TEXT_PREVIEW)}\n… [truncated]`
    : file.content;
  const renderedPreview = isMarkdown ? stripYamlFrontmatter(preview) : preview;

  return (
    <Container includeBottomTabInset={false} scroll contentClassName="gap-sp-4 py-sp-4">
      <Header
        title={file.path.split("/").pop() ?? file.path}
        onBack={() => router.back()}
        theme={theme.text}
      />

      {binary ? (
        <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
          This is a binary file, so its contents are not shown here. The
          assistant can still read it when using this skill.
        </Text>
      ) : isMarkdown ? (
        <>
          <MarkdownView>{renderedPreview}</MarkdownView>
          {file.content.length > MAX_TEXT_PREVIEW ? (
            <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">
              … [truncated]
            </Text>
          ) : null}
        </>
      ) : (
        <Text selectable style={{ color: theme.text, fontFamily: "monospace", fontSize: 13, lineHeight: 20 }}>
          {preview}
        </Text>
      )}
    </Container>
  );
}

function stripYamlFrontmatter(markdown: string) {
  return markdown.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
}

function Header({
  onBack,
  theme,
  title,
}: {
  onBack: () => void;
  theme: string;
  title: string;
}) {
  return (
    <View className="flex-row items-center gap-sp-2">
      <Button
        leftIcon={<ChevronLeft color={theme} size={16} />}
        onPress={onBack}
        size="icon-xs"
        variant="ghost"
      />
      <Text className="min-w-0 flex-1 font-sans text-xl font-semibold text-foreground dark:text-foreground-dark">
        {title}
      </Text>
    </View>
  );
}
