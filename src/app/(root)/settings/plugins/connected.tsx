import { useRouter } from "expo-router";
import { ChevronLeft, ChevronRight, GitBranch, Plus } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { Container } from "@/components/shared/container";
import { PluginImportDrawer } from "@/components/plugins/plugin-import-drawer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useAppState } from "@/hooks/use-app-state";
import { useConfig } from "@/hooks/use-config";
import { useTheme } from "@/hooks/use-theme";

export default function ConnectedPluginsScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { ready } = useAppState();
  const { plugins, mcpServers } = useConfig();
  const [importOpen, setImportOpen] = useState(false);
  const enabledCount = useMemo(
    () => plugins.filter((plugin) => plugin.enabled).length,
    [plugins],
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
        <View className="min-w-0 flex-1">
          <Text className="font-sans text-xl font-semibold text-foreground dark:text-foreground-dark">
            Plugins
          </Text>
          <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">
            {enabledCount} ativos
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

      <Card className="gap-sp-3 px-sp-4 py-sp-4">
        <Text className="font-sans text-base font-semibold text-foreground dark:text-foreground-dark">
          Conecte seus serviços
        </Text>
        <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
          GitHub e outros serviços usam conexões MCP. Plugins instalados
          aparecem logo abaixo. As funções existentes continuam disponíveis.
        </Text>
        <Button
          leftIcon={<GitBranch color={theme.background} size={17} />}
          onPress={() => router.push("/settings/mcp/list?connect=github" as never)}
        >
          Conectar GitHub por token
        </Button>
        <Pressable
          accessibilityRole="button"
          className="min-h-12 flex-row items-center justify-between rounded-ui border border-border px-sp-3 dark:border-border-dark"
          onPress={() => router.push("/settings/mcp/connected" as never)}
        >
          <Text className="font-sans text-sm font-medium text-foreground dark:text-foreground-dark">
            Conexões MCP ({mcpServers.filter((server) => server.enabled).length} ativas)
          </Text>
          <ChevronRight color={theme.textSecondary} size={18} />
        </Pressable>
      </Card>

      <Pressable
        accessibilityRole="button"
        className="min-h-14 flex-row items-center justify-between gap-sp-3 rounded-ui border border-border px-sp-4 dark:border-border-dark"
        onPress={() => router.push("/settings/plugins/integrations" as never)}
      >
        <View className="min-w-0 flex-1">
          <Text className="font-sans text-base font-medium text-foreground dark:text-foreground-dark">
            Integrações conhecidas do ChatGPT
          </Text>
          <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">
            Veja o que pode ser conectado ao Mobile Agent
          </Text>
        </View>
        <ChevronRight color={theme.textSecondary} size={18} />
      </Pressable>

      {!ready ? (
        <Card className="px-sp-4 py-sp-4">
          <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
            Carregando plugins…
          </Text>
        </Card>
      ) : (
        <>
          {plugins.length === 0 ? (
            <Card className="gap-sp-2 px-sp-4 py-sp-4">
              <Text className="font-sans text-base font-medium text-foreground dark:text-foreground-dark">
                Nenhum plugin instalado
              </Text>
              <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
                Você pode instalar plugins personalizados ou conectar serviços
                pela opção MCP acima. São recursos diferentes.
              </Text>
            </Card>
          ) : (
          <Card className="overflow-hidden">
            {plugins.map((plugin, index) => (
              <View key={plugin.id}>
                <Pressable
                  accessibilityRole="button"
                  className="flex-row items-center gap-sp-3 px-sp-4 py-sp-3"
                  onPress={() =>
                    router.push(
                      `/settings/plugins/${encodeURIComponent(plugin.id)}` as never,
                    )
                  }
                  style={({ pressed }) => (pressed ? { opacity: 0.82 } : null)}
                >
                  <View className="min-w-0 flex-1 gap-0.5">
                    <Text
                      className="font-sans text-base font-medium text-foreground dark:text-foreground-dark"
                      numberOfLines={1}
                    >
                      {plugin.name}
                    </Text>
                    <Text
                      className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark"
                      numberOfLines={1}
                    >
                      {plugin.enabled
                        ? plugin.description || "Ativo"
                        : "Desativado"}
                    </Text>
                    {plugin.lastError ? (
                      <Text
                        className="font-sans text-xs text-destructive dark:text-destructive-dark"
                        numberOfLines={1}
                      >
                        {plugin.lastError}
                      </Text>
                    ) : null}
                  </View>
                  <ChevronRight color={theme.textSecondary} size={18} />
                </Pressable>
                {index < plugins.length - 1 ? <Separator /> : null}
              </View>
            ))}
          </Card>
          )}
          <Button
            leftIcon={<Plus color={theme.text} size={16} />}
            onPress={() => router.push("/settings/plugins/list" as never)}
            variant="outline"
          >
            Explorar plugins
          </Button>
        </>
      )}

      <PluginImportDrawer onOpenChange={setImportOpen} open={importOpen} />
    </Container>
  );
}
