"use client";

import { useEffect, useState } from "react";
import {
  REFERRAL_SPECIALTIES, REFERRAL_SPECIALTY_LABEL, REFERRAL_STATUS_LABEL, REFERRAL_URGENCIES, REFERRAL_URGENCY_LABEL, WORKFLOW_STATE_LABEL,
  nextReferralState, type ReferralAction, type ReferralSpecialty, type ReferralStatus, type ReferralUrgency, type WorkflowState,
} from "@/lib/referrals";

/**
 * الإحالات في ملف المريض الموحّد (M2 slice 73): القائمة، وإصدار إحالة (خارجية بخطابٍ أو
 * داخلية إلى طبيبٍ في المركز)، وخطوات الإحالة الداخلية، وإغلاق الخارجية بنتيجتها. الخادم يقرر
 * من يملك كل خطوة (المحال إليه، المحيل، أو من يملك نطاق المواعيد كله للحجز) ويعرض الرفض بالعربية؛
 * الشاشة تعرض الخطوات الصحيحة لحالة الإحالة فقط.
 */
export interface ReferralRow {
  id: number; toName: string; toSpecialty: ReferralSpecialty; status: ReferralStatus; kind?: "external" | "internal";
  workflowState?: WorkflowState | null; reason?: string; doctorName?: string | null;
}
export interface BookedAppointment { id: number; date: string; time: string | null; status: string }

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-referral`);
const STEP_LABEL: Record<ReferralAction, string> = {
  accept: "قبول", decline: "اعتذار", schedule: "ربط بموعد", complete: "إكمال وإعادة للمحيل", acknowledge: "اطّلعت", cancel: "إلغاء الإحالة",
};
const field = "min-h-10 rounded-xl border border-slate-300 bg-white px-2 text-sm";

async function send(url: string, method: string, body: unknown): Promise<string | null> {
  try {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(body) });
    if (response.ok) return null;
    const payload = await response.json().catch(() => null);
    return payload?.message ?? "تعذّر الحفظ.";
  } catch { return "تعذّر الاتصال بالخادم."; }
}

export function CanonicalReferralWork({ patientId, referrals, appointments, canManage, onChanged }: {
  patientId: string; referrals: ReferralRow[]; appointments: BookedAppointment[]; canManage: boolean; onChanged: () => void;
}) {
  const [issuing, setIssuing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div data-testid="referral-work">
      {referrals.length === 0 ? <p className="text-sm text-slate-500">لا إحالات.</p> : (
        <ul className="divide-y divide-slate-100 text-sm">
          {referrals.map(referral => (
            <ReferralLine key={referral.id} referral={referral} appointments={appointments} canManage={canManage}
              onDone={error => { setMessage(error); if (!error) onChanged(); }} />
          ))}
        </ul>
      )}
      {message ? <p role="alert" className="mt-2 text-xs font-bold text-red-700">{message}</p> : null}
      {canManage ? (
        issuing ? <IssueForm patientId={patientId} onClose={() => setIssuing(false)} onDone={() => { setIssuing(false); onChanged(); }} />
          : <button type="button" onClick={() => { setMessage(null); setIssuing(true); }} data-testid="referral-issue-open"
            className="mt-2 min-h-10 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">إصدار إحالة</button>
      ) : null}
    </div>
  );
}

function ReferralLine({ referral, appointments, canManage, onDone }: {
  referral: ReferralRow; appointments: BookedAppointment[]; canManage: boolean; onDone: (error: string | null) => void;
}) {
  const [open, setOpen] = useState<ReferralAction | "close" | null>(null);
  const [note, setNote] = useState("");
  const [procedure, setProcedure] = useState("");
  const [appointmentId, setAppointmentId] = useState("");
  const [busy, setBusy] = useState(false);
  const internal = referral.kind === "internal" && referral.workflowState;
  const steps = internal ? (["accept", "decline", "schedule", "complete", "acknowledge", "cancel"] as ReferralAction[])
    .filter(step => nextReferralState(referral.workflowState as WorkflowState, step) !== null) : [];
  const state = internal ? WORKFLOW_STATE_LABEL[referral.workflowState as WorkflowState] : REFERRAL_STATUS_LABEL[referral.status] ?? referral.status;

  async function run(body: Record<string, unknown>, url: string, method: string) {
    setBusy(true);
    const error = await send(url, method, body);
    setBusy(false);
    if (!error) { setOpen(null); setNote(""); setProcedure(""); setAppointmentId(""); }
    onDone(error);
  }
  return (
    <li className="py-2" data-referral={referral.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-slate-800 [overflow-wrap:anywhere]">{referral.toName} — {REFERRAL_SPECIALTY_LABEL[referral.toSpecialty] ?? referral.toSpecialty}</span>
        <span className="rounded-lg bg-slate-50 px-2 py-0.5 text-xs font-bold text-slate-600">{state}</span>
      </div>
      {canManage ? (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {steps.map(step => (
            <button key={step} type="button" disabled={busy} onClick={() => setOpen(open === step ? null : step)} data-step={step}
              className="min-h-9 rounded-lg border border-slate-300 px-2 text-xs font-bold text-navy-800 disabled:opacity-50">{STEP_LABEL[step]}</button>
          ))}
          {!internal && referral.status === "sent" ? (
            <button type="button" disabled={busy} onClick={() => setOpen(open === "close" ? null : "close")} data-step="close"
              className="min-h-9 rounded-lg border border-slate-300 px-2 text-xs font-bold text-navy-800 disabled:opacity-50">تسجيل النتيجة</button>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-xl bg-slate-50 p-2 text-xs">
          {open === "schedule" ? (
            <select className={field} value={appointmentId} onChange={event => setAppointmentId(event.target.value)} aria-label="موعد الإحالة" data-testid="referral-appointment">
              <option value="">اختر موعدًا محجوزًا…</option>
              {appointments.filter(item => item.status === "booked").map(item => <option key={item.id} value={item.id}>{item.date}{item.time ? ` ${item.time}` : ""}</option>)}
            </select>
          ) : null}
          {open === "complete" ? (
            <input className={`${field} min-w-0 flex-1`} value={procedure} onChange={event => setProcedure(event.target.value)} placeholder="ما أُنجز للمريض" aria-label="ما أُنجز" data-testid="referral-procedure" />
          ) : null}
          <input className={`${field} min-w-0 flex-1`} value={note} onChange={event => setNote(event.target.value)}
            placeholder={open === "decline" || open === "cancel" ? "السبب (إلزامي)" : "ملاحظة"} aria-label="ملاحظة الإحالة" data-testid="referral-note" />
          {open === "close" ? (
            <>
              <button type="button" disabled={busy} onClick={() => void run({ action: "complete", note }, `/api/referrals/${referral.id}`, "PATCH")} data-testid="referral-close-complete"
                className="min-h-10 rounded-xl bg-emerald-800 px-3 font-bold text-white disabled:opacity-50">اكتملت</button>
              <button type="button" disabled={busy} onClick={() => void run({ action: "cancel", note }, `/api/referrals/${referral.id}`, "PATCH")}
                className="min-h-10 rounded-xl border border-slate-300 px-3 font-bold disabled:opacity-50">أُلغيت</button>
            </>
          ) : (
            <button type="button" disabled={busy} data-testid="referral-step-save"
              onClick={() => void run({ action: open, note, procedurePerformed: procedure, appointmentId: appointmentId ? Number(appointmentId) : null },
                `/api/referrals/${referral.id}/transition`, "POST")}
              className="min-h-10 rounded-xl bg-navy-800 px-3 font-bold text-white disabled:opacity-50">تأكيد</button>
          )}
        </div>
      ) : null}
    </li>
  );
}

function IssueForm({ patientId, onClose, onDone }: { patientId: string; onClose: () => void; onDone: () => void }) {
  const [requestKey] = useState(newKey);
  const [kind, setKind] = useState<"internal" | "external">("internal");
  const [receivers, setReceivers] = useState<{ id: number; name: string }[] | null>(null);
  const [toPartyId, setToPartyId] = useState("");
  const [toName, setToName] = useState("");
  const [toSpecialty, setToSpecialty] = useState<ReferralSpecialty>(REFERRAL_SPECIALTIES[0]);
  const [urgency, setUrgency] = useState<ReferralUrgency>("routine");
  const [reason, setReason] = useState("");
  const [teeth, setTeeth] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/referrals/mine", { cache: "no-store" }).then(response => response.ok ? response.json() : null)
      .then((payload: { receivers?: { id: number; name: string }[] } | null) => { if (!cancelled) setReceivers(payload?.receivers ?? []); })
      .catch(() => { if (!cancelled) setReceivers([]); });
    return () => { cancelled = true; };
  }, []);
  async function submit() {
    setBusy(true); setError(null);
    const body = kind === "internal"
      ? { requestKey, kind, toPartyId: toPartyId ? Number(toPartyId) : null, toSpecialty, urgency, reason, teeth }
      : { requestKey, kind, toName, toSpecialty, urgency, reason, teeth };
    const failure = await send(`/api/patients/${encodeURIComponent(patientId)}/referrals`, "POST", body);
    setBusy(false);
    if (failure) setError(failure); else onDone();
  }
  return (
    <div className="mt-2 grid gap-2 rounded-xl border border-slate-200 p-3 text-xs" data-testid="referral-issue-form">
      <div className="flex gap-2" role="group" aria-label="نوع الإحالة">
        {(["internal", "external"] as const).map(option => (
          <button key={option} type="button" aria-pressed={kind === option} onClick={() => setKind(option)}
            className={`min-h-9 rounded-lg px-3 font-bold ${kind === option ? "bg-navy-800 text-white" : "border border-slate-300 text-navy-800"}`}>
            {option === "internal" ? "داخلية (طبيب في المركز)" : "خارجية (خطاب)"}
          </button>
        ))}
      </div>
      {kind === "internal" ? (
        <select className={field} value={toPartyId} onChange={event => setToPartyId(event.target.value)} aria-label="الطبيب المحال إليه" data-testid="referral-receiver">
          <option value="">{receivers === null ? "جارٍ التحميل…" : "اختر الطبيب…"}</option>
          {(receivers ?? []).map(receiver => <option key={receiver.id} value={receiver.id}>{receiver.name}</option>)}
        </select>
      ) : (
        <input className={field} value={toName} onChange={event => setToName(event.target.value)} placeholder="اسم الجهة أو الطبيب" aria-label="المحال إليه" data-testid="referral-to-name" />
      )}
      <div className="flex flex-wrap gap-2">
        <select className={field} value={toSpecialty} onChange={event => setToSpecialty(event.target.value as ReferralSpecialty)} aria-label="التخصص" data-testid="referral-specialty">
          {REFERRAL_SPECIALTIES.map(specialty => <option key={specialty} value={specialty}>{REFERRAL_SPECIALTY_LABEL[specialty]}</option>)}
        </select>
        <select className={field} value={urgency} onChange={event => setUrgency(event.target.value as ReferralUrgency)} aria-label="الاستعجال">
          {REFERRAL_URGENCIES.map(item => <option key={item} value={item}>{REFERRAL_URGENCY_LABEL[item]}</option>)}
        </select>
        <input className={field} dir="ltr" value={teeth} onChange={event => setTeeth(event.target.value)} placeholder="16 26" aria-label="الأسنان" />
      </div>
      <textarea className={`${field} min-h-16 py-1`} value={reason} onChange={event => setReason(event.target.value)} placeholder="سبب الإحالة" aria-label="سبب الإحالة" data-testid="referral-reason" />
      {error ? <p role="alert" className="font-bold text-red-700">{error}</p> : null}
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => void submit()} data-testid="referral-issue-save"
          className="min-h-10 rounded-xl bg-navy-800 px-3 font-bold text-white disabled:opacity-50">إصدار</button>
        <button type="button" disabled={busy} onClick={onClose} className="min-h-10 rounded-xl border border-slate-300 px-3 font-bold">إلغاء</button>
      </div>
    </div>
  );
}
