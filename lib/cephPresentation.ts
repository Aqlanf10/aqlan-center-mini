import { parseCephSourceIdentity, type CephCompletionSources, type CephSourceIdentity } from "./ceph-source-review";
import { CEPH_ENGINE_VERSION, CEPH_ENGINE_SOURCE_SHA256 } from "./ceph-engine-identity";
import type { CephProvenanceRead, CephReferenceSnapshot } from "./ceph-completion-provenance";
import { type CephExpertDiagnosis, type EnrichedMeasurement, type RefMap, isDescriptiveCephMeasurement, MEASUREMENTS, type MeasurementResult } from "./ceph";

/** Quarantined clinical outputs stay in archival storage, but must not be
 * restored as a current value, grade, recommendation or comparison endpoint. */
export const CEPH_UNAVAILABLE_NOTICE = "الرمز القديم EXT_INDEX لا يُعرض ولا يُعاد تفسير قيمه المحفوظة كمؤشر EI_KIM_1996. المؤشر الجديد وصفي، وليس توصية بالقلع أو عدمه.";
export const isQuarantinedCephMeasurement = (code: string) => code === "EXT_INDEX";

export function displayableCephSnapshot<T extends { code: string }>(snapshot: readonly T[]): T[] {
  return snapshot.filter((row) => !isQuarantinedCephMeasurement(row.code));
}

/** Null means a live draft; an empty sealed snapshot still means no values,
 * never permission to recompute historical clinical measurements. */
export function presentCephMeasurements(
  live: MeasurementResult[], sealed: readonly { code: string; value: number }[] | null, provenance?: CephProvenanceRead,
): MeasurementResult[] {
  if (sealed !== null) return presentCompletedCephMeasurements(sealed, provenance);
  return live.map((row) => {
    const quarantined = isQuarantinedCephMeasurement(row.code);
    const descriptive = isDescriptiveCephMeasurement(row.code);
    const value = quarantined ? null : row.value;
    const finite = value !== null && Number.isFinite(value) ? value : null;

    return { ...row, value: finite, display: finite === null ? "—" : String(finite),
      mean: null, tol: null, status: null, severityStars: "",
      interpretationEn: "", interpretationAr: "",
      source: descriptive ? row.source : CEPH_REFERENCE_UNAVAILABLE,
      sourceUrl: descriptive ? row.sourceUrl : undefined,
      populationReference: descriptive ? row.populationReference : undefined,
      note: quarantined ? CEPH_UNAVAILABLE_NOTICE : descriptive ? row.note : undefined,
    };
  });
}

export const CEPH_LEGACY_NOTICE = "سجل اعتماد قديم بلا توثيق لإصدار الحساب أو الوحدات والمراجع وقت الاعتماد. تُعرض الأرقام المحفوظة فقط، ولم يُعَد التحقق منها بأثر رجعي. لا تُفسَّر بمراجع اليوم.";
export const CEPH_INTEGRITY_NOTICE = "تعذّر التحقق من سلامة سجل الاعتماد. أُوقف عرض النتائج السريرية والطباعة المعتمدة حتى مراجعة السجل؛ لا تُعد هذه الدراسة نتيجة موثوقة.";
export const CEPH_VERSIONED_NOTICE = "القيم والوحدات محفوظة عند الاعتماد. هوية الصورة وإصدار الحساب والمراجع التقطها الخادم وقت الاعتماد؛ لا يثبت ذلك أن الطبيب شاهد المصدر المطابق لهذه البصمات. توثيق المصدر ليس تحققًا سريريًا مستقلًا، ولا تُولَّد تفسيرات جديدة للسجل المعتمد. وحدات القياسات المحفوظة لا توثّق مستقلًا وحدات أرقام المرجع أو توافق صيغها.";
export const CEPH_REVIEWED_SOURCE_NOTICE = "القيم والوحدات والمراجع محفوظة عند الاعتماد، وهوية المصادر المرسلة من شاشة المراجعة طابقت ما التقطه الخادم. بصمة الصورة هي البصمة المسجلة للمستند، وليست إعادة فحص لبايتات الملف عند الاعتماد أو تحققًا سريريًا مستقلًا. وحدات القياسات المحفوظة لا توثّق مستقلًا وحدات أرقام المرجع أو توافق صيغها.";
export function cephCompletionNotice(provenance?: CephProvenanceRead): string {
  return provenance?.state === "versioned" ? (provenance.witness.sourceIdentityMeaning === "submitted_source_identity_matches_server_capture" ? CEPH_REVIEWED_SOURCE_NOTICE : CEPH_VERSIONED_NOTICE)
    : provenance?.state === "integrity_unavailable" ? CEPH_INTEGRITY_NOTICE : CEPH_LEGACY_NOTICE;
}

/** Clinical history is not enriched from today's definitions. Current grouping
 * is navigation only; code is the archival label. Unknown codes stay visible. */
function presentCompletedCephMeasurements(
  sealed: readonly { code: string; value: number }[], provenance?: CephProvenanceRead,
): MeasurementResult[] {
  if (provenance?.state === "integrity_unavailable") return [];
  const witnessed = provenance?.state === "versioned" ? provenance.witness.measurements : null;
  return displayableCephSnapshot(witnessed ?? sealed).map(row => {
    const evidence = witnessed?.find(saved => saved.code === row.code);
    const definition = MEASUREMENTS.find(item => item.code === row.code);
    const value = Number.isFinite(row.value) ? row.value : null;
    return { code: row.code, ar: row.code, en: row.code,
      group: definition?.group ?? "sagittal", schools: definition?.schools ?? [],
      value, display: value === null ? "—" : String(value),
      unit: evidence?.unit ?? " (الوحدة غير موثقة)",
      mean: evidence?.reference.mean ?? null, tol: evidence?.reference.sd ?? null,
      source: evidence?.reference.source ?? "المصدر التاريخي غير موثّق",
      sourceUrl: evidence?.reference.sourceUrl ?? undefined,
      populationReference: evidence?.reference.populationReference ?? undefined,
      descriptiveOnly: evidence?.reference.origin === "descriptive_cohort_only" || evidence?.reference.origin === "descriptive_measurement_only",
      calculationVersion: evidence?.algorithm.version,
      note: evidence ? `إصدار الحساب: ${evidence.algorithm.version} · ${evidence.algorithm.id} · ${evidence.reference.source} · ${evidence.reference.origin === "selected_reference_set" ? "أرقام المجموعة المختارة المحفوظة" : evidence.reference.origin === "builtin_definition_fallback" ? "مرجع مدمج بديل محفوظ، ليس من المجموعة المختارة" : evidence.reference.populationReference ? "عينة وصفية محفوظة" : "قياس وصفي محفوظ؛ بلا معيار شخصي"}` : CEPH_LEGACY_NOTICE,
      status: null, severityStars: "", interpretationEn: "", interpretationAr: "",
    };
  });
}

/** Completed reference numbers are saved evidence, never fresh classifications.
 * Draft catalog values are informational numbers, not validated patient norms.
 * A missing row never borrows a built-in definition or another catalog. */
export function enrichPresentedCephMeasurements(
  table: MeasurementResult[], refs: RefMap | null, completed: boolean,
  referenceSource = "مصدر الكتالوج غير موثّق",
): EnrichedMeasurement[] {
  if (completed) return table.map(row => ({ ...row, refMean: row.mean, refSd: row.tol,
    diff: null, z: null, refLabel: null, refSeverity: null }));
  return table.map(row => {
    const descriptive = row.descriptiveOnly || isDescriptiveCephMeasurement(row.code);
    const ref = !descriptive && !isQuarantinedCephMeasurement(row.code) && refs && Object.hasOwn(refs, row.code) ? refs[row.code] : null;
    const available = ref && Number.isFinite(ref.mean) && Number.isFinite(ref.sd) && ref.sd > 0;
    return { ...row, mean: null, tol: null, status: null, severityStars: "", interpretationAr: "", interpretationEn: "",
      refMean: available ? ref.mean : null, refSd: available ? ref.sd : null,
      source: descriptive ? row.source : available ? referenceSource : CEPH_REFERENCE_UNAVAILABLE,
      sourceUrl: descriptive ? row.sourceUrl : undefined, populationReference: descriptive ? row.populationReference : undefined,
      diff: null, z: null, refLabel: null, refSeverity: null };
  });
}

export const CEPH_REFERENCE_UNAVAILABLE = "مرجع غير متاح في مصدر هذه المراجعة؛ لا يُستبدل بمرجع مدمج";
export const CEPH_REFERENCE_NOTICE = "ملاءمة هذه المراجع لهذا المريض غير متحققة. أرقام الكتالوج معلومات مصدرية فقط؛ وحداتها وتوافق صيغها مع القياسات غير موثّقين مستقلًا. لا تُستخدم لتصنيف الطبيعي أو الشدة أو التشخيص أو اختيار العلاج. مطابقة الهوية والبصمة لا تثبت صلاحية سريرية.";
export const CEPH_RAW_OBSERVATION_NOTICE = "قياسات وصفية فقط، بلا تصنيف سريري آلي أو توصية علاجية؛ يلزم تقييم الطبيب.";

export interface CephDraftReferenceContext {
  refs: RefMap | null;
  name: string;
  source: string;
  referenceSet: CephReferenceSnapshot | null;
  identity: CephSourceIdentity | null;
  patientSpecificSuitability: "not_validated";
}
/** Consumes the server-produced bundle. This validates its shape and identity
 * scope, not a browser-side rehash or an independent unit/formula witness. */
export function cephDraftReferenceContext(
  sources: CephCompletionSources | undefined,
  analysis: { documentId: number; refSet: string },
): CephDraftReferenceContext {
  const unavailable: CephDraftReferenceContext = { refs: null, name: CEPH_REFERENCE_UNAVAILABLE,
    source: CEPH_REFERENCE_UNAVAILABLE, referenceSet: null, identity: null, patientSpecificSuitability: "not_validated" };
  if (sources?.state !== "available") return unavailable;
  const identity = parseCephSourceIdentity(sources.identity), set = sources.referenceSet;
  const nonempty = (v: unknown): v is string => typeof v === "string" && !!v.trim() && v.length <= 2000;
  if (!identity || identity.documentId !== analysis.documentId || identity.referenceSetKey !== analysis.refSet
    || identity.engineVersion !== CEPH_ENGINE_VERSION || identity.engineSourceSha256 !== CEPH_ENGINE_SOURCE_SHA256
    || !set || typeof set !== "object" || Array.isArray(set) || Object.keys(set).length !== 9 || set.key !== identity.referenceSetKey || set.active !== true
    || !nonempty(set.name) || !nonempty(set.version) || !(set.population === null || nonempty(set.population))
    || !(set.sex === null || nonempty(set.sex)) || !(set.ageMin === null || typeof set.ageMin === "number" && Number.isFinite(set.ageMin))
    || !(set.ageMax === null || typeof set.ageMax === "number" && Number.isFinite(set.ageMax))
    || !Array.isArray(set.values) || set.values.length > 256) return unavailable;
  const refs: RefMap = Object.create(null), codes = new Set<string>();
  for (const row of set.values) {
    if (!row || typeof row !== "object" || Object.keys(row).length !== 3 || !nonempty(row.code) || codes.has(row.code) || typeof row.mean !== "number" || !Number.isFinite(row.mean)
      || typeof row.sd !== "number" || !Number.isFinite(row.sd) || row.sd <= 0) return unavailable;
    codes.add(row.code);
    if (!isQuarantinedCephMeasurement(row.code) && !isDescriptiveCephMeasurement(row.code)) refs[row.code] = { mean: row.mean, sd: row.sd };
  }
  return { refs, name: set.name, source: `${set.key}@${set.version}`, referenceSet: set, identity, patientSpecificSuitability: "not_validated" };
}

/** Grouping is navigation only. Neither built-in nor selected catalog numbers
 * can create a diagnostic conclusion in these raw measurement notes. */
export function describeCephMeasurements(rows: readonly MeasurementResult[]) {
  const finite = rows.filter(row => !isQuarantinedCephMeasurement(row.code) && row.value !== null && Number.isFinite(row.value));
  const group = (...groups: MeasurementResult["group"][]) => finite.filter(row => groups.includes(row.group))
    .map(row => `${row.code} = ${row.value}${row.unit}`).join(" · ") || "لا توجد قياسات متاحة في هذه المجموعة";
  return { skeletal: group("sagittal", "vertical"), vertical: group("vertical"), dental: group("dental"), softTissue: group("softTissue"),
    finalDx: CEPH_RAW_OBSERVATION_NOTICE, recommendationsText: CEPH_RAW_OBSERVATION_NOTICE };
}

/** Legacy response shape retained without manufacturing clinical decisions.
 * False intervention flags mean no automated recommendation, never exclusion. */
export function generateCephDescriptiveResponse(rows: readonly MeasurementResult[]): CephExpertDiagnosis {
  const raw = describeCephMeasurements(rows), notice = CEPH_RAW_OBSERVATION_NOTICE;
  return {
    sagittalSkeletal: { classification: "Indeterminate", severity: "indeterminate", descriptionAr: raw.skeletal,
      detailsAr: [raw.skeletal], maxilla: "indeterminate", mandible: "indeterminate" },
    verticalSkeletal: { pattern: "Indeterminate", descriptionAr: raw.vertical, detailsAr: [raw.vertical], growthTendencyAr: notice },
    dentalAnalysis: { descriptionAr: raw.dental, detailsAr: [raw.dental], upperIncisor: "indeterminate", lowerIncisor: "indeterminate",
      compensationAr: notice, interincisalAr: notice },
    aestheticProfile: { profileTypeAr: notice, lipCompetenceAr: notice, nasolabialAr: notice, eLineAr: notice, summaryAr: raw.softTissue },
    treatmentRecommendations: { extractionDecision: "not-specified", extractionRationaleAr: notice,
      growthModification: false, expansion: false, anchorageOrTADs: false, orthognathicSurgery: false,
      narrativePlanAr: `${notice} عدم صدور توصية آلية لا يعني استبعاد أي خيار علاجي.` },
    formatted: raw,
  };
}
