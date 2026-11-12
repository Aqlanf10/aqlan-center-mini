"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * دليل المختبرات للجلسة الموحّدة (M2 slice 70a) — لمن يملك clinical.laboratories.manage.
 *
 * بيانات التواصل والتسليم فقط. عملة المختبر وحساباته وترحيله الآلي لا تُعرض إلا لمن يملك
 * finance.payables.record ولا تُعدَّل من هنا (شريحة مالية مستقلة)؛ المختبر الجديد يأخذ
 * الافتراضات القديمة. الحذف يعطّل المختبر الذي له طلبات ولا يمحوه.
 */
interface Lab {
  id: number; name: string; phone: string | null; whatsapp: string | null; address: string | null; contactPerson: string | null;
  deliveryDays: number; note: string | null; isActive: boolean; activeOrdersCount: number; totalOrdersCount: number;
}
type Draft = { name: string; phone: string; whatsapp: string; contactPerson: string; deliveryDays: string; note: string };
const EMPTY: Draft = { name: "", phone: "", whatsapp: "", contactPerson: "", deliveryDays: "7", note: "" };
const draftOf = (lab: Lab): Draft => ({ name: lab.name, phone: lab.phone ?? "", whatsapp: lab.whatsapp ?? "", contactPerson: lab.contactPerson ?? "", deliveryDays: String(lab.deliveryDays), note: lab.note ?? "" });

export function CanonicalLaboratoriesDirectory() {
  const [labs, setLabs] = useState<Lab[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLabs(null); setError(null);
    try {
      const response = await fetch("/api/laboratories", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (current !== sequence.current) return;
      if (!response.ok || !Array.isArray(payload?.laboratories)) { setError(payload?.message ?? "تعذّر تحميل دليل المختبرات."); return; }
      setLabs(payload.laboratories as Lab[]);
    } catch { if (current === sequence.current) setError("تعذّر الاتصال بالخادم."); }
  }, []);
  useEffect(() => { const first = setTimeout(() => void load(), 0); return () => clearTimeout(first); }, [load]);

  async function send(url: string, method: string, body?: unknown) {
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, cache: "no-store", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) { setMessage(payload?.message ?? "تعذّر الحفظ."); return false; }
      if (typeof payload?.message === "string") setMessage(payload.message);
      return true;
    } catch { setMessage("تعذّر الاتصال بالخادم."); return false; } finally { setBusy(false); }
  }
  async function save() {
    const body = { name: draft.name.trim(), phone: draft.phone.trim() || null, whatsapp: draft.whatsapp.trim() || null,
      contactPerson: draft.contactPerson.trim() || null, deliveryDays: Number(draft.deliveryDays), note: draft.note.trim() || null };
    const ok = editing === "new" ? await send("/api/laboratories", "POST", body) : await send(`/api/laboratories/${editing}`, "PATCH", body);
    if (ok) { setEditing(null); setDraft(EMPTY); void load(); }
  }

  const field = "min-h-10 w-full min-w-0 rounded-xl border border-slate-300 px-2 text-sm";
  const form = (
    <div className="grid gap-2 rounded-2xl border border-slate-200 bg-white p-3 sm:grid-cols-2" data-testid="laboratory-form">
      {([["name", "اسم المختبر"], ["phone", "الهاتف"], ["whatsapp", "واتساب"], ["contactPerson", "المسؤول"], ["deliveryDays", "مدة التسليم (أيام)"], ["note", "ملاحظة"]] as const).map(([key, label]) => (
        <label key={key} className="text-xs text-slate-700">{label}
          <input className={field} value={draft[key]} inputMode={key === "deliveryDays" ? "numeric" : undefined} dir={key === "phone" || key === "whatsapp" ? "ltr" : undefined}
            onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} data-lab-field={key} />
        </label>
      ))}
      <div className="flex gap-2 sm:col-span-2">
        <button type="button" disabled={busy || !draft.name.trim()} onClick={() => void save()} data-testid="laboratory-save" className="min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50">حفظ</button>
        <button type="button" onClick={() => { setEditing(null); setDraft(EMPTY); }} className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-bold">إلغاء</button>
      </div>
    </div>
  );
  return (
    <section dir="rtl" className="mx-auto max-w-4xl space-y-3" data-testid="canonical-laboratories" aria-labelledby="labs-title">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 id="labs-title" className="text-lg font-black text-navy-900">دليل المختبرات</h1>
          <p className="text-xs text-slate-600">بيانات التواصل والتسليم. الحسابات والعملة من شاشة الحسابات.</p>
        </div>
        <button type="button" onClick={() => { setEditing("new"); setDraft(EMPTY); setMessage(null); }} data-testid="laboratory-add" className="min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white">مختبر جديد</button>
      </header>
      {editing === "new" ? form : null}
      {message ? <p role="status" className="text-sm text-navy-800">{message}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-800">{error}</p> : null}
      {labs ? (
        <ul className="space-y-2" data-testid="laboratory-list">
          {labs.map(lab => (
            <li key={lab.id} data-lab={lab.id} className={`rounded-2xl border bg-white p-3 text-sm ${lab.isActive ? "border-slate-200" : "border-slate-200 opacity-70"}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-bold text-navy-900">{lab.name}{lab.isActive ? null : <span className="mr-2 text-xs text-slate-600">(معطّل)</span>}</span>
                <span className="text-xs text-slate-600">طلبات جارية {lab.activeOrdersCount} · الكل {lab.totalOrdersCount} · التسليم {lab.deliveryDays} أيام</span>
              </div>
              <p className="mt-1 text-xs text-slate-700">{[lab.contactPerson, lab.phone, lab.whatsapp].filter(Boolean).join(" · ") || "بلا بيانات تواصل"}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => { setEditing(lab.id); setDraft(draftOf(lab)); setMessage(null); }} className="min-h-10 rounded-xl border border-slate-300 px-3 text-xs font-bold">تعديل</button>
                {lab.isActive ? null : <button type="button" disabled={busy} onClick={() => void send(`/api/laboratories/${lab.id}`, "PATCH", { isActive: true }).then(ok => { if (ok) void load(); })} className="min-h-10 rounded-xl border border-slate-300 px-3 text-xs font-bold">إعادة التفعيل</button>}
                {lab.isActive ? (confirmDelete === lab.id
                  ? <button type="button" disabled={busy} data-testid="laboratory-confirm-delete" onClick={() => void send(`/api/laboratories/${lab.id}`, "DELETE").then(ok => { setConfirmDelete(null); if (ok) void load(); })} className="min-h-10 rounded-xl bg-red-700 px-3 text-xs font-bold text-white">تأكيد {lab.totalOrdersCount ? "التعطيل" : "الحذف"}</button>
                  : <button type="button" onClick={() => setConfirmDelete(lab.id)} data-testid="laboratory-delete" className="min-h-10 rounded-xl border border-red-300 px-3 text-xs font-bold text-red-800">{lab.totalOrdersCount ? "تعطيل…" : "حذف…"}</button>) : null}
              </div>
              {editing === lab.id ? <div className="mt-2">{form}</div> : null}
            </li>
          ))}
        </ul>
      ) : error ? null : <p role="status" className="text-sm text-slate-600">جارٍ التحميل…</p>}
    </section>
  );
}
