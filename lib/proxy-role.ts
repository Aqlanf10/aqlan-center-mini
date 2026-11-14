import { classifySessionEnvelope, decodeSessionBody, splitSessionEnvelope } from "./session-envelope";

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

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type VerifiedProxySessionAccess =
  | { kind: "canonical"; role?: undefined; financeAccess?: undefined }
  | { kind: "legacy"; role?: string; financeAccess?: Record<string, unknown> };

/** Uses the same signed-envelope and legacy eligibility grammar as lib/auth.
 * A canonical envelope is selected without legacy grants: a caller must not
 * replace it with a Bearer just because the legacy route will reject it.
 * Current account/credential/permission revocation remains the handler's job. */
export async function verifiedSessionAccess(token: string | undefined | null, secret = process.env.SESSION_SECRET): Promise<VerifiedProxySessionAccess | null> {
  const envelope = splitSessionEnvelope(token);
  if (!envelope || !secret || secret.length < 32) return null;
  const { body, signature } = envelope;
  try {
    const expected = toBase64Url(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body)));
    if (!sameString(expected, signature)) return null;
    const selection = classifySessionEnvelope(decodeSessionBody(body));
    if (!selection || selection.kind === "canonical") return selection;
    const { payload } = selection;
    return {
      kind: "legacy",
      role: typeof payload.role === "string" ? payload.role : undefined,
      financeAccess: payload.financeAccess && typeof payload.financeAccess === "object"
        ? payload.financeAccess as Record<string, unknown> : undefined,
    };
  } catch {
    return null;
  }
}

/** Compatibility helper for callers that only need the signed role. */
export async function verifiedSessionRole(token: string | undefined | null, secret = process.env.SESSION_SECRET): Promise<string | null> {
  return (await verifiedSessionAccess(token, secret))?.role ?? null;
}
