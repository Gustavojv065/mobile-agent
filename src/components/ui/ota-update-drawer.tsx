import { Text } from "react-native";

import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { MarkdownView } from "@/components/ui/markdown-view";
import type { ReleaseNotes } from "@/modules/updates/github-release";

/**
 * Informational drawer shown once this session is running an OTA bundle.
 *
 * An OTA ships JS only and is applied automatically on the next launch, so
 * there is never an action for the user to take — the drawer only ever opens
 * after the update has been applied, never while it downloads. That changes
 * the footer shape compared with the APK drawer: one full-width Close instead
 * of the Skip / Update pair, and no "View release page" link.
 *
 * Release notes come from the GitHub release for the running app version: an
 * OTA never changes the version tag, so its own tag cannot label the notes.
 */
export function OtaUpdateDrawer({
  notes,
  onDone,
  open,
}: {
  /** Notes for the running version; `null` while loading or when unpublished. */
  notes: ReleaseNotes | null;
  onDone: () => void;
  open: boolean;
}) {
  const notesBody = notes?.body.trim() ?? "";

  return (
    <Drawer
      onOpenChange={(next) => {
        if (!next) onDone();
      }}
      open={open}
    >
      <DrawerContent showCloseButton showHandle>
        <DrawerHeader>
          <DrawerTitle>App has been updated</DrawerTitle>
          <DrawerDescription>
            {"Here's what's new in this update."}
          </DrawerDescription>
        </DrawerHeader>

        <DrawerBody contentContainerClassName="gap-sp-3 pb-sp-4">
          {notesBody ? (
            <MarkdownView>{notes?.body ?? ""}</MarkdownView>
          ) : (
            <Text className="font-sans text-sm leading-5 text-muted-foreground dark:text-muted-foreground-dark">
              {notes
                ? "The full changelog is on the release page."
                : "Your app is up to date with the latest changes."}
            </Text>
          )}
        </DrawerBody>

        <DrawerFooter className="items-center gap-sp-3">
          <Button className="w-full" onPress={onDone}>
            Close
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
