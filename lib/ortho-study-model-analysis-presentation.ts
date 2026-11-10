import type { projectStudyAssessment } from "./ortho-case-study-assessment-projection";
import { DISABLED_ASSESSMENT_METHODS } from "./ortho-assessment-measurement-set-v2";

/** Presentation only, after the caller's canonical saved-source authorization and
 * decoder. Never calculates, selects fresh inputs, approves, or updates a source.
 * The exact witness must be wired into versioned export notes before replacing
 * the existing visible payload. This module alone changes no output renderer. */
export const STUDY_MODEL_ANALYSIS_PRESENTATION = "ortho-model-analysis-presentation-v1" as const;
export type SavedStudyModelAnalysis = ReturnType<typeof projectStudyAssessment>["analyses"][number];
export interface ModelAnalysisPresentation {
  version: typeof STUDY_MODEL_ANALYSIS_PRESENTATION;
  title: string;
  clinicalRows: [label: string, value: string][];
  provenanceRows: [label: string, value: string][];
  exactWitness: Pick<SavedStudyModelAnalysis, "selection" | "stored">;
}
const titles = {
  arch_space: "تحليل المسافة / Arch space",
  bolton_anterior: "تحليل Bolton الأمامي / Anterior Bolton",
  bolton_overall: "تحليل Bolton الكلي / Overall Bolton",
  tanaka_johnston_1974: "تقدير Tanaka–Johnston 1974",
  moyers: "Moyers", tanaka_johnston: "Tanaka–Johnston — الاختيار القديم غير المحدد",
  huckaba: "Huckaba", ashley_howe: "Ashley Howe", stanley_kerber: "Stanley Kerber",
  pont: "Pont", linder_harth: "Linder–Harth", peck_peck: "Peck–Peck",
} satisfies Record<SavedStudyModelAnalysis["selection"]["method"], string>;
function fail(): never { throw Error("invalid_saved_model_analysis_presentation"); }
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !("value" in descriptor))
    || Object.keys(value).sort().join("|") !== [...keys].sort().join("|")) fail();
  return value as Record<string, unknown>;
}
function text(value: unknown): asserts value is string { if (typeof value !== "string" || !value.trim()) fail(); }
function number(value: unknown): asserts value is number { if (typeof value !== "number" || !Number.isFinite(value)) fail(); }
function oneOf(value: unknown, values: readonly unknown[]) { if (!values.includes(value)) fail(); }
function observationId(value: unknown, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) fail();
}
function tooth(value: unknown) { if (typeof value !== "number" || !Number.isInteger(value) || !/^[1-8][1-8]$/.test(String(value))) fail(); }
const arch = (value: "upper" | "lower") => value === "upper" ? "علوي / Upper" : "سفلي / Lower";
const mm = (value: number) => `${String(value)} mm`;
const percent = (value: number) => `${String(value)} %`;
const unapproved = "مسودة حسابية؛ غير معتمدة سريريًا / Draft calculation; clinically unapproved";

/** Check known stored shapes without deriving or comparing numerical formula
 * outputs. Exact source correctness remains the canonical decoder's job. */
function validate(input: SavedStudyModelAnalysis): void {
  const top = fields(input, ["selection", "stored", "clinicalApproval"]);
  if (top.clinicalApproval !== "unapproved") fail();
  const selection = input.selection;
  if (!selection || typeof selection !== "object") fail();
  fields(selection, ["state", "id", "measurementSetId", "method", ...(["arch_space", "tanaka_johnston_1974"].includes(selection.method) ? ["arch"] : [])]);
  if (selection.state !== "draft" || !Object.hasOwn(titles, selection.method)) fail();
  observationId(selection.id); observationId(selection.measurementSetId);
  if ("arch" in selection) oneOf(selection.arch, ["upper", "lower"]);
  fields(input.stored, ["analysisId", "result", "resultHash"]);
  // The canonical saved decoder has already verified this hash. Its projection
  // may reorder object keys; rehashing that projection would reject valid old
  // witnesses whose persisted hash used the historical engine's JSON order.
  if (input.stored.analysisId !== selection.id || typeof input.stored.resultHash !== "string" || !/^[a-f0-9]{64}$/.test(input.stored.resultHash)) fail();
  const result = input.stored.result;
  if (!result || !Array.isArray(result.dependencyObservationIds)) fail();
  result.dependencyObservationIds.forEach(id => observationId(id));
  if (new Set(result.dependencyObservationIds).size !== result.dependencyObservationIds.length) fail();
  const common = ["state", "dependencyObservationIds"];
  switch (result.state) {
    case "unsupported_dentition": fields(result, common); return;
    case "incomplete":
      fields(result, [...common, "missing"]);
      if (!Array.isArray(result.missing) || !result.missing.length) fail();
      for (const missing of result.missing) {
        oneOf(missing.kind, ["dentition", "tooth_width", "available_space", "unerupted_segment_status"]);
        fields(missing, ["kind", "observationId", ...(missing.kind === "available_space" ? ["arch"] : missing.kind === "dentition" ? [] : ["tooth"])]);
        observationId(missing.observationId, true);
        if ("arch" in missing) oneOf(missing.arch, ["upper", "lower"]);
        if ("tooth" in missing) tooth(missing.tooth);
      }
      return;
    case "inapplicable":
      fields(result, [...common, "tooth", "reason"]); tooth(result.tooth);
      oneOf(result.reason, ["tooth_absent", "not_erupted", "segment_width_already_measured", "target_not_applicable"]); return;
    case "outside_supported_predictor_domain":
      fields(result, [...common, "predictorSumMm", "minimumMm", "maximumMm", "policyVersion"]);
      if (selection.method !== "tanaka_johnston_1974" || result.minimumMm !== 20.5 || result.maximumMm !== 27) fail();
      number(result.predictorSumMm);
      oneOf(result.policyVersion, ["tanaka_whole_arch_mixed_v1", "tanaka_whole_arch_mixed_decimal_v2"]); return;
    case "ready": break;
    default: fail();
  }
  fields(result, [...common, "witness"]);
  const witness = result.witness;
  fields(witness, ["formula", "result", "reference", "clinicalApproval"]);
  const calculation = witness.result;
  if (!calculation || typeof calculation !== "object") fail();
  fields(witness.formula, ["engineVersion", "formulaVersion"]);
  if (witness.clinicalApproval !== "unapproved") fail();
  if (calculation.state === "unavailable") {
    fields(calculation, ["state", "reason"]); text(calculation.reason);
    if (!(DISABLED_ASSESSMENT_METHODS as readonly string[]).includes(selection.method) || witness.reference !== null
      || witness.formula.engineVersion !== "ortho-model-2.1.0"
      || witness.formula.formulaVersion !== `${selection.method}_disabled_reference_pending`) fail();
    return;
  }
  if (calculation.state !== "calculated") fail();
  if (calculation.method === "arch_space") {
    fields(calculation, ["state", "method", "arch", "requiredMm", "availableMm", "availableMinusRequiredMm"]);
    if (selection.method !== "arch_space" || selection.arch !== calculation.arch || witness.reference !== null
      || witness.formula.engineVersion !== "ortho-model-2.1.0" || witness.formula.formulaVersion !== "available_minus_required_v2") fail();
    [calculation.requiredMm, calculation.availableMm, calculation.availableMinusRequiredMm].forEach(number); return;
  }
  const reference = witness.reference;
  if (!reference) fail();
  if (calculation.method === "bolton_anterior" || calculation.method === "bolton_overall") {
    fields(calculation, ["state", "method", "upperMm", "lowerMm", "ratioPercent", "upperReference", "lowerReference"]);
    fields(calculation.upperReference, ["lowerMinusExpectedMm"]); fields(calculation.lowerReference, ["upperMinusExpectedMm"]);
    [calculation.upperMm, calculation.lowerMm, calculation.ratioPercent, calculation.upperReference.lowerMinusExpectedMm, calculation.lowerReference.upperMinusExpectedMm].forEach(number);
    if (selection.method !== calculation.method || witness.formula.engineVersion !== "ortho-model-2.1.0"
      || witness.formula.formulaVersion !== "bolton_lower_over_upper_v1") fail();
    fields(reference, ["id", "version", "percent", "source", "sourceVerification", "review"]);
    if (!("percent" in reference)) fail();
    number(reference.percent);
  } else if (calculation.method === "tanaka_johnston_1974_approximation_v1") {
    fields(calculation, ["state", "method", "arch", "measuredLowerIncisorSumMm", "measuredTargetIncisorSumMm", "predictedCaninePremolarPerQuadrantMm", "predictedBothQuadrantsMm", "estimatedRequiredMm", "measuredAvailableMm", "availableMinusEstimatedRequiredMm", "withinPublishedTablePredictorDomain"]);
    if (selection.method !== "tanaka_johnston_1974" || calculation.arch !== selection.arch || typeof calculation.withinPublishedTablePredictorDomain !== "boolean") fail();
    [calculation.measuredLowerIncisorSumMm, calculation.measuredTargetIncisorSumMm, calculation.predictedCaninePremolarPerQuadrantMm, calculation.predictedBothQuadrantsMm, calculation.estimatedRequiredMm, calculation.measuredAvailableMm, calculation.availableMinusEstimatedRequiredMm].forEach(number);
    const decimal = witness.formula.engineVersion === "ortho-model-2.2.1";
    if (witness.formula.engineVersion !== (decimal ? "ortho-model-2.2.1" : "ortho-model-2.2.0")
      || witness.formula.formulaVersion !== (decimal ? "tanaka_johnston_1974_decimal_domain_v2" : "tanaka_johnston_1974_approximation_v1")) fail();
    fields(reference, ["id", "version", "kind", "source", "sourceUrl", "sourceVerification", "review", "populationApplicability", "policyVersion", "supportedPredictorDomainMm", ...(decimal ? ["predictorDomainComparison"] : [])]);
    if (!("kind" in reference) || reference.kind !== "prediction" || reference.populationApplicability !== "not_assessed"
      || reference.policyVersion !== (decimal ? "tanaka_whole_arch_mixed_decimal_v2" : "tanaka_whole_arch_mixed_v1")) fail();
    text(reference.sourceUrl);
    fields(reference.supportedPredictorDomainMm, ["min", "max"]);
    if (reference.supportedPredictorDomainMm.min !== 20.5 || reference.supportedPredictorDomainMm.max !== 27
      || decimal && (!("predictorDomainComparison" in reference) || reference.predictorDomainComparison !== "sum_of_canonical_decimal_inputs")) fail();
  } else fail();
  text(reference.id); text(reference.source);
  if (reference.version !== 1 || reference.sourceVerification !== "primary_verified" || reference.review !== "unapproved") fail();
}

export function presentSavedModelAnalysis(input: SavedStudyModelAnalysis): ModelAnalysisPresentation {
  validate(input);
  const exactWitness = structuredClone({ selection: input.selection, stored: input.stored });
  const { selection, stored } = exactWitness, result = stored.result;
  const clinicalRows: ModelAnalysisPresentation["clinicalRows"] = [["التحليل / Analysis", titles[selection.method]], ["الاعتماد السريري / Clinical approval", unapproved]];
  const provenanceRows: ModelAnalysisPresentation["provenanceRows"] = [
    ["معرف التحليل المحفوظ", selection.id], ["معرف مجموعة القياسات", selection.measurementSetId],
    ["الملاحظات التي تعتمد عليها النتيجة — بالترتيب المحفوظ", result.dependencyObservationIds.join("، ") || "لا توجد مراجع ملاحظات في النتيجة المحفوظة"],
    ["بصمة النتيجة SHA256", stored.resultHash],
  ];
  if ("arch" in selection) clinicalRows.push(["الفك / Arch", arch(selection.arch)]);
  const row = (label: string, value: string) => { clinicalRows.push([label, value]); };
  if (result.state === "incomplete") {
    row("حالة الحساب", "المدخلات غير مكتملة / Incomplete inputs");
    for (const [index, missing] of result.missing.entries()) {
      const label = missing.kind === "dentition" ? "نوع الأسنان / Dentition"
        : missing.kind === "available_space" ? `المسافة المتاحة — ${arch(missing.arch)}`
          : `${missing.kind === "tooth_width" ? "عرض السن" : "توثيق حالة الجزء غير البازغ"} — FDI ${missing.tooth}`;
      row(`المدخل الناقص ${index + 1}`, label);
      provenanceRows.push([`مرجع المدخل الناقص ${index + 1}`, missing.observationId ?? "لا يوجد مرجع ملاحظة مسجل"]);
    }
  } else if (result.state === "unsupported_dentition") row("حالة الحساب", "نوع الأسنان المسجل غير مدعوم لهذا التحليل / Unsupported recorded dentition");
  else if (result.state === "inapplicable") {
    row("حالة الحساب", "غير منطبق على المدخلات المسجلة / Inapplicable to recorded inputs");
    row("السن المسجل", `FDI ${result.tooth}`);
    row("السبب المسجل", { tooth_absent: "السن مسجل كغائب", not_erupted: "السن مسجل كغير بازغ", segment_width_already_measured: "عرض الجزء مسجل كمقاس بالفعل", target_not_applicable: "الهدف مسجل كغير منطبق" }[result.reason]);
  } else if (result.state === "outside_supported_predictor_domain") {
    row("حالة الحساب", "خارج مجال المدخل التنبؤي المدعوم / Outside supported predictor domain");
    row("مجموع القواطع السفلية المسجل", mm(result.predictorSumMm));
    row("الحد الأدنى للمجال المدعوم", mm(result.minimumMm)); row("الحد الأعلى للمجال المدعوم", mm(result.maximumMm));
    row("حدود التفسير", "هذا مجال دعم التطبيق للمدخل التنبؤي، وليس مجالًا طبيعيًا بيولوجيًا أو تشخيصًا.");
    provenanceRows.push(["إصدار سياسة المجال المحفوظ", result.policyVersion]);
  } else if (result.state === "ready") {
    const witness = result.witness, calculation = witness.result;
    provenanceRows.push(["إصدار الحساب المحفوظ", witness.formula.engineVersion], ["إصدار المعادلة المحفوظ", witness.formula.formulaVersion]);
    if (calculation.state === "unavailable") {
      row("حالة الحساب", "الحساب غير متاح لهذا الاختيار / Calculation unavailable"); row("السبب المحفوظ", calculation.reason);
    } else {
      row("حالة الحساب", "نتيجة حسابية محفوظة؛ ليست اعتمادًا سريريًا / Saved calculation, not clinical approval");
      if (calculation.method === "arch_space") {
        row("المسافة المتاحة / Available space", mm(calculation.availableMm)); row("المسافة المطلوبة / Required space", mm(calculation.requiredMm));
        row("المتاح ناقص المطلوب / Available − required", mm(calculation.availableMinusRequiredMm));
      } else if (calculation.method === "bolton_anterior" || calculation.method === "bolton_overall") {
        row("مجموع عروض الأسنان العلوية / Upper sum", mm(calculation.upperMm)); row("مجموع عروض الأسنان السفلية / Lower sum", mm(calculation.lowerMm));
        row("نسبة السفلي إلى العلوي / Lower-to-upper ratio", percent(calculation.ratioPercent));
        row("السفلي ناقص السفلي المتوقع بمرجع علوي / Lower − expected lower", mm(calculation.upperReference.lowerMinusExpectedMm));
        row("العلوي ناقص العلوي المتوقع بمرجع سفلي / Upper − expected upper", mm(calculation.lowerReference.upperMinusExpectedMm));
      } else if (calculation.method === "tanaka_johnston_1974_approximation_v1") {
        row("مجموع القواطع السفلية المقاس / Measured lower incisors", mm(calculation.measuredLowerIncisorSumMm));
        row("مجموع قواطع الفك المطلوب المقاس / Measured target incisors", mm(calculation.measuredTargetIncisorSumMm));
        row("الناب والضاحكان لكل جهة — تقدير / Predicted segment per side", mm(calculation.predictedCaninePremolarPerQuadrantMm));
        row("الناب والضاحكان في الجهتين — تقدير / Predicted both sides", mm(calculation.predictedBothQuadrantsMm));
        row("المسافة المتاحة المقاسة / Measured available space", mm(calculation.measuredAvailableMm));
        row("المسافة المطلوبة المقدّرة / Estimated required space", mm(calculation.estimatedRequiredMm));
        row("المتاح ناقص المطلوب المقدّر / Available − estimated required", mm(calculation.availableMinusEstimatedRequiredMm));
        row("ضمن مجال مدخل الجداول المنشورة — كما حُفظ", calculation.withinPublishedTablePredictorDomain ? "نعم / Yes" : "لا / No");
        row("حدود التفسير", "القيم المقدّرة ليست قياسات مباشرة؛ مجال الدعم ليس مجالًا طبيعيًا بيولوجيًا.");
      }
    }
    const reference = witness.reference;
    if (!reference) provenanceRows.push(["مرجع النتيجة المحفوظ", "لا يوجد مرجع مسجل في هذه النتيجة"]);
    else {
      provenanceRows.push(["معرف المرجع", reference.id], ["نسخة المرجع", String(reference.version)], ["المصدر كما حُفظ", reference.source],
        ["التحقق من المصدر", "متحقق من مصدر أصلي / Primary source verified"], ["مراجعة المرجع السريرية", "غير معتمدة / Unapproved"]);
      if ("percent" in reference) row("النسبة المرجعية المحفوظة / Stored reference ratio", percent(reference.percent));
      else {
        row("ملاءمة المرجع للحالة", "لم تُقيّم / Not assessed");
        provenanceRows.push(["نوع المرجع", "تنبؤ / Prediction"], ["رابط المصدر كما حُفظ", reference.sourceUrl], ["إصدار سياسة المجال المحفوظ", reference.policyVersion],
          ["الحد الأدنى لمجال المدخل التنبؤي المدعوم", mm(reference.supportedPredictorDomainMm.min)], ["الحد الأعلى لمجال المدخل التنبؤي المدعوم", mm(reference.supportedPredictorDomainMm.max)]);
        if ("predictorDomainComparison" in reference) provenanceRows.push(["أساس مقارنة المجال المحفوظ", "مجموع القيم العشرية الأصلية للمدخلات / Sum of canonical decimal inputs"]);
      }
    }
  }
  return { version: STUDY_MODEL_ANALYSIS_PRESENTATION, title: titles[selection.method], clinicalRows, provenanceRows, exactWitness };
}
