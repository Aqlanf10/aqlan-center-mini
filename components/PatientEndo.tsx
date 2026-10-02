"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  APICAL_DIAGNOSES, APICAL_LABEL, CROWN_STATE_LABEL, ENDO_KIND_LABEL, ENDO_STAGES, ENDO_STAGE_LABEL, ENDO_STATUS_LABEL,
  MEASUREMENT_METHODS, MEASUREMENT_METHOD_LABEL, PROGNOSES, PROGNOSIS_LABEL, PULPAL_DIAGNOSES, PULPAL_LABEL,
  REFERENCE_POINTS, REFERENCE_POINT_LABEL, RESTORATIVE_LABEL, RESTORATIVE_STATUSES, TENDERNESS_LABEL,
  TENDERNESS_RESULTS, VITALITY_LABEL, VITALITY_RESULTS, expectedCanals,
} from "@/lib/endodontics";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { ALL_TEETH, toothName } from "@/lib/dental";
import type { EndoTreatmentView, EndoVisitView } from "@/lib/endodontics-db";
import type { CasePlanItem, SpecialtyCase } from "@/lib/db";

/**
 * A focused clinical-note composer with adjacent tooth reference, adapted from documented
 * Open Dental procedure-entry and Dentrix Ascend clinical-note workflows. See docs/ENDODONTICS.md.
 * Stage selection changes presentation only; hidden clinical values remain in the same draft.
 * Clinical save, visit signature, planned work and financial posting remain separate canonical actions.
 */

interface CanalRowState {
  label: string; workingLengthMm: string; referencePoint: string; measurementMethod: string;
  masterApicalSize: string; taperPercent: string; instrumentation: string; obturated: boolean; note: string;
}

const emptyCanal = (label: string): CanalRowState => ({
  label, workingLengthMm: "", referencePoint: "", measurementMethod: "", masterApicalSize: "", taperPercent: "", instrumentation: "",
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
      taperPercent: str(canal.taperPercent), instrumentation: str(canal.instrumentation), obturated: canal.obturated, note: str(canal.note),
    })),
  };
}

const orNull = (value: string) => (value.trim() === "" ? null : value);
const numOrNull = (value: string) => {
  if (value.trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("أدخل رقمًا صالحًا في الحقول العددية قبل الحفظ.");
  return number;
};

function payloadFrom(form: FormState, visitId: number, expectedVersion: number | null) {
  const canals = form.canals.filter((canal) => {
    if (canal.label.trim() !== "") return true;
    if (canal.obturated || [canal.workingLengthMm, canal.referencePoint, canal.measurementMethod, canal.masterApicalSize,
      canal.taperPercent, canal.instrumentation, canal.note].some((value) => value.trim() !== "")) {
      throw new Error("اكتب اسم القناة التي تحمل قياسًا أو ملاحظة قبل الحفظ.");
    }
    return false;
  });
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
    canals: canals.map((canal) => ({
      label: canal.label, workingLengthMm: numOrNull(canal.workingLengthMm), referencePoint: orNull(canal.referencePoint),
      measurementMethod: orNull(canal.measurementMethod), masterApicalSize: numOrNull(canal.masterApicalSize),
      taperPercent: numOrNull(canal.taperPercent), instrumentation: orNull(canal.instrumentation), obturated: canal.obturated, note: orNull(canal.note),
    })),
  };
}

function recordDetails(visit: EndoVisitView): [string, string | number | null][] {
  return [
    ["الأعراض", visit.symptoms], ["البرودة", visit.vitalityCold ? VITALITY_LABEL[visit.vitalityCold] : null],
    ["الحرارة", visit.vitalityHeat ? VITALITY_LABEL[visit.vitalityHeat] : null],
    ["الكهربائي", visit.vitalityEpt ? VITALITY_LABEL[visit.vitalityEpt] : null],
    ["القرع", visit.percussion ? TENDERNESS_LABEL[visit.percussion] : null],
    ["الجس", visit.palpation ? TENDERNESS_LABEL[visit.palpation] : null],
    ["الحركة", visit.mobilityGrade], ["اللثة", visit.perioFindings], ["علاج سابق", visit.previousTreatment],
    ["الموجودات الشعاعية", visit.radiographicFindings], ["عدد القنوات", visit.canalsFound],
    ["التحضير والأدوات", visit.instrumentation], ["الترميم", visit.restorationAfter ? RESTORATIVE_LABEL[visit.restorationAfter] : null],
    ["التنبؤ", visit.prognosis ? PROGNOSIS_LABEL[visit.prognosis] : null], ["المراجعة بعد أسابيع", visit.nextVisitWeeks], ["ملاحظة", visit.note],
  ];
}

function draftPreview(form: FormState): string {
  const names: Record<Exclude<keyof FormState, "canals">, string> = {
    stage: "المرحلة", chiefComplaint: "الشكوى", symptoms: "الأعراض", pulpalDiagnosis: "التشخيص اللبّي", apicalDiagnosis: "التشخيص الذروي",
    vitalityCold: "البرودة", vitalityHeat: "الحرارة", vitalityEpt: "الكهربائي", percussion: "القرع", palpation: "الجس",
    mobilityGrade: "الحركة", perioFindings: "اللثة", previousTreatment: "العلاج السابق", radiographicFindings: "الموجودات الشعاعية",
    canalsFound: "عدد القنوات", instrumentation: "التحضير والأدوات", irrigation: "الغسول", medicament: "الدواء",
    obturationTechnique: "تقنية الحشو", obturationMaterial: "مادة الحشو", restorationAfter: "الترميم", complications: "المضاعفات",
    prognosis: "التنبؤ", nextStep: "الخطوة التالية", nextVisitWeeks: "المراجعة بعد أسابيع", note: "ملاحظة",
  };
  const vocabulary: Record<string, string> = { ...ENDO_STAGE_LABEL, ...PULPAL_LABEL, ...APICAL_LABEL, ...VITALITY_LABEL,
    ...TENDERNESS_LABEL, ...RESTORATIVE_LABEL, ...PROGNOSIS_LABEL, ...REFERENCE_POINT_LABEL, ...MEASUREMENT_METHOD_LABEL };
  const fields = Object.entries(names).flatMap(([key, name]) => {
    const value = form[key as Exclude<keyof FormState, "canals">];
    return value ? [`${name}: ${vocabulary[value] ?? value}`] : [];
  });
  return [...fields, ...form.canals.map((canal) => [
    `القناة: ${canal.label || "بدون اسم"}`, canal.workingLengthMm ? `الطول: ${canal.workingLengthMm}` : "",
    canal.referencePoint ? `المرجع: ${vocabulary[canal.referencePoint] ?? canal.referencePoint}` : "",
    canal.measurementMethod ? `الطريقة: ${vocabulary[canal.measurementMethod] ?? canal.measurementMethod}` : "",
    canal.masterApicalSize ? `مقاس المبرد: ${canal.masterApicalSize}` : "", canal.taperPercent ? `الاستدقاق: ${canal.taperPercent}` : "",
    canal.instrumentation, canal.obturated ? "محشوّة" : "", canal.note,
  ].filter(Boolean).join(" · "))].join("\n");
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

type ClinicalField = Exclude<keyof FormState, "canals" | "stage">;
const FORM_FIELDS: Record<ClinicalField, { name: string; options?: readonly [string, string][]; mode?: "numeric"; rows?: number; testId?: string }> = {
  chiefComplaint: { name: "الشكوى", testId: "endo-complaint" }, symptoms: { name: "الأعراض" },
  pulpalDiagnosis: { name: "التشخيص اللبّي", options: PULPAL_DIAGNOSES.map((key) => [key, PULPAL_LABEL[key]]), testId: "endo-pulpal" },
  apicalDiagnosis: { name: "التشخيص الذروي", options: APICAL_DIAGNOSES.map((key) => [key, APICAL_LABEL[key]]), testId: "endo-apical" },
  vitalityCold: { name: "اختبار البرودة", options: VITALITY_RESULTS.map((key) => [key, VITALITY_LABEL[key]]) },
  vitalityHeat: { name: "اختبار الحرارة", options: VITALITY_RESULTS.map((key) => [key, VITALITY_LABEL[key]]) },
  vitalityEpt: { name: "الاختبار الكهربائي", options: VITALITY_RESULTS.map((key) => [key, VITALITY_LABEL[key]]) },
  percussion: { name: "القرع", options: TENDERNESS_RESULTS.map((key) => [key, TENDERNESS_LABEL[key]]) },
  palpation: { name: "الجسّ", options: TENDERNESS_RESULTS.map((key) => [key, TENDERNESS_LABEL[key]]) },
  mobilityGrade: { name: "درجة الحركة (٠–٣)", mode: "numeric" }, perioFindings: { name: "اللثة / النسج الداعمة" },
  previousTreatment: { name: "علاج سابق / إعادة علاج" }, radiographicFindings: { name: "الموجودات الشعاعية", rows: 2 },
  canalsFound: { name: "عدد القنوات", mode: "numeric" }, instrumentation: { name: "التحضير / الأدوات" },
  irrigation: { name: "الغسول" }, medicament: { name: "الدواء داخل القناة" },
  obturationTechnique: { name: "تقنية الحشو" }, obturationMaterial: { name: "مادة الحشو" },
  restorationAfter: { name: "الترميم بعد الجلسة", options: RESTORATIVE_STATUSES.map((key) => [key, RESTORATIVE_LABEL[key]]), testId: "endo-restoration" },
  complications: { name: "المضاعفات" }, prognosis: { name: "التنبؤ", options: PROGNOSES.map((key) => [key, PROGNOSIS_LABEL[key]]) },
  nextStep: { name: "الخطوة التالية", testId: "endo-next-step" }, nextVisitWeeks: { name: "الجلسة التالية بعد (أسابيع)", mode: "numeric" },
  note: { name: "ما تمّ في الجلسة", rows: 2, testId: "endo-note" },
};
const STAGE_FIELDS: Record<string, ClinicalField[]> = {
  assessment: ["chiefComplaint", "pulpalDiagnosis", "apicalDiagnosis"], access_cleaning: ["instrumentation", "irrigation"],
  shaping: ["instrumentation", "irrigation"], medicament: ["medicament", "irrigation"],
  obturation: ["obturationTechnique", "obturationMaterial", "restorationAfter"], review: ["symptoms", "restorationAfter"], other: [],
};
const ASSESSMENT_FIELDS: ClinicalField[] = ["chiefComplaint", "pulpalDiagnosis", "apicalDiagnosis", "symptoms", "vitalityCold", "vitalityHeat", "vitalityEpt", "percussion", "palpation", "mobilityGrade", "perioFindings", "previousTreatment", "radiographicFindings"];
const SESSION_FIELDS: ClinicalField[] = ["instrumentation", "irrigation", "medicament", "obturationTechnique", "obturationMaterial", "restorationAfter", "complications", "prognosis", "nextVisitWeeks"];

class EndoRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

interface PatientEndoProps {
  patientId: number; authorityKey?: string; canWrite: boolean; canEditPlans?: boolean; openVisitId: number | null;
  onDraftChange?: (pending: boolean) => void;
  onNavigationGuardChange?: (guard: (() => boolean) | null) => void;
  onOpenToday?: () => void; onOpenPlans?: () => void; onOpenAccount?: () => void;
}

export function PatientEndo(props: PatientEndoProps) {
  // A patient/authority change never reuses another context's data or draft, even before effects run.
  return <PatientEndoWorkspace key={`${props.patientId}:${props.authorityKey ?? ""}:${props.canWrite}:${props.canEditPlans}`} {...props} />;
}

function PatientEndoWorkspace({ patientId, canWrite, canEditPlans = false, openVisitId, onDraftChange, onNavigationGuardChange, onOpenToday, onOpenPlans, onOpenAccount }: PatientEndoProps) {
  const [treatments, setTreatments] = useState<EndoTreatmentView[] | null>(null);
  const [cases, setCases] = useState<SpecialtyCase[]>([]);
  const [planItems, setPlanItems] = useState<CasePlanItem[]>([]);
  const [planVisible, setPlanVisible] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openForm, setOpenForm] = useState<{ toothCode: string; caseId: string; kind: string } | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
  const [addendum, setAddendum] = useState<{ endoVisitId: number; treatmentId: number; text: string; requestKey: string; submitted: boolean } | null>(null);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const [formTreatmentId, setFormTreatmentId] = useState<number | null>(null);
  const [formVisitId, setFormVisitId] = useState<number | null>(null);
  const [caseUnavailable, setCaseUnavailable] = useState(false);
  const [caseCreationUncertain, setCaseCreationUncertain] = useState(false);
  const [crownLink, setCrownLink] = useState({ crown: "", rct: "" });
  const [closing, setClosing] = useState<{ treatmentId: number; status: "completed" | "abandoned"; outcome: string } | null>(null);

  const pendingDraft = form !== null || addendum !== null || closing !== null || openForm !== null || Boolean(crownLink.crown || crownLink.rct) || busy;
  useEffect(() => { onDraftChange?.(pendingDraft); return () => onDraftChange?.(false); }, [pendingDraft, onDraftChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (pendingDraft) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pendingDraft]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);

  const load = useCallback(async () => {
    const ticket = ++generation.current;
    const current = () => mounted.current && generation.current === ticket;
    try {
      const [endoResponse, caseResponse] = await Promise.all([
        fetch(`/api/patients/${patientId}/endo`, { cache: "no-store" }),
        fetch(`/api/patients/${patientId}/cases`, { cache: "no-store" }),
      ]);
      const [endoPayload, casePayload] = await Promise.all([
        endoResponse.json().catch(() => null), caseResponse.json().catch(() => null),
      ]);
      if (!current()) return;
      if (!endoResponse.ok || !Array.isArray(endoPayload?.treatments)) {
        setTreatments(null); setCases([]); setPlanItems([]); setPlanVisible(false);
        setError(endoPayload?.message ?? "تعذّر تحميل علاج الجذور.");
        return;
      }
      setTreatments(endoPayload.treatments);
      // Choose once. A refresh must not move a draft to a newer/fallback episode.
      setSelectedId((current) => current ?? endoPayload.treatments.find((one: EndoTreatmentView) => one.status === "in_progress")?.id ?? endoPayload.treatments[0]?.id ?? null);
      const casesOk = caseResponse.ok && Array.isArray(casePayload?.cases);
      setCaseUnavailable(!casesOk);
      setError(casesOk ? null : casePayload?.message ?? "تعذّر تحميل الحالات. أعد التحميل قبل فتح علاج أو ربط الخطة.");
      setCases(casesOk ? casePayload.cases.filter((one: SpecialtyCase) => one.specialty === "endodontics" && one.id !== null
        && (one.status === "active" || one.status === "waiting")) : []);
      setPlanVisible(casesOk && casePayload.planVisible === true);
      setPlanItems(casesOk && casePayload.planVisible === true ? casePayload.items ?? [] : []);
    } catch {
      if (current()) setError("تعذّر الاتصال بالخادم. أعد التحميل.");
    }
  }, [patientId]);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => {
    if (!treatments?.length) return null;
    if (selectedId !== null) return treatments.find((one) => one.id === selectedId) ?? null;
    return treatments.find((one) => one.status === "in_progress") ?? treatments[0];
  }, [treatments, selectedId]);

  const request = async (url: string, method: "POST" | "PUT" | "PATCH", body: unknown) => {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload.id !== "number") {
      throw new EndoRequestError(payload?.message ?? "تعذّر الحفظ. أعد المحاولة.", response.status);
    }
    return payload;
  };
  // Lock synchronously, including case creation. A disabled button alone does not contain repeated events.
  const mutate = async (work: () => Promise<EndoTreatmentView>): Promise<EndoTreatmentView | null> => {
    if (busyRef.current || !canWrite) return null;
    busyRef.current = true;
    const ticket = ++generation.current;
    setBusy(true); setError(null); setNotice(null);
    try {
      const payload = await work();
      if (!mounted.current || generation.current !== ticket) return null;
      setTreatments((current) => {
        const list = current ?? [];
        return list.some((one) => one.id === payload.id) ? list.map((one) => (one.id === payload.id ? payload : one)) : [payload, ...list];
      });
      setSelectedId(payload.id);
      return payload;
    } catch (failure) {
      if (mounted.current && generation.current === ticket) {
        if (failure instanceof EndoRequestError && (failure.status === 401 || failure.status === 403)) {
          setTreatments(null); setCases([]); setPlanItems([]); setPlanVisible(false);
        }
        setError(failure instanceof TypeError ? "تعذّر الاتصال بالخادم. أعد المحاولة." : failure instanceof Error ? failure.message : "تعذّر الاتصال بالخادم.");
      }
      return null;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const send = (url: string, method: "POST" | "PUT" | "PATCH", body: unknown) => mutate(() => request(url, method, body));
  const discard = useCallback(() => !busyRef.current && (!pendingDraft || window.confirm("هناك عمل غير محفوظ. هل تريد تجاهله؟")), [pendingDraft]);
  useEffect(() => {
    onNavigationGuardChange?.(discard);
    return () => onNavigationGuardChange?.(null);
  }, [discard, onNavigationGuardChange]);

  const todayRecord = selected && openVisitId !== null ? selected.visits.find((visit) => visit.visitId === openVisitId) ?? null : null;

  const startForm = (treatment: EndoTreatmentView) => {
    if (!discard()) return;
    setOpenForm(null); setAddendum(null); setClosing(null); setCrownLink({ crown: "", rct: "" });
    setSelectedId(treatment.id);
    setFormTreatmentId(treatment.id);
    setFormVisitId(openVisitId);
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
    return <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
      <p role={error ? "alert" : undefined}>{error ?? "جارٍ التحميل…"}</p>
      {error ? <button type="button" onClick={() => void load()}>إعادة التحميل</button> : null}
    </div>;
  }

  const patch = (changes: Partial<FormState>) => setForm((current) => (current ? { ...current, ...changes } : current));
  const patchCanal = (index: number, changes: Partial<CanalRowState>) => setForm((current) => current
    ? { ...current, canals: current.canals.map((canal, i) => (i === index ? { ...canal, ...changes } : canal)) } : current);
  const toothOptions = ALL_TEETH.filter((code) => !treatments.some((one) => one.toothCode === code && one.status === "in_progress"));
  const crownCandidates = selected ? planItems.filter((item) => item.toothCode === selected.toothCode && item.category === "crown" && item.status !== "cancelled") : [];
  const rctCandidates = selected ? planItems.filter((item) => item.toothCode === selected.toothCode && item.caseId === selected.caseId && item.category === "rct" && item.status !== "cancelled") : [];

  const primaryFields = form ? STAGE_FIELDS[form.stage] ?? [] : [];
  const canalStage = form ? ["access_cleaning", "shaping", "obturation"].includes(form.stage) : false;
  const renderField = (key: ClinicalField) => {
    if (!form) return null;
    const definition = FORM_FIELDS[key];
    return <label key={key} className={label}>{definition.name}
      {definition.options ? <Select value={form[key]} onChange={(value) => patch({ [key]: value })} options={definition.options} testId={definition.testId ?? `endo-${key}`} />
        : definition.rows ? <textarea value={form[key]} onChange={(event) => patch({ [key]: event.target.value })} rows={definition.rows} className={field} data-testid={definition.testId ?? `endo-${key}`} />
        : <input value={form[key]} onChange={(event) => patch({ [key]: event.target.value })} inputMode={definition.mode} className={field} data-testid={definition.testId ?? `endo-${key}`} />}
    </label>;
  };
  const optionalCount = (keys: ClinicalField[]) => form ? keys.filter((key) => !primaryFields.includes(key) && form[key] !== "").length : 0;

  return (
    <fieldset disabled={busy} className="min-w-0 space-y-3" data-testid="patient-endo" dir="rtl">
      {error ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800" data-testid="endo-error">{error}
        <button type="button" className="mr-2 underline" onClick={() => void load()}>تحديث البيانات مع إبقاء المسودة</button>
      </p> : null}
      {notice ? <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800">{notice}</p> : null}

      {/* ── الأسنان ── */}
      <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="أسنان علاج الجذور">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-black text-navy-900">علاج الجذور</h3>
          {canWrite && !openForm && !caseUnavailable ? (
            <button type="button" data-testid="endo-new" onClick={() => { if (!discard()) return; setForm(null); setAddendum(null); setClosing(null); setCrownLink({ crown: "", rct: "" }); setOpenForm({ toothCode: "", caseId: "", kind: "initial" }); }}
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
                <option value="">— حالة جديدة —</option>
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
              <button type="button" data-testid="endo-open-save" disabled={busy || !openForm.toothCode || (caseCreationUncertain && !openForm.caseId)}
                onClick={async () => {
                  const opened = await mutate(async () => {
                    let caseId = openForm.caseId ? Number(openForm.caseId) : null;
                    if (caseId === null) {
                      if (caseCreationUncertain) throw new Error("اختر الحالة المحفوظة بعد إعادة التحميل قبل المحاولة مجددًا.");
                      let created: SpecialtyCase;
                      try {
                        created = await request(`/api/patients/${patientId}/cases`, "POST", {
                          specialty: "endodontics", title: `علاج جذور — سن ${openForm.toothCode}`, site: openForm.toothCode,
                        });
                      } catch (failure) {
                        setCaseCreationUncertain(!(failure instanceof EndoRequestError && failure.status >= 400 && failure.status < 500));
                        throw failure;
                      }
                      caseId = created.id!;
                      if (!mounted.current) throw new Error("أُغلقت الشاشة.");
                      setCases((current) => [...current.filter((one) => one.id !== created.id), created]);
                      setOpenForm((current) => current ? { ...current, caseId: String(caseId) } : current);
                    }
                    return request(`/api/patients/${patientId}/endo`, "POST", { toothCode: Number(openForm.toothCode), caseId, kind: openForm.kind });
                  });
                  if (opened) { setOpenForm(null); setForm(null); setCaseCreationUncertain(false); }
                }}
                className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40">فتح</button>
              <button type="button" onClick={() => { if (discard()) setOpenForm(null); }} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600">إلغاء</button>
            </div>
          </div>
        ) : null}

        {caseUnavailable || caseCreationUncertain ? <p role="alert" className="text-xs text-amber-800">
          تعذّر تأكيد الحالة. أعد تحميل الحالات واختر الحالة المحفوظة؛ لن تُنشأ حالة أخرى تلقائيًا. إن لم تظهر الحالة، تحقّق من تبويب الحالات وأعد التحميل حتى تتضح نتيجة الطلب.
          <button type="button" className="mr-2 underline" onClick={() => void load()}>إعادة التحميل</button>
        </p> : null}
        {treatments.length === 0 ? (
          <p className="text-xs text-slate-500">لا علاج جذور مسجَّل لهذا المريض.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {treatments.map((one) => (
              <li key={one.id}>
                <button type="button" data-testid={`endo-tooth-${one.toothCode}`} onClick={() => { if (one.id === selected?.id || !discard()) return; setSelectedId(one.id); setForm(null); setClosing(null); setAddendum(null); setCrownLink({ crown: "", rct: "" }); }}
                  className={`rounded-xl border px-3 py-2 text-right text-xs ${selected?.id === one.id ? "border-navy-900 bg-navy-50" : "border-slate-200 bg-white"}`}>
                  <span className="text-sm font-black text-navy-900">سنّ {one.toothCode}</span>
                  <span className={`mr-2 inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_TONE[one.status]}`}>{ENDO_STATUS_LABEL[one.status]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(form && (!selected || selected.id !== formTreatmentId || selected.status !== "in_progress"))
        || (closing && (!selected || selected.id !== closing.treatmentId || selected.status !== "in_progress"))
        || (addendum && selected?.id !== addendum.treatmentId) ? (
        <section role="alert" data-testid="endo-draft-unavailable" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
          بقيت المسودة مرتبطة بنوبة العلاج #{form ? formTreatmentId : closing?.treatmentId ?? addendum?.treatmentId}؛ النوبة غير متاحة للتعديل في السياق الحالي. لن تُنقل إلى سنّ أو نوبة أخرى.
          <label className="mt-2 block text-xs font-bold">نسخة المسودة المحفوظة في هذه الشاشة (للقراءة والنسخ)
            <textarea readOnly data-testid="endo-retained-draft" rows={8} className={field}
              value={form ? draftPreview(form) : closing ? `${ENDO_STATUS_LABEL[closing.status]}: ${closing.outcome}` : addendum?.text ?? ""} />
          </label>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void load()} className="underline">إعادة تحميل النوبة</button>
            <button type="button" data-testid="endo-discard-unavailable" onClick={() => { if (!discard()) return; setForm(null); setClosing(null); setAddendum(null); setCrownLink({ crown: "", rct: "" }); }} className="underline">تجاهل المسودة</button>
          </div>
        </section>
      ) : null}
      {selected ? (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="ملخص علاج الجذور" data-testid="endo-strip">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-black text-navy-900">سنّ {selected.toothCode} · {selected.toothName}</h3>
              <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${STATUS_TONE[selected.status]}`} data-testid="endo-strip-status">{ENDO_STATUS_LABEL[selected.status]} · {RESTORATIVE_LABEL[selected.restorativeStatus]}</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">{selected.caseTitle} · {ENDO_KIND_LABEL[selected.kind]} · {selected.summary.sessions} جلسات
              {openVisitId !== null ? ` · زيارة #${openVisitId}` : ""}{todayRecord?.doctorName ? ` · ${todayRecord.doctorName}` : ""}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
              <span data-testid="endo-strip-dx">{[selected.summary.pulpalDiagnosis ? PULPAL_LABEL[selected.summary.pulpalDiagnosis] : null,
                selected.summary.apicalDiagnosis ? APICAL_LABEL[selected.summary.apicalDiagnosis] : null].filter(Boolean).join(" · ") || "التشخيص لم يُسجّل"}</span>
              <span data-testid="endo-strip-wl" dir="ltr">{selected.summary.canals.map((canal) => `${canal.label} ${canal.workingLengthMm ?? "—"}`).join(" · ")}</span>
            </div>
            <p className="mt-2 text-xs font-bold text-amber-800" data-testid="endo-next">التالي: {selected.nextAction}</p>
          </section>

          {/* ── تسجيل جلسة اليوم ── */}
          {canWrite && selected.status === "in_progress" ? (
            <section className="rounded-2xl border border-slate-200 bg-white p-3" aria-label="تسجيل الجلسة">
              {openVisitId === null && !form ? (
                <p className="text-xs text-amber-800" data-testid="endo-no-visit">لا توجد زيارة مفتوحة لهذا المريض — ابدأ الزيارة من «زيارة اليوم» ثم سجّل الجلسة هنا.</p>
              ) : !form ? (
                <button type="button" data-testid="endo-record" onClick={() => startForm(selected)}
                  className="rounded-lg bg-navy-900 px-3 py-1.5 text-xs font-bold text-white">
                  {todayRecord && !todayRecord.signed ? "تعديل سجلّ جلسة اليوم" : "تسجيل جلسة اليوم"}
                </button>
              ) : (
                <div className="space-y-3" data-testid="endo-form">
                  {formVisitId !== openVisitId ? <p role="alert">تغيّرت الزيارة المفتوحة. بقيت المسودة لزيارة #{formVisitId}؛ راجع السياق قبل التسجيل.</p> : null}
                  <div className="grid gap-3 sm:grid-cols-3" data-testid="endo-primary-fields">
                    <label className={label}>عمل الجلسة
                      <Select value={form.stage} onChange={(value) => patch({ stage: value || "assessment" })} options={ENDO_STAGES.map((key) => [key, ENDO_STAGE_LABEL[key]] as [string, string])} testId="endo-stage" />
                    </label>
                    {primaryFields.map(renderField)}
                  </div>
                  <details key={`canals-${form.stage}`} open={canalStage} className="rounded-xl border border-slate-200 p-2" data-testid="endo-canal-editor">
                    <summary className="cursor-pointer text-xs font-bold text-navy-900">القنوات والقياسات · {form.canals.length} قنوات</summary>
                    <p className="mt-2 text-xs text-slate-500">الأسماء اقتراحات فقط؛ أدخل ما قسته اليوم. القياس السابق مرجع ولا يُنسخ إلى الجلسة.</p>
                    <div className="my-2 flex flex-wrap items-end gap-2">
                      {renderField("canalsFound")}
                      <button type="button" onClick={() => patch({ canals: [...form.canals, emptyCanal("")] })} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold">+ قناة</button>
                    </div>
                    <div className="space-y-2" data-testid="endo-canal-rows">
                      {form.canals.map((canal, index) => {
                        const last = selected.summary.canals.find((entry) => entry.label === canal.label.trim().toUpperCase());
                        return <div key={index} className="rounded-lg bg-slate-50 p-2">
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            <label className={label}>القناة<input value={canal.label} onChange={(event) => patchCanal(index, { label: event.target.value })} dir="ltr" className={field} data-testid={`endo-canal-label-${index}`} /></label>
                            <label className={label}>الطول مم{last?.workingLengthMm != null ? <span className="font-normal text-slate-500"> (آخر قياس مسجّل {last.workingLengthMm})</span> : null}
                              <input value={canal.workingLengthMm} onChange={(event) => patchCanal(index, { workingLengthMm: event.target.value })} inputMode="decimal" dir="ltr" className={field} data-testid={`endo-canal-wl-${index}`} /></label>
                            <label className={label}>نقطة المرجع<Select value={canal.referencePoint} onChange={(value) => patchCanal(index, { referencePoint: value })} options={REFERENCE_POINTS.map((key) => [key, REFERENCE_POINT_LABEL[key]] as [string, string])} testId={`endo-canal-ref-${index}`} /></label>
                            <label className={label}>الطريقة<Select value={canal.measurementMethod} onChange={(value) => patchCanal(index, { measurementMethod: value })} options={MEASUREMENT_METHODS.map((key) => [key, MEASUREMENT_METHOD_LABEL[key]] as [string, string])} testId={`endo-canal-method-${index}`} /></label>
                          </div>
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <label className="flex items-center gap-2 text-xs font-bold text-slate-600"><input type="checkbox" checked={canal.obturated} onChange={(event) => patchCanal(index, { obturated: event.target.checked })} data-testid={`endo-canal-obt-${index}`} /> سُجّل حشو هذه القناة اليوم</label>
                            <button type="button" aria-label="حذف القناة" onClick={() => patch({ canals: form.canals.filter((_, i) => i !== index) })} className="rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-700">حذف</button>
                          </div>
                          <details className="mt-2" data-testid={`endo-canal-more-${index}`}>
                            <summary className="cursor-pointer text-xs font-bold text-slate-600">تفاصيل التحضير والملاحظة{[canal.masterApicalSize, canal.taperPercent, canal.instrumentation, canal.note].some(Boolean) ? " · بيانات مسجّلة" : ""}</summary>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <label className={label}>مقاس المبرد<input value={canal.masterApicalSize} onChange={(event) => patchCanal(index, { masterApicalSize: event.target.value })} inputMode="numeric" dir="ltr" className={field} data-testid={`endo-canal-size-${index}`} /></label>
                              <label className={label}>الاستدقاق ٪<input value={canal.taperPercent} onChange={(event) => patchCanal(index, { taperPercent: event.target.value })} inputMode="numeric" dir="ltr" className={field} data-testid={`endo-canal-taper-${index}`} /></label>
                              <label className={label}>أدوات القناة<input value={canal.instrumentation} onChange={(event) => patchCanal(index, { instrumentation: event.target.value })} className={field} /></label>
                              <label className={label}>ملاحظة القناة<input value={canal.note} onChange={(event) => patchCanal(index, { note: event.target.value })} className={field} data-testid={`endo-canal-note-${index}`} /></label>
                            </div>
                          </details>
                        </div>;
                      })}
                    </div>
                  </details>
                  <div className="grid gap-2 sm:grid-cols-2" data-testid="endo-note-fields">{renderField("note")}{renderField("nextStep")}</div>
                  <div className="flex gap-2">
                    <button type="button" data-testid="endo-save" disabled={busy || formVisitId !== openVisitId || formTreatmentId !== selected.id || selected.status !== "in_progress"}
                      onClick={async () => {
                        if (formVisitId === null || formVisitId !== openVisitId || formTreatmentId === null || formTreatmentId !== selected.id || selected.status !== "in_progress") return;
                        const saved = await mutate(() => request(`/api/patients/${patientId}/endo/${formTreatmentId}/visits`, "PUT", payloadFrom(form, formVisitId, editingVersion)));
                        if (saved) { setForm(null); setNotice("حُفظ سجلّ الجلسة."); }
                      }}
                      className="rounded-lg bg-navy-900 px-4 py-1.5 text-xs font-bold text-white disabled:opacity-40">حفظ الجلسة</button>
                    <button type="button" onClick={() => { if (discard()) setForm(null); }} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600">إلغاء</button>
                  </div>
                  <p className="text-xs text-slate-500">الحفظ يوثّق الجلسة فقط. توقيع الزيارة وتسجيل الإجراءات المالية من «زيارة اليوم».</p>
                  <details key={`assessment-${form.stage}`} className="rounded-xl border border-slate-200 p-2" data-testid="endo-assessment-more">
                    <summary className="cursor-pointer text-xs font-bold text-slate-600">الفحص والتشخيص التفصيلي{optionalCount(ASSESSMENT_FIELDS) ? ` · ${optionalCount(ASSESSMENT_FIELDS)} حقول مسجّلة` : ""}</summary>
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">{ASSESSMENT_FIELDS.filter((key) => !primaryFields.includes(key)).map(renderField)}</div>
                  </details>
                  <details key={`session-${form.stage}`} className="rounded-xl border border-slate-200 p-2" data-testid="endo-session-more">
                    <summary className="cursor-pointer text-xs font-bold text-slate-600">تفاصيل الجلسة والمتابعة{optionalCount(SESSION_FIELDS) ? ` · ${optionalCount(SESSION_FIELDS)} حقول مسجّلة` : ""}</summary>
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">{SESSION_FIELDS.filter((key) => !primaryFields.includes(key)).map(renderField)}</div>
                  </details>
                </div>
              )}
            </section>
          ) : null}

          <section className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3 text-xs" aria-label="الخطة وزيارة اليوم" data-testid="endo-work-links">
            <div>
              <p className="font-bold text-slate-700">الإجراء والفوترة من الزيارة والخطة</p>
              {planVisible && !caseUnavailable ? <p className="mt-1 text-slate-500" data-testid="endo-plan-context">{rctCandidates.length === 0 ? "لا يوجد بند جذور مرتبط بهذه الحالة وهذا السنّ في الخطة." : rctCandidates.length === 1 ? `بند الخطة: ${rctCandidates[0].serviceName}` : `${rctCandidates.length} بنود جذور لهذا السنّ والحالة؛ اختر البند الصحيح داخل الزيارة.`}</p> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {onOpenToday ? <button type="button" onClick={onOpenToday} className="rounded-lg border border-navy-200 px-3 py-2 font-bold text-navy-900" data-testid="endo-open-today">إجراءات زيارة اليوم</button> : null}
              {planVisible && onOpenPlans ? <button type="button" onClick={onOpenPlans} className="rounded-lg border border-slate-200 px-3 py-2" data-testid="endo-open-plans">الخطة</button> : null}
              {onOpenAccount ? <button type="button" onClick={onOpenAccount} className="rounded-lg border border-slate-200 px-3 py-2" data-testid="endo-open-account">حساب المريض</button> : null}
            </div>
          </section>

          {/* ── القنوات ── */}
          {selected.summary.canals.length > 0 ? (
            <details className="rounded-2xl border border-slate-200 bg-white p-3" data-testid="endo-reference">
              <summary className="cursor-pointer text-sm font-bold text-navy-900">مرجع القنوات وآخر القياسات المسجّلة</summary>
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
            </details>
          ) : null}

          {/* ── الجلسات ── */}
          <details key={`history-${selected.id}`} open={Boolean(addendum)} className="rounded-2xl border border-slate-200 bg-white p-3" data-testid="endo-history">
            <summary className="cursor-pointer text-sm font-bold text-navy-900">السجل السابق والملاحق · {selected.visits.length} جلسات</summary>
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
                    <details className="mt-2" data-testid={`endo-record-details-${visit.id}`}>
                      <summary className="cursor-pointer font-bold text-navy-800">تفاصيل السجل المحفوظ</summary>
                      <dl className="mt-1 grid gap-1 sm:grid-cols-2">
                        {recordDetails(visit).filter(([, value]) => value !== null && value !== "").map(([name, value]) => (
                          <div key={name}><dt className="inline font-bold">{name}: </dt><dd className="inline">{value}</dd></div>
                        ))}
                      </dl>
                      {visit.canals.map((canal) => <p key={canal.label} className="mt-1">
                        <b dir="ltr">{canal.label}</b>: {canal.referencePoint ? REFERENCE_POINT_LABEL[canal.referencePoint] : "—"} · {canal.measurementMethod ? MEASUREMENT_METHOD_LABEL[canal.measurementMethod] : "—"}
                        {canal.masterApicalSize !== null ? ` · مقاس ${canal.masterApicalSize}` : ""}{canal.taperPercent !== null ? ` · استدقاق ${canal.taperPercent}%` : ""}
                        {canal.instrumentation ? ` · ${canal.instrumentation}` : ""}{canal.note ? ` · ${canal.note}` : ""}
                      </p>)}
                    </details>
                    {visit.addenda.map((entry) => (
                      <p key={entry.id} className="mt-1 rounded-lg bg-amber-50 px-2 py-1 text-amber-900" data-testid="endo-addendum">
                        — ملحق ({entry.author} · {entry.createdAt.slice(0, 16).replace("T", " ")}): {entry.body}
                      </p>
                    ))}
                    {canWrite && visit.signed ? (
                      addendum?.endoVisitId === visit.id ? (
                        <div className="mt-2 space-y-1">
                          <textarea disabled={addendum.submitted} value={addendum.text} onChange={(event) => setAddendum({ ...addendum, text: event.target.value })} rows={2}
                            placeholder="نص الملحق (التصحيح يُضاف ولا يمحو الأصل)" className="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs" data-testid="endo-addendum-text" />
                          <div className="flex gap-2">
                            <button type="button" disabled={busy || !addendum.text.trim()} data-testid="endo-addendum-save"
                              onClick={async () => {
                                if (addendum.treatmentId !== selected.id) return;
                                setAddendum({ ...addendum, submitted: true });
                                if (await send(`/api/patients/${patientId}/endo/${addendum.treatmentId}/visits/${addendum.endoVisitId}/addenda`, "POST", { text: addendum.text, requestKey: addendum.requestKey })) setAddendum(null);
                              }}
                              className="rounded-lg bg-navy-900 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40">حفظ الملحق</button>
                            <button type="button" onClick={() => { if (discard()) setAddendum(null); }} className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600">رجوع</button>
                          </div>
                        </div>
                      ) : (
                        <button type="button" data-testid={`endo-addendum-open-${visit.id}`} onClick={() => {
                          if (!discard()) return;
                          try { setSelectedId(selected.id); setAddendum({ endoVisitId: visit.id, treatmentId: selected.id, text: "", requestKey: newIdempotencyKey("endo-addendum"), submitted: false }); setForm(null); setClosing(null); setOpenForm(null); setCrownLink({ crown: "", rct: "" }); }
                          catch { setError("مولّد مفتاح الطلب الآمن غير متاح. أعد فتح الصفحة قبل كتابة الملحق."); }
                        }}
                          className="mt-2 rounded-lg border border-slate-200 px-2 py-0.5 text-[11px] font-bold text-slate-600">+ ملحق</button>
                      )
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </details>

          {/* ── التاج والإكمال ── */}
          {selected.status !== "abandoned" ? (
            <details key={`completion-${selected.id}`} open={Boolean(closing || crownLink.crown || crownLink.rct)} className="rounded-2xl border border-slate-200 bg-white p-3" data-testid="endo-completion">
              <summary className="cursor-pointer text-sm font-bold text-navy-900">التاج وإكمال العلاج</summary>
              <p className="my-2 text-xs text-slate-500" data-testid="endo-crown-state">{selected.crown === "ready" ? "علاج الجذور مكتمل سريريًا؛ تنفيذ التاج يتبع متطلبات الخطة" : CROWN_STATE_LABEL[selected.crown]}</p>
              {canWrite ? <div className="flex flex-wrap items-end gap-2">
                <label className={label}>هل السنّ يحتاج تاجًا؟
                  <select value={selected.crownRequired === null ? "" : selected.crownRequired ? "yes" : "no"} className={field} data-testid="endo-crown-required" disabled={Boolean(form || addendum || closing || openForm)}
                    onChange={async (event) => {
                      if (!event.target.value) return;
                      await send(`/api/patients/${patientId}/endo/${selected.id}/crown`, "PATCH", { crownRequired: event.target.value === "yes" });
                    }}>
                    <option value="">— لم يُقرَّر —</option>
                    <option value="yes">نعم</option>
                    <option value="no">لا</option>
                  </select>
                </label>
                {canEditPlans && planVisible && selected.crownRequired && !caseUnavailable ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <label className={label}>بند التاج في الخطة
                      <select value={crownLink.crown} className={field} data-testid="endo-crown-item" disabled={Boolean(form || addendum || closing || openForm)}
                        onChange={(event) => setCrownLink({ ...crownLink, crown: event.target.value })}>
                        <option value="">— اختر —</option>
                        {crownCandidates.map((item) => <option key={item.id} value={item.id}>{item.serviceName} ({item.planTitle})</option>)}
                      </select>
                    </label>
                    <label className={label}>بند علاج الجذور لهذه الحالة
                      <select value={crownLink.rct} className={field} data-testid="endo-rct-item" disabled={Boolean(form || addendum || closing || openForm)}
                        onChange={(event) => setCrownLink({ ...crownLink, rct: event.target.value })}>
                        <option value="">— اختر —</option>
                        {rctCandidates.map((item) => <option key={item.id} value={item.id}>{item.serviceName} ({item.planTitle})</option>)}
                      </select>
                    </label>
                    <button type="button" data-testid="endo-crown-link" disabled={busy || !crownLink.crown || !crownLink.rct}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold"
                      onClick={async () => {
                        if (await send(`/api/patients/${patientId}/endo/${selected.id}/crown`, "PATCH", {
                          crownRequired: true, crownPlanItemId: Number(crownLink.crown), rctPlanItemId: Number(crownLink.rct),
                        })) setCrownLink({ crown: "", rct: "" });
                      }}>ربط التاج بعد علاج الجذور</button>
                  </div>
                ) : null}
                {selected.crownPlanItem ? <p className="text-xs text-slate-600">مرتبط ببند: {selected.crownPlanItem.name}</p> : null}
              </div> : null}

              {canWrite && selected.status === "in_progress" ? (
                <div className="mt-3 border-t border-slate-100 pt-2">
                  {closing ? (
                    <div className="space-y-1">
                      <textarea value={closing.outcome} onChange={(event) => setClosing({ ...closing, outcome: event.target.value })} rows={2}
                        placeholder={closing.status === "abandoned" ? "سبب الإيقاف (مطلوب)" : "ملاحظة الإكمال (اختياري)"}
                        className="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs" />
                      <div className="flex gap-2">
                        <button type="button" disabled={busy || (closing.status === "abandoned" && !closing.outcome.trim())} data-testid="endo-close-confirm"
                          onClick={async () => { if (closing.treatmentId !== selected.id || selected.status !== "in_progress") return; if (await send(`/api/patients/${patientId}/endo/${closing.treatmentId}`, "PATCH", { status: closing.status, outcome: closing.outcome || null })) setClosing(null); }}
                          className="rounded-lg bg-navy-900 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40">تأكيد: {ENDO_STATUS_LABEL[closing.status]}</button>
                        <button type="button" onClick={() => { if (discard()) setClosing(null); }} className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600">رجوع</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button type="button" data-testid="endo-complete" onClick={() => { if (!discard()) return; setForm(null); setAddendum(null); setOpenForm(null); setCrownLink({ crown: "", rct: "" }); setSelectedId(selected.id); setClosing({ treatmentId: selected.id, status: "completed", outcome: "" }); }}
                        className="rounded-lg border border-sky-200 px-2.5 py-1 text-[11px] font-bold text-sky-800">إكمال علاج الجذور</button>
                      <button type="button" onClick={() => { if (!discard()) return; setForm(null); setAddendum(null); setOpenForm(null); setCrownLink({ crown: "", rct: "" }); setSelectedId(selected.id); setClosing({ treatmentId: selected.id, status: "abandoned", outcome: "" }); }}
                        className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-bold text-slate-600">إيقاف العلاج</button>
                    </div>
                  )}
                </div>
              ) : null}
            </details>
          ) : null}
        </>
      ) : null}
    </fieldset>
  );
}
