"use client";

import { useEffect, useRef, useState } from "react";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { DEFAULT_LAB_DAYS, WORK_TYPES } from "@/lib/lab";
import { addDays, clinicDateString } from "@/lib/schedule";

/**
 * إنشاء طلب مختبر من اللوحة الموحّدة (M2 slice 68).
 *
 * كل فتحٍ للنموذج يولّد مفتاح طلب واحدًا يُرسل مع كل محاولة: الضغطة المزدوجة أو إعادة
 * الإرسال بعد انقطاع الرد تعيد الطلب نفسه ولا تنشئ ثانيًا. يتجدد المفتاح بعد النجاح أو
 * حين يُغيّر المستخدم الطلب بعد رفض «استُعمل لطلب مختلف». المختبر من الدليل فقط، ولا
 * تُرسل تكلفة ولا ترحيل: التكلفة من قواعد تسعير المختبر إن وُجدت.
 */
interface Directory { labParties?: { id: number; name: string }[]; doctors?: { id: number; name: string }[] }
interface PatientHit { id: number; fullName: string; patientNumber: string }
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-key`);

export function CanonicalLabCreateForm({ directory, onCreated }: { directory: Directory; onCreated: () => void }) {
  const today = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);
  const [open, setOpen] = useState(false);
  const [requestKey, setRequestKey] = useState(newKey);
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<PatientHit[]>([]);
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [partyId, setPartyId] = useState("");
  const [doctorId, setDoctorId] = useState("");
  const [workType, setWorkType] = useState("");
  const [teeth, setTeeth] = useState("");
  const [sentDate, setSentDate] = useState(today);
  const [dueDate, setDueDate] = useState(addDays(today, DEFAULT_LAB_DAYS));
  const [priority, setPriority] = useState<"normal" | "urgent" | "rush">("normal");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const search = useRef(0);

  useEffect(() => {
    const current = ++search.current;
    if (!open || patient || term.trim().length < 2) return;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/patients?q=${encodeURIComponent(term.trim())}`, { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (current !== search.current) return;
        setHits(response.ok && Array.isArray(payload) ? payload.slice(0, 8) : []);
        if (!response.ok) setMessage({ tone: "error", text: payload?.message ?? "تعذّر البحث عن المرضى." });
      } catch { if (current === search.current) setMessage({ tone: "error", text: "تعذّر الاتصال بالخادم." }); }
    }, 300);
    return () => clearTimeout(timer);
  }, [term, open, patient]);

  // Editing clears the last message; a "key reused/used" refusal already started a fresh key.
  const edit = <T,>(set: (value: T) => void) => (value: T) => { set(value); setMessage(null); };

  async function submit() {
    if (!patient) { setMessage({ tone: "error", text: "اختر المريض أولًا." }); return; }
    setBusy(true); setMessage(null);
    try {
      const response = await fetch("/api/lab", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({
          requestKey, patientId: patient.id, partyId: partyId ? Number(partyId) : undefined, doctorId: doctorId ? Number(doctorId) : undefined,
          workType: workType.trim(), toothNumbers: teeth.trim() || undefined, sentDate, dueDate, priority, details: details.trim() || undefined,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (payload?.code === "lab_request_key_reused" || payload?.code === "lab_request_key_used") setRequestKey(newKey());
        setMessage({ tone: "error", text: payload?.message ?? "تعذّر حفظ الطلب." });
        return;
      }
      setMessage({ tone: "ok", text: payload?.replayed ? "الطلب مسجّل سلفًا — لم يُنشأ طلب مكرر." : "سُجّل طلب المختبر." });
      setRequestKey(newKey());
      setPatient(null); setTerm(""); setHits([]); setWorkType(""); setTeeth(""); setDetails("");
      onCreated();
    } catch {
      // The response was lost: the same key retries safely (a replay, never a second order).
      setMessage({ tone: "error", text: "انقطع الاتصال قبل وصول الرد؛ أعد الإرسال بأمان — لن يتكرر الطلب." });
    } finally { setBusy(false); }
  }

  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} data-testid="lab-create-open"
      className="min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white">طلب مختبر جديد</button>;
  }
  const field = "min-h-10 w-full min-w-0 rounded-xl border border-slate-300 px-2 text-sm";
  return (
    <form className="space-y-2 rounded-2xl border border-slate-200 bg-white p-3" data-testid="lab-create-form" aria-label="طلب مختبر جديد"
      onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="grid gap-2 sm:grid-cols-2">
        {/* A div, not a label: buttons inside a label receive the label's forwarded click
            after a re-render (selecting a patient would immediately "change" it again). */}
        <div className="text-xs text-slate-700" role="group" aria-labelledby="lab-create-patient-label">
          <span id="lab-create-patient-label">المريض</span>
          {patient ? (
            <span className="mt-1 flex items-center justify-between rounded-xl border border-slate-300 px-2 py-2 text-sm">
              <span>{patient.fullName} <span className="text-xs text-slate-500">({patient.patientNumber})</span></span>
              <button type="button" className="text-xs font-bold text-sky-800" onClick={() => { setPatient(null); setTerm(""); }}>تغيير</button>
            </span>
          ) : (
            <>
              <input className={field} value={term} onChange={event => edit(setTerm)(event.target.value)} placeholder="الاسم أو الرقم" aria-labelledby="lab-create-patient-label" data-testid="lab-create-patient" />
              {hits.length ? (
                <ul className="mt-1 divide-y divide-slate-100 rounded-xl border border-slate-200">
                  {hits.map(hit => (
                    <li key={hit.id}><button type="button" className="w-full px-2 py-2 text-start text-sm" data-patient={hit.id}
                      onClick={() => { setPatient(hit); setHits([]); setMessage(null); }}>{hit.fullName} <span className="text-xs text-slate-500">({hit.patientNumber})</span></button></li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>
        <label className="text-xs text-slate-700">المختبر
          <select className={field} value={partyId} onChange={event => edit(setPartyId)(event.target.value)} data-testid="lab-create-party" required>
            <option value="">اختر من الدليل</option>
            {(directory.labParties ?? []).map(party => <option key={party.id} value={party.id}>{party.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-700">الطبيب المعالج
          <select className={field} value={doctorId} onChange={event => edit(setDoctorId)(event.target.value)} data-testid="lab-create-doctor">
            <option value="">الطبيب المرتبط بحسابي</option>
            {(directory.doctors ?? []).map(doctor => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-700">نوع العمل
          <input className={field} value={workType} list="lab-work-types" maxLength={80} onChange={event => edit(setWorkType)(event.target.value)} required data-testid="lab-create-work" />
          <datalist id="lab-work-types">{WORK_TYPES.map(type => <option key={type} value={type} />)}</datalist>
        </label>
        <label className="text-xs text-slate-700">الأسنان (FDI)
          <input className={field} dir="ltr" value={teeth} onChange={event => edit(setTeeth)(event.target.value)} placeholder="16, 17" data-testid="lab-create-teeth" />
        </label>
        <label className="text-xs text-slate-700">الأولوية
          <select className={field} value={priority} onChange={event => edit(setPriority)(event.target.value as typeof priority)}>
            <option value="normal">عادي</option><option value="urgent">عاجل</option><option value="rush">مستعجل جدًا</option>
          </select>
        </label>
        <label className="text-xs text-slate-700">تاريخ الإرسال
          <input type="date" dir="ltr" className={field} value={sentDate} onChange={event => edit(setSentDate)(event.target.value)} required />
        </label>
        <label className="text-xs text-slate-700">موعد التسليم
          <input type="date" dir="ltr" className={field} value={dueDate} min={sentDate} onChange={event => edit(setDueDate)(event.target.value)} required data-testid="lab-create-due" />
        </label>
      </div>
      <label className="block text-xs text-slate-700">تفاصيل للمختبر
        <input className={field} value={details} maxLength={300} onChange={event => edit(setDetails)(event.target.value)} />
      </label>
      <p className="text-xs text-slate-600">لا تُدخل تكلفة هنا: تُحسب من قواعد تسعير المختبر إن وُجدت، وتعديلها من شاشة الحسابات.</p>
      {message ? <p role={message.tone === "error" ? "alert" : "status"} className={`text-sm ${message.tone === "error" ? "text-red-800" : "text-emerald-800"}`}>{message.text}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} data-testid="lab-create-submit" className="min-h-11 rounded-xl bg-navy-900 px-4 text-sm font-bold text-white disabled:opacity-50">
          {busy ? "جارٍ الحفظ…" : "حفظ الطلب"}
        </button>
        <button type="button" onClick={() => { setOpen(false); setMessage(null); }} className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-bold text-navy-900">إغلاق</button>
      </div>
    </form>
  );
}
