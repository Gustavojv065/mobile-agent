import { cva } from "class-variance-authority";
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type ReactNode,
} from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { CollapsibleChevron } from "@/components/ui/collapsible-section";
import { cn } from "@/core/utils";
import { useTheme } from "@/hooks/use-theme";

/**
 * shadcn `trace` ported to React Native — the building block for reasoning,
 * tool calls, sources, plan steps and more:
 *
 * Trace
 * └── TraceLine
 *     ├── TraceIcon        (before the title it names the action;
 *     │                     after it, it is the indicator)
 *     ├── TraceTitle       (truncates, shimmers while `running`)
 *     └── TraceDescription (secondary text, never truncates)
 *
 * Wrap the line in `TraceCollapsible` to show more detail when it expands:
 *
 * Trace
 * └── TraceCollapsible
 *     ├── TraceCollapsibleTrigger  (a Pressable wrapping a TraceLine,
 *     │                             with the chevron appended)
 *     └── TraceCollapsibleContent  (muted detail, e.g. a small CodeBlock)
 *
 * `TraceLine` is always the line. To make a line do something, wrap it in that
 * thing's trigger — a collapsible trigger, a link or a dialog trigger.
 */

export type TraceStatus = "running" | "error" | "pending";

type TraceLineContextValue = {
  status: TraceStatus | undefined;
};

const TraceLineContext = createContext<TraceLineContextValue>({
  status: undefined,
});

export type TraceProps = ComponentPropsWithoutRef<typeof View> & {
  children?: ReactNode;
  className?: string;
};

/** A list of rows. */
export const Trace = forwardRef<ComponentRef<typeof View>, TraceProps>(
  ({ children, className, ...props }, ref) => {
    return (
      <View
        ref={ref}
        className={cn("flex-col gap-0.5", className)}
        {...props}
      >
        {children}
      </View>
    );
  },
);

Trace.displayName = "Trace";

const traceTitleVariants = cva("font-sans text-sm", {
  variants: {
    status: {
      none: "text-foreground dark:text-foreground-dark",
      running: "text-foreground dark:text-foreground-dark",
      error: "text-destructive dark:text-destructive-dark",
      pending: "text-muted-foreground dark:text-muted-foreground-dark",
    },
  },
  defaultVariants: {
    status: "none",
  },
});

export type TraceLineProps = ComponentPropsWithoutRef<typeof View> & {
  /** The state of the work the line reports. */
  status?: TraceStatus;
  className?: string;
};

/**
 * One line: an icon and a title. It is a plain view — wrap it in a trigger or
 * a link to make it do something. Wrap the children's title copy as a
 * sentence that says what happened, like "Edited trace.tsx".
 */
export const TraceLine = forwardRef<ComponentRef<typeof View>, TraceLineProps>(
  ({ children, className, status, ...props }, ref) => {
    return (
      <TraceLineContext.Provider value={{ status }}>
        <View
          ref={ref}
          className={cn("flex-row flex-wrap items-center gap-1.5", className)}
          {...props}
        >
          {children}
        </View>
      </TraceLineContext.Provider>
    );
  },
);

TraceLine.displayName = "TraceLine";

export type TraceIconProps = ComponentPropsWithoutRef<typeof View> & {
  className?: string;
};

/**
 * A decorative icon slot, hidden from assistive tech: `TraceTitle` is the
 * accessible name.
 */
export const TraceIcon = forwardRef<ComponentRef<typeof View>, TraceIconProps>(
  ({ className, ...props }, ref) => {
    return (
      <View
        ref={ref}
        accessibilityElementsHidden
        aria-hidden
        className={cn("shrink-0 items-center justify-center", className)}
        {...props}
      />
    );
  },
);

TraceIcon.displayName = "TraceIcon";

export type TraceTitleProps = ComponentPropsWithoutRef<typeof Text> & {
  className?: string;
};

/** One sentence on one line. It truncates and shimmers while the line runs. */
export const TraceTitle = forwardRef<
  ComponentRef<typeof Text>,
  TraceTitleProps
>(({ children, className, ...props }, ref) => {
  const { status } = useContext(TraceLineContext);
  const animated = status === "running";

  return (
    <Text
      ref={ref}
      className={cn(
        traceTitleVariants({ status: status ?? "none" }),
        "flex-1",
        className,
      )}
      numberOfLines={1}
      {...props}
    >
      {animated ? <Shimmer>{children}</Shimmer> : children}
    </Text>
  );
});

TraceTitle.displayName = "TraceTitle";

/**
 * Opacity pulse for a running row, matching the tool-run pulse pattern in the
 * chat message rows. Stops when the reader prefers reduced motion.
 */
function Shimmer({ children }: { children: ReactNode }) {
  const reduceMotion = useReducedMotion();

  return reduceMotion ? (
    <>{children}</>
  ) : (
    <PulsingText>{children}</PulsingText>
  );
}

const PulsingText = forwardRef<
  ComponentRef<typeof Text>,
  { children: ReactNode }
>(function PulsingTextImpl({ children }, ref) {
  const pulse = useSharedValue(1);

  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(0.55, { duration: 700, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );

    return () => {
      cancelAnimation(pulse);
    };
  }, [pulse]);

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: pulse.value,
  }));

  return (
    <Animated.Text ref={ref} style={pulseStyle}>
      {children}
    </Animated.Text>
  );
});

export type TraceDescriptionProps = ComponentPropsWithoutRef<
  typeof Text
> & {
  className?: string;
};

/** Secondary text after the title, such as a count or a duration. */
export const TraceDescription = forwardRef<
  ComponentRef<typeof Text>,
  TraceDescriptionProps
>(({ className, ...props }, ref) => {
  return (
    <Text
      ref={ref}
      className={cn(
        "flex-shrink font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark",
        className,
      )}
      {...props}
    />
  );
});

TraceDescription.displayName = "TraceDescription";

// —─── Collapsible row ──────────────────────────────────────────────────────

export type TraceCollapsibleProps = ComponentPropsWithoutRef<typeof View> & {
  children?: ReactNode;
  /** Start open. */
  defaultOpen?: boolean;
  className?: string;
  /** Controlled open state. Pass it with `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/** A row that expands. Controlled (`open` + `onOpenChange`) or uncontrolled. */
export const TraceCollapsible = forwardRef<
  ComponentRef<typeof View>,
  TraceCollapsibleProps
>(function TraceCollapsibleImpl(
  {
    children,
    className,
    defaultOpen = false,
    open,
    onOpenChange,
    ...props
  },
  ref,
) {
  const controlled = open !== undefined;
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isExpanded = controlled ? open : internalOpen;

  const setOpen = (next: boolean) => {
    if (!controlled) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  };

  return (
    <TraceOpenContext.Provider value={{ expanded: isExpanded, setOpen }}>
      <View
        ref={ref}
        className={cn("flex-col gap-0.5", className)}
        {...props}
      >
        {children}
      </View>
    </TraceOpenContext.Provider>
  );
});

type TraceOpenContextValue = {
  expanded: boolean;
  setOpen: (open: boolean) => void;
};

const TraceOpenContext = createContext<TraceOpenContextValue>({
  expanded: false,
  setOpen: () => {},
});

export type TraceCollapsibleTriggerProps = ComponentPropsWithoutRef<
  typeof Pressable
> & {
  children?: ReactNode;
  /** Chevron tint; defaults to the secondary text color. */
  chevronColor?: string;
  className?: string;
};

/**
 * The button that opens and closes the row. Put a `TraceLine` inside it. It
 * adds a chevron after the line.
 */
export const TraceCollapsibleTrigger = forwardRef<
  ComponentRef<typeof Pressable>,
  TraceCollapsibleTriggerProps
>(function TraceCollapsibleTriggerImpl(
  { chevronColor, children, className, ...props },
  ref,
) {
  const theme = useTheme();
  const { expanded, setOpen } = useContext(TraceOpenContext);

  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      className={cn("flex-row items-center gap-1", className)}
      onPress={() => {
        setOpen(!expanded);
      }}
      style={({ pressed }) => (pressed ? { opacity: 0.72 } : null)}
      {...props}
    >
      {children}
      <CollapsibleChevron
        color={chevronColor ?? theme.textSecondary}
        expanded={expanded}
      />
    </Pressable>
  );
});

export type TraceCollapsibleContentProps = ComponentPropsWithoutRef<
  typeof View
> & {
  children?: ReactNode;
  /** Keep the detail mounted while closed, so nested rows keep their state. */
  keepMounted?: boolean;
  className?: string;
};

/** The detail of a row that expands, muted beneath the row it explains. */
export const TraceCollapsibleContent = forwardRef<
  ComponentRef<typeof View>,
  TraceCollapsibleContentProps
>(function TraceCollapsibleContentImpl(
  { children, keepMounted = false, className, ...props },
  ref,
) {
  const { expanded } = useContext(TraceOpenContext);
  const reduceMotion = useReducedMotion();

  if (!expanded) {
    if (!keepMounted) {
      return null;
    }

    return (
      <View
        ref={ref}
        style={{ display: "none" }}
        {...props}
      >
        {children}
      </View>
    );
  }

  return (
    <Animated.View
      ref={ref}
      className={cn("gap-1.5", className)}
      entering={reduceMotion ? undefined : FadeIn.duration(180)}
      {...props}
    >
      {children}
    </Animated.View>
  );
});
