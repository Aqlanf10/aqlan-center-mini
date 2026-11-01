import { NextResponse } from "next/server";
import { readStoredSettings, saveSettingsAudited } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canManageCategory } from "@/lib/settings-permissions";
import { bodyErrorResponse, readBoundedFormData, readJsonBody } from "@/lib/http-body";
import { LOGIN_PHOTO_ASSET, LOGIN_PHOTO_BODY_BYTES, LOGIN_PHOTO_KEYS, LOGIN_PHOTO_MAX_BYTES,
  LOGIN_PHOTO_VISIBLE, loginPhotoVersions, parseLoginPhotoAsset } from "@/lib/login-photo";
import { readVerifiedLoginPhoto, storeLoginPhoto, validateLoginPhotoBytes } from "@/lib/login-photo-server";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const fail = (message: string, status: number) => NextResponse.json({ message }, { status, headers });
async function actor() {
  const session = await requireSession();
  if (!session) return { error: fail("انتهت الجلسة. سجّل الدخول من جديد.", 401) } as const;
  if (!canManageCategory(session.role, "branding")) return { error: fail("تعديل صورة الدخول يحتاج صلاحية إدارة الهوية.", 403) } as const;
  return { session } as const;
}
async function snapshot() {
  const stored = await readStoredSettings();
  return NextResponse.json({
    [LOGIN_PHOTO_ASSET]: stored.get(LOGIN_PHOTO_ASSET)?.value ?? "",
    [LOGIN_PHOTO_VISIBLE]: stored.get(LOGIN_PHOTO_VISIBLE)?.value ?? "false",
    __versions: Object.fromEntries(LOGIN_PHOTO_KEYS.map(k => [k, stored.get(k)?.updatedAt ?? null])),
  }, { headers });
}
async function save(values: Record<string, string>, expected: Record<string, string | null>,
  session: { username: string; role: string }) {
  const result = await saveSettingsAudited({
    values, expected, actor: session.username, actorRole: session.role,
    transactionalAudit: true, // Never client-controlled; both setting rows and audit commit together.
  });
  if (!result.ok) return fail("تغيرت الصورة أو حالة إظهارها. حدّث الإعدادات قبل إعادة المحاولة.", 409);
  return snapshot();
}
export async function GET() {
  const access = await actor(); if ("error" in access) return access.error;
  try {
    const stored = await readStoredSettings();
    const asset = parseLoginPhotoAsset(stored.get(LOGIN_PHOTO_ASSET)?.value ?? "");
    const bytes = asset ? await readVerifiedLoginPhoto(asset) : null;
    if (!asset || !bytes) return new Response(null, { status: 404, headers });
    return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Type": asset.mimeType,
      "Content-Disposition": "inline", "Content-Security-Policy": "default-src 'none'; sandbox" } });
  } catch { return fail("تعذّر تحميل معاينة الصورة.", 500); }
}
export async function POST(request: Request) {
  const access = await actor(); if ("error" in access) return access.error;
  try {
    const form = await readBoundedFormData(request, LOGIN_PHOTO_BODY_BYTES);
    let rawVersions: unknown;
    try { rawVersions = JSON.parse(String(form.get("__versions") ?? "")); } catch { return fail("نسخة الإعداد مفقودة. حدّث الصفحة.", 409); }
    const expected = loginPhotoVersions(rawVersions);
    if (!expected) return fail("نسخة الإعداد مفقودة. حدّث الصفحة.", 409);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0 || file.size > LOGIN_PHOTO_MAX_BYTES) return fail("اختر صورة JPEG أو PNG لا تتجاوز ٢ ميغابايت.", 400);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!validateLoginPhotoBytes(bytes, file.type)) return fail("الصورة غير صالحة. استخدم JPEG أو PNG ثابتة ضمن حدود الحجم والأبعاد.", 400);
    const asset = await storeLoginPhoto(bytes, file.type);
    // Replacement is private until the owner explicitly publishes this exact version.
    return await save({ [LOGIN_PHOTO_ASSET]: JSON.stringify(asset), [LOGIN_PHOTO_VISIBLE]: "false" }, expected, access.session);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) { bounded.headers.set("Cache-Control", "private, no-store"); bounded.headers.set("X-Content-Type-Options", "nosniff"); return bounded; }
    return fail("تعذّر حفظ الصورة. تحقق من التخزين الدائم وحدّث الإعدادات قبل إعادة المحاولة.", 500);
  }
}
export async function PATCH(request: Request) {
  const access = await actor(); if ("error" in access) return access.error;
  try {
    const body = await readJsonBody(request, 4096) as Record<string, unknown>;
    const expected = loginPhotoVersions(body?.__versions);
    if (!expected) return fail("نسخة الإعداد مفقودة. حدّث الصفحة.", 409);
    if (typeof body.visible !== "boolean") return fail("حالة الإظهار غير صالحة.", 400);
    const stored = await readStoredSettings();
    const raw = stored.get(LOGIN_PHOTO_ASSET)?.value ?? "";
    const asset = parseLoginPhotoAsset(raw);
    if (body.visible && (!asset || !(await readVerifiedLoginPhoto(asset)))) return fail("ارفع صورة صالحة قبل إظهارها.", 400);
    return await save({ [LOGIN_PHOTO_ASSET]: raw, [LOGIN_PHOTO_VISIBLE]: String(body.visible) }, expected, access.session);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) { bounded.headers.set("Cache-Control", "private, no-store"); bounded.headers.set("X-Content-Type-Options", "nosniff"); return bounded; }
    return fail("تعذّر تأكيد التغيير. حدّث الإعدادات قبل إعادة المحاولة.", 500);
  }
}
