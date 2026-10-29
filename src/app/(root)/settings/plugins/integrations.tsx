import { useRouter } from "expo-router";
import { ChevronLeft, ChevronRight, ExternalLink, PlugZap, Search } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Alert, Linking, Pressable, Text, View } from "react-native";

import { Container } from "@/components/shared/container";
import { SearchBox } from "@/components/shared/search-box";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useConfig } from "@/hooks/use-config";
import { useTheme } from "@/hooks/use-theme";
import {
  FEATURED_INTEGRATIONS,
  findMobileMcpConnection,
  type IntegrationEntry,
} from "@/modules/plugins/featured-integrations";

export default function IntegrationsDirectoryScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { mcpServers } = useConfig();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const term = query.toLocaleLowerCase("pt-BR").trim();
    return term
      ? FEATURED_INTEGRATIONS.filter((entry) =>
          (entry.name + " " + entry.description).toLocaleLowerCase("pt-BR").includes(term),
        )
      : FEATURED_INTEGRATIONS;
  }, [query]);

  const openIntegration = (entry: IntegrationEntry) => {
    if (entry.action === "mcp") {
      if (entry.mcpPresetId === "github") {
        router.push("/settings/mcp/list?connect=github" as never);
      } else {
        router.push(`/settings/mcp/list?search=${encodeURIComponent(entry.name)}` as never);
      }
    } else if (entry.action === "skills") {
      router.push("/settings/skills/list" as never);
    } else if (entry.action === "docs" && entry.docsUrl) {
      void Linking.openURL(entry.docsUrl).catch(() =>
        Alert.alert("Não foi possível abrir as instruções", "Confira sua conexão com a internet."),
      );
    }
  };

  return (
    <Container scroll contentClassName="gap-sp-4 py-sp-4" includeBottomTabInset={false}>
      <View className="flex-row items-center gap-sp-2">
        <Button
          leftIcon={<ChevronLeft color={theme.text} size={16} />}
          onPress={() => router.back()}
          size="icon-xs"
          variant="ghost"
        />
        <View className="min-w-0 flex-1">
          <Text className="font-sans text-xl font-semibold text-foreground dark:text-foreground-dark">
            Integrações
          </Text>
          <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">
            {FEATURED_INTEGRATIONS.length} serviços e ferramentas
          </Text>
        </View>
      </View>

      <Card className="gap-sp-2 px-sp-4 py-sp-4">
        <View className="flex-row items-center gap-sp-2">
          <PlugZap color={theme.text} size={20} />
          <Text className="font-sans text-base font-semibold text-foreground dark:text-foreground-dark">
            Integrações para o Mobile Agent
          </Text>
        </View>
        <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
          Estes atalhos não instalam nem sincronizam automaticamente seus plugins
          do ChatGPT. Conecte cada serviço com uma autorização própria e veja
          abaixo o que é compatível.
        </Text>
      </Card>

      <SearchBox
        onChangeText={setQuery}
        placeholder="Buscar GitHub, Notion, Supabase..."
        value={query}
      />

      <Card className="overflow-hidden">
        {filtered.length === 0 ? (
          <Text className="px-sp-4 py-sp-4 font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
            Nenhuma integração encontrada.
          </Text>
        ) : (
          filtered.map((entry, i) => {
            const status = findMobileMcpConnection(entry, mcpServers);
            const actionable = entry.action !== "chatgpt";
            const subtitle =
              status === "connected"
                ? "Conexão MCP testada"
                : status === "configured"
                  ? "Adicionada — teste a conexão"
                  : entry.action === "mcp"
                    ? "Conectar no Mobile Agent"
                    : entry.action === "docs"
                      ? "Ver compatibilidade e autenticação"
                      : entry.action === "skills"
                        ? "Explorar skills alternativas"
                        : "Disponível somente no ChatGPT";

            return (
              <View key={entry.id}>
                {i > 0 ? <Separator /> : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !actionable }}
                  className="min-h-16 flex-row items-center gap-sp-3 px-sp-4 py-sp-3"
                  disabled={!actionable}
                  onPress={() => openIntegration(entry)}
                  style={({ pressed }) => (pressed && actionable ? { opacity: 0.8 } : null)}
                >
                  <View className="min-w-0 flex-1 gap-1">
                    <Text className="font-sans text-base font-medium text-foreground dark:text-foreground-dark">
                      {entry.name}
                    </Text>
                    <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">
                      {subtitle}
                    </Text>
                    <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark" numberOfLines={2}>
                      {entry.description}
                    </Text>
                  </View>
                  {entry.action === "docs" ? (
                    <ExternalLink color={theme.textSecondary} size={16} />
                  ) : actionable ? (
                    <ChevronRight color={theme.textSecondary} size={18} />
                  ) : null}
                </Pressable>
              </View>
            );
          })
        )}
      </Card>

      <Text className="px-sp-1 font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">
        Uma conexão só estará disponível para o agente depois de configurada
        e validada no próprio Mobile Agent. Nenhuma chave de API é compartilhada
        com o ChatGPT por esta tela.
      </Text>
    </Container>
  );
}
