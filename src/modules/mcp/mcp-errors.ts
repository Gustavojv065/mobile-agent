/**
 * Human-readable error selection for MCP connection failures.
 *
 * Pure helpers (no native imports) so the fallback/transport-mismatch logic
 * stays unit-testable. `connectMcpClient` tries the configured transport and
 * then the alternate one, so `errors` is ordered oldest-first.
 */

export function parseOAuthErrorMessage(message: string) {
  const descriptionMatch = message.match(
    /["']error_description["']\s*:\s*["']([^"']+)["']/i,
  );
  if (descriptionMatch?.[1]) {
    return descriptionMatch[1];
  }

  return null;
}

export function getActionableMcpErrorMessages(
  error: unknown,
  depth = 0,
): string[] {
  if (depth > 4) return [];

  if (error instanceof Error) {
    const nested = getActionableMcpErrorMessages(
      (error as Error & { cause?: unknown }).cause,
      depth + 1,
    );
    const parsedOAuthError = parseOAuthErrorMessage(error.message);
    return [parsedOAuthError ?? error.message, ...nested].filter(Boolean);
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const description =
      typeof record.error_description === "string"
        ? record.error_description
        : null;
    const ownMessage = description
      ? description
      : typeof record.message === "string"
        ? record.message
        : null;
    return [
      ...(ownMessage ? [ownMessage] : []),
      ...getActionableMcpErrorMessages(record.cause, depth + 1),
    ];
  }

  return typeof error === "string" && error.trim() ? [error] : [];
}

export function getActionableMcpErrorMessage(errors: unknown[]) {
  const messages = errors
    .flatMap((error) => getActionableMcpErrorMessages(error))
    .map((message) => message.trim())
    .filter(Boolean);
  // Failures are pushed in attempt order, so scan from the last one: when the
  // configured transport fails (e.g. SSE 405 on an http-only server) the
  // fallback transport's error is the actionable one.
  const specific = [...messages]
    .reverse()
    .find((message) =>
      /error_description|oauth|unauthori[sz]ed|forbidden|invalid_|\b(?:400|401|403|404|405|409|422|429)\b/i.test(
        message,
      ),
    );

  const base =
    specific ??
    messages[messages.length - 1] ??
    "Failed to connect MCP server.";
  return errors.length > 1
    ? `${base} (Tried both "sse" and "http" transports.)`
    : base;
}

const TRANSPORT_MISMATCH_PATTERN =
  /\b404\b|\b405\b|method not allowed|does not support .*transport/i;

/**
 * Whether a connection failure looks like the wrong transport was used
 * (e.g. SSE 405 on an http-only server). Only these failures justify
 * probing the alternate transport; auth/timeout/network errors should fail
 * fast against the configured transport instead of generating noise.
 */
export function isTransportMismatchError(error: unknown): boolean {
  return getActionableMcpErrorMessages(error).some((message) =>
    TRANSPORT_MISMATCH_PATTERN.test(message),
  );
}
