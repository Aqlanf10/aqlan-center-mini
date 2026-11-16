"use client";
import { useId, useRef, useState } from "react";
import { SPECIALTIES, SPECIALTY_LABEL, type ServiceSpecialty } from "@/lib/appointment-services";
import { newRequestKey } from "@/lib/request-key";

type Draft = { specialty: ServiceSpecialty | ""; title: string; site: string; problem: string };
const blank = (): Draft => ({ specialty: "", title: "", site: "", problem: "" });
const button = "min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800 disabled:opacity-50";
const field = "mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white p-2";

/**
 * Open a specialty case (M2 slice 80). One request key per form: a double press or a retry
 * after an unclear result returns the first case instead of opening a second one. The
 * server decides: clinical.plans.edit, the clinician link or the owner, the patient scope;
 * orthodontic cases are opened from the ortho module (they need clinical.ortho.view).
 */
export function CanonicalCaseCreateEditor({ patientId, refresh }: { patientId: string; refresh: () => void }) {
  const formId = useId();
  const [open, setOpen] = useState(false), [draft, setDraft] = useState<Draft>(blank), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "done" | "unsure"; text: string } | null>(null);
  const key = useRef(newRequestKey()), sending = useRef(false);
  const specialties = SPECIALTIES.filter(key => key !== "orthodontics");
  async function save() {
    if (sending.current) return;
    if (!draft.specialty || !draft.title.trim() || draft.title.length > 160 || draft.site.length > 60 || draft.problem.length > 2000) {
      setMessage({ kind: "error", text: "اختر التخصص واكتب عنوان الحالة (حتى 160 حرفًا)؛ الموضع حتى 60 حرفًا." });
      return;
    }
    sending.current = true; setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/patients/${patientId}/cases`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specialty: draft.specialty, title: draft.title.trim(), site: draft.site.trim() || null, problem: draft.problem.trim() || null, requestKey: key.current }) });
      const result = await response.json().catch(() => null) as { message?: string; caseId?: number } | null;
      if (response.ok && result && Number.isSafeInteger(result.caseId)) {
        key.current = newRequestKey(); setDraft(blank()); setOpen(false);
        setMessage({ kind: "done", text: "فُتحت الحالة وسُجّل الأثر." }); refresh();
      } else if (response.status >= 400 && response.status < 500) {
        setMessage({ kind: "error", text: result?.message ?? "لم تُفتح الحالة." });
      } else {
        setMessage({ kind: "unsure", text: "لم تتأكد نتيجة فتح الحالة. إعادة الحفظ آمنة: لن تُفتح حالة ثانية بالطلب نفسه." });
      }
    } catch {
      setMessage({ kind: "unsure", text: "تعذّر الاتصال بالخادم. إعادة الحفظ آمنة: لن تُفتح حالة ثانية بالطلب نفسه." });
    } finally { sending.current = false; setBusy(false); }
  }
  return <div data-testid="canonical-case-create-editor" className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm">
    {message ? <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "unsure" ? "text-amber-800" : undefined}>{message.text}</p> : null}
    {!open ? <button type="button" className={button} disabled={busy} onClick={() => { setOpen(true); setMessage(null); }}>فتح حالة تخصصية</button> : <form className="space-y-3" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className="text-xs text-slate-600">فتح الحالة لا يغيّر الحسابات. حالات التقويم تُفتح من «التقويم وسيفالو».</p>
      <div><label htmlFor={`${formId}-specialty`} className="block text-xs font-bold">تخصص الحالة</label><select id={`${formId}-specialty`} className={field} disabled={busy} value={draft.specialty} onChange={event => setDraft({ ...draft, specialty: event.target.value as Draft["specialty"] })}><option value="">اختر التخصص</option>{specialties.map(key => <option key={key} value={key}>{SPECIALTY_LABEL[key]}</option>)}</select></div>
      <div><label htmlFor={`${formId}-title`} className="block text-xs font-bold">عنوان الحالة</label><input id={`${formId}-title`} className={field} maxLength={160} disabled={busy} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></div>
      <div><label htmlFor={`${formId}-site`} className="block text-xs font-bold">الموضع</label><input id={`${formId}-site`} className={field} maxLength={60} disabled={busy} value={draft.site} onChange={event => setDraft({ ...draft, site: event.target.value })} /></div>
      <div><label htmlFor={`${formId}-problem`} className="block text-xs font-bold">المشكلة (اختياري)</label><textarea id={`${formId}-problem`} className={field} maxLength={2000} disabled={busy} value={draft.problem} onChange={event => setDraft({ ...draft, problem: event.target.value })} /></div>
      <div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={busy}>{busy ? "جارٍ الحفظ…" : "حفظ الحالة"}</button><button type="button" className={button} disabled={busy} onClick={() => { setOpen(false); setDraft(blank()); key.current = newRequestKey(); setMessage(null); }}>إلغاء فتح الحالة</button></div>
    </form>}
  </div>;
}
