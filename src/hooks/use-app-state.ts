import { useAppState as useDirectAppState } from "@/providers/app-state";
import { useHarness } from "@/providers/harness-state";

export function useAppState() {
  const direct = useDirectAppState();
  const harness = useHarness();
  return { ...direct, error: harness.active ? harness.error : direct.error };
}
