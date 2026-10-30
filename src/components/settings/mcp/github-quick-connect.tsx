import { useState } from "react";
import { Linking, Text, View } from "react-native";

import { Button } from "@/components/ui/button";
import { DrawerBody, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { useConfig } from "@/hooks/use-config";

// Use the official remote GitHub MCP endpoint, not a URL from a remote catalog.
// A token must never be sent to an arbitrary server supplied by a catalog.
const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
const GITHUB_TOKEN_URL =
  "https://github.com/settings/personal-access-tokens/new";

export function GitHubQuickConnect({
  onConnected,
  onManage,
}: {
  onConnected: () => void;
  onManage: () => void;
}) {
  const { createMcpServer, mcpServers, testMcpServer, updateMcpServer } = useConfig();
  const [token, setToken] = useState("");
  const existingGitHub = mcpServers.find(
    (server) => server.url.replace(/\/$/, "") === GITHUB_MCP_URL.replace(/\/$/, ""),
  );
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    const value = token.trim();

    if (!value || /\s/.test(value)) {
      setError("Cole um token válido do GitHub, sem espaços.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      let serverId: string;
      if (existingGitHub) {
        await updateMcpServer(existingGitHub.id, {
          authMode: "headers",
          enabled: true,
          headerValues: { Authorization: "Bearer " + value },
          label: "GitHub",
          transport: "http",
          url: GITHUB_MCP_URL,
        });
        serverId = existingGitHub.id;
      } else {
        const server = await createMcpServer({
          authMode: "headers",
          enabled: true,
          headerValues: { Authorization: "Bearer " + value },
          label: "GitHub",
          transport: "http",
          url: GITHUB_MCP_URL,
        });
        serverId = server.id;
      }

      // The existing credential store persists headers securely. Do not
      // retain the plaintext token in component state after saving it.
      setToken("");
      setSaved(true);

      try {
        await testMcpServer(serverId);
        onConnected();
      } catch {
        setError(
          "A conexão foi salva, mas o teste falhou. Abra suas conexões para consultar o erro e ajustar o token.",
        );
      }
    } catch {
      setError(
        "Não foi possível salvar a conexão. Confira o token e tente novamente.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>Conectar GitHub</DrawerTitle>
      </DrawerHeader>
      <DrawerBody contentContainerClassName="gap-sp-4 pb-sp-4">
        <View className="gap-sp-2">
          <Text className="font-sans text-base font-semibold text-foreground dark:text-foreground-dark">
            {existingGitHub ? "Atualizar acesso ao GitHub" : "Seus repositórios em poucos passos"}
          </Text>
          <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
            1. Crie um token de acesso de permissões específicas (fine-grained)
            no GitHub. Selecione somente os repositórios necessários e prefira
            permissões de leitura.
          </Text>
          <Button
            onPress={() => {
              void Linking.openURL(GITHUB_TOKEN_URL).catch(() =>
                setError("Não foi possível abrir o site do GitHub."),
              );
            }}
            size="sm"
            variant="outline"
          >
            Criar token no GitHub
          </Button>
          <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
            2. Copie o token e cole abaixo. Ele será guardado no armazenamento
            seguro do aplicativo. Nunca compartilhe seu token no chat.
          </Text>
        </View>

        {!saved ? (
          <View className="gap-sp-2">
            <Text className="font-sans text-sm font-medium text-foreground dark:text-foreground-dark">
              Token de acesso
            </Text>
            <Input
              accessibilityLabel="Token pessoal do GitHub"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              onChangeText={setToken}
              placeholder="Cole seu token aqui"
              secureTextEntry
              value={token}
            />
          </View>
        ) : null}

        {error ? (
          <Text className="font-sans text-sm text-destructive dark:text-destructive-dark">
            {error}
          </Text>
        ) : null}

        {saved ? (
          <Button onPress={onManage}>Ver conexão e diagnóstico</Button>
        ) : (
          <Button
            disabled={!token.trim()}
            loading={busy}
            onPress={() => void connect()}
          >
            {existingGitHub ? "Atualizar e testar" : "Conectar e testar"}
          </Button>
        )}

        <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">
          O acesso real dependerá das permissões do token. O aplicativo só
          indicará conexão concluída depois de um teste bem-sucedido.
        </Text>
      </DrawerBody>
    </>
  );
}
