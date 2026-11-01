"use client";
import { useRef, useState } from "react";
import { LOGIN_PHOTO_ASSET, LOGIN_PHOTO_KEYS, LOGIN_PHOTO_MAX_BYTES, LOGIN_PHOTO_VISIBLE, loginPhotoVersions, parseLoginPhotoAsset } from "@/lib/login-photo";

export function LoginPhotoEditor({ values, versions, editable, onSaved }: {
  values: Record<string, string>; versions: Record<string, string | null>;
  editable: boolean; onSaved: (payload: Record<string, unknown>) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const asset = parseLoginPhotoAsset(values[LOGIN_PHOTO_ASSET] ?? "");
  const visible = values[LOGIN_PHOTO_VISIBLE] === "true";
  async function save(kind: "upload" | "visibility") {
    if (!editable || inFlight.current || (kind === "upload" && !file)) return;
    inFlight.current = true; setBusy(true); setError(null); setSuccess(null);
    try {
      const expected = Object.fromEntries(LOGIN_PHOTO_KEYS.map(k => [k, versions[k] ?? null]));
      let request: RequestInit;
      if (kind === "upload") {
        const form = new FormData(); form.append("file", file!); form.append("__versions", JSON.stringify(expected));
        request = { method: "POST", body: form };
      } else {
        request = { method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visible: !visible, __versions: expected }) };
      }
      const response = await fetch("/api/settings/login-photo", request);
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر حفظ الصورة. حدّث الإعدادات وأعد المحاولة."); return; }
      if (!payload || !loginPhotoVersions(payload.__versions)
        || typeof payload[LOGIN_PHOTO_ASSET] !== "string"
        || !["true", "false"].includes(payload[LOGIN_PHOTO_VISIBLE])
        || (payload[LOGIN_PHOTO_ASSET] !== "" && !parseLoginPhotoAsset(payload[LOGIN_PHOTO_ASSET]))) {
        setError("تعذّر تأكيد نتيجة الحفظ. حدّث الإعدادات للتحقق قبل إعادة المحاولة."); return;
      }
      const savedAsset = parseLoginPhotoAsset(payload[LOGIN_PHOTO_ASSET]);
      const expectedVisible = kind === "upload" ? "false" : String(!visible);
      if (!savedAsset || payload[LOGIN_PHOTO_VISIBLE] !== expectedVisible
        || (kind === "visibility" && savedAsset.key !== asset?.key)) {
        setError("تعذّر تأكيد نتيجة الحفظ. حدّث الإعدادات للتحقق قبل إعادة المحاولة."); return;
      }
      onSaved(payload); setFile(null); if (input.current) input.current.value = "";
      setSuccess(kind === "upload" ? "حُفظت الصورة وهي مخفية. يمكنك إظهارها عندما تكون جاهزًا."
        : payload[LOGIN_PHOTO_VISIBLE] === "true" ? "أصبحت الصورة ظاهرة في شاشة الدخول." : "أُخفيت الصورة دون حذفها.");
    } catch { setError("تعذّر تأكيد الحفظ. حدّث الإعدادات للتحقق قبل إعادة المحاولة."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <article aria-label="صورة شاشة الدخول" className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm xl:col-span-2">
    <h2 className="text-sm font-black text-navy-950">صورة شاشة الدخول</h2>
    <p className="mt-2 text-sm text-slate-600">ارفع الصورة من جهازك أو غيّرها هنا. تُحفظ مخفية حتى تضغط «إظهار الصورة للزوار». الإخفاء لا يحذفها.</p>
    <p className="mt-1 text-xs text-slate-600">عند الإظهار تصبح الصورة عامة قبل تسجيل الدخول، بما فيها بياناتها الأصلية المضمّنة إن وُجدت. اختر صورة مناسبة للنشر؛ إخفاؤها لاحقًا لا يسحب النسخ التي حُفظت سابقًا.</p>
    <div className="mt-4 flex flex-wrap items-center gap-4">
      {asset && editable ? <img src={`/api/settings/login-photo?v=${encodeURIComponent(versions[LOGIN_PHOTO_ASSET] ?? "")}`}
        alt="معاينة صورة شاشة الدخول" className="h-24 w-24 rounded-full border-2 border-brand-orange object-cover object-top" /> : null}
      <p className="text-sm font-bold text-navy-900">{asset ? visible ? "الحالة: ظاهرة للزوار" : "الحالة: محفوظة ومخفية" : "لم تُرفع صورة؛ يظهر شعار المركز بدلًا منها."}</p>
    </div>
    {editable ? <fieldset disabled={busy} className="mt-4 space-y-3">
      <label className="block text-sm font-bold text-navy-900">اختيار صورة أو تغييرها
        <input ref={input} type="file" accept="image/jpeg,image/png" className="mt-2 block w-full text-sm"
          onChange={e => {
            const chosen = e.target.files?.[0] ?? null; setSuccess(null); setError(null);
            if (chosen && (!["image/jpeg", "image/png"].includes(chosen.type) || chosen.size > LOGIN_PHOTO_MAX_BYTES)) {
              setFile(null); setError("اختر JPEG أو PNG لا تتجاوز ٢ ميغابايت."); return;
            }
            setFile(chosen);
          }} />
      </label>
      <p className="text-xs text-slate-500">JPEG أو PNG ثابتة، حتى ٢ ميغابايت و٦٠٠٠ بكسل لكل ضلع و١٦ مليون بكسل إجمالًا.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={!file || busy} onClick={() => void save("upload")}
          className="rounded-xl bg-navy-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">حفظ الصورة مخفية</button>
        <button type="button" disabled={!asset || busy} onClick={() => void save("visibility")}
          className="rounded-xl border border-navy-800 px-4 py-2 text-sm font-bold text-navy-900 disabled:opacity-50">
          {visible ? "إخفاء الصورة" : "إظهار الصورة للزوار"}
        </button>
      </div>
      {busy ? <p role="status" className="text-sm">جارٍ الحفظ…</p> : null}
    </fieldset> : <p className="mt-3 text-sm text-slate-600">تعديل الصورة وإظهارها متاح لإدارة الهوية فقط.</p>}
    {error ? <p role="alert" className="mt-3 text-sm text-danger-900">{error}</p> : null}
    {success ? <p role="status" className="mt-3 text-sm text-success-700">{success}</p> : null}
  </article>;
}
