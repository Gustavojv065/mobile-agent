import { Text, View } from "react-native";

/**
 * Raw-TeX box. Deliberately dependency-free (no MathJax) so it can be
 * imported statically as the `Suspense` fallback for the lazily-loaded
 * `MathBlock` without pulling MathJax into the startup bundle.
 */
export function MathFallback({ tex }: { tex: string }) {
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
