import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppState } from "react-native";

import {
  DEFAULT_STARTER_PROMPTS,
  fetchStarterPrompts,
  STARTER_PROMPTS_REFRESH_MS,
} from "@/modules/chat/starter-prompts";

/** Empty-chat starter prompts, refreshed from the catalog like the composer tip. */
export function useStarterPrompts() {
  const [active, setActive] = useState(AppState.currentState !== "background");

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setActive(state === "active");
    });
    return () => subscription.remove();
  }, []);

  const { data: prompts } = useQuery({
    queryKey: ["starter-prompts"],
    queryFn: ({ signal }) => fetchStarterPrompts(signal),
    initialData: DEFAULT_STARTER_PROMPTS,
    initialDataUpdatedAt: 0,
    enabled: active,
    staleTime: STARTER_PROMPTS_REFRESH_MS,
    refetchInterval: STARTER_PROMPTS_REFRESH_MS,
    retry: false,
  });

  return prompts;
}
