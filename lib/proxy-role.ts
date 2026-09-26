/**
 * (P2-1) دور الجلسة كما يراه الباب (proxy) — بتحقق توقيعٍ كامل بـ Web Crypto.
 *
 * الباب يعمل حيث قد لا يتاح `node:crypto`، فيُعاد هنا التحقق نفسه الذي في
 * `lib/auth.readSessionToken` (HMAC-SHA256 بـ SESSION_SECRET على جسم التوكن، ثم
 * الانتهاء) بواجهة `crypto.subtle` المتاحة في كل بيئة.
 *
 * وما يُرجعه هو **الدور الموقَّع** — ولا يثق به الباب لأكثر من التضييق: توكنٌ لا
 * يُتحقَّق منه يُعامل كأنه بلا دور مقيَّد، ثم يرفضه المسار نفسه في `requireSession`.
 * وتغيير دور المستخدم يُبطل جلساته القائمة (lib/session)، فالدور الموقَّع يطابق
 * القاعدة دائمًا.
 */

const encoder = new TextEncoder();
let cachedKey: { secret: string; key: CryptoKey } | null = null;

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret === secret) return cachedKey.key;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  cachedKey = { secret, key };
  return key;
}

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Signed role and its per-user finance limits, or null for an invalid token. */
export async function verifiedSessionAccess(token: string | undefined | null, secret = process.env.SESSION_SECRET): Promise<{
  role: string; financeAccess?: Record<string, unknown>;
} | null> {
  if (!token || !secret || secret.length < 32) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  try {
    const expected = toBase64Url(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body)));
    if (!sameString(expected, signature)) return null;
    const payload = JSON.parse(fromBase64Url(body)) as { role?: unknown; expiresAt?: unknown; financeAccess?: unknown };
    if (typeof payload.expiresAt !== "number" || payload.expiresAt < Date.now()) return null;
    return typeof payload.role === "string"
      ? { role: payload.role, financeAccess: payload.financeAccess && typeof payload.financeAccess === "object"
        ? payload.financeAccess as Record<string, unknown> : undefined }
      : null;
  } catch {
    return null;
  }
}

/** Compatibility helper for callers that only need the signed role. */
export async function verifiedSessionRole(token: string | undefined | null, secret = process.env.SESSION_SECRET): Promise<string | null> {
  return (await verifiedSessionAccess(token, secret))?.role ?? null;
}
