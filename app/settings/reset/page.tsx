"use client";

import { useEffect, useState } from "react";

/**
 * إعادة الضبط — مسح البيانات التجريبية وبدء العمل الحقيقي من الصفر.
 *
 * شاشة خطرة عمدًا: تعرض ما سيُمسح بالعدد، وما يبقى بالاسم، وتطلب عبارة التأكيد
 * حرفيًّا وكلمة مرور المدير. والخادم يأخذ نسخةً احتياطية متحقَّقًا منها قبل أي مسح.
 */

interface Group { label: string; count: number }

const KEPT = [
  "المستخدمون وكلمات المرور",
  "إعدادات المركز والشعار",
  "الخدمات والأسعار",
  "الأطباء والموردون والمختبرات ونسبهم وأسعارهم",
  "بنود المصروفات وأصناف المخزون",
  "سجل التدقيق (ويُسجَّل فيه هذا المسح)",
];

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export default function ResetPage() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [phrase, setPhrase] = useState("");
  const [expected, setExpected] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ groups: Group[]; backupId: string | null } | null>(null);

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/settings/reset", { cache: "no-store" });
      const payload = await readJson(response);
      if (!response.ok) { setError(String(payload.message ?? "تعذّر التحميل.")); return; }
      setGroups(payload.groups as Group[]);
      setExpected(String(payload.phrase ?? ""));
    })();
  }, []);

  async function reset() {
    if (!window.confirm("سيُمسح كل ما في القائمة نهائيًّا بعد أخذ نسخة احتياطية. متابعة؟")) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/settings/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phrase, password }),
      });
      const payload = await readJson(response);
      if (!response.ok) { setError(String(payload.message ?? "تعذّرت إعادة الضبط.")); return; }
      setDone({ groups: payload.groups as Group[], backupId: (payload.backupId as string | null) ?? null });
      setPassword(""); setPhrase("");
    } catch {
      setError("انقطع الاتصال. افتح الصفحة من جديد لترى الحالة.");
    } finally {
      setBusy(false);
    }
  }

  const total = (groups ?? []).reduce((sum, group) => sum + group.count, 0);

  return (
    <main className="mx-auto max-w-3xl p-4 pb-24">
      <header className="mb-4">
        <h1 className="text-xl font-extrabold leading-tight text-rose-800">إعادة الضبط — مسح البيانات التجريبية</h1>
        <p className="text-xs text-slate-500">للبدء من الصفر بعد التجربة. يبقى الإعداد، وتُمسح البيانات.</p>
        <div className="mt-2">
          <a href="/settings" className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-800">‹ الإعدادات</a>
        </div>
      </header>

      {done ? (
        <section className="rounded-2xl border-2 border-emerald-600/40 bg-emerald-50/60 p-4" aria-label="تمت إعادة الضبط">
          <p className="text-sm font-extrabold text-emerald-900">تمت إعادة الضبط. النظام جاهز لبياناتك الحقيقية.</p>
          {done.backupId ? (
            <p className="mt-1 text-[11px] font-bold text-slate-600">النسخة الاحتياطية قبل المسح: <span dir="ltr" className="font-mono">{done.backupId}</span></p>
          ) : null}
          <ul className="mt-2 grid grid-cols-2 gap-1 text-xs font-bold text-slate-700">
            {done.groups.filter((group) => group.count > 0).map((group) => (
              <li key={group.label}>{group.label}: {group.count} مُسح</li>
            ))}
          </ul>
        </section>
      ) : (
        <>
          <section className="mb-4 rounded-2xl border-2 border-rose-300 bg-rose-50/60 p-4" aria-label="ما سيُمسح">
            <h2 className="text-sm font-extrabold text-rose-900">ما سيُمسح نهائيًّا ({total})</h2>
            {groups ? (
              <ul className="mt-2 grid grid-cols-2 gap-1 text-xs font-bold text-rose-900">
                {groups.map((group) => <li key={group.label}>{group.label}: {group.count}</li>)}
              </ul>
            ) : <p className="mt-2 text-xs text-slate-500">جارٍ الحساب…</p>}
            <p className="mt-2 text-[11px] font-bold text-rose-800">ومعها كل ما يتبعها: بنود الفواتير، الخطط، الوصفات، الإحالات، تتبع المختبر، قائمة الانتظار وطلبات الحجز. والترقيم يعود إلى ١.</p>
          </section>

          <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4" aria-label="ما يبقى">
            <h2 className="text-sm font-extrabold text-emerald-900">ما يبقى كما هو</h2>
            <ul className="mt-2 list-disc pr-5 text-xs font-bold text-slate-700">
              {KEPT.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4" aria-label="التأكيد">
            <p className="text-xs font-bold text-slate-700">
              قبل المسح تُؤخذ نسخة احتياطية كاملة ويُتحقَّق منها — وإن تعذّرت لا يُمسح شيء.
            </p>
            <label className="mt-3 block text-xs font-bold text-slate-700">
              اكتب: <span className="text-rose-800">«{expected}»</span>
              <input value={phrase} onChange={(event) => setPhrase(event.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" autoComplete="off" />
            </label>
            <label className="mt-3 block text-xs font-bold text-slate-700">
              كلمة مرورك
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" autoComplete="current-password" />
            </label>
            {error ? <p role="alert" className="mt-3 rounded-xl bg-rose-50 p-2 text-xs font-bold text-rose-700">{error}</p> : null}
            <button type="button" onClick={() => void reset()}
              disabled={busy || !groups || phrase.trim() !== expected || !password}
              className="mt-3 w-full rounded-xl bg-rose-700 py-2.5 text-sm font-extrabold text-white disabled:opacity-40">
              {busy ? "جارٍ النسخ ثم المسح…" : "انسخ احتياطيًّا ثم امسح البيانات التجريبية"}
            </button>
          </section>
        </>
      )}
    </main>
  );
}
