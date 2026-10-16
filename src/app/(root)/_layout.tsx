import { Stack } from "expo-router";

import { AppSidebar } from "@/components/ui/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

export default function Layout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      {/* Native stack (screens-backed): off-screen routes freeze instead of
        re-rendering on every chat update. Chrome stays hidden to preserve
        the current look. Drill screens slide; top-level hubs fade so lateral
        switches don't look like drill-downs. */}
      <Stack
        screenOptions={{
          animation: "slide_from_right",
          headerShown: false,
        }}
      >
        <Stack.Screen name="index" options={{ animation: "fade" }} />
        <Stack.Screen name="library" options={{ animation: "fade" }} />
        <Stack.Screen name="terminal" options={{ animation: "fade" }} />
        <Stack.Screen name="settings/index" options={{ animation: "fade" }} />
      </Stack>
    </SidebarProvider>
  );
}
