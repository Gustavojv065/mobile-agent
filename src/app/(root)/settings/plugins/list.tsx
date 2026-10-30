import { useRouter } from "expo-router";
import { ChevronLeft, Plus } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";

import { Container } from "@/components/shared/container";
import { PluginImportDrawer } from "@/components/plugins/plugin-import-drawer";
import { SearchBox } from "@/components/shared/search-box";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useConfig } from "@/hooks/use-config";
import { useTheme } from "@/hooks/use-theme";
import {
  fetchPluginCatalogCached,
  type PluginCatalogEntry,
} from "@/modules/plugins/catalog";

export default function PluginCatalogScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { importPlugin, plugins } = useConfig();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [entries, setEntries] = useState<PluginCatalogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  const filteredEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();

    if (!needle) return entries;

    return entries.filter(
      (entry) =>
        entry.label.toLowerCase().includes(needle) ||
        entry.description.toLowerCase().includes(needle),
    );
  }, [entries, query]);

  useEffect(() => {
    const controller = new AbortController();

    setCatalogLoading(true);
    setCatalogError(null);

    fetchPluginCatalogCached(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setEntries(result.entries);
      })
      .catch((catalogLoadError) => {
        if (controller.signal.aborted) return;
        setCatalogError(
          catalogLoadError instanceof Error
            ? catalogLoadError.message
            : "Não foi possível carregar o catálogo de plugins.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });

    return () => controller.abort();
  }, []);

  const installEntry = async (entry: PluginCatalogEntry) => {
    setBusyKey(entry.id);
    setError(null);

    try {
      const { fetchPluginFromUrl } = await import("@/modules/plugins/import");
      const source = await fetchPluginFromUrl(entry.url);
      await importPlugin(source, entry.url);
    } catch (installError) {
      setError(
        installError instanceof Error
          ? installError.message
          : "Não foi possível instalar o plugin.",
      );
    } finally {
      setBusyKey(null);
    }
  };

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
        <View className="min-w-0 flex-1">
          <Text className="font-sans text-xl font-semibold text-foreground dark:text-foreground-dark">
            Plugins
          </Text>
        </View>
        <Button
          className="ml-auto"
          leftIcon={<Plus color={theme.text} size={16} />}
          onPress={() => setImportOpen(true)}
          size="sm"
          variant="outline"
        >
          Importar plugin
        </Button>
      </View>

      <Card className="gap-sp-2 px-sp-4 py-sp-4">
        <Text className="font-sans text-base font-semibold text-foreground dark:text-foreground-dark">
          Quer conectar GitHub, Supabase ou outro serviço?
        </Text>
        <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
          Essas integrações ficam em Conexões MCP e são configuradas
          com token ou autorização, conforme o serviço.
        </Text>
        <Button
          onPress={() => router.push("/settings/mcp/list" as never)}
          variant="outline"
        >
          Explorar conexões MCP
        </Button>
      </Card>

      {entries.length > 0 ? (
        <>
          <SearchBox
            onChangeText={setQuery}
            placeholder="Buscar plugins"
            value={query}
          />
          {filteredEntries.length > 0 ? (
            <Card className="overflow-hidden">
              {filteredEntries.map((entry, index) => {
                const installed = plugins.some(
                  (plugin) => plugin.sourceUrl === entry.url,
                );

                return (
                  <View key={entry.id}>
                    {index > 0 ? <Separator /> : null}
                    <View className="flex-row items-center gap-sp-3 px-sp-4 py-sp-4">
                      <View className="min-w-0 flex-1 gap-1">
                        <Text
                          className="font-sans text-base font-semibold text-foreground dark:text-foreground-dark"
                          numberOfLines={1}
                        >
                          {entry.label}
                        </Text>
                        <Text
                          className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark"
                          numberOfLines={3}
                        >
                          {entry.description}
                        </Text>
                      </View>
                      <Button
                        disabled={installed}
                        loading={busyKey === entry.id}
                        onPress={() => installEntry(entry).catch(console.error)}
                        size="sm"
                        variant={installed ? "secondary" : "outline"}
                      >
                        {installed ? "Instalado" : "Instalar"}
                      </Button>
                    </View>
                  </View>
                );
              })}
            </Card>
          ) : (
            <Card className="px-sp-4 py-sp-4">
              <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
                {`Nenhum plugin corresponde a "${query}".`}
              </Text>
            </Card>
          )}
        </>
      ) : catalogLoading ? (
        <Card className="px-sp-4 py-sp-4">
          <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
            Carregando plugins…
          </Text>
        </Card>
      ) : (
        <Card className="px-sp-4 py-sp-4">
          <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
            O catálogo de plugins está vazio no momento. Você ainda pode
            importar um plugin JavaScript confiável usando a opção acima,
            ou conectar serviços pela área MCP.
          </Text>
        </Card>
      )}

      {catalogError ? (
        <Text className="font-sans text-sm text-destructive dark:text-destructive-dark">
          {catalogError}
        </Text>
      ) : null}
      {error ? (
        <Text className="font-sans text-sm text-destructive dark:text-destructive-dark">
          {error}
        </Text>
      ) : null}

      <PluginImportDrawer onOpenChange={setImportOpen} open={importOpen} />
    </Container>
  );
}
