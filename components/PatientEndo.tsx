"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  APICAL_DIAGNOSES, APICAL_LABEL, CROWN_STATE_LABEL, ENDO_KIND_LABEL, ENDO_STAGES, ENDO_STAGE_LABEL, ENDO_STATUS_LABEL,
  MEASUREMENT_METHODS, MEASUREMENT_METHOD_LABEL, PROGNOSES, PROGNOSIS_LABEL, PULPAL_DIAGNOSES, PULPAL_LABEL,
  REFERENCE_POINTS, REFERENCE_POINT_LABEL, RESTORATIVE_LABEL, RESTORATIVE_STATUSES, TENDERNESS_LABEL,
  TENDERNESS_RESULTS, VITALITY_LABEL, VITALITY_RESULTS, expectedCanals,
} from "@/lib/endodontics";
import { ALL_TEETH, toothName } from "@/lib/dental";
import type { EndoTreatmentView, EndoVisitView } from "@/lib/endodontics-db";
import type { CasePlanItem, SpecialtyCase } from "@/lib/db";

/**
 * (ENDO-3) علاج الجذور داخل ملف المريض — التشخيص ← القنوات ← الأطوال العاملة ← الجلسات ← الحالة ← الخطوة التالية.
 *
 * نوبةٌ لكل سنّ، وسجلٌّ مهيكلٌ لكل زيارة. الطبيب يرى الشريط السريع أولًا (ما يحتاجه على الكرسي)، ثم القنوات
 * بأطوالها، ثم الجلسات. زيارةٌ موقَّعة لا تُعدَّل: يظهر لها ملحقٌ فقط. والمال لا يُمسّ هنا.
 */

interface CanalRowState {
  label: string; workingLengthMm: string; referencePoint: string; measurementMethod: string;
  masterApicalSize: string; taperPercent: string; obturated: boolean; note: string;
}

const emptyCanal = (label: string): CanalRowState => ({
  label, workingLengthMm: "", referencePoint: "", measurementMethod: "", masterApicalSize: "", taperPercent: "",
  obturated: false, note: "",
});

interface FormState {
  stage: string; chiefComplaint: string; symptoms: string; pulpalDiagnosis: string; apicalDiagnosis: string;
  vitalityCold: string; vitalityHeat: string; vitalityEpt: string; percussion: string; palpation: string;
  mobilityGrade: string; perioFindings: string; previousTreatment: string; radiographicFindings: string;
  canalsFound: string; instrumentation: string; irrigation: string; medicament: string;
  obturationTechnique: string; obturationMaterial: string; restorationAfter: string; complications: string;
  prognosis: string; nextStep: string; nextVisitWeeks: string; note: string; canals: CanalRowState[];
}

const blankForm = (canals: CanalRowState[]): FormState => ({
  stage: "assessment", chiefComplaint: "", symptoms: "", pulpalDiagnosis: "", apicalDiagnosis: "", vitalityCold: "",
  vitalityHeat: "", vitalityEpt: "", percussion: "", palpation: "", mobilityGrade: "", perioFindings: "",
  previousTreatment: "", radiographicFindings: "", canalsFound: "", instrumentation: "", irrigation: "", medicament: "",
  obturationTechnique: "", obturationMaterial: "", restorationAfter: "", complications: "", prognosis: "", nextStep: "",
  nextVisitWeeks: "", note: "", canals,
});

const str = (value: unknown) => (value === null || value === undefined ? "" : String(value));

function formFromVisit(visit: EndoVisitView): FormState {
  return {
    stage: visit.stage, chiefComplaint: str(visit.chiefComplaint), symptoms: str(visit.symptoms),
    pulpalDiagnosis: str(visit.pulpalDiagnosis), apicalDiagnosis: str(visit.apicalDiagnosis),
    vitalityCold: str(visit.vitalityCold), vitalityHeat: str(visit.vitalityHeat), vitalityEpt: str(visit.vitalityEpt),
    percussion: str(visit.percussion), palpation: str(visit.palpation), mobilityGrade: str(visit.mobilityGrade),
    perioFindings: str(visit.perioFindings), previousTreatment: str(visit.previousTreatment),
    radiographicFindings: str(visit.radiographicFindings), canalsFound: str(visit.canalsFound),
    instrumentation: str(visit.instrumentation), irrigation: str(visit.irrigation), medicament: str(visit.medicament),
    obturationTechnique: str(visit.obturationTechnique), obturationMaterial: str(visit.obturationMaterial),
    restorationAfter: str(visit.restorationAfter), complications: str(visit.complications),
    prognosis: str(visit.prognosis), nextStep: str(visit.nextStep), nextVisitWeeks: str(visit.nextVisitWeeks),
    note: str(visit.note),
    canals: visit.canals.map((canal) => ({
      label: canal.label, workingLengthMm: str(canal.workingLengthMm), referencePoint: str(canal.referencePoint),
      measurementMethod: str(canal.measurementMethod), masterApicalSize: str(canal.masterApicalSize),
      taperPercent: str(canal.taperPercent), obturated: canal.obturated, note: str(canal.note),
    })),
  };
}

const orNull = (value: string) => (value.trim() === "" ? null : value);
const numOrNull = (value: string) => (value.trim() === "" ? null : Number(value));

function payloadFrom(form: FormState, visitId: number, expectedVersion: number | null) {
  return {
    visitId, expectedVersion, stage: form.stage, chiefComplaint: orNull(form.chiefComplaint), symptoms: orNull(form.symptoms),
    pulpalDiagnosis: orNull(form.pulpalDiagnosis), apicalDiagnosis: orNull(form.apicalDiagnosis),
    vitalityCold: orNull(form.vitalityCold), vitalityHeat: orNull(form.vitalityHeat), vitalityEpt: orNull(form.vitalityEpt),
    percussion: orNull(form.percussion), palpation: orNull(form.palpation), mobilityGrade: numOrNull(form.mobilityGrade),
    perioFindings: orNull(form.perioFindings), previousTreatment: orNull(form.previousTreatment),
    radiographicFindings: orNull(form.radiographicFindings), canalsFound: numOrNull(form.canalsFound),
    instrumentation: orNull(form.instrumentation), irrigation: orNull(form.irrigation), medicament: orNull(form.medicament),
    obturationTechnique: orNull(form.obturationTechnique), obturationMaterial: orNull(form.obturationMaterial),
    restorationAfter: orNull(form.restorationAfter), complications: orNull(form.complications),
    prognosis: orNull(form.prognosis), nextStep: orNull(form.nextStep), nextVisitWeeks: numOrNull(form.nextVisitWeeks),
    note: orNull(form.note),
    canals: form.canals.filter((canal) => canal.label.trim() !== "").map((canal) => ({
      label: canal.label, workingLengthMm: numOrNull(canal.workingLengthMm), referencePoint: orNull(canal.referencePoint),
      measurementMethod: orNull(canal.measurementMethod), masterApicalSize: numOrNull(canal.masterApicalSize),
      taperPercent: numOrNull(canal.taperPercent), obturated: canal.obturated, note: orNull(canal.note),
    })),
  };
}

const STATUS_TONE: Record<string, string> = {
  in_progress: "bg-emerald-50 text-emerald-800 border-emerald-200",
  completed: "bg-sky-50 text-sky-800 border-sky-200",
  abandoned: "bg-slate-100 text-slate-600 border-slate-200",
};

const field = "mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm";
const label = "text-xs font-bold text-slate-600";

function Select({ value, onChange, options, testId }: {
  value: string; onChange: (value: string) => void; options: readonly [string, string][]; testId?: string;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className={field} data-testid={testId}>
      <option value="">—</option>
      {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
    </select>
  );
}

export function PatientEndo({ patientId, canWrite, openVisitId }: { patientId: number; canWrite: boolean; openVisitId: number | null }) {
  const [treatments, setTreatments] = useState<EndoTreatmentView[] | null>(null);
  const [cases, setCases] = useState<SpecialtyCase[]>([]);
  const [planItems, setPlanItems] = useState<CasePlanItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openForm, setOpenForm] = useState<{ toothCode: string; caseId: string; kind: string } | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
  const [addendum, setAddendum] = useState<{ endoVisitId: number; text: string } | null>(null);
  const [closing, setClosing] = useState<{ status: "completed" | "abandoned"; outcome: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [endoResponse, caseResponse] = await Promise.all([
        fetch(`/api/patients/${patientId}/endo`, { cache: "no-store" }),
        fetch(`/api/patients/${patientId}/cases`, { cache: "no-store" }),
      ]);
      const endoPayload = await endoResponse.json().catch(() => null) as { treatments?: EndoTreatmentView[]; message?: string } | null;
      if (!endoResponse.ok || !endoPayload?.treatments) {
        setError(endoPayload?.message ?? "تعذّر تحميل علاج الجذور.");
        return;
      }
      setTreatments(endoPayload.treatments);
      setError(null);
      const casePayload = await caseResponse.json().catch(() => null) as { cases?: SpecialtyCase[]; items?: CasePlanItem[] } | null;
      setCases((casePayload?.cases ?? []).filter((one) => one.specialty === "endodontics" && one.id !== null
        && (one.status === "active" || one.status === "waiting")));
      setPlanItems(casePayload?.items ?? []);
    } catch {
      setError("تعذّر الاتصال بالخادم.");
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => {
    if (!treatments?.length) return null;
    return treatments.find((one) => one.id === selectedId)
      ?? treatments.find((one) => one.status === "in_progress") ?? treatments[0];
  }, [treatments, selectedId]);

  /** تنفيذ طلبٍ كتابي: يعرض رسالة الخادم العربية كما هي، ويحدّث القائمة بالنتيجة. */
  const send = async (url: string, method: "POST" | "PUT" | "PATCH", body: unknown): Promise<EndoTreatmentView | null> => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null) as (EndoTreatmentView & { message?: string }) | null;
      if (!response.ok || !payload || typeof payload.id !== "number") {
        setError(payload?.message ?? "تعذّر الحفظ. أعد المحاولة.");
        return null;
      }
      setTreatments((current) => {
        const list = current ?? [];
        return list.some((one) => one.id === payload.id) ? list.map((one) => (one.id === payload.id ? payload : one)) : [payload, ...list];
      });
      setSelectedId(payload.id);
      return payload;
    } catch {
      setError("تعذّر الاتصال بالخادم.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const todayRecord = selected && openVisitId !== null ? selected.visits.find((visit) => visit.visitId === openVisitId) ?? null : null;

  const startForm = (treatment: EndoTreatmentView) => {
    const record = openVisitId === null ? null : treatment.visits.find((visit) => visit.visitId === openVisitId && !visit.signed) ?? null;
    if (record) {
      setForm(formFromVisit(record)); setEditingVersion(record.version);
    } else {
      const known = treatment.summary.canals.map((canal) => canal.label);
      const labels = known.length > 0 ? known : expectedCanals(treatment.toothCode);
      setForm({ ...blankForm(labels.map(emptyCanal)), stage: known.length > 0 ? "shaping" : "assessment" });
      setEditingVersion(null);
    }
  };

  if (!treatments) {
    return <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">{error ?? "جارٍ التحميل…"}</p>;
  }

  const patch = (changes: Partial<FormState>) => setForm((current) => (current ? { ...current, ...changes } : current));
  const patchCanal = (index: number, changes: Partial<CanalRowState>) => setForm((current) => current
    ? { ...current, canals: current.canals.map((canal, i) => (i === index ? { ...canal, ...changes } : canal)) } : current);
  const toothOptions = ALL_TEETH.filter((code) => !treatments.some((one) => one.toothCode === code && one.status === "in_progress"));
  const crownCandidates = selected ? planItems.filter((item) => item.toothCode === selected.toothCode && item.status !== "cancelled") : [];

  return (
    <div className="space-y-3" data-testid="patient-endo">
      {error ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800" data-testid="endo-error">{error}</p> : null}
      {notice ? <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800">{notice}</p> : null}

      {/* ── الأسنان ── */}
      <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="أسنان علاج الجذور">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-black text-navy-900">علاج الجذور</h3>
          {canWrite && !openForm ? (
            <button type="button" data-testid="endo-new" onClick={() => setOpenForm({ toothCode: "", caseId: cases[0]?.id ? String(cases[0].id) : "", kind: "initial" })}
              className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white">+ سنّ جديد</button>
          ) : null}
        </div>

        {openForm ? (
          <div className="mb-3 grid gap-2 rounded-xl border border-navy-100 bg-navy-50/40 p-2 sm:grid-cols-3">
            <label className={label}>السنّ (FDI)
              <select value={openForm.toothCode} onChange={(event) => setOpenForm({ ...openForm, toothCode: event.target.value })} className={field} data-testid="endo-tooth">
                <option value="">—</option>
                {toothOptions.map((code) => <option key={code} value={code}>{code} — {toothName(code)}</option>)}
              </select>
            </label>
            <label className={label}>الحالة التخصصية
              <select value={openForm.caseId} onChange={(event) => setOpenForm({ ...openForm, caseId: event.target.value })} className={field} data-testid="endo-case">
                <option value="">— اختر —</option>
                {cases.map((one) => <option key={one.id as number} value={one.id as number}>{one.title}</option>)}
              </select>
            </label>
            <label className={label}>النوع
              <select value={openForm.kind} onChange={(event) => setOpenForm({ ...openForm, kind: event.target.value })} className={field}>
                <option value="initial">{ENDO_KIND_LABEL.initial}</option>
                <option value="retreatment">{ENDO_KIND_LABEL.retreatment}</option>
              </select>
            </label>
            {cases.length === 0 ? (
              <p className="text-xs text-amber-800 sm:col-span-3">لا توجد حالة علاج جذور جارية — يمكنك فتحها هنا مع السنّ.</p>
            ) : null}
            <div className="flex gap-2 sm:col-span-3">
              <button type="button" data-testid="endo-open-save" disabled={busy || !openForm.toothCode}
                onClick={async () => {
                  let caseId = openForm.caseId ? Number(openForm.caseId) : null;
                  if (caseId === null) {
                    // حالةٌ جديدة بالنظام نفسه (الحالات التخصصية) — لا نموذج حالةٍ ثانٍ.
                    const created = await fetch(`/api/patients/${patientId}/cases`, {
                      method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ specialty: "endodontics", title: `علاج جذور — سن ${openForm.toothCode}`, site: openForm.toothCode }),
                    });
                    const payload = await created.json().catch(() => null) as { id?: number; message?: string } | null;
                    if (!created.ok || typeof payload?.id !== "number") { setError(payload?.message ?? "تعذّر فتح الحالة."); return; }
                    caseId = payload.id;
                  }
                  if (await send(`/api/patients/${patientId}/endo`, "POST", { toothCode: Number(openForm.toothCode), caseId, kind: openForm.kind })) {
                    setOpenForm(null); setForm(null); await load();
                  }
                }}
                className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">فتح</button>
              <button type="button" onClick={() => setOpenForm(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600">إلغاء</button>
            </div>
          </div>
        ) : null}

        {treatments.length === 0 ? (
          <p className="text-xs text-slate-500">لا علاج جذور مسجَّل لهذا المريض.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {treatments.map((one) => (
              <li key={one.id}>
                <button type="button" data-testid={`endo-tooth-${one.toothCode}`} onClick={() => { setSelectedId(one.id); setForm(null); setClosing(null); }}
                  className={`rounded-xl border px-3 py-2 text-right text-xs ${selected?.id === one.id ? "border-navy-900 bg-navy-50" : "border-slate-200 bg-white"}`}>
                  <span className="block text-sm font-black text-navy-900">سنّ {one.toothCode}</span>
                  <span className={`mt-1 inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_TONE[one.status]}`}>{ENDO_STATUS_LABEL[one.status]}</span>
                  <span className="mt-1 block text-[11px] text-slate-500">{one.summary.canals.length} قنوات · {one.summary.sessions} جلسات</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected ? (
        <>
          {/* ── الشريط السريع: التشخيص ← القنوات ← الأطوال ← الجلسات ← الحالة ← الخطوة التالية ── */}
          <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="ملخص علاج الجذور" data-testid="endo-strip">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-black text-navy-900">
                سنّ {selected.toothCode} — {selected.toothName} <span className="text-xs font-bold text-slate-500">· {ENDO_KIND_LABEL[selected.kind]} · {selected.caseTitle}</span>
              </h3>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${STATUS_TONE[selected.status]}`}>{ENDO_STATUS_LABEL[selected.status]}</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <div className="rounded-xl bg-slate-50 p-2" data-testid="endo-strip-dx">
                <p className="text-[11px] font-bold text-slate-500">التشخيص</p>
                <p className="text-xs font-bold text-navy-900">{selected.summary.pulpalDiagnosis ? PULPAL_LABEL[selected.summary.pulpalDiagnosis] : "—"}</p>
                <p className="text-xs text-slate-600">{selected.summary.apicalDiagnosis ? APICAL_LABEL[selected.summary.apicalDiagnosis] : "—"}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-2" data-testid="endo-strip-canals">
                <p className="text-[11px] font-bold text-slate-500">القنوات</p>
                <p className="text-xs font-bold text-navy-900">{selected.summary.canals.length > 0 ? selected.summary.canals.map((c) => c.label).join("، ") : "—"}</p>
                {selected.summary.canalsFound !== null ? <p className="text-xs text-slate-600">المُعلَن: {selected.summary.canalsFound}</p> : null}
              </div>
              <div className="rounded-xl bg-slate-50 p-2" data-testid="endo-strip-wl">
                <p className="text-[11px] font-bold text-slate-500">الأطوال العاملة</p>
                <p className="text-xs font-bold text-navy-900" dir="ltr">
                  {selected.summary.canals.some((c) => c.workingLengthMm !== null)
                    ? selected.summary.canals.map((c) => `${c.label} ${c.workingLengthMm ?? "?"}`).join(" · ") : "—"}
                </p>
              </div>
              <div className="rounded-xl bg-slate-50 p-2">
                <p className="text-[11px] font-bold text-slate-500">الجلسات</p>
                <p className="text-xs font-bold text-navy-900">{selected.summary.sessions}</p>
                <p className="text-xs text-slate-600">{selected.summary.lastStage ? ENDO_STAGE_LABEL[selected.summary.lastStage] : "—"}</p>
              </div>
              <div className="rounded-xl bg-slate-50 p-2" data-testid="endo-strip-status">
                <p className="text-[11px] font-bold text-slate-500">الحالة</p>
                <p className="text-xs font-bold text-navy-900">{ENDO_STATUS_LABEL[selected.status]} · {RESTORATIVE_LABEL[selected.restorativeStatus]}</p>
                <p className="text-xs text-slate-600" data-testid="endo-crown-state">{CROWN_STATE_LABEL[selected.crown]}</p>
                {selected.summary.prognosis ? <p className="text-xs text-slate-600">التنبؤ: {PROGNOSIS_LABEL[selected.summary.prognosis]}</p> : null}
              </div>
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-2" data-testid="endo-next">
                <p className="text-[11px] font-bold text-amber-800">الخطوة التالية</p>
                <p className="text-xs font-bold text-amber-900">{selected.nextAction}</p>
                {selected.summary.nextVisitWeeks !== null ? <p className="text-xs text-amber-800">بعد {selected.summary.nextVisitWeeks} أسبوع</p> : null}
              </div>
            </div>
          </section>

          {/* ── القنوات ── */}
          {selected.summary.canals.length > 0 ? (
            <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="القنوات">
              <h3 className="mb-2 text-sm font-black text-navy-900">القنوات والأطوال العاملة</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs" data-testid="endo-canals">
                  <thead><tr className="text-slate-500">
                    <th className="p-1 text-right">القناة</th><th className="p-1 text-right">الطول (مم)</th><th className="p-1 text-right">نقطة المرجع</th>
                    <th className="p-1 text-right">الطريقة</th><th className="p-1 text-right">المبرد</th><th className="p-1 text-right">الحشو</th>
                  </tr></thead>
                  <tbody>
                    {selected.summary.canals.map((canal) => (
                      <tr key={canal.label} className="border-t border-slate-100">
                        <td className="p-1 font-black text-navy-900">{canal.label}</td>
                        <td className="p-1" dir="ltr">{canal.workingLengthMm ?? "—"}</td>
                        <td className="p-1">{canal.referencePoint ? REFERENCE_POINT_LABEL[canal.referencePoint] : "—"}</td>
                        <td className="p-1">{canal.measurementMethod ? MEASUREMENT_METHOD_LABEL[canal.measurementMethod] : "—"}</td>
                        <td className="p-1" dir="ltr">{canal.masterApicalSize ? `${canal.masterApicalSize}${canal.taperPercent ? `/.${String(canal.taperPercent).padStart(2, "0")}` : ""}` : "—"}</td>
                        <td className="p-1">{canal.obturated ? "✓ محشوّة" : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {/* ── تسجيل جلسة اليوم ── */}
          {canWrite && selected.status === "in_progress" ? (
            <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="تسجيل الجلسة">
              {openVisitId === null ? (
                <p className="text-xs text-amber-800" data-testid="endo-no-visit">لا توجد زيارة مفتوحة لهذا المريض — ابدأ الزيارة من «زيارة اليوم» ثم سجّل الجلسة هنا.</p>
              ) : !form ? (
                <button type="button" data-testid="endo-record" onClick={() => startForm(selected)}
                  className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white">
                  {todayRecord && !todayRecord.signed ? "تعديل سجلّ جلسة اليوم" : "تسجيل جلسة اليوم"}
                </button>
              ) : (
                <div className="space-y-3" data-testid="endo-form">
                  <div className="grid gap-2 sm:grid-cols-3">
                    <label className={label}>مرحلة الجلسة
                      <Select value={form.stage} onChange={(value) => patch({ stage: value || "assessment" })} options={ENDO_STAGES.map((k) => [k, ENDO_STAGE_LABEL[k]] as [string, string])} testId="endo-stage" />
                    </label>
                    <label className={`${label} sm:col-span-2`}>الشكوى
                      <input value={form.chiefComplaint} onChange={(event) => patch({ chiefComplaint: event.target.value })} className={field} />
                    </label>
                  </div>
                  <fieldset className="rounded-xl border border-slate-100 p-2">
                    <legend className="px-1 text-xs font-black text-navy-900">التقييم</legend>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <label className={label}>التشخيص اللبّي
                        <Select value={form.pulpalDiagnosis} onChange={(value) => patch({ pulpalDiagnosis: value })} options={PULPAL_DIAGNOSES.map((k) => [k, PULPAL_LABEL[k]] as [string, string])} testId="endo-pulpal" /></label>
                      <label className={label}>التشخيص الذروي
                        <Select value={form.apicalDiagnosis} onChange={(value) => patch({ apicalDiagnosis: value })} options={APICAL_DIAGNOSES.map((k) => [k, APICAL_LABEL[k]] as [string, string])} testId="endo-apical" /></label>
                      <label className={label}>الأعراض
                        <input value={form.symptoms} onChange={(event) => patch({ symptoms: event.target.value })} className={field} /></label>
                      {([["vitalityCold", "اختبار البرودة"], ["vitalityHeat", "اختبار الحرارة"], ["vitalityEpt", "الاختبار الكهربائي"]] as const).map(([key, text]) => (
                        <label key={key} className={label}>{text}
                          <Select value={form[key]} onChange={(value) => patch({ [key]: value })} options={VITALITY_RESULTS.map((k) => [k, VITALITY_LABEL[k]] as [string, string])} /></label>
                      ))}
                      <label className={label}>القرع
                        <Select value={form.percussion} onChange={(value) => patch({ percussion: value })} options={TENDERNESS_RESULTS.map((k) => [k, TENDERNESS_LABEL[k]] as [string, string])} /></label>
                      <label className={label}>الجسّ
                        <Select value={form.palpation} onChange={(value) => patch({ palpation: value })} options={TENDERNESS_RESULTS.map((k) => [k, TENDERNESS_LABEL[k]] as [string, string])} /></label>
                      <label className={label}>درجة الحركة (٠–٣)
                        <input value={form.mobilityGrade} onChange={(event) => patch({ mobilityGrade: event.target.value })} inputMode="numeric" className={field} /></label>
                      <label className={`${label} sm:col-span-3`}>اللثة / النسج الداعمة
                        <input value={form.perioFindings} onChange={(event) => patch({ perioFindings: event.target.value })} className={field} /></label>
                      <label className={`${label} sm:col-span-3`}>علاج سابق / إعادة علاج
                        <input value={form.previousTreatment} onChange={(event) => patch({ previousTreatment: event.target.value })} className={field} /></label>
                      <label className={`${label} sm:col-span-3`}>الموجودات الشعاعية
                        <textarea value={form.radiographicFindings} onChange={(event) => patch({ radiographicFindings: event.target.value })} rows={2} className={field} /></label>
                    </div>
                  </fieldset>

                  <fieldset className="rounded-xl border border-slate-100 p-2">
                    <legend className="px-1 text-xs font-black text-navy-900">القنوات والأطوال العاملة</legend>
                    <div className="mb-2 flex flex-wrap items-end gap-2">
                      <label className={label}>عدد القنوات
                        <input value={form.canalsFound} onChange={(event) => patch({ canalsFound: event.target.value })} inputMode="numeric" className={`${field} w-20`} /></label>
                      <button type="button" onClick={() => patch({ canals: [...form.canals, emptyCanal("")] })}
                        className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-bold text-slate-700">+ قناة</button>
                    </div>
                    <div className="space-y-2" data-testid="endo-canal-rows">
                      {form.canals.map((canal, index) => {
                        const last = selected.summary.canals.find((c) => c.label === canal.label.trim().toUpperCase());
                        return (
                          <div key={index} className="grid gap-1.5 rounded-lg bg-slate-50 p-2 sm:grid-cols-7">
                            <label className={label}>القناة
                              <input value={canal.label} onChange={(event) => patchCanal(index, { label: event.target.value })} dir="ltr" className={field} data-testid={`endo-canal-label-${index}`} /></label>
                            <label className={label}>الطول مم{last?.workingLengthMm != null ? <span className="font-normal text-slate-400"> (آخر {last.workingLengthMm})</span> : null}
                              <input value={canal.workingLengthMm} onChange={(event) => patchCanal(index, { workingLengthMm: event.target.value })} inputMode="decimal" dir="ltr" className={field} data-testid={`endo-canal-wl-${index}`} /></label>
                            <label className={label}>نقطة المرجع
                              <Select value={canal.referencePoint} onChange={(value) => patchCanal(index, { referencePoint: value })} options={REFERENCE_POINTS.map((k) => [k, REFERENCE_POINT_LABEL[k]] as [string, string])} testId={`endo-canal-ref-${index}`} /></label>
                            <label className={label}>الطريقة
                              <Select value={canal.measurementMethod} onChange={(value) => patchCanal(index, { measurementMethod: value })} options={MEASUREMENT_METHODS.map((k) => [k, MEASUREMENT_METHOD_LABEL[k]] as [string, string])} testId={`endo-canal-method-${index}`} /></label>
                            <label className={label}>مقاس المبرد
                              <input value={canal.masterApicalSize} onChange={(event) => patchCanal(index, { masterApicalSize: event.target.value })} inputMode="numeric" dir="ltr" className={field} /></label>
                            <label className={label}>الاستدقاق ٪
                              <input value={canal.taperPercent} onChange={(event) => patchCanal(index, { taperPercent: event.target.value })} inputMode="numeric" dir="ltr" className={field} /></label>
                            <div className="flex items-end justify-between gap-1">
                              <label className="flex items-center gap-1 text-xs font-bold text-slate-600">
                                <input type="checkbox" checked={canal.obturated} onChange={(event) => patchCanal(index, { obturated: event.target.checked })} data-testid={`endo-canal-obt-${index}`} /> محشوّة</label>
                              <button type="button" aria-label="حذف القناة" onClick={() => patch({ canals: form.canals.filter((_, i) => i !== index) })}
                                className="rounded-lg border border-rose-200 px-1.5 py-0.5 text-xs text-rose-700">×</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </fieldset>

                  <fieldset className="rounded-xl border border-slate-100 p-2">
                    <legend className="px-1 text-xs font-black text-navy-900">الجلسة</legend>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <label className={label}>التحضير / الأدوات
                        <input value={form.instrumentation} onChange={(event) => patch({ instrumentation: event.target.value })} className={field} /></label>
                      <label className={label}>الغسول
                        <input value={form.irrigation} onChange={(event) => patch({ irrigation: event.target.value })} className={field} /></label>
                      <label className={label}>الدواء داخل القناة
                        <input value={form.medicament} onChange={(event) => patch({ medicament: event.target.value })} className={field} /></label>
                      <label className={label}>تقنية الحشو
                        <input value={form.obturationTechnique} onChange={(event) => patch({ obturationTechnique: event.target.value })} className={field} /></label>
                      <label className={label}>مادة الحشو
                        <input value={form.obturationMaterial} onChange={(event) => patch({ obturationMaterial: event.target.value })} className={field} /></label>
                      <label className={label}>الترميم بعد الجلسة
                        <Select value={form.restorationAfter} onChange={(value) => patch({ restorationAfter: value })} options={RESTORATIVE_STATUSES.map((k) => [k, RESTORATIVE_LABEL[k]] as [string, string])} testId="endo-restoration" /></label>
                      <label className={`${label} sm:col-span-3`}>المضاعفات
                        <input value={form.complications} onChange={(event) => patch({ complications: event.target.value })} className={field} /></label>
                      <label className={label}>التنبؤ
                        <Select value={form.prognosis} onChange={(value) => patch({ prognosis: value })} options={PROGNOSES.map((k) => [k, PROGNOSIS_LABEL[k]] as [string, string])} /></label>
                      <label className={label}>الخطوة التالية
                        <input value={form.nextStep} onChange={(event) => patch({ nextStep: event.target.value })} className={field} data-testid="endo-next-step" /></label>
                      <label className={label}>الجلسة التالية بعد (أسابيع)
                        <input value={form.nextVisitWeeks} onChange={(event) => patch({ nextVisitWeeks: event.target.value })} inputMode="numeric" className={field} /></label>
                      <label className={`${label} sm:col-span-3`}>ملاحظة
                        <input value={form.note} onChange={(event) => patch({ note: event.target.value })} className={field} /></label>
                    </div>
                  </fieldset>
                  <div className="flex gap-2">
                    <button type="button" data-testid="endo-save" disabled={busy}
                      onClick={async () => {
                        const saved = await send(`/api/patients/${patientId}/endo/${selected.id}/visits`, "PUT", payloadFrom(form, openVisitId, editingVersion));
                        if (saved) { setForm(null); setNotice("حُفظ سجلّ الجلسة."); }
                      }}
                      className="rounded-lg bg-navy-900 px-4 py-1.5 text-xs font-bold text-white disabled:opacity-40">حفظ الجلسة</button>
                    <button type="button" onClick={() => setForm(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600">إلغاء</button>
                  </div>
                </div>
              )}
            </section>
          ) : null}

          {/* ── الجلسات ── */}
          <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="جلسات علاج الجذور">
            <h3 className="mb-2 text-sm font-black text-navy-900">الجلسات</h3>
            {selected.visits.length === 0 ? <p className="text-xs text-slate-500">لا جلسات مسجَّلة بعد.</p> : (
              <ol className="space-y-2" data-testid="endo-sessions">
                {[...selected.visits].reverse().map((visit) => (
                  <li key={visit.id} className="rounded-xl border border-slate-200 p-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <span className="font-black text-navy-900">{ENDO_STAGE_LABEL[visit.stage]} · زيارة #{visit.visitId}</span>
                      <span className="text-slate-500">
                        {visit.doctorName ?? "—"} · {new Date(visit.recordedAt).toLocaleDateString("ar-YE-u-nu-latn")}
                        <span className={`mr-1 rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${visit.signed ? "border-sky-200 bg-sky-50 text-sky-800" : "border-amber-200 bg-amber-50 text-amber-800"}`}>
                          {visit.signed ? "موقَّعة" : "مفتوحة"}
                        </span>
                      </span>
                    </div>
                    <dl className="mt-1 grid gap-x-3 gap-y-0.5 sm:grid-cols-2">
                      {visit.chiefComplaint ? <div><dt className="inline font-bold text-slate-500">الشكوى: </dt><dd className="inline">{visit.chiefComplaint}</dd></div> : null}
                      {visit.pulpalDiagnosis ? <div><dt className="inline font-bold text-slate-500">لبّي: </dt><dd className="inline">{PULPAL_LABEL[visit.pulpalDiagnosis]}</dd></div> : null}
                      {visit.apicalDiagnosis ? <div><dt className="inline font-bold text-slate-500">ذروي: </dt><dd className="inline">{APICAL_LABEL[visit.apicalDiagnosis]}</dd></div> : null}
                      {visit.irrigation ? <div><dt className="inline font-bold text-slate-500">الغسول: </dt><dd className="inline">{visit.irrigation}</dd></div> : null}
                      {visit.medicament ? <div><dt className="inline font-bold text-slate-500">الدواء: </dt><dd className="inline">{visit.medicament}</dd></div> : null}
                      {visit.obturationMaterial || visit.obturationTechnique ? <div><dt className="inline font-bold text-slate-500">الحشو: </dt><dd className="inline">{[visit.obturationTechnique, visit.obturationMaterial].filter(Boolean).join(" — ")}</dd></div> : null}
                      {visit.complications ? <div className="text-rose-700"><dt className="inline font-bold">مضاعفات: </dt><dd className="inline">{visit.complications}</dd></div> : null}
                      {visit.nextStep ? <div><dt className="inline font-bold text-slate-500">التالي: </dt><dd className="inline">{visit.nextStep}</dd></div> : null}
                    </dl>
                    {visit.canals.length > 0 ? (
                      <p className="mt-1 text-slate-600" dir="ltr">{visit.canals.map((c) => `${c.label}${c.workingLengthMm !== null ? ` ${c.workingLengthMm}` : ""}${c.obturated ? " ✓" : ""}`).join(" · ")}</p>
                    ) : null}
                    {visit.addenda.map((entry) => (
                      <p key={entry.id} className="mt-1 rounded-lg bg-amber-50 px-2 py-1 text-amber-900" data-testid="endo-addendum">
                        — ملحق ({entry.author} · {entry.createdAt.slice(0, 16).replace("T", " ")}): {entry.body}
                      </p>
                    ))}
                    {canWrite && visit.signed ? (
                      addendum?.endoVisitId === visit.id ? (
                        <div className="mt-2 space-y-1">
                          <textarea value={addendum.text} onChange={(event) => setAddendum({ endoVisitId: visit.id, text: event.target.value })} rows={2}
                            placeholder="نص الملحق (التصحيح يُضاف ولا يمحو الأصل)" className="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs" data-testid="endo-addendum-text" />
                          <div className="flex gap-2">
                            <button type="button" disabled={busy || !addendum.text.trim()} data-testid="endo-addendum-save"
                              onClick={async () => { if (await send(`/api/patients/${patientId}/endo/${selected.id}/visits/${visit.id}/addenda`, "POST", { text: addendum.text })) setAddendum(null); }}
                              className="rounded-lg bg-navy-900 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40">حفظ الملحق</button>
                            <button type="button" onClick={() => setAddendum(null)} className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600">رجوع</button>
                          </div>
                        </div>
                      ) : (
                        <button type="button" data-testid={`endo-addendum-open-${visit.id}`} onClick={() => setAddendum({ endoVisitId: visit.id, text: "" })}
                          className="mt-2 rounded-lg border border-slate-200 px-2 py-0.5 text-[11px] font-bold text-slate-600">+ ملحق</button>
                      )
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* ── التاج والإكمال ── */}
          {canWrite && selected.status !== "abandoned" ? (
            <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="التاج والإكمال">
              <h3 className="mb-2 text-sm font-black text-navy-900">الترميم بعد علاج الجذور</h3>
              <div className="flex flex-wrap items-end gap-2">
                <label className={label}>هل السنّ يحتاج تاجًا؟
                  <select value={selected.crownRequired === null ? "" : selected.crownRequired ? "yes" : "no"} className={field} data-testid="endo-crown-required"
                    onChange={async (event) => {
                      if (!event.target.value) return;
                      await send(`/api/patients/${patientId}/endo/${selected.id}/crown`, "PATCH", { crownRequired: event.target.value === "yes" });
                    }}>
                    <option value="">— لم يُقرَّر —</option>
                    <option value="yes">نعم</option>
                    <option value="no">لا</option>
                  </select>
                </label>
                {selected.crownRequired && crownCandidates.length > 0 ? (
                  <label className={label}>بند التاج في الخطة
                    <select value={selected.crownPlanItem?.id ?? ""} className={field} data-testid="endo-crown-item"
                      onChange={async (event) => {
                        if (!event.target.value) return;
                        const rct = crownCandidates.find((item) => item.category === "rct" || item.category === "endo");
                        await send(`/api/patients/${patientId}/endo/${selected.id}/crown`, "PATCH", {
                          crownRequired: true, crownPlanItemId: Number(event.target.value), rctPlanItemId: rct?.id ?? null,
                        });
                      }}>
                      <option value="">— اختر —</option>
                      {crownCandidates.map((item) => <option key={item.id} value={item.id}>{item.serviceName} ({item.planTitle})</option>)}
                    </select>
                  </label>
                ) : null}
                {selected.crownPlanItem ? <p className="text-xs text-slate-600">مرتبط ببند: {selected.crownPlanItem.name}</p> : null}
              </div>

              {selected.status === "in_progress" ? (
                <div className="mt-3 border-t border-slate-100 pt-2">
                  {closing ? (
                    <div className="space-y-1">
                      <textarea value={closing.outcome} onChange={(event) => setClosing({ ...closing, outcome: event.target.value })} rows={2}
                        placeholder={closing.status === "abandoned" ? "سبب الإيقاف (مطلوب)" : "ملاحظة الإكمال (اختياري)"}
                        className="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs" />
                      <div className="flex gap-2">
                        <button type="button" disabled={busy || (closing.status === "abandoned" && !closing.outcome.trim())} data-testid="endo-close-confirm"
                          onClick={async () => { if (await send(`/api/patients/${patientId}/endo/${selected.id}`, "PATCH", { status: closing.status, outcome: closing.outcome || null })) setClosing(null); }}
                          className="rounded-lg bg-navy-900 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40">تأكيد: {ENDO_STATUS_LABEL[closing.status]}</button>
                        <button type="button" onClick={() => setClosing(null)} className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600">رجوع</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button type="button" data-testid="endo-complete" onClick={() => setClosing({ status: "completed", outcome: "" })}
                        className="rounded-lg border border-sky-200 px-2.5 py-1 text-[11px] font-bold text-sky-800">إكمال علاج الجذور</button>
                      <button type="button" onClick={() => setClosing({ status: "abandoned", outcome: "" })}
                        className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600">إيقاف العلاج</button>
                    </div>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
