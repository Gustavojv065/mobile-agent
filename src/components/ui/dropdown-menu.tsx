import {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  ReactElement,
  ReactNode,
  useContext,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ComponentRef,
} from "react";
import { Modal, Pressable, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { cn } from "@/core/utils";

type Position = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type DropdownContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  position: Position | null;
  setPosition: (position: Position) => void;
};

const DropdownContext = createContext<DropdownContextValue | null>(null);

function useDropdown(name: string) {
  const ctx = useContext(DropdownContext);

  if (!ctx) {
    throw new Error(`${name} must be used inside DropdownMenu`);
  }

  return ctx;
}

export function DropdownMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);

  return (
    <DropdownContext.Provider
      value={{
        open,
        setOpen,
        position,
        setPosition,
      }}
    >
      {children}
    </DropdownContext.Provider>
  );
}

export function DropdownMenuTrigger({
  children,
  triggerOn = "press",
}: {
  children: ReactElement;
  triggerOn?: "press" | "longPress";
}) {
  const ref = useRef<View>(null);

  const { open, setOpen, setPosition } = useDropdown("DropdownMenuTrigger");
  const child = children as ReactElement<any>;
  const openMenu = () => {
    ref.current?.measureInWindow((x, y, width, height) => {
      setPosition({
        x,
        y,
        width,
        height,
      });
    });
  };

  if (triggerOn === "longPress") {
    return cloneElement(child, {
      ref,

      onLongPress: (...args: any[]) => {
        openMenu();
        setOpen(true);
        child.props.onLongPress?.(...args);
      },
    });
  }

  return cloneElement(child, {
    ref,

    onPress: (...args: any[]) => {
      openMenu();
      setOpen(!open);

      child.props.onPress?.(...args);
    },
  });
}

export function DropdownMenuContent({
  alignOffset = 0,
  children,
  sideOffset = 4,
  width = 180,
}: {
  alignOffset?: number;
  children: ReactNode;
  sideOffset?: number;
  width?: number;
}) {
  const { open, setOpen, position } = useDropdown("DropdownMenuContent");
  const { height: screenHeight, width: screenWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [measuredHeight, setMeasuredHeight] = useState(0);

  if (!open || !position) {
    return null;
  }

  // First frame has no onLayout yet; estimate from the item count (rows are
  // ~52px: py-3 around single-line text) so the clamp is effective from the
  // first frame instead of launching bottom-clipped.
  const menuHeight = measuredHeight || Children.count(children) * 52;
  const bottomMargin = insets.bottom + 12;
  // Clamp into the safe area on both ends: a trigger scrolled behind the
  // composer must not pin the menu to the bottom edge with items cut off.
  const top = Math.max(
    8,
    Math.min(
      position.y + position.height + sideOffset,
      screenHeight - menuHeight - bottomMargin,
    ),
  );

  return (
    <Modal
      transparent
      animationType="fade"
      visible={open}
      onRequestClose={() => setOpen(false)}
    >
      <Pressable className="flex-1" onPress={() => setOpen(false)}>
        <View
          onLayout={(event) => {
            const height = Math.round(event.nativeEvent.layout.height);
            setMeasuredHeight((current) => (current === height ? current : height));
          }}
          style={{
            position: "absolute",

            top,

            // right-align with trigger
            left: Math.min(
              screenWidth - width - 8,
              Math.max(
                8,
                position.x + position.width - width + alignOffset,
              ),
            ),

            width,
          }}
          className="overflow-hidden rounded-2xl border border-border bg-popover shadow-xl dark:border-border-dark dark:bg-popover-dark"
        >
          {children}
        </View>
      </Pressable>
    </Modal>
  );
}

export const DropdownMenuItem = forwardRef<
  ComponentRef<typeof Pressable>,
  ComponentPropsWithoutRef<typeof Pressable>
>(({ children, className, disabled, onPress, ...props }, ref) => {
  const { setOpen } = useDropdown("DropdownMenuItem");

  return (
    <Pressable
      ref={ref}
      className={cn(
        "px-4 py-3 active:bg-secondary dark:active:bg-secondary-dark",
        disabled && "opacity-50",
        className,
      )}
      disabled={disabled}
      onPress={(e) => {
        setOpen(false);
        onPress?.(e);
      }}
      {...props}
    >
      {typeof children === "string" ? (
        <Text className="text-base text-foreground dark:text-foreground-dark">
          {children}
        </Text>
      ) : (
        children
      )}
    </Pressable>
  );
});

DropdownMenuItem.displayName = "DropdownMenuItem";
