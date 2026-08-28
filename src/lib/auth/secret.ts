/**
 * AUTH_SECRET resolution with a hard production gate.
 *
 * Production runtime MUST provide AUTH_SECRET (>= 16 chars). A missing or
 * too-short secret throws at boot — the process refuses to start instead of
 * silently signing sessions with a public hard-coded string.
 *
 * `next build` (NEXT_PHASE = phase-production-build) may run without the
 * secret in CI: no requests are served and no sessions are signed during
 * build; the runtime check still applies when the server actually boots.
 */

export const MIN_AUTH_SECRET_LENGTH = 16;

export const DEV_FALLBACK_SECRET = "insecure-development-secret-change-me";

/** True when the process is serving production traffic (not a build step). */
export function isProductionRuntime(
  nodeEnv: string | undefined,
  nextPhase: string | undefined
): boolean {
  return nodeEnv === "production" && nextPhase !== "phase-production-build";
}

/**
 * Resolve the Better Auth signing secret.
 *
 * - Valid secret (>= 16 chars): returned as-is.
 * - Missing/short secret in production runtime: throws (boot refused).
 * - Missing/short secret in development/test/build: dev fallback with no
 *   silent production usage.
 */
export function resolveAuthSecret(
  env: Readonly<Record<string, string | undefined>>,
  nodeEnv: string | undefined,
  nextPhase: string | undefined
): string {
  const secret = env.AUTH_SECRET?.trim();

  if (secret && secret.length >= MIN_AUTH_SECRET_LENGTH) {
    return secret;
  }

  if (isProductionRuntime(nodeEnv, nextPhase)) {
    throw new Error(
      "AUTH_SECRET is required in production (minimum 16 characters). " +
        "Set the AUTH_SECRET environment variable on Railway (or your host) and redeploy. " +
        "The application refuses to start with a hard-coded secret."
    );
  }

  return DEV_FALLBACK_SECRET;
}
