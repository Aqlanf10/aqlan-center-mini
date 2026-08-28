"use client";

import { useState } from "react";

/**
 * إنشاء أول مدير — تُستخدم مرة واحدة ثم تُغلق نفسها.
 *
 * تطلب رمز الإعداد من متغيرات النشر: بدونه يستطيع أول من يجد الرابط أن يصير المدير.
 */
export default function SetupPage() {
  const [form, setForm] = useState({ token: "", username: "", displayName: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر إنشاء الحساب.");
        return;
      }
      setDone(true);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
          <p className="text-sm font-bold text-emerald-800">أُنشئ حساب المدير.</p>
          <p className="mt-2 text-xs text-emerald-700">
            احذف <code>SETUP_TOKEN</code> من إعدادات النشر الآن — لم يعد له عمل.
          </p>
          <a href="/login" className="mt-4 inline-block rounded-xl bg-navy-800 px-5 py-2 text-sm font-bold text-white">
            إلى تسجيل الدخول
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6">
        <h1 className="text-lg font-extrabold">الإعداد الأول</h1>
        <p className="mt-1 text-xs text-slate-500">يُستخدم مرة واحدة لإنشاء حساب المدير.</p>

        {([
          ["token", "رمز الإعداد", "text"],
          ["displayName", "الاسم الظاهر", "text"],
          ["username", "اسم المستخدم", "text"],
          ["password", "كلمة المرور (8 أحرف فأكثر)", "password"],
        ] as const).map(([key, label, type]) => (
          <div key={key}>
            <label className="mt-3 block text-xs font-bold" htmlFor={key}>{label}</label>
            <input
              id={key}
              type={type}
              value={form[key]}
              onChange={set(key)}
              autoCapitalize="none"
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-blue"
            />
          </div>
        ))}

        {error ? (
          <p role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="mt-5 w-full rounded-xl bg-brand-orange py-2.5 text-sm font-bold text-white disabled:opacity-50"
        >
          {busy ? "جارٍ الإنشاء…" : "إنشاء حساب المدير"}
        </button>
      </form>
    </main>
  );
}
