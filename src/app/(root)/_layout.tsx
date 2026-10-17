import { Stack } from "expo-router";

import { AppSidebar } from "@/components/ui/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { useColorScheme } from "@/hooks/use-color-scheme";

export default function Layout() {
  const colorScheme = useColorScheme();

  return (
    <SidebarProvider>
      <AppSidebar />
      {/* Native stack (screens-backed): off-screen routes freeze instead of
        re-rendering on every chat update. Chrome stays hidden to preserve
        the current look. Settings and drill screens use the default slide. */}
      <Stack
        screenOptions={{
          animation: "slide_from_right",
          headerShown: false,
          statusBarStyle: colorScheme === "dark" ? "light" : "dark",
        }}
      >
        <Stack.Screen name="index" options={{ animation: "fade" }} />
        <Stack.Screen name="library" options={{ animation: "fade" }} />
        <Stack.Screen name="terminal" options={{ animation: "fade" }} />
        <Stack.Screen name="settings/index" />
      </Stack>
    </SidebarProvider>
  );
}
