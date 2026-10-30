import { useRouter } from "expo-router";
import { ChevronLeft, ChevronRight, ExternalLink, PlugZap } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Alert, Linking, Pressable, Text, View } from "react-native";

import { Container } from "@/components/shared/container";
import { SearchBox } from "@/components/shared/search-box";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useConfig } from "@/hooks/use-config";
import { useTheme } from "@/hooks/use-theme";
import { isMcpOAuthCanceledError } from "@/modules/mcp/oauth";
import {
  FEATURED_INTEGRATIONS,
  findMobileMcpConnection,
  getOneTapOAuthPreset,
  type IntegrationEntry,
} from "@/modules/plugins/featured-integrations";

export default function IntegrationsDirectoryScreen() {
  const router = useRouter();
  const theme = useTheme();
  const {
    connectMcpServerOAuth,
    createMcpServerOAuth,
    mcpServers,
    testMcpServer,
    updateMcpServer,
  } = useConfig();
  const [query, setQuery] = useState("");
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const term = query.toLocaleLowerCase("pt-BR").trim();
    return term
      ? FEATURED_INTEGRATIONS.filter((entry) =>
          (entry.name + " " + entry.description).toLocaleLowerCase("pt-BR").includes(term),
        )
      : FEATURED_INTEGRATIONS;
  }, [query]);

  const openIntegration = async (entry: IntegrationEntry) => {
    if (connectingId !== null) return;
    setConnectionError(null);

    const oauth = getOneTapOAuthPreset(entry);
    if (oauth) {
      const existing = mcpServers.find(
        (server) => server.url.replace(/\/$/, "") === oauth.url.replace(/\/$/, ""),
      );
      if (existing?.lastStatus === "connected" && existing.enabled) {
        router.push("/settings/mcp/connected" as never);
        return;
      }
      if (existing && existing.authMode !== "oauth") {
        setConnectionError(
          "Este serviço já possui uma conexão por token. Abra Conexões MCP para revisar a configuração atual.",
        );
        return;
      }

      setConnectingId(entry.id);
      try {
        // Use the Mobile Agent's existing secure OAuth + browser callback flow,
        // not any ChatGPT session or token.
        let id: string;
        if (existing) {
          await connectMcpServerOAuth(existing.id);
          if (!existing.enabled) {
            await updateMcpServer(existing.id, { enabled: true });
          }
          id = existing.id;
        } else {
          const server = await createMcpServerOAuth({
            enabled: true,
            label: oauth.label,
            transport: oauth.transport,
            url: oauth.url,
          });
          id = server.id;
        }

        try {
          // Completing a browser grant is NOT proof that the MCP endpoint works.
          await testMcpServer(id);
          router.push("/settings/mcp/connected" as never);
        } catch {
          setConnectionError(
            "A autorização terminou, mas o serviço não passou no teste. Abra Conexões MCP para conferir o diagnóstico.",
          );
        }
      } catch (error) {
        if (!isMcpOAuthCanceledError(error)) {
          setConnectionError(
            "Não foi possível concluir a autorização. Confira a conta e as permissões no navegador. Alguns serviços exigem aprovação do aplicativo para permitir o acesso.",
          );
        }
      } finally {
        setConnectingId(null);
      }
      return;
    }

    if (entry.action === "mcp") {
      // GitHub remote MCP uses a personal access token unless the client owns
      // a separately registered and approved GitHub OAuth app.
      router.push("/settings/mcp/list?connect=github" as never);
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

      {connectionError ? (
        <Card className="gap-sp-2 px-sp-4 py-sp-4">
          <Text
            accessibilityRole="alert"
            className="font-sans text-sm text-destructive dark:text-destructive-dark"
          >
            {connectionError}
          </Text>
          <Button
            size="sm"
            variant="outline"
            onPress={() => router.push("/settings/mcp/connected" as never)}
          >
            Ver conexões e diagnóstico
          </Button>
        </Card>
      ) : null}

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
            const authorizing = connectingId === entry.id;
            const oauth = getOneTapOAuthPreset(entry);
            const subtitle =
              status === "connected"
                ? "Conectado e testado"
                : status === "configured"
                  ? "Adicionada — teste a conexão"
                  : oauth
                    ? authorizing
                      ? "Aguardando autorização no navegador…"
                      : "Toque para autorizar no navegador"
                    : entry.action === "mcp"
                      ? "Conectar por token"
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
                  accessibilityState={{ disabled: !actionable || connectingId !== null }}
                  className="min-h-16 flex-row items-center gap-sp-3 px-sp-4 py-sp-3"
                  disabled={!actionable || connectingId !== null}
                  onPress={() => void openIntegration(entry)}
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
