import { cva, type VariantProps } from "class-variance-authority";
import { Check, Copy } from "lucide-react-native";
import {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type ForwardedRef,
  type ReactElement,
  type ReactNode,
} from "react";
import * as Clipboard from "expo-clipboard";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { cn } from "@/core/utils";
import { useTheme } from "@/hooks/use-theme";
import {
  renderCodeRuns,
  useHighlightedCode,
  type SyntaxRun,
} from "@/modules/chat/syntax-highlight";

/**
 * shadcn `code-block` ported to React Native, following the shipped web
 * implementation's layout metrics (padding rhythm, font sizes, spacing,
 * border/background treatment) while keeping the app's own font stack and
 * the shared refractor highlighter:
 *
 * CodeBlock
 * ├── CodeBlockHeader
 * │   ├── CodeBlockTitle (font-sans medium; leading icon allowed)
 * │   └── CodeBlockActions
 * │       └── CodeBlockCopyButton
 * ├── CodeBlockContent (string, or CodeBlockLine children)
 * │   └── CodeBlockLine
 * └── CodeBlockFooter
 *
 * A plain string child renders as one text node, so a streaming block stays
 * cheap. Give `CodeBlockContent` a `language` (or per-line `CodeBlockLine`
 * children carrying `SyntaxRun`s from the shared `useHighlightedCode` hook)
 * and it highlights; `"ansi"` renders terminal output with SGR colors, and a
 * language that is not registered renders as plain text.
 *
 * Long lines scroll horizontally by default. `wrap` wraps them instead, which
 * suits tool output — the thing the `sm` size (tighter padding, smaller code)
 * was made for inside a `Trace` or under a terminal command.
 */

const blockVariants = cva(
  "w-full overflow-hidden rounded-2xl bg-secondary text-sm dark:bg-secondary-dark",
  {
    variants: {
      variant: {
        default:
          "border border-border text-foreground dark:border-border-dark dark:text-foreground-dark",
        destructive:
          "border border-destructive/30 text-destructive dark:border-destructive-dark/40 dark:text-destructive-dark",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type CodeBlockVariant = NonNullable<
  VariantProps<typeof blockVariants>["variant"]
>;
type CodeBlockSize = "default" | "sm";

type CodeBlockContextValue = {
  size: CodeBlockSize;
  variant: CodeBlockVariant;
  hasHeader: boolean;
  hasFooter: boolean;
  registerHeader: (present: boolean) => void;
  registerFooter: (present: boolean) => void;
};

const CodeBlockContext = createContext<CodeBlockContextValue>({
  size: "default",
  variant: "default",
  hasHeader: false,
  hasFooter: false,
  registerHeader: () => {},
  registerFooter: () => {},
});

/**
 * Code typography: `text-sm leading-relaxed` (14 / 22.75) by default,
 * `text-xs` (12 / 19.5) for the `sm` size — the shadcn metrics.
 */
function contentTextStyle(size: CodeBlockSize) {
  return size === "sm"
    ? ({ fontSize: 12, lineHeight: 19.5 } as const)
    : ({ fontSize: 14, lineHeight: 22.75 } as const);
}

/**
 * The shipped paddings: base `px-3 py-3`, `pt-2` under a header, `pb-2`
 * above a footer; the `sm` size tightens to 2.5 (and `pt-1.5` under a
 * header). Computed as inline style so sibling presence can influence it
 * without CSS sibling selectors.
 */
function contentPadding(
  size: CodeBlockSize,
  hasHeader: boolean,
  hasFooter: boolean,
) {
  const base = size === "sm" ? 10 : 12;
  const top = hasHeader ? (size === "sm" ? 6 : 8) : base;
  const bottom = hasFooter ? (size === "sm" ? 10 : 8) : base;
  return {
    paddingTop: top,
    paddingBottom: bottom,
    paddingLeft: base,
    paddingRight: base,
  };
}

export type CodeBlockProps = Omit<
  ComponentPropsWithoutRef<typeof View>,
  "children"
> & {
  children: ReactNode;
  className?: string;
  variant?: CodeBlockVariant;
  /** `"sm"` has tighter padding and smaller code, for tool output. */
  size?: CodeBlockSize;
};

/** The surface that holds the header, the content and the footer. */
export const CodeBlock = forwardRef<ComponentRef<typeof View>, CodeBlockProps>(
  (
    { children, className, size = "default", variant = "default", ...props },
    ref,
  ) => {
    const [hasHeader, setHasHeader] = useState(false);
    const [hasFooter, setHasFooter] = useState(false);

    const value = useMemo(
      () => ({
        size: size,
        variant: variant,
        hasHeader,
        hasFooter,
        registerHeader: setHasHeader,
        registerFooter: setHasFooter,
      }),
      [size, variant, hasHeader, hasFooter],
    );

    return (
      <CodeBlockContext.Provider value={value}>
        <View
          ref={ref}
          className={cn(
            blockVariants({ variant: variant }),
            size === "sm" ? "text-xs" : "text-sm",
            className,
          )}
          {...props}
        >
          {children}
        </View>
      </CodeBlockContext.Provider>
    );
  },
);

CodeBlock.displayName = "CodeBlock";

export type CodeBlockHeaderProps = ComponentPropsWithoutRef<typeof View> & {
  className?: string;
};

/** A row above the content for a title and actions. No separator — the gap to the code is spacing (`pt-3`, code `pt-2`). */
export const CodeBlockHeader = forwardRef<
  ComponentRef<typeof View>,
  CodeBlockHeaderProps
>(({ className, ...props }, ref) => {
  const { size, variant, registerHeader } = useContext(CodeBlockContext);

  useEffect(() => {
    registerHeader(true);
    return () => registerHeader(false);
  }, [registerHeader]);

  const padding = size === "sm" ? "px-2.5 pt-2.5" : "px-3 pt-3";
  const tone =
    variant === "destructive"
      ? "text-destructive dark:text-destructive-dark"
      : "text-muted-foreground dark:text-muted-foreground-dark";

  return (
    <View
      ref={ref}
      className={cn("min-w-0 flex-row items-center gap-2", padding, tone, className)}
      {...props}
    />
  );
});

CodeBlockHeader.displayName = "CodeBlockHeader";

export type CodeBlockTitleProps = ComponentPropsWithoutRef<typeof Text> & {
  className?: string;
  children?: ReactNode;
};

/**
 * A filename or a label — `font-sans font-medium`, foreground colored. It
 * truncates; a leading icon (e.g. `<Terminal size={14} />`) is sized and
 * colored to match, the way the web port styles title icons.
 */
export const CodeBlockTitle = forwardRef<
  ComponentRef<typeof Text>,
  CodeBlockTitleProps
>(function CodeBlockTitleImpl({ children, className, ...props }, ref) {
  const { size, variant } = useContext(CodeBlockContext);
  const theme = useTheme();

  const tone =
    variant === "destructive"
      ? "text-destructive dark:text-destructive-dark"
      : "text-foreground dark:text-foreground-dark";
  const textClass = cn(
    "min-w-0 font-sans font-medium",
    size === "sm" ? "text-xs" : "text-sm",
    tone,
    className,
  );

  const parts = Children.toArray(children);
  const hasIcon = parts.some((part) => isValidElement(part));

  if (!hasIcon) {
    return (
      <Text
        ref={ref}
        className={textClass}
        numberOfLines={1}
        style={{ flexShrink: 1 }}
        {...props}
      >
        {children}
      </Text>
    );
  }

  const iconColor =
    variant === "destructive" ? theme.destructive : theme.text;

  return (
    <View className={cn("min-w-0 flex-row items-center gap-1.5", className)}>
      {parts.map((part, index) =>
        isValidElement(part) ? (
          cloneElement(
            part as ReactElement<{ color?: string; size?: number }>,
            {
              key: `title-part-${index}`,
              color:
                (part.props as { color?: string }).color ?? iconColor,
              size: (part.props as { size?: number }).size ?? 14,
            },
          )
        ) : (
          <Text
            key={`title-part-${index}`}
            className={textClass}
            numberOfLines={1}
            style={{ flexShrink: 1 }}
            {...props}
          >
            {part}
          </Text>
        ),
      )}
    </View>
  );
});

CodeBlockTitle.displayName = "CodeBlockTitle";

export type CodeBlockActionsProps = ComponentPropsWithoutRef<typeof View> & {
  className?: string;
};

/**
 * Holds buttons at the end of the header (`ms-auto`), pulled 6px toward the
 * edge so icon buttons optically align with the 12px content padding, the
 * same `-me-1.5` compensation the web port ships.
 */
export const CodeBlockActions = forwardRef<
  ComponentRef<typeof View>,
  CodeBlockActionsProps
>(({ className, style, ...props }, ref) => {
  return (
    <View
      ref={ref}
      className={cn("flex-row items-center gap-1", className)}
      style={[
        { marginLeft: "auto", marginEnd: -6, marginVertical: -4 },
        style,
      ]}
      {...props}
    />
  );
});

CodeBlockActions.displayName = "CodeBlockActions";

const COPIED_RESET_MS = 2000;

export type CodeBlockCopyButtonProps = {
  /** The text to copy. */
  value: string;
  className?: string;
  disabled?: boolean;
};

/**
 * Ghost `icon-xs` button that copies `value` to the clipboard: 24×24, 8px
 * radius, 12px icon, foreground colored — the shadcn metrics.
 */
export function CodeBlockCopyButton({
  className,
  disabled = false,
  value,
}: CodeBlockCopyButtonProps) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const Icon = copied ? Check : Copy;

  return (
    <Pressable
      accessibilityLabel={copied ? "Copied" : "Copy"}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      className={cn(
        "h-6 w-6 items-center justify-center rounded-lg",
        className,
      )}
      disabled={disabled}
      onPress={() => {
        Clipboard.setStringAsync(value)
          .then(() => {
            setCopied(true);

            if (timeoutRef.current !== null) {
              clearTimeout(timeoutRef.current);
            }

            timeoutRef.current = setTimeout(() => {
              setCopied(false);
            }, COPIED_RESET_MS);
          })
          .catch(() => {
            Alert.alert("Copy failed", "The content could not be copied.");
          });
      }}
      style={({ pressed }) =>
        pressed ? { backgroundColor: theme.backgroundSelected } : null
      }
    >
      <>
        <Icon color={theme.text} size={12} />
        {/*
          Polite live region that announces "Copied" once a copy succeeds.
        */}
        <View accessibilityLiveRegion="polite" className="hidden">
          <Text>{copied ? "Copied" : ""}</Text>
        </View>
      </>
    </Pressable>
  );
}

// ——— Content —————————————————————————————————————————————————————————————

export type CodeBlockContentProps = Omit<
  ComponentPropsWithoutRef<typeof View>,
  "children"
> & {
  children?: string | ReactNode;
  /** Wrap long lines instead of scrolling horizontally. */
  wrap?: boolean;
  /** Number each line. A string child is split into lines. */
  lineNumbers?: boolean;
  /** The number of the first line, when `lineNumbers` is set. */
  startLine?: number;
  /**
   * Convenience highlighting for a string child: a language from the shared
   * highlighter (`tsx`, `json`, …) or `"ansi"` for terminal output.
   */
  language?: string;
  className?: string;
};

/**
 * Layout handed down to `CodeBlockLine` children by `CodeBlockContent`, so a
 * gutter works without the caller passing numbers around.
 */
type CodeBlockLineLayout = {
  gutter: number | null;
  lineNumber: number;
  size: CodeBlockSize;
  textColor: string;
};

const CodeBlockLineLayoutContext = createContext<CodeBlockLineLayout>({
  gutter: null,
  lineNumber: 1,
  size: "default",
  textColor: "#000000",
});

/** Line-variant tints and the diff markers. */
type CodeBlockRowVariant = "default" | "added" | "removed" | "highlighted";

const lineRowVariants = cva("min-w-full flex-row items-start", {
  variants: {
    variant: {
      default: "",
      added: "bg-green-600/15 dark:bg-green-500/15",
      removed: "bg-destructive/10 dark:bg-destructive-dark/10",
      highlighted: "bg-muted dark:bg-muted-dark",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export const CodeBlockContent = forwardRef<
  ComponentRef<typeof View>,
  CodeBlockContentProps
>(function CodeBlockContentImpl(
  {
    children,
    className,
    language,
    lineNumbers = false,
    startLine = 1,
    wrap = false,
    ...props
  },
  ref,
) {
  const { size, hasHeader, hasFooter } = useContext(CodeBlockContext);
  const theme = useTheme();
  const textColor = theme.text;

  const stringCode = typeof children === "string" ? children : null;

  // Hook order must stay stable: call unconditionally, with empty inputs when
  // the child is not a string.
  const highlightedLines = useHighlightedCode(
    stringCode ?? "",
    language ?? "",
  );

  if (stringCode !== null) {
    return renderStringChild({
      className,
      code: stringCode,
      hasFooter,
      hasHeader,
      highlightedLines,
      lineNumbers,
      props,
      ref,
      size,
      startLine,
      textColor,
      wrap,
    });
  }

  // CodeBlockLine children: hand each line its layout through context so the
  // gutter comes for free, mirroring the shadcn composition.
  const lines = Children.toArray(children);
  const gutter = gutterWidth(startLine, lines.length, size);

  return (
    <CodeBlockScrollWrap className={className} ref={ref} wrap={wrap} {...props}>
      <View>
      {lines.map((line, index) =>
        isValidElement(line) &&
        (line.type as { displayName?: string }).displayName ===
          "CodeBlockLine" ? (
          <CodeBlockLineLayoutContext.Provider
            key={line.key ?? `line-${index}`}
            value={{
              gutter: lineNumbers ? gutter : null,
              lineNumber: startLine + index,
              size,
              textColor,
            }}
          >
            {line}
          </CodeBlockLineLayoutContext.Provider>
        ) : (
          line
        ),
      )}
      </View>
    </CodeBlockScrollWrap>
  );
});

CodeBlockContent.displayName = "CodeBlockContent";

function renderStringChild({
  className,
  code,
  hasFooter,
  hasHeader,
  highlightedLines,
  lineNumbers,
  props,
  ref,
  size,
  startLine,
  textColor,
  wrap,
}: {
  className?: string;
  code: string;
  hasFooter: boolean;
  hasHeader: boolean;
  highlightedLines: SyntaxRun[][] | null;
  lineNumbers: boolean;
  props: ComponentPropsWithoutRef<typeof View>;
  ref: ForwardedRef<ComponentRef<typeof View>>;
  size: CodeBlockSize;
  startLine: number;
  textColor: string;
  wrap: boolean;
}) {
  const textStyles = contentTextStyle(size);
  const padding = contentPadding(size, hasHeader, hasFooter);

  if (highlightedLines === null) {
    // Plain string, one text node.
    return (
      <CodeBlockScrollWrap className={className} ref={ref} wrap={wrap} {...props}>
        <Text
          selectable
          style={[
            textStyles,
            padding,
            { color: textColor, fontFamily: "monospace" },
          ]}
        >
          {code}
        </Text>
      </CodeBlockScrollWrap>
    );
  }

  if (!lineNumbers) {
    // Highlighted, no gutter: nested text inside one native Text node — the
    // cheapest representation for a block that streams.
    return (
      <CodeBlockScrollWrap className={className} ref={ref} wrap={wrap} {...props}>
        <Text
          accessibilityLiveRegion="polite"
          selectable
          style={[
            textStyles,
            padding,
            { color: textColor, fontFamily: "monospace" },
          ]}
        >
          {highlightedLines.map((runs, index) => (
            <Text key={index}>
              {index > 0 ? "\n" : null}
              {runs.length > 0 ? (
                <HighlightedRuns runs={runs} textColor={textColor} />
              ) : null}
            </Text>
          ))}
        </Text>
      </CodeBlockScrollWrap>
    );
  }

  const gutter = gutterWidth(startLine, highlightedLines.length, size);

  return (
    <CodeBlockScrollWrap className={className} ref={ref} wrap={wrap} {...props}>
      <View>
        {highlightedLines.map((runs, index) => (
          <CodeBlockRow
            gutter={gutter}
            key={index}
            lineNumber={startLine + index}
            runs={runs}
            size={size}
            textColor={textColor}
            variant="default"
          />
        ))}
      </View>
    </CodeBlockScrollWrap>
  );
}

/**
 * The gutter is `min-w-6` (24px) and grows to fit the widest number, with
 * 12px to the code — the `grid-cols-[auto_1fr] gap-x-3` of the web port.
 */
function gutterWidth(startLine: number, lineCount: number, size: CodeBlockSize) {
  const lastLineNumber = Math.max(
    startLine + Math.max(lineCount, 1) - 1,
    1,
  );
  const digits = String(lastLineNumber).length;
  const fontSize = contentTextStyle(size).fontSize;
  return Math.max(24, digits * fontSize * 0.6);
}

/** Horizontal scroll by default; vertical when wrapped. */
type CodeBlockScrollWrapProps = Omit<
  ComponentPropsWithoutRef<typeof View>,
  "children"
> & {
  children?: ReactNode;
  wrap: boolean;
};

const CodeBlockScrollWrap = forwardRef<
  ComponentRef<typeof View>,
  CodeBlockScrollWrapProps
>(function CodeBlockScrollWrapImpl(
  { children, className, wrap, ...props },
  ref,
) {
  if (wrap) {
    return (
      <View ref={ref} className={className} {...props}>
        <ScrollView
          className="flex-1"
          nestedScrollEnabled
          overScrollMode="never"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </View>
    );
  }

  return (
    <View ref={ref} className={className} {...props}>
      <ScrollView
        horizontal
        nestedScrollEnabled
        overScrollMode="never"
        showsHorizontalScrollIndicator
      >
        {children}
      </ScrollView>
    </View>
  );
});

/** Renders highlighted token runs; hook-based by design. */
function HighlightedRuns({
  runs,
  textColor,
}: {
  runs: SyntaxRun[];
  textColor: string;
}) {
  const theme = useTheme();

  return <>{renderCodeRuns(runs, textColor, theme)}</>;
}

type CodeBlockRowProps = {
  children?: ReactNode;
  className?: string;
  gutter?: number | null;
  lineNumber?: number;
  runs?: SyntaxRun[];
  size: CodeBlockSize;
  textColor: string;
  variant?: CodeBlockRowVariant;
};

const CodeBlockRow = forwardRef<ComponentRef<typeof View>, CodeBlockRowProps>(
  function CodeBlockRowImpl(
    {
      children,
      className,
      gutter,
      lineNumber,
      runs,
      size,
      textColor,
      variant = "default",
    },
    ref,
  ) {
    const theme = useTheme();
    const textStyles = contentTextStyle(size);
    const horizontalPadding = size === "sm" ? 10 : 12;
    const isDiff = variant === "added" || variant === "removed";

    return (
      <View
        className={cn(lineRowVariants({ variant: variant }), className)}
        ref={ref}
        style={{
          paddingLeft: horizontalPadding,
          paddingRight: horizontalPadding,
          position: "relative",
        }}
      >
        {isDiff ? (
          <Text
            accessible={false}
            style={[
              textStyles,
              {
                position: "absolute",
                left: 4,
                top: 0,
                color:
                  variant === "added" ? "#16a34a" : theme.destructive,
                fontFamily: "monospace",
              },
            ]}
          >
            {variant === "added" ? "+" : "−"}
          </Text>
        ) : null}
        {gutter != null && lineNumber != null ? (
          <Text
            accessible={false}
            style={[
              textStyles,
              {
                color: theme.textSecondary,
                flexShrink: 0,
                fontFamily: "monospace",
                textAlign: "right",
                width: gutter,
              },
            ]}
          >
            {lineNumber}
          </Text>
        ) : null}
        <View
          className="flex-1"
          style={gutter != null ? { marginLeft: 12 } : undefined}
        >
          {runs !== undefined && runs.length > 0 ? (
            <HighlightedRuns runs={runs} textColor={textColor} />
          ) : (
            children
          )}
        </View>
      </View>
    );
  },
);

// —─── Public per-line part ─────────────────────────────────────────────────

export type CodeBlockLineProps = {
  variant?: CodeBlockRowVariant;
  runs?: SyntaxRun[];
  children?: ReactNode;
  className?: string;
};

/**
 * One line of code. `variant="added"` / `"removed"` add a `+` / `−` marker and
 * a tint (`bg-muted` / `bg-destructive/10`), so a diff does not rely on color
 * alone; `variant="highlighted"` calls the line out.
 */
export const CodeBlockLine = forwardRef<
  ComponentRef<typeof View>,
  CodeBlockLineProps
>(function CodeBlockLineImpl(
  { children, className, runs, variant = "default" },
  ref,
) {
  const layout = useContext(CodeBlockLineLayoutContext);

  return (
    <CodeBlockRow
      className={className}
      gutter={layout.gutter}
      lineNumber={layout.gutter !== null ? layout.lineNumber : undefined}
      ref={ref}
      runs={runs}
      size={layout.size}
      textColor={layout.textColor}
      variant={variant}
    >
      {children}
    </CodeBlockRow>
  );
});

export type CodeBlockFooterProps = ComponentPropsWithoutRef<typeof View> & {
  className?: string;
};

/** A row below the content, e.g. for a Show More button. No separator — content padding tightens (`pb-2`) to sit closer. */
export const CodeBlockFooter = forwardRef<
  ComponentRef<typeof View>,
  CodeBlockFooterProps
>(({ className, ...props }, ref) => {
  const { size, variant, registerFooter } = useContext(CodeBlockContext);

  useEffect(() => {
    registerFooter(true);
    return () => registerFooter(false);
  }, [registerFooter]);

  const padding = size === "sm" ? "px-2.5 pb-2.5" : "px-3 pb-3";
  const tone =
    variant === "destructive"
      ? "text-destructive dark:text-destructive-dark"
      : "text-muted-foreground dark:text-muted-foreground-dark";

  return (
    <View
      ref={ref}
      className={cn("min-w-0 flex-row items-center gap-2", padding, tone, className)}
      {...props}
    />
  );
});

CodeBlockFooter.displayName = "CodeBlockFooter";
