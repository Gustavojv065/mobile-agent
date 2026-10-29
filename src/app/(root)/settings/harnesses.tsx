import { useRouter } from "expo-router";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import { Container } from "@/components/shared/container";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { OpenCodeConnectionForm } from "@/components/settings/opencode-connection-form";
import { useTheme } from "@/hooks/use-theme";
import { useHarness } from "@/providers/harness-state";
import { useConfig } from "@/hooks/use-config";
import { DrawerPager, DrawerPagerPage } from "@/components/ui/drawer-pager";
import { Separator } from "@/components/ui/separator";
import { SUPPORTED_HARNESSES } from "@/modules/harnesses/catalog";
import { Input } from "@/components/ui/input";
import {
  ProviderModelRow,
  StatusRow,
} from "@/components/settings/provider-detail-rows";

export default function SettingsHarnessesScreen() {
  const router = useRouter();
  const theme = useTheme();
  const harness = useHarness();
  const { selectModel, currentModel } = useConfig();
  const loading = harness.status === "connecting";
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [modelQuery, setModelQuery] = useState("");
  const query = modelQuery.trim().toLowerCase();
  const displayModels = harness.availableModels.filter(
    (model) =>
      !query ||
      model.label.toLowerCase().includes(query) ||
      model.modelId.toLowerCase().includes(query),
  );

  return (
    <Container
      scroll
      contentClassName="gap-sp-4 py-sp-4"
      includeBottomTabInset={false}
    >
      <View className="flex-row items-center gap-sp-2">
        <Button
          leftIcon={<ChevronLeft color={theme.text} size={16} />}
          onPress={() => router.back()}
          size="icon-xs"
          variant="ghost"
        />
        <Text className="font-sans text-xl font-semibold text-foreground dark:text-foreground-dark">
          Harnesses
        </Text>
      </View>
      <Card className="overflow-hidden">
        {loading ? (
          <View
            accessibilityLabel="Carregando ambientes de agentes"
            className="flex-row items-center justify-between gap-sp-3 px-sp-4 py-sp-4"
          >
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-4 w-1/4" />
          </View>
        ) : (
          SUPPORTED_HARNESSES.map((definition, index) => (
            <View key={definition.id}>
              {index > 0 ? <Separator /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={definition.label}
                className="min-h-14 flex-row items-center gap-sp-3 px-sp-4 py-sp-3"
                onPress={() => {
                  setPage(0);
                  setModelQuery("");
                  setOpen(true);
                }}
                style={({ pressed }) => (pressed ? { opacity: 0.82 } : null)}
              >
                <Text className="flex-1 font-sans text-base text-foreground dark:text-foreground-dark">
                  {definition.label}
                </Text>
                <Text className="text-right font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
                  {harness.connected
                    ? `${harness.models.length} disponíveis`
                    : "Conectar"}
                </Text>
                <ChevronRight color={theme.textSecondary} size={18} />
              </Pressable>
            </View>
          ))
        )}
      </Card>
      <Drawer
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setPage(0);
        }}
      >
        <DrawerContent
          contentClassName="overflow-hidden"
          showCloseButton
          showHandle
          size={720}
        >
          <DrawerPager page={page} onPageChange={setPage}>
            <DrawerPagerPage>
              <DrawerHeader>
                <DrawerTitle>OpenCode</DrawerTitle>
              </DrawerHeader>
              <DrawerBody contentContainerClassName="pb-sp-4">
                <View className="overflow-hidden rounded-card border border-border dark:border-border-dark">
                  <StatusRow
                    label="Status"
                    value={
                      loading
                        ? "Conectando"
                        : harness.connected
                          ? "Conectado"
                          : "Não configurado"
                    }
                  />
                  <Separator />
                  <StatusRow label="Tipo" value="Harness" />
                  {harness.active && currentModel ? (
                    <>
                      <Separator />
                      <StatusRow
                        label="Modelo atual"
                        value={currentModel.label}
                      />
                    </>
                  ) : null}
                </View>
                <View className="gap-sp-2">
                  <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
                    {harness.connected ? "Conexão ativa" : "Conexão"}
                  </Text>
                  {harness.connected ? (
                    <>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setPage(1)}
                        style={({ pressed }) =>
                          pressed ? { opacity: 0.82 } : null
                        }
                        className="flex-row items-center justify-between overflow-hidden rounded-card border border-border px-sp-4 py-sp-3 dark:border-border-dark"
                      >
                        <Text className="font-sans text-base text-foreground dark:text-foreground-dark">
                          OpenCode
                        </Text>
                        <View className="flex-row items-center gap-sp-1">
                          <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
                            Manage
                          </Text>
                          <ChevronRight color={theme.textSecondary} size={18} />
                        </View>
                      </Pressable>
                      <Button
                        variant="outline"
                        disabled={harness.mutating}
                        onPress={harness.disconnect}
                      >
                        Disconnect
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="secondary"
                      loading={loading}
                      onPress={() => setPage(1)}
                    >
                      Conectar
                    </Button>
                  )}
                </View>
                {harness.connected ? (
                  <View className="gap-sp-3">
                    <View className="flex-row items-center justify-between gap-sp-3">
                      <Text className="flex-1 font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
                        Modelos do OpenCode
                      </Text>
                      <Button
                        size="xs"
                        variant="outline"
                        loading={loading}
                        disabled={harness.mutating}
                        onPress={() => {
                          void harness.connect();
                        }}
                      >
                        Atualizar
                      </Button>
                    </View>
                    <Input
                      autoCapitalize="none"
                      autoCorrect={false}
                      onChangeText={setModelQuery}
                      placeholder="Buscar modelos"
                      value={modelQuery}
                    />
                    <View className="overflow-hidden rounded-card border border-border dark:border-border-dark">
                      {displayModels.map((model, index) => (
                        <View key={model.ref}>
                          {index > 0 ? <Separator /> : null}
                          <ProviderModelRow
                            capabilityBadges={model.isFree ? ["Free"] : []}
                            checkColor={theme.text}
                            current={currentModel?.ref === model.ref}
                            disabled={harness.mutating}
                            label={model.label}
                            modelId={model.modelId}
                            stateLabel={
                              currentModel?.ref === model.ref
                                ? "Atual"
                                : "Usar"
                            }
                            onPress={() => {
                              void selectModel(model.ref).catch(() => {});
                            }}
                          />
                        </View>
                      ))}
                      {displayModels.length === 0 ? (
                        <Text className="px-sp-4 py-sp-4 font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
                          {query
                            ? "Nenhum modelo encontrado."
                            : "Nenhum modelo disponível."}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ) : null}
                {harness.error ? (
                  <Text className="font-sans text-sm text-destructive dark:text-destructive-dark">
                    {harness.error}
                  </Text>
                ) : null}
              </DrawerBody>
            </DrawerPagerPage>
            <DrawerPagerPage>
              <DrawerHeader>
                <View className="flex-row items-center gap-sp-2">
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    leftIcon={<ChevronLeft color={theme.text} size={16} />}
                    onPress={() => setPage(0)}
                  />
                  <DrawerTitle>Conectar</DrawerTitle>
                </View>
              </DrawerHeader>
              {open && page === 1 ? (
                <OpenCodeConnectionForm
                  onConnected={() => {
                    void harness.connect().then(() => setPage(0));
                  }}
                />
              ) : null}
            </DrawerPagerPage>
          </DrawerPager>
        </DrawerContent>
      </Drawer>
    </Container>
  );
}
