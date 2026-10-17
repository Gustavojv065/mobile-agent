import { useCallback, useMemo } from "react";
import { StyleSheet } from "react-native";
import Markdown, { MarkdownIt } from "react-native-markdown-display";

import { useTheme } from "@/hooks/use-theme";
import { openExternalLink } from "@/modules/chat/open-link";

const MARKDOWN_PARSER = MarkdownIt({
  breaks: true,
  linkify: true,
  typographer: true,
});

/**
 * Themed markdown for non-chat surfaces (skill files, release notes…).
 *
 * Reuses the renderer the app already ships instead of a bespoke block parser;
 * links open in the in-app browser unless the caller handles them itself.
 */
export function MarkdownView({
  children,
  onLinkPress,
}: {
  children: string;
  /** Return `false` when you have handled the URL yourself, so the library's
   * own `Linking.openURL` fallback does not also fire. */
  onLinkPress?: (url: string) => boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => createMarkdownStyles(theme), [theme]);
  const handleLinkPress = useCallback(
    (url: string) => {
      if (onLinkPress) {
        return onLinkPress(url);
      }

      openExternalLink(url).catch(console.error);
      return false;
    },
    [onLinkPress],
  );

  if (!children.trim()) {
    return null;
  }

  return (
    <Markdown
      markdownit={MARKDOWN_PARSER}
      onLinkPress={handleLinkPress}
      style={styles}
    >
      {children}
    </Markdown>
  );
}

function createMarkdownStyles(theme: ReturnType<typeof useTheme>) {
  return {
    body: {
      color: theme.text,
      fontFamily: "System",
      fontSize: 15,
      lineHeight: 22,
      margin: 0,
    },
    bullet_list: {
      marginBottom: 10,
      marginTop: 2,
    },
    bullet_list_content: {
      flex: 1,
    },
    bullet_list_icon: {
      color: theme.text,
      marginRight: 8,
      width: 12,
    },
    ordered_list: {
      marginBottom: 10,
      marginTop: 2,
    },
    ordered_list_icon: {
      color: theme.text,
      marginRight: 8,
      width: 12,
    },
    code_block: {
      backgroundColor: theme.backgroundElement,
      borderRadius: 12,
      color: theme.text,
      fontFamily: "monospace",
      fontSize: 13,
      lineHeight: 20,
      marginBottom: 10,
      marginTop: 4,
      padding: 10,
    },
    code_inline: {
      backgroundColor: theme.backgroundSelected,
      borderRadius: 6,
      color: theme.text,
      fontFamily: "monospace",
      fontSize: 13,
      paddingHorizontal: 5,
      paddingVertical: 1,
    },
    fence: {
      backgroundColor: theme.backgroundElement,
      borderRadius: 12,
      color: theme.text,
      fontFamily: "monospace",
      fontSize: 13,
      lineHeight: 20,
      marginBottom: 10,
      marginTop: 4,
      padding: 10,
    },
    blockquote: {
      borderColor: theme.border,
      borderLeftWidth: 3,
      color: theme.textSecondary,
      marginBottom: 10,
      marginTop: 2,
      paddingLeft: 10,
    },
    heading1: {
      color: theme.text,
      fontSize: 24,
      fontWeight: "700",
      lineHeight: 31,
      marginBottom: 8,
      marginTop: 0,
    },
    heading2: {
      color: theme.text,
      fontSize: 20,
      fontWeight: "700",
      lineHeight: 27,
      marginBottom: 6,
      marginTop: 8,
    },
    heading3: {
      color: theme.text,
      fontSize: 17,
      fontWeight: "700",
      lineHeight: 24,
      marginBottom: 4,
      marginTop: 6,
    },
    heading4: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "700",
      lineHeight: 22,
      marginBottom: 4,
      marginTop: 6,
    },
    heading5: {
      color: theme.text,
      fontSize: 14,
      fontWeight: "700",
      lineHeight: 21,
      marginBottom: 4,
      marginTop: 6,
    },
    heading6: {
      color: theme.textSecondary,
      fontSize: 13,
      fontWeight: "700",
      lineHeight: 20,
      marginBottom: 4,
      marginTop: 6,
    },
    hr: {
      backgroundColor: theme.border,
      height: 1,
      marginBottom: 12,
      marginTop: 8,
    },
    link: {
      color: theme.textSecondary,
      textDecorationLine: "underline",
    },
    paragraph: {
      marginBottom: 10,
      marginTop: 0,
    },
    strong: {
      fontWeight: "700",
    },
    em: {
      fontStyle: "italic",
    },
  } satisfies StyleSheet.NamedStyles<any>;
}
