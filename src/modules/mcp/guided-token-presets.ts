import type { McpServerPreset } from "./catalog";

/**
 * Only offer simplified API-key entry for known server URLs. The public MCP
 * catalog is updated remotely; never send a secret to a new URL merely
 * because a remote catalog entry keeps the same ID.
 */
export const GUIDED_TOKEN_SERVERS = {
  render: {
    id: "render",
    label: "Render",
    url: "https://mcp.render.com/mcp",
    headerName: "Authorization",
    prefix: "Bearer ",
    instructions: "Crie uma chave de API no painel do Render e cole abaixo.",
    helpUrl: "https://dashboard.render.com/u/settings#api-keys",
  },
  "google-maps": {
    id: "google-maps",
    label: "Google Maps",
    url: "https://mapstools.googleapis.com/mcp",
    headerName: "X-Goog-Api-Key",
    prefix: "",
    instructions: "Crie uma chave no Google Cloud com as APIs e restrições necessárias. O uso pode gerar cobrança.",
    helpUrl: "https://console.cloud.google.com/apis/credentials",
  },
} as const;

export type GuidedTokenServer =
  (typeof GUIDED_TOKEN_SERVERS)[keyof typeof GUIDED_TOKEN_SERVERS];

function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      return null;
    return url.href.replace(/\\/$/, "");
  } catch {
    return null;
  }
}

export function getGuidedTokenServer(
  preset: Pick<McpServerPreset, "id" | "url" | "authMode" | "transport">,
): GuidedTokenServer | null {
  const config =
    GUIDED_TOKEN_SERVERS[preset.id as keyof typeof GUIDED_TOKEN_SERVERS];
  if (!config || preset.authMode !== "headers" || preset.transport !== "http") {
    return null;
  }
  return normalizeUrl(preset.url) === normalizeUrl(config.url) ? config : null;
}

export function createGuidedTokenHeaders(
  config: GuidedTokenServer,
  token: string,
): Record<string, string> {
  const value = token.trim();
  if (!value || /\\s/.test(value) || value.includes("\\r") || value.includes("\\n")) {
    throw new Error("Cole uma chave válida, sem espaços ou quebras de linha.");
  }
  return { [config.headerName]: config.prefix + value };
}
