import { useState } from "react";
import { Linking, Text, View } from "react-native";

import { Button } from "@/components/ui/button";
import { DrawerBody, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { useConfig } from "@/hooks/use-config";
import {
  createGuidedTokenHeaders,
  type GuidedTokenServer,
} from "@/modules/mcp/guided-token-presets";

export function McpTokenQuickConnect({
  config,
  onConnected,
  onManage,
}: {
  config: GuidedTokenServer;
  onConnected: () => void;
  onManage: () => void;
}) {
  const { createMcpServer, mcpServers, testMcpServer, updateMcpServer } =
    useConfig();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = mcpServers.find(
    (server) =>
      server.url.replace(/\\/$/, "") === config.url.replace(/\\/$/, ""),
  );

  const saveAndTest = async () => {
    let headers: Record<string, string>;
    try {
      headers = createGuidedTokenHeaders(config, token);
    } catch (validationError) {
      setError(
        validationError instanceof Error
          ? validationError.message
          : "Confira sua chave e tente novamente.",
      );
      return;
    }

    setBusy(true);
    setError(null);

    try {
      let serverId: string;
      if (existing) {
        await updateMcpServer(existing.id, {
          authMode: "headers",
          enabled: true,
          headerValues: headers,
          label: config.label,
          transport: "http",
          url: config.url,
        });
        serverId = existing.id;
      } else {
        const created = await createMcpServer({
          authMode: "headers",
          enabled: true,
          headerValues: headers,
          label: config.label,
          transport: "http",
          url: config.url,
        });
        serverId = created.id;
      }

      // Never retain or display the secret after the secure-store write.
      setToken("");
      setSaved(true);

      try {
        await testMcpServer(serverId);
        onConnected();
      } catch {
        setError(
          "A chave foi salva, mas o teste falhou. Abra suas conexões para consultar o diagnóstico.",
        );
      }
    } catch {
      setError("Não foi possível salvar a chave. Confira a configuração.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{`Conectar ${config.label}`}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody contentContainerClassName="gap-sp-4 pb-sp-4">
        <View className="gap-sp-2">
          <Text className="font-sans text-base font-semibold text-foreground dark:text-foreground-dark">
            {existing ? "Atualizar chave de acesso" : "Conexão por chave de API"}
          </Text>
          <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
            {config.instructions}
          </Text>
          <Button
            onPress={() => {
              void Linking.openURL(config.helpUrl).catch(() =>
                setError("Não foi possível abrir o site do serviço."),
              );
            }}
            variant="outline"
            size="sm"
          >
            Abrir site para obter chave
          </Button>
          <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
            Cole sua chave somente no campo protegido abaixo, nunca em chats,
            arquivos ou capturas de tela.
          </Text>
        </View>

        {!saved ? (
          <View className="gap-sp-2">
            <Text className="font-sans text-sm font-medium text-foreground dark:text-foreground-dark">
              Chave de API
            </Text>
            <Input
              accessibilityLabel={`Chave de API do ${config.label}`}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              onChangeText={setToken}
              placeholder="Cole sua chave aqui"
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
            onPress={() => void saveAndTest()}
          >
            {existing ? "Atualizar e testar" : "Conectar e testar"}
          </Button>
        )}
        <Text className="font-sans text-xs text-muted-foreground dark:text-muted-foreground-dark">
          A conexão só será considerada ativa após um teste bem-sucedido.
          As permissões e eventuais custos dependem do serviço.
        </Text>
      </DrawerBody>
    </>
  );
}
