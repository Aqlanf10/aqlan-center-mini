"use client";

import { useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { useSession } from "@/components/SessionProvider";

/**
 * (P2-2) حسابي — تغيير كلمة المرور ذاتيًّا.
 *
 * الكلمة الحالية شرط، والجديدة تُكتب مرتين، وبعد الحفظ تُطرد الأجهزة الأخرى
 * ويبقى هذا الجهاز داخلًا.
 */
export default function AccountPage() {
  const session = useSession();
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const mismatch = form.confirm.length > 0 && form.confirm !== form.newPassword;
  const canSubmit = !busy && form.currentPassword.length > 0 && form.newPassword.length >= 8
    && form.confirm === form.newPassword;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }),
      });
      const payload = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) {
        setError(payload?.message ?? "تعذّر تغيير كلمة المرور.");
        return;
      }
      setForm({ currentPassword: "", newPassword: "", confirm: "" });
      setDone(payload?.message ?? "تغيّرت كلمة المرور.");
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-md p-4 pb-24">
      <PageHeader title="حسابي" subtitle={session ? `${session.displayName || session.username} — ${session.username}` : undefined} />

      <form onSubmit={submit} className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="تغيير كلمة المرور">
        <h2 className="mb-3 text-sm font-extrabold">تغيير كلمة المرور</h2>
        <label className="mb-2 block text-xs font-bold text-slate-600">
          كلمة المرور الحالية
          <input type="password" autoComplete="current-password" value={form.currentPassword}
            onChange={(e) => setForm((c) => ({ ...c, currentPassword: e.target.value }))}
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" dir="ltr" />
        </label>
        <label className="mb-2 block text-xs font-bold text-slate-600">
          كلمة المرور الجديدة (8 أحرف على الأقل)
          <input type="password" autoComplete="new-password" value={form.newPassword}
            onChange={(e) => setForm((c) => ({ ...c, newPassword: e.target.value }))}
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" dir="ltr" />
        </label>
        <label className="mb-3 block text-xs font-bold text-slate-600">
          أعد كتابة كلمة المرور الجديدة
          <input type="password" autoComplete="new-password" value={form.confirm}
            onChange={(e) => setForm((c) => ({ ...c, confirm: e.target.value }))}
            className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" dir="ltr" />
        </label>
        {mismatch ? <p className="mb-2 text-xs font-bold text-red-700">الكلمتان غير متطابقتين.</p> : null}
        {error ? <p role="alert" className="mb-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p> : null}
        {done ? <p role="status" className="mb-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{done}</p> : null}
        <button type="submit" disabled={!canSubmit}
          className="w-full rounded-xl bg-navy-800 py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
          {busy ? "جارٍ الحفظ…" : "غيّر كلمة المرور"}
        </button>
      </form>
    </main>
  );
}
