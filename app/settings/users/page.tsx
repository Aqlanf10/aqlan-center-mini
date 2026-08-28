"use client";

import { useCallback, useEffect, useState } from "react";
import { ROLES, ROLE_HINT, ROLE_LABEL, type Role } from "@/lib/roles";
import { friendlyDateLong } from "@/lib/reminders";

/**
 * المستخدمون.
 *
 * بلا هذه الشاشة كان الجميع يدخل بحساب المدير الوحيد، فتصير كل فحوص الصلاحيات بلا
 * معنى، ويصير «من استلم المبلغ» في كل سند اسمًا واحدًا مهما اختلف من استلمه.
 *
 * ولا حذف — إيقاف فقط: المستخدم المحذوف تبقى سنداته باسمه في السجل، وحذفه يجعل
 * مئة سند بلا مستلم معروف.
 */

interface StaffAccount {
  id: number; username: string; displayName: string;
  role: string; isActive: boolean; createdAt: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<StaffAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ username: "", displayName: "", password: "", role: "reception" as Role });
  const [resetFor, setResetFor] = useState<number | null>(null);
  const [newPassword, setNewPassword] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/users", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر التحميل.");
      setUsers(payload as StaffAccount[]);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر التحميل.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const send = useCallback(async (run: () => Promise<Response>) => {
    if (busy) return false;
    setBusy(true);
    try {
      const response = await run();
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setError(payload?.message ?? "تعذّر التنفيذ."); return false; }
      setError(null);
      await load();
      return true;
    } catch {
      setError("تعذّر الاتصال بالخادم.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, load]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const ok = await send(() => fetch("/api/users", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    }));
    if (ok) { setForm({ username: "", displayName: "", password: "", role: form.role }); setAdding(false); }
  };

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <header className="mb-4">
        <h1 className="text-xl font-extrabold leading-tight">المستخدمون</h1>
        <p className="text-xs text-slate-500">لكل موظف حسابه — فيُعرف من فعل ماذا</p>
        <div className="mt-2">
          <a href="/settings" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">‹ الإعدادات</a>
        </div>
      </header>

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>
      ) : null}

      {!adding ? (
        <button onClick={() => setAdding(true)}
          className="mb-4 w-full rounded-2xl bg-brand-orange py-2.5 text-sm font-extrabold text-white">
          + مستخدم جديد
        </button>
      ) : (
        <form onSubmit={add} className="mb-4 rounded-2xl border border-brand-blue bg-white p-4">
          <h2 className="mb-3 text-sm font-bold">مستخدم جديد</h2>
          <input value={form.displayName} onChange={(e) => setForm((c) => ({ ...c, displayName: e.target.value }))}
            placeholder="الاسم الظاهر — مثل: أ. سميّة" aria-label="الاسم الظاهر"
            className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          <input value={form.username} onChange={(e) => setForm((c) => ({ ...c, username: e.target.value }))}
            placeholder="اسم الدخول بالإنجليزية" aria-label="اسم الدخول" dir="ltr" autoComplete="off"
            className="mb-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          <input value={form.password} onChange={(e) => setForm((c) => ({ ...c, password: e.target.value }))}
            placeholder="كلمة المرور (8 أحرف فأكثر)" aria-label="كلمة المرور" type="password" dir="ltr" autoComplete="new-password"
            className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />

          <div className="mb-3 space-y-1.5">
            {ROLES.map((role) => (
              <button key={role} type="button" onClick={() => setForm((c) => ({ ...c, role }))}
                className={`block w-full rounded-xl border px-3 py-2 text-right ${
                  form.role === role ? "border-brand-blue bg-brand-blue/5" : "border-slate-200 bg-white"
                }`}>
                <span className="block text-sm font-bold">{ROLE_LABEL[role]}</span>
                <span className="block text-[11px] text-slate-500">{ROLE_HINT[role]}</span>
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <button type="submit" disabled={busy || !form.username.trim() || form.password.length < 8}
              className="flex-1 rounded-xl bg-brand-orange py-2.5 text-sm font-extrabold text-white disabled:opacity-50">
              أنشئ الحساب
            </button>
            <button type="button" onClick={() => setAdding(false)}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-bold text-slate-600">
              إلغاء
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">جارٍ التحميل…</p>
      ) : (
        <ul className="space-y-2">
          {users.map((user) => (
            <li key={user.id} className={`rounded-2xl border p-3 ${
              user.isActive ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50 opacity-60"
            }`}>
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-[8rem] flex-1">
                  <p className="text-sm font-extrabold">{user.displayName}</p>
                  <p className="text-[11px] text-slate-500" dir="ltr">{user.username}</p>
                </div>
                <select
                  value={user.role}
                  onChange={(event) => send(() => fetch(`/api/users/${user.id}`, {
                    method: "PATCH", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ role: event.target.value }),
                  }))}
                  disabled={busy}
                  aria-label="الدور"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold"
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>{ROLE_LABEL[role]}</option>
                  ))}
                </select>
                <button
                  onClick={() => { setResetFor(resetFor === user.id ? null : user.id); setNewPassword(""); }}
                  className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-navy-800">
                  كلمة المرور
                </button>
                <button
                  onClick={() => send(() => fetch(`/api/users/${user.id}`, {
                    method: "PATCH", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ isActive: !user.isActive }),
                  }))}
                  disabled={busy}
                  className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-500 disabled:opacity-40">
                  {user.isActive ? "إيقاف" : "تفعيل"}
                </button>
              </div>

              {resetFor === user.id ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <input value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                    type="password" dir="ltr" autoComplete="new-password"
                    placeholder="كلمة مرور جديدة (8 أحرف فأكثر)" aria-label="كلمة مرور جديدة"
                    className="min-w-[10rem] flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" />
                  <button
                    onClick={async () => {
                      const ok = await send(() => fetch(`/api/users/${user.id}`, {
                        method: "PATCH", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ password: newPassword }),
                      }));
                      if (ok) { setResetFor(null); setNewPassword(""); }
                    }}
                    disabled={busy || newPassword.length < 8}
                    className="rounded-xl bg-navy-800 px-4 py-2 text-xs font-bold text-white disabled:opacity-40">
                    غيّرها
                  </button>
                </div>
              ) : null}

              <p className="mt-1 text-[11px] text-slate-400">
                {ROLE_HINT[user.role as Role] ?? user.role} · منذ {friendlyDateLong(user.createdAt.slice(0, 10))}
              </p>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-400">
        لا حذف — إيقاف فقط. سندات المستخدم تبقى باسمه في السجل، وحذفه يجعلها بلا
        مستلم معروف.
      </p>
    </main>
  );
}
