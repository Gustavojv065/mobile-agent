/**
 * Familiar names from the user's ChatGPT plugin directory.
 *
 * The entries below are DISCOVERY SHORTCUTS ONLY. They are not installed
 * ChatGPT plugins and must not be represented as authenticated or available
 * tools until the corresponding Mobile Agent MCP connection is tested.
 */
export type IntegrationEntry = {
  id: string;
  name: string;
  description: string;
  action: "mcp" | "docs" | "skills" | "chatgpt";
  mcpPresetId?: "github" | "notion" | "supabase";
  mcpUrl?: string;
  docsUrl?: string;
};

export const FEATURED_INTEGRATIONS: readonly IntegrationEntry[] = [
  { id: "default-templates", name: "Default templates", description: "Modelos próprios do ChatGPT; não sincroniza automaticamente.", action: "chatgpt" },
  { id: "figma", name: "Figma", description: "MCP oficial disponível, mas o acesso pode exigir um cliente aprovado pelo Figma.", action: "docs", docsUrl: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/" },
  { id: "frontend-design-premium", name: "Frontend Design Premium", description: "Plugin do ChatGPT. Consulte o catálogo de skills para alternativas compatíveis.", action: "skills" },
  { id: "github", name: "GitHub", description: "Conecte repositórios e Pull Requests com seu token de acesso.", action: "mcp", mcpPresetId: "github", mcpUrl: "https://api.githubcopilot.com/mcp/" },
  { id: "gpts-to-plugin", name: "GPTs to Plugin", description: "Ferramenta da plataforma ChatGPT, sem sincronização com este APK.", action: "chatgpt" },
  { id: "magicpath", name: "MagicPath", description: "Integração com Mobile Agent ainda não confirmada.", action: "chatgpt" },
  { id: "minidroid", name: "MiniDroid", description: "Ferramenta independente; não é um servidor MCP nativo deste aplicativo.", action: "chatgpt" },
  { id: "notion", name: "Notion", description: "Conecte suas páginas e documentos autorizando no navegador.", action: "mcp", mcpPresetId: "notion", mcpUrl: "https://mcp.notion.com/mcp" },
  { id: "nvidia-skills", name: "NVIDIA Skills", description: "Explore skills compatíveis; a conexão do ChatGPT não é transferida.", action: "skills" },
  { id: "omgskills", name: "omgskills", description: "Explore skills compatíveis para instalar no Mobile Agent.", action: "skills" },
  { id: "pets", name: "Pets", description: "Plugin específico do ChatGPT, sem integração MCP verificada.", action: "chatgpt" },
  { id: "plugin-creator", name: "Plugin Creator", description: "Criador de plugins do ChatGPT; o Mobile Agent tem importação própria.", action: "chatgpt" },
  { id: "plugin-management", name: "Plugin Management", description: "Gerenciador de plugins do ChatGPT, separado do aplicativo.", action: "chatgpt" },
  { id: "product-design", name: "Product Design", description: "Explore skills de design equivalentes no catálogo do Mobile Agent.", action: "skills" },
  { id: "prompt-perfect", name: "Prompt Perfect", description: "Plugin do ChatGPT, sem sincronização automática de conta.", action: "chatgpt" },
  { id: "supabase", name: "Supabase", description: "Conecte seus projetos com autorização no navegador.", action: "mcp", mcpPresetId: "supabase", mcpUrl: "https://mcp.supabase.com/mcp" },
  { id: "template-creator", name: "Template Creator", description: "Plugin do ChatGPT. Consulte as skills disponíveis para templates.", action: "skills" },
  { id: "ui-ux-designer", name: "UI UX Designer", description: "Explore skills de design e acessibilidade compatíveis.", action: "skills" },
  { id: "vercel", name: "Vercel", description: "MCP oficial exige autorização e clientes aprovados pelo Vercel.", action: "docs", docsUrl: "https://vercel.com/docs/agent-resources/vercel-mcp" },
];

export function findMobileMcpConnection(
  entry: IntegrationEntry,
  servers: readonly { url: string; enabled: boolean; lastStatus?: string | null }[],
): "connected" | "configured" | "disconnected" | "unavailable" {
  if (entry.action !== "mcp" || !entry.mcpUrl) return "unavailable";
  const normalize = (url: string) => url.trim().replace(/\/$/, "");
  const server = servers.find((item) => normalize(item.url) === normalize(entry.mcpUrl!));
  if (!server) return "disconnected";
  return server.enabled && server.lastStatus === "connected" ? "connected" : "configured";
}
