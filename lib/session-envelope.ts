/** Shared, runtime-neutral session grammar. Both signature verifiers must accept
 * the same bytes and legacy claims before either transport can be selected.
 * These helpers do NOT verify a signature or establish current account authority. */
export function splitSessionEnvelope(token: string | null | undefined): { body: string; signature: string } | null {
  if (typeof token !== "string" || token.length > 32768) return null;
  const segments = token.split(".");
  if (segments.length !== 2) return null;
  const [body, signature] = segments;
  if (!body || !signature || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  return { body, signature };
}

/** Call only after signature verification. One decoder prevents Node's lenient
 * Buffer parsing and the proxy's Web APIs from assigning different identities. */
export function decodeSessionBody(body: string): unknown {
  const base64 = body.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

const forbiddenLegacyMarkers = ["authority", "staffAuthority", "durableIdentity"] as const;
export function hasCanonicalSessionMarker(payload: object): boolean {
  return forbiddenLegacyMarkers.some(key => Object.hasOwn(payload, key));
}

export type LegacyEnvelopeClaims = Record<string, unknown> & { userId: number; expiresAt: number };

/** Signed canonical cookies are selected even when admission will reject them;
 * they must never fall through to a different legacy Bearer identity. */
export function classifySessionEnvelope(payload: unknown):
  | { kind: "canonical" }
  | { kind: "legacy"; payload: LegacyEnvelopeClaims }
  | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (hasCanonicalSessionMarker(payload)) return { kind: "canonical" };
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.expiresAt !== "number" || !Number.isFinite(candidate.expiresAt) || candidate.expiresAt <= Date.now()) return null;
  if (!Number.isSafeInteger(candidate.userId) || (candidate.userId as number) < 1) return null;
  return { kind: "legacy", payload: candidate as LegacyEnvelopeClaims };
}
