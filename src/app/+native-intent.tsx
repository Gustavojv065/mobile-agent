const MCP_OAUTH_CALLBACK_ROUTE = "/mcp/oauth/callback";

const APP_SCHEMES = new Set(["mobile-agent:", "exp+mobile-agent:"]);
const WEB_SCHEMES = new Set(["http:", "https:"]);

/**
 * A share intent normally carries its payload in extras and no `data` URI, but
 * some apps/ROMs attach one. Expo Linking treats any `intent.data` as the
 * initial URL, so ignore foreign schemes (content:, file:, …) instead of
 * asking the router to navigate to them.
 */
function isForeignScheme(path: string) {
  if (!path.includes(":")) return false;

  try {
    const { protocol } = new URL(path, "mobile-agent://app.home");

    return !APP_SCHEMES.has(protocol) && !WEB_SCHEMES.has(protocol);
  } catch {
    return false;
  }
}

function stripQueryAndHash(path: string) {
  return path.split(/[?#]/, 1)[0] ?? path;
}

function isMcpOAuthCallback(path: string) {
  try {
    const url = new URL(path, "mobile-agent://app.home");

    return (
      (url.hostname === "mcp" && url.pathname === "/oauth/callback") ||
      url.pathname === MCP_OAUTH_CALLBACK_ROUTE
    );
  } catch {
    const normalizedPath = stripQueryAndHash(path);

    return (
      normalizedPath === MCP_OAUTH_CALLBACK_ROUTE ||
      normalizedPath === "mcp/oauth/callback" ||
      normalizedPath === "/oauth/callback" ||
      normalizedPath === "oauth/callback"
    );
  }
}

export function redirectSystemPath({ path }: { initial: boolean; path: string }) {
  if (isMcpOAuthCallback(path)) {
    return MCP_OAUTH_CALLBACK_ROUTE;
  }

  if (isForeignScheme(path)) {
    return "/";
  }

  return path;
}
