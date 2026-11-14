"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { CanonicalOrthoDecisions } from "@/lib/canonical-ortho-decisions-projection";
type Intent = { adjustmentId: number; patientId: number; expectedVersion: string };
const button = "min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800 disabled:opacity-50";
/** List-level recovery survives a resolved row disappearing. No stored patient
 * details, automatic resubmission or inference of a permanent request receipt. */
export function CanonicalOrthoDecisionEditor({ ownerKey, feed, refresh }: { ownerKey: string; feed: CanonicalOrthoDecisions | null; refresh: () => void }) {
  const storageKey = `aqlan.ortho-decision.pending:${encodeURIComponent(ownerKey)}`, formId = useId();
  const [initial] = useState(() => { try { return { pending: sessionStorage.getItem(storageKey) !== null, warning: false }; } catch { return { pending: false, warning: true }; } });
  const [uncertain, setUncertain] = useState(initial.pending), [warning, setWarning] = useState(initial.warning), [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false), [intent, setIntent] = useState<Intent | null>(null), [decision, setDecision] = useState<"billed" | "no_charge" | "">("");
  const [value, setValue] = useState(""), [message, setMessage] = useState<string | null>(null), [unverifiedFeed, setUnverifiedFeed] = useState<CanonicalOrthoDecisions | null>(null);
  const active = useRef(false), sending = useRef(false), uncertainRef = useRef(initial.pending), controller = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, [storageKey]);
  useEffect(() => { const leave = (e: BeforeUnloadEvent) => { if (sending.current || uncertainRef.current) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", leave); return () => window.removeEventListener("beforeunload", leave); }, []);
  const erase = () => { try { sessionStorage.removeItem(storageKey); } catch { setWarning(true); } };
  const clearDraft = () => { setIntent(null); setDecision(""); setValue(""); setOpen(false); };
  const currentRow = intent && feed?.pending.find(row => row.adjustmentId === intent.adjustmentId && row.patientId === intent.patientId && row.decisionContext?.expectedVersion === intent.expectedVersion);
  const available = feed?.pending.some(row => row.decisionContext !== null) === true;
  async function save() {
    if (!active.current || sending.current || uncertainRef.current || !intent || !feed || !decision) return;
    if (!currentRow?.decisionContext?.choices.includes(decision)) { clearDraft(); setMessage("تغيّرت الشدّة أو صلاحية القرار. راجع القائمة واختر من جديد."); return; }
    if (!value.trim() || decision === "no_charge" && (value.trim().length < 3 || value.trim().length > 300)) { setMessage("راجع السبب المكتوب أو رقم الفاتورة؛ لن نختصره تلقائيًا."); return; }
    const current = intent, requestedDecision = decision, request = new AbortController(); controller.current = request; sending.current = true; setBusy(true); setMessage(null); setUnverifiedFeed(feed);
    try { sessionStorage.setItem(storageKey, "pending"); } catch { setWarning(true); }
    const timeout = setTimeout(() => request.abort(), 10000);
    const unknown = () => { uncertainRef.current = true; setUncertain(true); clearDraft(); setMessage("لم تتأكد نتيجة القرار. لن نعيد الطلب تلقائيًا."); refresh(); };
    try {
      const response = await fetch(`/api/ortho/adjustments/${current.adjustmentId}/billing-decision`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: request.signal,
        body: JSON.stringify({ patientId: current.patientId, expectedVersion: current.expectedVersion, decision: requestedDecision, reason: requestedDecision === "no_charge" ? value.trim() : null, invoiceNumber: requestedDecision === "billed" ? value.trim() : null }) });
      const result = await response.json().catch(() => null); if (!active.current) return;
      if (!response.ok) {
        if (response.status < 500 && result && (response.status === 401 || /^(STAFF_|ortho_decision_|invalid_ortho_decision$)/.test(String(result.code)))) { erase(); clearDraft(); setMessage(typeof result.message === "string" ? result.message : "لم يُحفظ القرار. راجع الحالة الحالية."); refresh(); }
        else unknown(); return;
      }
      if (!result || Object.keys(result).sort().join(",") !== "adjustmentId,decision,ok" || result.ok !== true || result.adjustmentId !== current.adjustmentId || result.decision !== requestedDecision) { unknown(); return; }
      erase(); clearDraft(); setMessage("حُفظ قرار الشدّة في التدقيق. لم تُنشأ فاتورة ولم تتغيّر المبالغ أو العملات."); refresh();
    } catch { if (active.current) unknown(); }
    finally { clearTimeout(timeout); sending.current = false; if (active.current) setBusy(false); }
  }
  if (!available && !uncertain && !open && !message && !busy) return null;
  const verified = feed !== null && feed !== unverifiedFeed;
  return <div data-testid="canonical-ortho-decision-editor" className="mt-3 space-y-2 rounded-xl border border-slate-200 bg-white p-3 text-sm">
    {warning ? <p role="status" className="text-xs text-amber-800">تعذّر حفظ متابعة الطلب في التبويب؛ الاستعادة بعد إعادة التحميل غير مضمونة. تجنب إغلاق الصفحة قبل التحقق.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {uncertain ? <div className="space-y-2 rounded-lg bg-amber-50 p-3"><p>قرار سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.</p>
      <button type="button" className={button} disabled={busy} onClick={() => { setUnverifiedFeed(feed); refresh(); }}>التحقق من قائمة المراجعة الحالية</button>
      {verified ? <><p className="text-xs">راجع السجل الحالي. اختفاء الشدّة من القائمة لا يثبت نتيجة طلب بعينه.</p><button type="button" className={button} onClick={() => { if (!active.current || sending.current || !feed) return; erase(); uncertainRef.current = false; setUncertain(false); clearDraft(); setOpen(true); setMessage(null); }}>راجعت الحالة، بدء قرار جديد</button></> : null}
    </div> : !open ? available ? <button type="button" className={button} disabled={busy || !feed} onClick={() => { setOpen(true); setIntent(null); setDecision(""); setValue(""); setMessage(null); }}>تسجيل قرار شدّة معلّقة</button> : null : feed ? <form className="space-y-3" onSubmit={e => { e.preventDefault(); void save(); }}>
      <p className="text-xs text-slate-600">«بلا رسوم» قرار مسبّب للطبيب المسؤول أو المالك. «فوتِرت» يربط فاتورة قائمة للمريض؛ لا ينشئ فاتورة ولا يغيّر مبلغًا.</p>
      <label htmlFor={`${formId}-adjustment`} className="block text-xs font-bold">الشدّة من القراءة الحالية</label>
      <select id={`${formId}-adjustment`} className="min-h-11 w-full rounded-lg border border-slate-300 bg-white p-2" disabled={busy} value={intent?.adjustmentId ?? ""} onChange={e => { const row = feed.pending.find(r => r.adjustmentId === Number(e.target.value)); setIntent(row?.decisionContext ? { adjustmentId: row.adjustmentId, patientId: row.patientId, expectedVersion: row.decisionContext.expectedVersion } : null); setDecision(""); setValue(""); }}><option value="">اختر شدّة معلّقة</option>{feed.pending.filter(row => row.decisionContext).map(row => <option key={row.adjustmentId} value={row.adjustmentId}>{row.patientName} — {row.doneOn}</option>)}</select>
      <label htmlFor={`${formId}-decision`} className="block text-xs font-bold">القرار المسموح</label><select id={`${formId}-decision`} className="min-h-11 w-full rounded-lg border border-slate-300 bg-white p-2" disabled={busy || !currentRow} value={decision} onChange={e => { setDecision(e.target.value === "billed" ? "billed" : e.target.value === "no_charge" ? "no_charge" : ""); setValue(""); }}><option value="">اختر القرار</option>{currentRow?.decisionContext?.choices.map(choice => <option key={choice} value={choice}>{choice === "billed" ? "فوتِرت — ربط فاتورة قائمة" : "بلا رسوم — سبب مكتوب"}</option>)}</select>
      {decision ? <><label htmlFor={`${formId}-value`} className="block text-xs font-bold">{decision === "billed" ? "رقم الفاتورة القائمة" : "سبب بلا رسوم"}</label><textarea id={`${formId}-value`} className="min-h-20 w-full rounded-lg border border-slate-300 p-2" maxLength={decision === "no_charge" ? 300 : undefined} disabled={busy} value={value} onChange={e => setValue(e.target.value)} /></> : null}
      <div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={busy || !intent || !decision}>{busy ? "جارٍ الحفظ…" : "تأكيد قرار الشدّة"}</button><button type="button" className={button} disabled={busy} onClick={() => { clearDraft(); setMessage(null); }}>إلغاء القرار</button></div>
    </form> : <p role="status">تحقق من القراءة الحالية قبل اتخاذ القرار.</p>}
  </div>;
}
