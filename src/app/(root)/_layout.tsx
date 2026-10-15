import { Stack } from "expo-router";

import { AppSidebar } from "@/components/ui/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

export default function Layout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      {/* Native stack (screens-backed): off-screen routes freeze instead of
        re-rendering on every chat update. Chrome stays hidden to preserve
        the current look; navigation API (router.push) is unchanged. */}
      <Stack
        screenOptions={{
          animation: "slide_from_right",
          headerShown: false,
        }}
      />
    </SidebarProvider>
  );
}
