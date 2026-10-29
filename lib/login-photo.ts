/** Login branding only: these reserved extensions cannot address patient uploads. */
export const LOGIN_PHOTO_ASSET = "clinic.login_photo_asset";
export const LOGIN_PHOTO_VISIBLE = "clinic.login_photo_visible";
export const LOGIN_PHOTO_KEYS = [LOGIN_PHOTO_ASSET, LOGIN_PHOTO_VISIBLE] as const;
export const LOGIN_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGIN_PHOTO_BODY_BYTES = LOGIN_PHOTO_MAX_BYTES + 16 * 1024;
export const LOGIN_PHOTO_MAX_DIMENSION = 6000;
export const LOGIN_PHOTO_MAX_PIXELS = 16_000_000;
export const LOGIN_PHOTO_EXTENSIONS = { "image/jpeg": "loginjpg", "image/png": "loginpng" } as const;
export interface LoginPhotoAsset {
  key: string; sha256: string; mimeType: keyof typeof LOGIN_PHOTO_EXTENSIONS;
  sizeBytes: number; width: number; height: number;
}
export function validLoginPhotoDimensions(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    && width <= LOGIN_PHOTO_MAX_DIMENSION && height <= LOGIN_PHOTO_MAX_DIMENSION
    && width * height <= LOGIN_PHOTO_MAX_PIXELS;
}
export function parseLoginPhotoAsset(raw: string): LoginPhotoAsset | null {
  try {
    const v = JSON.parse(raw) as LoginPhotoAsset;
    if (!v || typeof v !== "object" || Array.isArray(v)
      || typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.sha256)
      || !Object.hasOwn(LOGIN_PHOTO_EXTENSIONS, v.mimeType)
      || !Number.isInteger(v.sizeBytes) || v.sizeBytes <= 0 || v.sizeBytes > LOGIN_PHOTO_MAX_BYTES
      || !validLoginPhotoDimensions(v.width, v.height)) return null;
    const ext = LOGIN_PHOTO_EXTENSIONS[v.mimeType];
    if (v.key !== `${v.sha256.slice(0, 2)}/${v.sha256.slice(2, 4)}/${v.sha256}.${ext}`) return null;
    return { key: v.key, sha256: v.sha256, mimeType: v.mimeType, sizeBytes: v.sizeBytes, width: v.width, height: v.height };
  } catch { return null; }
}
export function loginPhotoVersions(raw: unknown): Record<string, string | null> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (LOGIN_PHOTO_KEYS.some(k => !Object.hasOwn(v, k) || !(v[k] === null || typeof v[k] === "string"))) return null;
  return Object.fromEntries(LOGIN_PHOTO_KEYS.map(k => [k, v[k] as string | null]));
}
