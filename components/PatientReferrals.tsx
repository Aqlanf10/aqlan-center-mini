"use client";

import { useCallback, useEffect, useState } from "react";
import {
  REFERRAL_SPECIALTIES, REFERRAL_SPECIALTY_LABEL, REFERRAL_STATUS_LABEL, REFERRAL_URGENCIES, REFERRAL_URGENCY_LABEL,
  WORKFLOW_STATE_LABEL,
  type Referral, type ReferralAction, type ReferralSpecialty, type ReferralUrgency,
} from "@/lib/referrals";
import type { Appointment } from "@/lib/schedule";
import { friendlyDateLong } from "@/lib/reminders";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { ToothPicker, parseTeethText } from "./ToothPicker";

/**
 * (P3-8) إحالات المريض الصادرة — خطابٌ يُطبع، ثم يبقى مفتوحًا حتى تعود النتيجة.
 *
 * الطبيب يصدر الخطاب؛ والاستقبال أو الطبيب يسجّل النتيجة حين تعود («قُلعت الأربعة»)
 * أو يلغي الإحالة بسببٍ مكتوب. المفتوحة أولًا لأنها ما ينتظر متابعة.
 */
/** (REF-1) خطوات الإحالة الداخلية المتاحة في كل حالة — والخادم يقرّر من يحق له كلٌّ منها. */
const INTERNAL_ACTIONS: Record<string, { action: ReferralAction; label: string }[]> = {
  requested: [{ action: "accept", label: "قبول" }, { action: "schedule", label: "حجز الإحالة" }, { action: "decline", label: "اعتذار" }, { action: "cancel", label: "إلغاء" }],
  accepted: [{ action: "schedule", label: "حجز الإحالة" }, { action: "complete", label: "إنهاء الإحالة" }, { action: "decline", label: "اعتذار" }, { action: "cancel", label: "إلغاء" }],
  scheduled: [{ action: "complete", label: "إنهاء الإحالة" }, { action: "schedule", label: "تغيير الموعد" }, { action: "cancel", label: "إلغاء" }],
  arrived: [{ action: "complete", label: "إنهاء الإحالة" }, { action: "cancel", label: "إلغاء" }],
  in_progress: [{ action: "complete", label: "إنهاء الإحالة" }, { action: "cancel", label: "إلغاء" }],
  completed: [{ action: "acknowledge", label: "اطّلعتُ على النتيجة" }],
};

interface Step {
  id: number; action: ReferralAction; note: string; appointmentId: string;
  procedurePerformed: string; followupRequired: boolean; mayReturn: boolean;
}

export function PatientReferrals({ patientId, canIssue, appointments = [] }: {
  patientId: number; canIssue: boolean;
  /** (REF-1) مواعيد المريض القادمة — «حجز الإحالة» يربط أحدها بالإحالة. */
  appointments?: Pick<Appointment, "id" | "scheduledDate" | "scheduledTime" | "status" | "doctorName">[];
}) {
  const [items, setItems] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{ toName: string; toSpecialty: ReferralSpecialty; reason: string; teeth: string; urgency: ReferralUrgency }>({
    toName: "", toSpecialty: "oral_surgery", reason: "", teeth: "", urgency: "routine",
  });
  const [closing, setClosing] = useState<{ id: number; action: "complete" | "cancel"; note: string } | null>(null);
  const [internal, setInternal] = useState(false);
  const [toPartyId, setToPartyId] = useState("");
  const [doctors, setDoctors] = useState<{ id: number; name: string }[]>([]);
  const [step, setStep] = useState<Step | null>(null);

  useEffect(() => {
    if (!canIssue && appointments.length === 0) return;
    void fetch("/api/parties?kind=doctor", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : [])
      .then((rows: unknown) => setDoctors(Array.isArray(rows) ? (rows as { id: number; name: string }[]) : []))
      .catch(() => setDoctors([]));
  }, [canIssue, appointments.length]);

  /** خطوةٌ داخلية واحدة — رسالة الخادم العربية كما هي عند الرفض (الصلاحية أو الحالة). */
  const runStep = async () => {
    if (!step) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/referrals/${step.id}/transition`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: step.action, note: step.note || null, appointmentId: step.appointmentId || null,
          procedurePerformed: step.procedurePerformed || null,
          followupRequired: step.action === "complete" ? step.followupRequired : null,
          mayReturn: step.action === "complete" ? step.mayReturn : null,
        }),
      });
      const payload = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) { setError(payload?.message ?? "تعذّر تحديث الإحالة."); return; }
      setStep(null);
      setError(null);
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const submitInternal = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/patients/${patientId}/referrals`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, kind: "internal", toPartyId }),
      });
      const payload = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) { setError(payload?.message ?? "تعذّر حفظ الإحالة."); return; }
      setCreating(false);
      setToPartyId("");
      setForm({ toName: "", toSpecialty: "oral_surgery", reason: "", teeth: "", urgency: "routine" });
      setError(null);
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/patients/${patientId}/referrals`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(payload)) {
        setError((payload as { message?: string } | null)?.message ?? "تعذّر تحميل الإحالات.");
        return;
      }
      setItems(payload as Referral[]);
      setError(null);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    /* نافذة الطباعة تُفتح هنا متزامنةً مع الضغطة — Safari يحجب النوافذ التي تُفتح بعد
       انتظار الشبكة، فتُحفظ الإحالة ولا يظهر الخطاب. تُوجَّه إلى الخطاب بعد الحفظ،
       وتُغلق إن فشل. */
    const printTab = window.open("", "_blank");
    setBusy(true);
    let printed = false;
    try {
      const response = await fetch(`/api/patients/${patientId}/referrals`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      const payload = await response.json().catch(() => null) as (Referral & { message?: string }) | null;
      if (!response.ok) { setError(payload?.message ?? "تعذّر حفظ الإحالة."); return; }
      if (payload?.id && printTab) {
        printTab.opener = null;
        printTab.location.href = `/print/referral/${payload.id}`;
        printed = true;
      }
      setCreating(false);
      setForm({ toName: "", toSpecialty: "oral_surgery", reason: "", teeth: "", urgency: "routine" });
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      if (!printed) printTab?.close();
      setBusy(false);
    }
  };

  const close = async () => {
    if (!closing) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/referrals/${closing.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: closing.action, note: closing.note }),
      });
      const payload = await response.json().catch(() => null) as { message?: string } | null;
      if (!response.ok) { setError(payload?.message ?? "تعذّر تحديث الإحالة."); return; }
      setClosing(null);
      await load();
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    } finally {
      setBusy(false);
    }
  };

  const ordered = [...items].sort((a, b) => Number(b.status === "sent") - Number(a.status === "sent"));

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-extrabold text-navy-900">📨 الإحالات إلى الأخصائيين</h3>
        {canIssue && !creating ? (
          <button type="button" onClick={() => setCreating(true)}
            className="rounded-xl bg-navy-800 px-3 py-1.5 text-xs font-extrabold text-white hover:bg-navy-900">
            + إحالة جديدة
          </button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-700">{error}</p>
      ) : null}

      {creating ? (
        <div className="mb-4 grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
          <div className="flex gap-2 sm:col-span-2" role="radiogroup" aria-label="نوع الإحالة">
            {[{ value: true, label: "داخل المركز" }, { value: false, label: "خارج المركز (خطاب)" }].map((option) => (
              <button key={String(option.value)} type="button" role="radio" aria-checked={internal === option.value}
                onClick={() => setInternal(option.value)}
                className={`rounded-lg border px-3 py-1 text-xs font-bold ${internal === option.value ? "border-navy-800 bg-navy-800 text-white" : "border-slate-300 bg-white text-slate-700"}`}>
                {option.label}
              </button>
            ))}
          </div>
          {internal ? (
            <label className="block text-xs font-bold text-slate-700">
              الطبيب المحال إليه
              <select value={toPartyId} onChange={(e) => setToPartyId(e.target.value)} aria-label="الطبيب المحال إليه"
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
                <option value="">—</option>
                {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
              </select>
            </label>
          ) : (
          <label className="block text-xs font-bold text-slate-700">
            المحال إليه (طبيب أو مركز)
            <input value={form.toName} onChange={(e) => setForm({ ...form, toName: e.target.value })}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" maxLength={120} />
          </label>
          )}
          <label className="block text-xs font-bold text-slate-700">
            التخصص
            <select value={form.toSpecialty} onChange={(e) => setForm({ ...form, toSpecialty: e.target.value as ReferralSpecialty })}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
              {REFERRAL_SPECIALTIES.map((key) => <option key={key} value={key}>{REFERRAL_SPECIALTY_LABEL[key]}</option>)}
            </select>
          </label>
          <label className="block text-xs font-bold text-slate-700 sm:col-span-2">
            السبب والمطلوب من الزميل
            <textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} rows={3}
              placeholder="مثال: قلع الضواحك الأولى الأربعة قبل بدء التقويم" maxLength={1000}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
          </label>
          <div className="block text-xs font-bold text-slate-700 sm:col-span-2">
            الأسنان (اختياري) — انقر لاختيارها
            <div className="mt-1">
              <ToothPicker value={parseTeethText(form.teeth)}
                onChange={(teeth) => setForm({ ...form, teeth: teeth.join(", ") })} />
            </div>
          </div>
          <label className="block text-xs font-bold text-slate-700">
            الاستعجال
            <select value={form.urgency} onChange={(e) => setForm({ ...form, urgency: e.target.value as ReferralUrgency })}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
              {REFERRAL_URGENCIES.map((key) => <option key={key} value={key}>{REFERRAL_URGENCY_LABEL[key]}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button type="button" disabled={busy || (internal && !toPartyId)} onClick={() => void (internal ? submitInternal() : submit())}
              className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-extrabold text-white hover:bg-emerald-700 disabled:opacity-40">
              {internal ? "إرسال الإحالة للزميل" : "حفظ وطباعة الخطاب"}
            </button>
            <button type="button" onClick={() => setCreating(false)}
              className="rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700">
              إلغاء
            </button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <p className="text-xs text-slate-400">جارٍ التحميل…</p>
      ) : ordered.length === 0 ? (
        <p className="text-xs text-slate-500">لا إحالات لهذا المريض.</p>
      ) : (
        <ul className="space-y-2">
          {ordered.map((item) => (
            <li key={item.id} data-referral={item.id}
              className={`rounded-xl border p-3 ${item.status === "sent" ? "border-amber-300 bg-amber-50/40" : "border-slate-200 bg-white"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-extrabold text-navy-900">
                  {item.toName} <span className="text-xs font-bold text-slate-500">— {REFERRAL_SPECIALTY_LABEL[item.toSpecialty]}</span>
                </p>
                <span className="rounded-lg border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-extrabold text-slate-700">
                  {item.kind === "internal" && item.workflowState ? `داخلية · ${WORKFLOW_STATE_LABEL[item.workflowState]}` : REFERRAL_STATUS_LABEL[item.status]}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-xs text-slate-700">{item.reason}</p>
              <p className="mt-1 text-[11px] text-slate-500">
                {friendlyDateLong(clinicDateString(new Date(item.createdAt), CLINIC_ZONE_FALLBACK))}
                {item.teeth ? <> · الأسنان <span dir="ltr">{item.teeth}</span></> : null}
                {item.urgency !== "routine" ? ` · ${REFERRAL_URGENCY_LABEL[item.urgency]}` : ""}
                {item.doctorName ? ` · د. ${item.doctorName}` : ""}
              </p>
              {item.outcomeNote ? (
                <p className="mt-1 text-xs font-bold text-slate-700">النتيجة: {item.outcomeNote}</p>
              ) : null}
              {item.kind === "internal" ? (
                <p className="mt-1 text-[11px] font-bold text-slate-600">
                  {item.appointmentDate ? `📅 ${item.appointmentDate}` : "لم يُحجز موعد بعد"}
                  {item.caseTitle ? ` · 🩺 ${item.caseTitle}` : ""}
                  {item.procedurePerformed ? ` · ما أُنجز: ${item.procedurePerformed}` : ""}
                  {item.followupRequired ? " · يحتاج متابعة" : ""}
                </p>
              ) : null}
              {item.kind === "internal" && item.workflowState ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(INTERNAL_ACTIONS[item.workflowState] ?? []).map((option) => (
                    <button key={option.action} type="button"
                      onClick={() => setStep({ id: item.id, action: option.action, note: "", appointmentId: "", procedurePerformed: "", followupRequired: false, mayReturn: false })}
                      className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700">
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {step?.id === item.id ? (
                <div className="mt-2 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2 sm:grid-cols-2">
                  {step.action === "schedule" ? (
                    <label className="block text-[11px] font-bold text-slate-700 sm:col-span-2">
                      موعد الإحالة (احجزه أولًا من «موعد» ثم اختره هنا)
                      <select value={step.appointmentId} onChange={(e) => setStep({ ...step, appointmentId: e.target.value })}
                        aria-label="موعد الإحالة" className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
                        <option value="">—</option>
                        {appointments.filter((one) => one.status === "booked").map((one) => (
                          <option key={one.id} value={one.id}>{one.scheduledDate} {one.scheduledTime}{one.doctorName ? ` · ${one.doctorName}` : ""}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {step.action === "complete" ? (
                    <>
                      <label className="block text-[11px] font-bold text-slate-700 sm:col-span-2">
                        ما أُنجز للمريض (يعود إلى المحيل)
                        <input value={step.procedurePerformed} onChange={(e) => setStep({ ...step, procedurePerformed: e.target.value })}
                          maxLength={500} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
                      </label>
                      <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
                        <input type="checkbox" checked={step.followupRequired} onChange={(e) => setStep({ ...step, followupRequired: e.target.checked })} />
                        يحتاج متابعة
                      </label>
                      <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700">
                        <input type="checkbox" checked={step.mayReturn} onChange={(e) => setStep({ ...step, mayReturn: e.target.checked })} />
                        قد يعود إليّ لاحقًا
                      </label>
                    </>
                  ) : null}
                  {step.action !== "accept" && step.action !== "acknowledge" && step.action !== "schedule" ? (
                    <label className="block text-[11px] font-bold text-slate-700 sm:col-span-2">
                      {step.action === "complete" ? "ملاحظة للمحيل (اختياري)" : step.action === "decline" ? "سبب الاعتذار" : "سبب الإلغاء"}
                      <input value={step.note} onChange={(e) => setStep({ ...step, note: e.target.value })} maxLength={1000}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
                    </label>
                  ) : null}
                  <div className="flex gap-2 sm:col-span-2">
                    <button type="button" disabled={busy} onClick={() => void runStep()}
                      className="rounded-lg bg-navy-800 px-3 py-1.5 text-[11px] font-extrabold text-white disabled:opacity-40">تأكيد</button>
                    <button type="button" onClick={() => setStep(null)}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-bold text-slate-700">تراجع</button>
                  </div>
                </div>
              ) : null}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {canIssue && item.kind !== "internal" ? (
                  <a href={`/print/referral/${item.id}`} target="_blank" rel="noopener"
                    className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700">
                    🖨️ الخطاب
                  </a>
                ) : null}
                {item.status === "sent" && item.kind !== "internal" ? (
                  <>
                    <button type="button" onClick={() => setClosing({ id: item.id, action: "complete", note: "" })}
                      className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-800">
                      عادت النتيجة
                    </button>
                    <button type="button" onClick={() => setClosing({ id: item.id, action: "cancel", note: "" })}
                      className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700">
                      إلغاء الإحالة
                    </button>
                  </>
                ) : null}
              </div>
              {closing?.id === item.id ? (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="block flex-1 text-[11px] font-bold text-slate-700">
                    {closing.action === "complete" ? "ماذا تم؟ (اختياري)" : "سبب الإلغاء"}
                    <input value={closing.note} onChange={(e) => setClosing({ ...closing, note: e.target.value })} maxLength={1000}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
                  </label>
                  <button type="button" disabled={busy} onClick={() => void close()}
                    className="rounded-lg bg-navy-800 px-3 py-1.5 text-[11px] font-extrabold text-white disabled:opacity-40">
                    تأكيد
                  </button>
                  <button type="button" onClick={() => setClosing(null)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-bold text-slate-700">
                    تراجع
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
