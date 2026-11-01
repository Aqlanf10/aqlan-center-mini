import { readStoredSettings } from "@/lib/db";
import { LOGIN_PHOTO_ASSET, LOGIN_PHOTO_VISIBLE, parseLoginPhotoAsset } from "@/lib/login-photo";
import { readVerifiedLoginPhoto } from "@/lib/login-photo-server";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
export async function GET() {
  try {
    // Fresh DB state on every request: hiding must not depend on settings caches.
    const stored = await readStoredSettings();
    if (stored.get(LOGIN_PHOTO_VISIBLE)?.value !== "true") return new Response(null, { status: 404, headers });
    const asset = parseLoginPhotoAsset(stored.get(LOGIN_PHOTO_ASSET)?.value ?? "");
    const bytes = asset ? await readVerifiedLoginPhoto(asset) : null;
    if (!asset || !bytes) return new Response(null, { status: 404, headers });
    return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Type": asset.mimeType,
      "Content-Disposition": "inline", "Content-Security-Policy": "default-src 'none'; sandbox" } });
  } catch { return new Response(null, { status: 404, headers }); }
}
