"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { CanonicalProposalFeed } from "@/lib/canonical-proposal-projection";
type Intent = { planId: number; patientId: number; expectedVersion: string };
const button = "min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800 disabled:opacity-50";
/** Kept at list level so a removed/consented proposal cannot erase pending recovery. */
export function CanonicalProposalContactEditor({ ownerKey, feed, refresh }: { ownerKey: string; feed: CanonicalProposalFeed | null; refresh: () => void }) {
  const storageKey = `aqlan.proposal-contact.pending:${encodeURIComponent(ownerKey)}`, formId = useId();
  const [initial] = useState(() => { try { return { pending: sessionStorage.getItem(storageKey) !== null, warning: false }; } catch { return { pending: false, warning: true }; } });
  const [uncertain, setUncertain] = useState(initial.pending), [warning, setWarning] = useState(initial.warning), [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false), [intent, setIntent] = useState<Intent | null>(null), [note, setNote] = useState(""), [message, setMessage] = useState<string | null>(null);
  const [unverifiedFeed, setUnverifiedFeed] = useState<CanonicalProposalFeed | null>(null);
  const active = useRef(false), sending = useRef(false), uncertainRef = useRef(initial.pending), controller = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, [storageKey]);
  useEffect(() => { const leave = (e: BeforeUnloadEvent) => { if (sending.current || uncertainRef.current) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave); }, []);
  const erase = () => { try { sessionStorage.removeItem(storageKey); } catch { setWarning(true); } };
  const clearDraft = () => { setIntent(null); setNote(""); setOpen(false); };
  async function save() {
    if (!active.current || sending.current || uncertainRef.current || !intent || !feed) return;
    if (!feed.proposals.some(r => r.planId === intent.planId && r.patientId === intent.patientId && r.contactVersion === intent.expectedVersion)) { clearDraft(); setMessage("تغيّر العرض المرصود. راجع القراءة الحالية واختر العرض من جديد."); return; }
    if (note.length > 300) { setMessage("الملاحظة ضمن 300 حرف؛ لن نختصرها."); return; }
    const current = intent, request = new AbortController(); controller.current = request; sending.current = true; setBusy(true); setMessage(null); setUnverifiedFeed(feed);
    try { sessionStorage.setItem(storageKey, "pending"); } catch { setWarning(true); }
    const timeout = setTimeout(() => request.abort(), 10000);
    const unknown = () => { uncertainRef.current = true; setUncertain(true); clearDraft(); setMessage("لم تتأكد نتيجة تسجيل التواصل. لن نعيد الطلب تلقائيًا."); refresh(); };
    try {
      const response = await fetch("/api/plans/proposals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...current, note: note.trim() || null }), signal: request.signal });
      const result = await response.json().catch(() => null); if (!active.current) return;
      if (!response.ok) {
        if (response.status < 500 && result && (response.status === 401 || /^(STAFF_|proposal_contact_|invalid_proposal_contact$)/.test(String(result.code)))) { erase(); clearDraft(); setMessage(typeof result.message === "string" ? result.message : "لم يُسجل التواصل. تحقق من الحالة الحالية."); refresh(); }
        else unknown(); return;
      }
      if (!result || Object.keys(result).sort().join(",") !== "lastContactAt,ok,planId" || result.ok !== true || result.planId !== current.planId || typeof result.lastContactAt !== "string" || !Number.isFinite(Date.parse(result.lastContactAt))) { unknown(); return; }
      erase(); clearDraft(); setMessage("سُجّل التواصل اليدوي في التدقيق. لم تُرسل رسالة أو تتغيّر الموافقة والأقساط."); refresh();
    } catch { if (active.current) unknown(); }
    finally { clearTimeout(timeout); sending.current = false; if (active.current) setBusy(false); }
  }
  const verified = feed !== null && feed !== unverifiedFeed;
  return <div data-testid="canonical-proposal-contact" className="mt-3 space-y-2 rounded-xl border border-slate-200 p-3 text-sm">
    {warning ? <p role="status" className="text-xs text-amber-800">تعذّر حفظ متابعة الطلب في التبويب؛ الاستعادة بعد إعادة التحميل غير مضمونة. تجنب إغلاق الصفحة قبل التحقق.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {uncertain ? <div className="space-y-2 rounded-lg bg-amber-50 p-3">
      <p>تسجيل تواصل سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.</p>
      <button type="button" className={button} disabled={busy} onClick={() => { setUnverifiedFeed(feed); refresh(); }}>التحقق من العروض وسجل التواصل الحالي</button>
      {verified ? <><p className="text-xs">راجع تاريخ التواصل والحالة الحالية. غياب العرض أو تشابه التاريخ لا يثبت نتيجة طلب بعينه.</p><button type="button" className={button} onClick={() => { if (!active.current || sending.current || !feed) return; erase(); uncertainRef.current = false; setUncertain(false); clearDraft(); setOpen(true); setMessage(null); }}>راجعت الحالة، تسجيل تواصل جديد</button></> : null}
    </div> : !open ? <button type="button" className={button} disabled={busy || !feed?.proposals.length} onClick={() => { setOpen(true); setIntent(null); setNote(""); setMessage(null); }}>تسجيل تواصل يدوي تم بالفعل</button> : feed ? <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save(); }}>
      <p className="text-xs text-slate-600">سجل تواصلًا أنجزته فعلًا. هذا لا يرسل رسالة ولا يوافق على الخطة ولا يغيّر تذكير الأقساط.</p>
      <label htmlFor={`${formId}-plan`} className="block text-xs font-bold">العرض الذي تم التواصل بشأنه</label>
      <select id={`${formId}-plan`} className="min-h-11 w-full rounded-lg border border-slate-300 bg-white p-2" disabled={busy} value={intent?.planId ?? ""} onChange={e => { const row = feed.proposals.find(r => r.planId === Number(e.target.value)); setIntent(row ? { planId: row.planId, patientId: row.patientId, expectedVersion: row.contactVersion } : null); }}><option value="">اختر عرضًا من القراءة الحالية</option>{feed.proposals.map(row => <option key={row.planId} value={row.planId}>{row.patientName} — {row.title}</option>)}</select>
      <label htmlFor={`${formId}-note`} className="block text-xs font-bold">ملاحظة التواصل الاختيارية</label><textarea id={`${formId}-note`} className="min-h-20 w-full rounded-lg border border-slate-300 p-2" maxLength={300} disabled={busy} value={note} onChange={e => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={busy || !intent}>{busy ? "جارٍ التسجيل…" : "تأكيد تسجيل التواصل المنجز"}</button><button type="button" className={button} disabled={busy} onClick={() => { clearDraft(); setMessage(null); }}>إلغاء تسجيل التواصل</button></div>
    </form> : <p role="status">تحقق من قراءة العروض الحالية قبل تسجيل التواصل.</p>}
  </div>;
}
