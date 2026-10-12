import { Component, type ReactNode, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";

import { useTheme } from "@/hooks/use-theme";
import { renderMathToSvg } from "@/modules/math/tex-to-svg";

/** Guard against pathological fences; longer sources render as raw TeX. */
const MAX_MATH_TEX_LENGTH = 5000;
const MATH_FONT_SIZE = 16;

/** Catches `SvgXml` parse/render throws and drops back to the raw source. */
class MathRenderBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function MathFallback({ tex }: { tex: string }) {
  return (
    <View className="my-1.5 max-w-full self-start rounded-2xl border border-border bg-secondary px-sp-3 py-sp-2 dark:border-border-dark dark:bg-secondary-dark">
      <Text
        selectable
        className="font-mono text-sm text-foreground dark:text-foreground-dark"
      >
        {tex}
      </Text>
    </View>
  );
}

/**
 * Display math (`$$…$$` / `\[…\]`) rendered as an SVG block.
 *
 * MathJax output is converted to a self-contained SVG (see `renderMathToSvg`)
 * and drawn with `SvgXml`. Wide equations scroll horizontally rather than
 * overflowing the message; the block is centred when it fits.
 */
export function MathBlock({ tex }: { tex: string }) {
  const theme = useTheme();
  const source = tex.trim();
  const rendered = useMemo(() => {
    if (!source || source.length > MAX_MATH_TEX_LENGTH) {
      return null;
    }

    return renderMathToSvg(source, {
      color: theme.text,
      fontSize: MATH_FONT_SIZE,
    });
  }, [source, theme.text]);

  if (!rendered) {
    return <MathFallback tex={source} />;
  }

  return (
    <MathRenderBoundary fallback={<MathFallback tex={source} />}>
      <View className="my-1 items-center">
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator={false}
          style={{ maxWidth: "100%" }}
        >
          <SvgXml
            height={rendered.height}
            width={rendered.width}
            xml={rendered.svg}
          />
        </ScrollView>
      </View>
    </MathRenderBoundary>
  );
}
