import { Component, type ReactNode, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { SvgXml } from "react-native-svg";

import { useTheme } from "@/hooks/use-theme";
import { renderMathToSvg, type MathSvg } from "@/modules/math/tex-to-svg";
import { MathFallback } from "@/components/ui/math-fallback";

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
  // MathJax conversion is synchronous and can block the JS thread. Compute it
  // after paint so the list can commit row layouts first — otherwise long
  // chats blank while a math row measures. First paint shows the raw-TeX
  // fallback, then upgrades to SVG (cached renders resolve near-instantly).
  const [rendered, setRendered] = useState<MathSvg | null | undefined>(
    undefined,
  );

  useEffect(() => {
    if (!source || source.length > MAX_MATH_TEX_LENGTH) {
      setRendered(null);
      return;
    }

    let cancelled = false;
    const timeout = setTimeout(() => {
      if (!cancelled) {
        setRendered(
          renderMathToSvg(source, {
            color: theme.text,
            fontSize: MATH_FONT_SIZE,
          }),
        );
      }
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
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
