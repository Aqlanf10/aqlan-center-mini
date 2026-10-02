/**
 * (ENDO-1) سير العمل السريري لعلاج العصب — المنطق الخالص (بلا قاعدة).
 *
 * نوبة علاجٍ واحدة لكل (مريض، سن) داخل حالةٍ تخصصية، وسجلٌّ مهيكلٌ لكل زيارة سريرية، وقنواتٌ بأطوالها
 * العاملة. هنا المفردات والتحقق والتسميات وقواعد الانتقال والتلخيص — والقاعدة والواجهة تستهلكانها.
 * لا مال هنا: الفوترة والعمولة تبقيان على `visit_procedures` وبنود الخطة. التصميم: docs/ENDODONTICS_GAP_AUDIT.md.
 */
import { isPrimary, isValidTooth } from "./dental";

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

// ─── المفردات ────────────────────────────────────────────────────────────────

export const ENDO_KINDS = ["initial", "retreatment"] as const;
export type EndoKind = (typeof ENDO_KINDS)[number];
export const ENDO_KIND_LABEL: Record<EndoKind, string> = { initial: "علاج جذور أولي", retreatment: "إعادة علاج" };

export const ENDO_STATUSES = ["in_progress", "completed", "abandoned"] as const;
export type EndoStatus = (typeof ENDO_STATUSES)[number];
export const ENDO_STATUS_LABEL: Record<EndoStatus, string> = {
  in_progress: "جارٍ", completed: "مكتمل", abandoned: "متوقّف",
};
/** النوبة المنتهية لا تعود: العلاج الجديد على السن نوبةٌ جديدة لا إعادة فتحٍ صامتة. */
const ENDO_TRANSITIONS: Record<EndoStatus, readonly EndoStatus[]> = {
  in_progress: ["completed", "abandoned"], completed: [], abandoned: [],
};
export function canMoveEndo(from: EndoStatus, to: EndoStatus): boolean {
  return ENDO_TRANSITIONS[from].includes(to);
}

export const RESTORATIVE_STATUSES = ["none", "temporary", "permanent"] as const;
export type RestorativeStatus = (typeof RESTORATIVE_STATUSES)[number];
export const RESTORATIVE_LABEL: Record<RestorativeStatus, string> = {
  none: "بلا ترميم", temporary: "ترميم مؤقت", permanent: "ترميم دائم",
};

export const ENDO_STAGES = [
  "assessment", "access_cleaning", "shaping", "medicament", "obturation", "review", "other",
] as const;
export type EndoStage = (typeof ENDO_STAGES)[number];
export const ENDO_STAGE_LABEL: Record<EndoStage, string> = {
  assessment: "تقييم وتشخيص", access_cleaning: "فتح وتنظيف", shaping: "تشكيل القنوات",
  medicament: "دواء داخل القناة", obturation: "حشو القنوات", review: "مراجعة", other: "أخرى",
};

export const PULPAL_DIAGNOSES = [
  "normal_pulp", "reversible_pulpitis", "symptomatic_irreversible_pulpitis",
  "asymptomatic_irreversible_pulpitis", "pulp_necrosis", "previously_treated", "previously_initiated",
] as const;
export type PulpalDiagnosis = (typeof PULPAL_DIAGNOSES)[number];
export const PULPAL_LABEL: Record<PulpalDiagnosis, string> = {
  normal_pulp: "لبّ سليم", reversible_pulpitis: "التهاب لبّ عكوس",
  symptomatic_irreversible_pulpitis: "التهاب لبّ غير عكوس بأعراض",
  asymptomatic_irreversible_pulpitis: "التهاب لبّ غير عكوس بلا أعراض",
  pulp_necrosis: "موت اللبّ", previously_treated: "معالَج سابقًا", previously_initiated: "بُدئ علاجه سابقًا",
};

export const APICAL_DIAGNOSES = [
  "normal_apical", "symptomatic_apical_periodontitis", "asymptomatic_apical_periodontitis",
  "acute_apical_abscess", "chronic_apical_abscess", "condensing_osteitis",
] as const;
export type ApicalDiagnosis = (typeof APICAL_DIAGNOSES)[number];
export const APICAL_LABEL: Record<ApicalDiagnosis, string> = {
  normal_apical: "ما حول الذروة سليم", symptomatic_apical_periodontitis: "التهاب ذروي بأعراض",
  asymptomatic_apical_periodontitis: "التهاب ذروي بلا أعراض", acute_apical_abscess: "خراج ذروي حاد",
  chronic_apical_abscess: "خراج ذروي مزمن", condensing_osteitis: "التهاب عظمي كثيف",
};

export const VITALITY_RESULTS = ["positive", "negative", "prolonged", "not_done"] as const;
export type VitalityResult = (typeof VITALITY_RESULTS)[number];
export const VITALITY_LABEL: Record<VitalityResult, string> = {
  positive: "إيجابي", negative: "سلبي", prolonged: "إيجابي مطوّل", not_done: "لم يُجرَ",
};

export const TENDERNESS_RESULTS = ["normal", "tender", "not_done"] as const;
export type TendernessResult = (typeof TENDERNESS_RESULTS)[number];
export const TENDERNESS_LABEL: Record<TendernessResult, string> = {
  normal: "طبيعي", tender: "ألم", not_done: "لم يُجرَ",
};

export const PROGNOSES = ["favorable", "questionable", "unfavorable"] as const;
export type Prognosis = (typeof PROGNOSES)[number];
export const PROGNOSIS_LABEL: Record<Prognosis, string> = {
  favorable: "جيد", questionable: "مشكوك فيه", unfavorable: "سيّئ",
};

export const REFERENCE_POINTS = ["cusp_tip", "incisal_edge", "buccal_cusp", "palatal_cusp", "marginal_ridge", "other"] as const;
export type ReferencePoint = (typeof REFERENCE_POINTS)[number];
export const REFERENCE_POINT_LABEL: Record<ReferencePoint, string> = {
  cusp_tip: "رأس الحدبة", incisal_edge: "الحافة القاطعة", buccal_cusp: "الحدبة الدهليزية",
  palatal_cusp: "الحدبة الحنكية", marginal_ridge: "الحافة الهامشية", other: "أخرى",
};

export const MEASUREMENT_METHODS = ["apex_locator", "radiograph", "both", "tactile"] as const;
export type MeasurementMethod = (typeof MEASUREMENT_METHODS)[number];
export const MEASUREMENT_METHOD_LABEL: Record<MeasurementMethod, string> = {
  apex_locator: "محدّد الذروة", radiograph: "أشعة", both: "محدّد وأشعة", tactile: "لمسي",
};

// ─── القنوات المتوقَّعة لكل سن (اقتراحٌ فقط — الطبيب يسجّل ما وجده فعلًا) ──────────────────

/** تسميات قنواتٍ شائعة لسنٍّ بترقيم FDI. اقتراحٌ يُسرّع الإدخال ولا يُقيّد: القناة الإضافية مسموحة. */
export function expectedCanals(toothCode: number): string[] {
  if (!isValidTooth(toothCode)) return [];
  const upper = [1, 2, 5, 6].includes(Math.floor(toothCode / 10));
  const type = toothCode % 10;
  if (isPrimary(toothCode)) return type >= 4 ? (upper ? ["MB", "DB", "P"] : ["MB", "ML", "D"]) : ["C"];
  if (type <= 3) return ["C"];
  if (type === 4) return upper ? ["B", "P"] : ["C"];
  if (type === 5) return ["C"];
  return upper ? ["MB", "MB2", "DB", "P"] : ["MB", "ML", "D"];
}

// ─── التحقق ──────────────────────────────────────────────────────────────────

const text = (raw: unknown, max: number): string | null => {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value ? value.slice(0, max) : null;
};

const positiveId = (raw: unknown): number | null => {
  const id = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
};

/** قيمةٌ من مفردةٍ مغلقة: غائبة ⇒ null، وغير معروفة ⇒ خطأ (لا تُحوَّل صامتةً إلى «بلا قيمة»). */
function vocab<T extends string>(raw: unknown, allowed: readonly T[]): { ok: true; value: T | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? { ok: true, value: raw as T } : { ok: false };
}

function intIn(raw: unknown, min: number, max: number): { ok: true; value: number | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? { ok: true, value } : { ok: false };
}

export interface EndoTreatmentDraft {
  toothCode: number;
  caseId: number;
  kind: EndoKind;
}

export function checkEndoTreatmentDraft(body: Record<string, unknown>): Checked<EndoTreatmentDraft> {
  const toothCode = typeof body.toothCode === "string" ? Number(body.toothCode) : body.toothCode;
  if (typeof toothCode !== "number" || !isValidTooth(toothCode)) return { ok: false, message: "اختر السن (ترقيم FDI)." };
  const caseId = positiveId(body.caseId);
  if (!caseId) return { ok: false, message: "اختر حالة علاج الجذور التي تنتمي إليها النوبة." };
  const kind = vocab(body.kind ?? "initial", ENDO_KINDS);
  if (!kind.ok || kind.value === null) return { ok: false, message: "نوع العلاج غير معروف." };
  return { ok: true, value: { toothCode, caseId, kind: kind.value } };
}

export interface EndoCanalDraft {
  label: string;
  workingLengthMm: number | null;
  referencePoint: ReferencePoint | null;
  measurementMethod: MeasurementMethod | null;
  masterApicalSize: number | null;
  taperPercent: number | null;
  instrumentation: string | null;
  obturated: boolean;
  note: string | null;
}

export function checkCanalDraft(raw: unknown): Checked<EndoCanalDraft> {
  const body = (raw ?? {}) as Record<string, unknown>;
  const label = typeof body.label === "string" ? body.label.trim().toUpperCase() : "";
  if (!/^[A-Z0-9+-]{1,12}$/.test(label)) return { ok: false, message: "اسم القناة غير صالح — مثل MB أو MB2 أو P (حتى ١٢ حرفًا)." };
  let workingLengthMm: number | null = null;
  if (body.workingLengthMm !== undefined && body.workingLengthMm !== null && body.workingLengthMm !== "") {
    const value = typeof body.workingLengthMm === "string" ? Number(body.workingLengthMm) : body.workingLengthMm;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0.1 || value > 40) {
      return { ok: false, message: `الطول العامل للقناة ${label} غير صالح — بين ٠٫١ و٤٠ مم.` };
    }
    workingLengthMm = Math.round(value * 10) / 10;
  }
  const reference = vocab(body.referencePoint, REFERENCE_POINTS);
  const method = vocab(body.measurementMethod, MEASUREMENT_METHODS);
  if (!reference.ok) return { ok: false, message: `نقطة المرجع للقناة ${label} غير معروفة.` };
  if (!method.ok) return { ok: false, message: `طريقة قياس القناة ${label} غير معروفة.` };
  if (workingLengthMm !== null && (reference.value === null || method.value === null)) {
    return { ok: false, message: `حدّد نقطة المرجع وطريقة القياس للقناة ${label} مع الطول العامل.` };
  }
  const size = intIn(body.masterApicalSize, 6, 200);
  const taper = intIn(body.taperPercent, 2, 12);
  if (!size.ok) return { ok: false, message: `مقاس المبرد الرئيسي للقناة ${label} غير صالح.` };
  if (!taper.ok) return { ok: false, message: `استدقاق المبرد للقناة ${label} غير صالح (٢–١٢٪).` };
  return {
    ok: true,
    value: {
      label, workingLengthMm, referencePoint: reference.value, measurementMethod: method.value,
      masterApicalSize: size.value, taperPercent: taper.value,
      instrumentation: text(body.instrumentation, 300), obturated: body.obturated === true,
      note: text(body.note, 500),
    },
  };
}

export interface EndoVisitDraft {
  stage: EndoStage;
  chiefComplaint: string | null;
  symptoms: string | null;
  pulpalDiagnosis: PulpalDiagnosis | null;
  apicalDiagnosis: ApicalDiagnosis | null;
  vitalityCold: VitalityResult | null;
  vitalityHeat: VitalityResult | null;
  vitalityEpt: VitalityResult | null;
  percussion: TendernessResult | null;
  palpation: TendernessResult | null;
  mobilityGrade: number | null;
  perioFindings: string | null;
  previousTreatment: string | null;
  radiographicFindings: string | null;
  canalsFound: number | null;
  instrumentation: string | null;
  irrigation: string | null;
  medicament: string | null;
  obturationTechnique: string | null;
  obturationMaterial: string | null;
  restorationAfter: RestorativeStatus | null;
  complications: string | null;
  prognosis: Prognosis | null;
  nextStep: string | null;
  nextVisitWeeks: number | null;
  note: string | null;
  canals: EndoCanalDraft[];
}

export function checkEndoVisitDraft(body: Record<string, unknown>): Checked<EndoVisitDraft> {
  const stage = vocab(body.stage ?? "assessment", ENDO_STAGES);
  if (!stage.ok || stage.value === null) return { ok: false, message: "مرحلة الجلسة غير معروفة." };
  const fields: [string, unknown, readonly string[], string][] = [
    ["pulpalDiagnosis", body.pulpalDiagnosis, PULPAL_DIAGNOSES, "التشخيص اللبّي غير معروف."],
    ["apicalDiagnosis", body.apicalDiagnosis, APICAL_DIAGNOSES, "التشخيص الذروي غير معروف."],
    ["vitalityCold", body.vitalityCold, VITALITY_RESULTS, "نتيجة اختبار البرودة غير معروفة."],
    ["vitalityHeat", body.vitalityHeat, VITALITY_RESULTS, "نتيجة اختبار الحرارة غير معروفة."],
    ["vitalityEpt", body.vitalityEpt, VITALITY_RESULTS, "نتيجة الاختبار الكهربائي غير معروفة."],
    ["percussion", body.percussion, TENDERNESS_RESULTS, "نتيجة القرع غير معروفة."],
    ["palpation", body.palpation, TENDERNESS_RESULTS, "نتيجة الجسّ غير معروفة."],
    ["restorationAfter", body.restorationAfter, RESTORATIVE_STATUSES, "حالة الترميم غير معروفة."],
    ["prognosis", body.prognosis, PROGNOSES, "التنبؤ غير معروف."],
  ];
  const picked: Record<string, string | null> = {};
  for (const [key, raw, allowed, message] of fields) {
    const result = vocab(raw, allowed);
    if (!result.ok) return { ok: false, message };
    picked[key] = result.value;
  }
  const mobility = intIn(body.mobilityGrade, 0, 3);
  if (!mobility.ok) return { ok: false, message: "درجة الحركة بين ٠ و٣." };
  const canalsFound = intIn(body.canalsFound, 0, 8);
  if (!canalsFound.ok) return { ok: false, message: "عدد القنوات بين ٠ و٨." };
  const nextWeeks = intIn(body.nextVisitWeeks, 0, 52);
  if (!nextWeeks.ok) return { ok: false, message: "موعد الجلسة التالية بالأسابيع بين ٠ و٥٢." };

  const rawCanals = body.canals === undefined || body.canals === null ? [] : body.canals;
  if (!Array.isArray(rawCanals)) return { ok: false, message: "قائمة القنوات غير صالحة." };
  if (rawCanals.length > 8) return { ok: false, message: "عدد القنوات في السجل لا يتجاوز ٨." };
  const canals: EndoCanalDraft[] = [];
  for (const entry of rawCanals) {
    const checked = checkCanalDraft(entry);
    if (!checked.ok) return checked;
    if (canals.some((existing) => existing.label === checked.value.label)) {
      return { ok: false, message: `القناة ${checked.value.label} مكرّرة في السجل.` };
    }
    canals.push(checked.value);
  }
  if (canalsFound.value !== null && canals.length > canalsFound.value) {
    return { ok: false, message: "عدد القنوات المسجَّلة يفوق عدد القنوات المُعلَن." };
  }
  return {
    ok: true,
    value: {
      stage: stage.value,
      chiefComplaint: text(body.chiefComplaint, 1000), symptoms: text(body.symptoms, 1000),
      pulpalDiagnosis: picked.pulpalDiagnosis as PulpalDiagnosis | null,
      apicalDiagnosis: picked.apicalDiagnosis as ApicalDiagnosis | null,
      vitalityCold: picked.vitalityCold as VitalityResult | null,
      vitalityHeat: picked.vitalityHeat as VitalityResult | null,
      vitalityEpt: picked.vitalityEpt as VitalityResult | null,
      percussion: picked.percussion as TendernessResult | null,
      palpation: picked.palpation as TendernessResult | null,
      mobilityGrade: mobility.value, perioFindings: text(body.perioFindings, 1000),
      previousTreatment: text(body.previousTreatment, 1000),
      radiographicFindings: text(body.radiographicFindings, 2000),
      canalsFound: canalsFound.value,
      instrumentation: text(body.instrumentation, 500), irrigation: text(body.irrigation, 500),
      medicament: text(body.medicament, 500),
      obturationTechnique: text(body.obturationTechnique, 300), obturationMaterial: text(body.obturationMaterial, 300),
      restorationAfter: picked.restorationAfter as RestorativeStatus | null,
      complications: text(body.complications, 1000), prognosis: picked.prognosis as Prognosis | null,
      nextStep: text(body.nextStep, 500), nextVisitWeeks: nextWeeks.value, note: text(body.note, 2000),
      canals,
    },
  };
}

/** Clinical content, excluding form defaults; sparse/malformed values are never evidence. */
export function hasMeaningfulEndoRecord(draft: EndoVisitDraft): boolean {
  if (!draft || typeof draft !== "object") return false;
  const hasText = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
  const hasValue = (value: unknown, allowed: readonly string[]): boolean =>
    typeof value === "string" && allowed.includes(value);
  const inRange = (value: unknown, min: number, max: number, integer = false): boolean =>
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    && (!integer || Number.isInteger(value));
  const narrative = [draft.chiefComplaint, draft.symptoms, draft.perioFindings, draft.previousTreatment,
    draft.radiographicFindings, draft.instrumentation, draft.irrigation, draft.medicament,
    draft.obturationTechnique, draft.obturationMaterial, draft.complications, draft.nextStep, draft.note];
  if (narrative.some(hasText)) return true;
  if (hasValue(draft.pulpalDiagnosis, PULPAL_DIAGNOSES) || hasValue(draft.apicalDiagnosis, APICAL_DIAGNOSES)
    || hasValue(draft.prognosis, PROGNOSES) || inRange(draft.mobilityGrade, 0, 3, true)) return true;
  if ([draft.vitalityCold, draft.vitalityHeat, draft.vitalityEpt]
    .some((value) => value !== "not_done" && hasValue(value, VITALITY_RESULTS))) return true;
  if ([draft.percussion, draft.palpation]
    .some((value) => value !== "not_done" && hasValue(value, TENDERNESS_RESULTS))) return true;
  if (draft.restorationAfter === "temporary" || draft.restorationAfter === "permanent") return true;
  return Array.isArray(draft.canals) && draft.canals.some((canal) => canal && typeof canal === "object" && (
    (inRange(canal.workingLengthMm, 0.1, 40) && hasValue(canal.referencePoint, REFERENCE_POINTS)
      && hasValue(canal.measurementMethod, MEASUREMENT_METHODS))
    || inRange(canal.masterApicalSize, 6, 200, true) || inRange(canal.taperPercent, 2, 12, true)
    || canal.obturated === true || hasText(canal.instrumentation) || hasText(canal.note)));
}

export interface EndoCompletionDraft { status: EndoStatus; outcome: string | null }

export function checkEndoStatusChange(body: Record<string, unknown>): Checked<EndoCompletionDraft> {
  const status = body.status as EndoStatus;
  if (!ENDO_STATUSES.includes(status) || status === "in_progress") return { ok: false, message: "حالة غير معروفة." };
  const outcome = text(body.outcome, 2000);
  if (status === "abandoned" && !outcome) return { ok: false, message: "اكتب سبب إيقاف علاج الجذور." };
  return { ok: true, value: { status, outcome } };
}

/** نصّ الملحق على سجلّ عصبٍ موقَّع: لا يُقبل فارغًا. */
export function checkEndoAddendum(body: Record<string, unknown>): Checked<string> {
  const value = text(body.text, 2000);
  return value ? { ok: true, value } : { ok: false, message: "اكتب نص الملحق." };
}

// ─── التلخيص (ما يراه الطبيب على الكرسي) ──────────────────────────────────────

export interface EndoVisitRecord extends EndoVisitDraft {
  id: number;
  visitId: number;
  doctorId: number | null;
  recordedAt: string;
  /** هل زيارتها السريرية موقَّعة (مجمَّدة)؟ */
  signed: boolean;
}

export interface CanalSummary {
  label: string;
  workingLengthMm: number | null;
  referencePoint: ReferencePoint | null;
  measurementMethod: MeasurementMethod | null;
  masterApicalSize: number | null;
  taperPercent: number | null;
  obturated: boolean;
  /** الزيارة التي سُجّل فيها آخر طولٍ عامل. */
  lastMeasuredVisitId: number | null;
}

export interface EndoSummary {
  pulpalDiagnosis: PulpalDiagnosis | null;
  apicalDiagnosis: ApicalDiagnosis | null;
  prognosis: Prognosis | null;
  canals: CanalSummary[];
  canalsFound: number | null;
  sessions: number;
  lastStage: EndoStage | null;
  nextStep: string | null;
  nextVisitWeeks: number | null;
  allCanalsObturated: boolean;
  /** الأحدث يغلب: تعديلُ طولٍ في زيارةٍ لاحقة يحلّ محلّ السابق دون أن يُمحى السابق من سجلّه. */
}

/** الحالة الراهنة للنوبة من سجلّ زياراتها مرتّبةً من الأقدم إلى الأحدث — تاريخٌ لا حقلٌ يُكتب فوقه. */
export function summarizeEndo(visits: readonly EndoVisitRecord[], canalRows: ReadonlyMap<number, EndoCanalDraft[]>): EndoSummary {
  const ordered = [...visits].sort((a, b) => a.id - b.id);
  let pulpal: PulpalDiagnosis | null = null;
  let apical: ApicalDiagnosis | null = null;
  let prognosis: Prognosis | null = null;
  let canalsFound: number | null = null;
  const canals = new Map<string, CanalSummary>();
  for (const visit of ordered) {
    pulpal = visit.pulpalDiagnosis ?? pulpal;
    apical = visit.apicalDiagnosis ?? apical;
    prognosis = visit.prognosis ?? prognosis;
    canalsFound = visit.canalsFound ?? canalsFound;
    for (const canal of canalRows.get(visit.id) ?? []) {
      const previous = canals.get(canal.label);
      const measured = canal.workingLengthMm !== null;
      canals.set(canal.label, {
        label: canal.label,
        workingLengthMm: measured ? canal.workingLengthMm : previous?.workingLengthMm ?? null,
        referencePoint: measured ? canal.referencePoint : previous?.referencePoint ?? null,
        measurementMethod: measured ? canal.measurementMethod : previous?.measurementMethod ?? null,
        masterApicalSize: canal.masterApicalSize ?? previous?.masterApicalSize ?? null,
        taperPercent: canal.taperPercent ?? previous?.taperPercent ?? null,
        obturated: canal.obturated || (previous?.obturated ?? false),
        lastMeasuredVisitId: measured ? visit.id : previous?.lastMeasuredVisitId ?? null,
      });
    }
  }
  const last = ordered[ordered.length - 1] ?? null;
  const list = [...canals.values()];
  return {
    pulpalDiagnosis: pulpal, apicalDiagnosis: apical, prognosis,
    canals: list, canalsFound: canalsFound ?? (list.length > 0 ? list.length : null),
    sessions: ordered.length, lastStage: last?.stage ?? null,
    nextStep: last?.nextStep ?? null, nextVisitWeeks: last?.nextVisitWeeks ?? null,
    allCanalsObturated: list.length > 0 && list.every((canal) => canal.obturated),
  };
}

// ─── الإكمال واعتمادية التاج ─────────────────────────────────────────────────

/**
 * هل يصلح إكمال النوبة؟ لا إكمال بلا قنواتٍ مسجَّلة كلها محشوّة، ولا بلا ترميمٍ (مؤقتٍ على الأقل) —
 * فالقناة المحشوّة بلا إغلاق تاجيّ تتسرّب. الشروط واضحةٌ بالعربية فيُصلحها الطبيب لا يتجاوزها.
 */
export function canCompleteEndo(summary: EndoSummary, restorative: RestorativeStatus): { ok: true } | { ok: false; message: string } {
  if (summary.canals.length === 0) return { ok: false, message: "سجّل قنوات السن وأطوالها العاملة قبل إكمال العلاج." };
  if (summary.canalsFound !== null && summary.canalsFound !== summary.canals.length) {
    return { ok: false, message: "طابق عدد القنوات المُعلَن مع القنوات المسجَّلة قبل إكمال العلاج." };
  }
  if (summary.canals.some((canal) => canal.workingLengthMm === null
    || !Number.isFinite(canal.workingLengthMm) || canal.workingLengthMm < 0.1 || canal.workingLengthMm > 40
    || canal.referencePoint === null || canal.measurementMethod === null)) {
    return { ok: false, message: "سجّل طولًا عاملًا صالحًا ونقطة المرجع وطريقة القياس لكل قناة قبل إكمال العلاج." };
  }
  if (!summary.allCanalsObturated || summary.canals.some((canal) => !canal.obturated)) return { ok: false, message: "هناك قنواتٌ لم يُسجَّل حشوها — أكملها أو أوقف العلاج بسبب." };
  if (restorative === "none") return { ok: false, message: "سجّل الترميم (مؤقتًا على الأقل) قبل إكمال علاج الجذور." };
  return { ok: true };
}

export type CrownState = "not_required" | "undecided" | "waiting_rct" | "ready" | "planned_done";

/**
 * اعتمادية الترميم بعد علاج الجذور: السن المعالَج بلا تاجٍ دائم عرضةٌ للكسر.
 * - `not_required`: قرر الطبيب أن التاج غير لازم؛ `undecided`: لم يقرّر بعد.
 * - `waiting_rct`: التاج مطلوب والنوبة جارية؛ `ready`: النوبة مكتملة والتاج لم يُنفَّذ بعد؛
 * - `planned_done`: الترميم دائم.
 */
export function crownState(input: { status: EndoStatus; crownRequired: boolean | null; restorative: RestorativeStatus }): CrownState {
  if (input.restorative === "permanent") return "planned_done";
  if (input.crownRequired === false) return "not_required";
  if (input.crownRequired === null) return "undecided";
  return input.status === "completed" ? "ready" : "waiting_rct";
}

export const CROWN_STATE_LABEL: Record<CrownState, string> = {
  not_required: "التاج غير لازم", undecided: "قرار التاج لم يُتخذ", waiting_rct: "التاج بعد اكتمال علاج الجذور",
  ready: "علاج الجذور مكتمل — التاج مطلوب", planned_done: "ترميمٌ دائم",
};

/** الخطوة التالية للطبيب — جملةٌ واحدة تُقرأ على الكرسي. */
export function endoNextAction(input: {
  status: EndoStatus; summary: EndoSummary; restorative: RestorativeStatus; crown: CrownState;
}): string {
  if (input.status === "abandoned") return "العلاج متوقّف.";
  if (input.status === "completed") {
    return input.crown === "ready" ? "إحالة السن للتاج." : input.crown === "undecided" ? "قرّر الحاجة إلى تاج." : "العلاج مكتمل.";
  }
  const { summary } = input;
  if (summary.sessions === 0) return "ابدأ بالتقييم والتشخيص.";
  if (!summary.pulpalDiagnosis || !summary.apicalDiagnosis) return "سجّل التشخيص اللبّي والذروي.";
  if (summary.canals.length === 0 || (summary.canalsFound !== null && summary.canalsFound !== summary.canals.length)) return "حدّد كل القنوات وطابق عددها مع القنوات المسجَّلة.";
  if (summary.canals.some((canal) => canal.workingLengthMm === null)) return "أكمل الأطوال العاملة لكل القنوات.";
  if (!summary.allCanalsObturated) return summary.nextStep ?? "أكمل التشكيل ثم الحشو.";
  return input.restorative === "none" ? "سجّل الترميم ثم أكمل العلاج." : "أكمل العلاج.";
}
