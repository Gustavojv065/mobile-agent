import { useRouter } from "expo-router";
import { Check, ChevronLeft, ChevronRight } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, Text, View } from "react-native";
import { Container } from "@/components/shared/container";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/core/utils";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { DrawerPager, DrawerPagerPage } from "@/components/ui/drawer-pager";
import { Separator } from "@/components/ui/separator";
import { useTheme } from "@/hooks/use-theme";
import {
  cancelVoiceDownload,
  deleteVoiceModel,
  downloadVoiceModel,
  getModelLanguages,
  isModelDownloaded,
  loadVoiceEngine,
  loadVoiceLanguage,
  refreshVoiceModels,
  saveVoiceEngine,
  saveVoiceLanguage,
  type VoiceCatalogModel,
  type VoiceEngine,
  type WhisperLanguage,
} from "@/modules/voice/models";

function formatBytes(bytes: number) {
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export default function VoiceSettingsScreen() {
  const router = useRouter();
  const theme = useTheme();
  const [engine, setEngine] = useState<VoiceEngine>("system");
  const [models, setModels] = useState<VoiceCatalogModel[]>([]);
  const [installed, setInstalled] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [language, setLanguage] = useState<WhisperLanguage>("pt");
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const supported = Platform.OS === "android" || Platform.OS === "ios";

  const refresh = async () => {
    if (!supported) return;
    const [currentEngine, catalog] = await Promise.all([
      loadVoiceEngine(),
      refreshVoiceModels(),
    ]);
    setEngine(currentEngine);
    setModels(catalog);
    setInstalled(
      catalog
        .filter((model) => isModelDownloaded(model.id))
        .map((model) => model.id),
    );
  };
  useEffect(() => {
    refresh().catch((error: unknown) =>
      Alert.alert("Configurações de voz", String(error)),
    );
    // Downloads are scoped to this screen; leaving cancels unfinished files.
    return () => {
      cancelVoiceDownload().catch(console.error);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedKey || selectedKey === "system") return;
    let disposed = false;
    loadVoiceLanguage(selectedKey)
      .then((value) => {
        if (!disposed) setLanguage(value);
      })
      .catch(console.error);
    return () => {
      disposed = true;
    };
  }, [selectedKey]);

  const selectEngine = async (next: VoiceEngine) => {
    try {
      await saveVoiceEngine(next);
      setEngine(next);
    } catch (error) {
      Alert.alert(
        "Configurações de voz",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const download = async (id: string) => {
    setBusy(id);
    setProgress(0);
    try {
      await downloadVoiceModel(id, setProgress);
      await refresh();
    } catch (error) {
      Alert.alert(
        "Falha no download",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusy(null);
    }
  };

  const remove = (id: string, label: string) =>
    Alert.alert(
      `Delete ${label}?`,
      "O modelo poderá ser baixado novamente. Se estiver ativo, a entrada de voz voltará ao reconhecimento do sistema.",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Excluir",
          style: "destructive",
          onPress: () => {
            deleteVoiceModel(id)
              .then(refresh)
              .catch((error: unknown) =>
                Alert.alert("Falha ao excluir", String(error)),
              );
          },
        },
      ],
    );

  const selectedModel =
    models.find((model) => model.id === selectedKey) ?? null;
  const selectedIsSystem = selectedKey === "system";
  const languageOptions = useMemo(
    () => (selectedKey ? getModelLanguages(selectedKey) : []),
    [selectedKey],
  );
  const languageLabel =
    languageOptions.find((item) => item.id === language)?.label ?? "Português";

  const rowValue = (id: string) => (engine === id ? "Selecionado" : "Configurar");

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
          Entrada de voz
        </Text>
      </View>

      {!supported ? (
        <Text className="px-sp-1 font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
          O Whisper local exige Android ou iOS.
        </Text>
      ) : null}

      <Card className="overflow-hidden">
        <VoiceLinkRow
          label="Sistema"
          onPress={() => {
            setPage(0);
            setSelectedKey("system");
          }}
          value={engine === "system" ? "Selecionado" : "Configurar"}
        />
        {models.map((model) => (
          <View key={model.id}>
            <Separator />
            <VoiceLinkRow
              label={model.label}
              onPress={() => {
                setPage(0);
                setSelectedKey(model.id);
              }}
              value={rowValue(model.id)}
            />
          </View>
        ))}
      </Card>

      <Drawer
        onOpenChange={(open) => {
          if (!open) {
            setSelectedKey(null);
            setPage(0);
          }
        }}
        open={selectedKey !== null}
      >
        <DrawerContent showCloseButton showHandle>
          <DrawerPager onPageChange={setPage} page={page}>
            <DrawerPagerPage>
              <DrawerHeader>
                <DrawerTitle>
                  {selectedIsSystem
                    ? "Sistema"
                    : (selectedModel?.label ?? "Modelo")}
                </DrawerTitle>
              </DrawerHeader>

              <DrawerBody contentContainerClassName="gap-sp-4 pb-sp-4">
                {selectedIsSystem ? (
                  <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
                    Usa o reconhecimento de voz do dispositivo. O idioma segue
                    as configurações do Android ou iOS.
                  </Text>
                ) : null}

                {selectedModel ? (
                  <View className="overflow-hidden rounded-card border border-border dark:border-border-dark">
                    <DetailRow
                      label="Status"
                      value={
                        engine === selectedModel.id
                          ? "Selecionado"
                          : installed.includes(selectedModel.id)
                            ? "Baixado"
                            : "Não baixado"
                      }
                    />
                    <Separator />
                    <DetailRow
                      label="Tamanho"
                      value={formatBytes(selectedModel.sizeBytes)}
                    />
                  </View>
                ) : null}

                {!selectedIsSystem ? (
                  <DrawerLinkRow
                    label="Idioma"
                    onPress={() => setPage(1)}
                    value={languageLabel}
                  />
                ) : null}

                {selectedModel && busy === selectedModel.id ? (
                  <View className="gap-sp-2">
                    <View className="h-1.5 overflow-hidden rounded-full bg-muted dark:bg-muted-dark">
                      <View
                        className="h-full rounded-full bg-foreground dark:bg-foreground-dark"
                        style={{
                          width: `${Math.max(2, Math.round(progress * 100))}%`,
                        }}
                      />
                    </View>
                    <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">
                      Baixando {Math.round(progress * 100)}%
                    </Text>
                  </View>
                ) : null}
              </DrawerBody>

              <DrawerFooter>
                {selectedIsSystem ? (
                  <Button
                    disabled={engine === "system"}
                    onPress={() => {
                      selectEngine("system").catch(console.error);
                    }}
                  >
                    {engine === "system" ? "Selecionado" : "Usar sistema"}
                  </Button>
                ) : selectedModel ? (
                  installed.includes(selectedModel.id) ? (
                    <View className="flex-row gap-sp-2">
                      <Button
                        className="flex-1"
                        disabled={busy !== null || engine === selectedModel.id}
                        onPress={() => {
                          selectEngine(selectedModel.id).catch(console.error);
                        }}
                      >
                        {engine === selectedModel.id ? "Selecionado" : "Usar modelo"}
                      </Button>
                      <Button
                        disabled={busy !== null}
                        onPress={() =>
                          remove(selectedModel.id, selectedModel.label)
                        }
                        variant="outline"
                      >
                        Excluir
                      </Button>
                    </View>
                  ) : (
                    <View className="w-full">
                      <Button
                        disabled={busy !== null || !supported}
                        onPress={() => {
                          download(selectedModel.id).catch(console.error);
                        }}
                      >
                        {busy === selectedModel.id
                          ? "Baixando…"
                          : `Baixar ${formatBytes(selectedModel.sizeBytes)}`}
                      </Button>
                      {busy === selectedModel.id ? (
                        <Pressable
                          accessibilityHint="Cancela o download do modelo"
                          accessibilityLabel="Cancelar"
                          accessibilityRole="button"
                          className="items-center py-sp-3"
                          hitSlop={8}
                          onPress={() => {
                            cancelVoiceDownload().catch(console.error);
                          }}
                          style={({ pressed }) =>
                            pressed ? { opacity: 0.6 } : null
                          }
                        >
                          <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
                            Cancelar
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                  )
                ) : null}
              </DrawerFooter>
            </DrawerPagerPage>

            <DrawerPagerPage>
              <DrawerHeader className="flex-row items-center gap-sp-2">
                <Pressable
                  accessibilityLabel="Voltar"
                  className="h-9 w-9 items-center justify-center rounded-full"
                  onPress={() => setPage(0)}
                >
                  <ChevronLeft color={theme.text} size={22} />
                </Pressable>
                <DrawerTitle>Idioma</DrawerTitle>
              </DrawerHeader>
              <DrawerBody contentContainerClassName="gap-sp-2 pb-sp-4">
                {languageOptions.map((item) => {
                  const selected = language === item.id;
                  return (
                    <View
                      key={item.id}
                      className={cn(
                        "rounded-ui border",
                        selected
                          ? "border-foreground bg-secondary dark:border-foreground-dark dark:bg-secondary-dark"
                          : "border-border bg-background dark:border-border-dark dark:bg-background-dark",
                      )}
                    >
                      <Pressable
                        accessibilityRole="button"
                        className="min-h-12 flex-row items-center gap-sp-3 px-sp-4 py-sp-3"
                        onPress={() => {
                          setLanguage(item.id);
                          if (selectedKey) {
                            saveVoiceLanguage(selectedKey, item.id)
                              .then(() => setPage(0))
                              .catch((error: unknown) =>
                                Alert.alert(
                                  "Voice settings",
                                  error instanceof Error
                                    ? error.message
                                    : String(error),
                                ),
                              );
                          }
                        }}
                        style={({ pressed }) =>
                          pressed ? { opacity: 0.85 } : null
                        }
                      >
                        <Text className="flex-1 font-sans text-base text-foreground dark:text-foreground-dark">
                          {item.label}
                        </Text>
                        {selected ? (
                          <Check color={theme.text} size={18} />
                        ) : null}
                      </Pressable>
                    </View>
                  );
                })}
              </DrawerBody>
            </DrawerPagerPage>
          </DrawerPager>
        </DrawerContent>
      </Drawer>
    </Container>
  );
}

function VoiceLinkRow({
  label,
  onPress,
  value,
}: {
  label: string;
  onPress: () => void;
  value: string;
}) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      className="min-h-14 flex-row items-center gap-sp-3 px-sp-4 py-sp-3"
      onPress={onPress}
      style={({ pressed }) => (pressed ? { opacity: 0.82 } : null)}
    >
      <Text className="flex-1 font-sans text-base text-foreground dark:text-foreground-dark">
        {label}
      </Text>
      <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
        {value}
      </Text>
      <ChevronRight color={theme.textSecondary} size={18} />
    </Pressable>
  );
}

function DrawerLinkRow({
  label,
  onPress,
  value,
}: {
  label: string;
  onPress: () => void;
  value: string;
}) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      className="min-h-14 flex-row items-center gap-sp-3 overflow-hidden rounded-card border border-border px-sp-4 py-sp-3 dark:border-border-dark"
      onPress={onPress}
      style={({ pressed }) => (pressed ? { opacity: 0.82 } : null)}
    >
      <Text className="flex-1 font-sans text-base text-foreground dark:text-foreground-dark">
        {label}
      </Text>
      <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
        {value}
      </Text>
      <ChevronRight color={theme.textSecondary} size={18} />
    </Pressable>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="min-h-14 flex-row items-center gap-sp-3 px-sp-4 py-sp-3">
      <Text className="flex-1 font-sans text-base text-foreground dark:text-foreground-dark">
        {label}
      </Text>
      <Text className="max-w-40 text-right font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
        {value}
      </Text>
    </View>
  );
}
