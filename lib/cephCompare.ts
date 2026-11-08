import type { MeasurementResult } from "./ceph";

/** Descriptive comparison of two acquisition projections. Ordering is resolved
 * separately: upload timestamps and record IDs never establish chronology. */

/** Catalog identity and recorded chronology do not establish reference
 * applicability, a shared clinical target, or measurement-specific precision.
 * There is deliberately no normative opt-in until that contract is validated. */
export const CEPH_COMPARISON_INTERPRETATION = Object.freeze({
  mode: "descriptive_only",
  reason: "reference_suitability_not_established",
} as const);
export type CephComparisonInterpretation = typeof CEPH_COMPARISON_INTERPRETATION;

export const CEPH_COMPARISON_INTERPRETATION_NOTICE = {
  ar: "فروق عددية وصفية فقط؛ لم تُثبت ملاءمة المراجع المعيارية واتساقها لهذه المقارنة، لذلك لا يُستنتج تحسّن أو تراجع أو دلالة سريرية للتغيّر.",
  en: "Descriptive numeric differences only. Normative reference suitability and consistency for this comparison have not been established; no improvement, deterioration or clinical significance is inferred.",
} as const;

export type ChangeDirection = "ungraded";
export const CHANGE_LABEL: Record<ChangeDirection, { ar: string; en: string }> = {
  ungraded: { ar: "فرق عددي وصفي؛ دون تقييم سريري", en: "Descriptive numeric difference; not clinically graded" },
};

export interface ComparedMeasurement {
  key: string;
  name: string;
  unit: string;
  before: number;
  after: number;
  /** Comparison endpoint minus reference endpoint; chronology is independent. */
  delta: number;
  /** Legacy response fields are retained only as explicitly withheld values. */
  gapBefore: null;
  gapAfter: null;
  direction: ChangeDirection;
}

export interface Comparison {
  interpretation: CephComparisonInterpretation;
  measurements: ComparedMeasurement[];
  onlyBefore: string[];
  onlyAfter: string[];
  /** Legacy counters must not imply clinical improvement, deterioration or stability. */
  improved: 0;
  worsened: 0;
  steady: 0;
}

export interface ComparableMeasurement {
  code: string;
  name: string;
  unit: string;
  value: number;
  /** Legacy input, never consumed as a comparative target. Public adapters emit null. */
  mean: number | null;
  /** Required when comparing versioned stored results; includes engine source identity. */
  provenanceKey?: string;
}

/** Adapt raw engine values without promoting a population mean to a clinical target. */
export function comparable(result: MeasurementResult): ComparableMeasurement | null {
  if (result.code === "EXT_INDEX" || result.value == null || !Number.isFinite(result.value)) return null;
  return { code: result.code, name: result.ar, unit: result.unit, value: result.value, mean: null };
}

/**
 * Compare compatible raw values only. Before/after denote reference/comparison
 * endpoints. Neither resolved dates nor explicit orientation authorizes grading.
 * No universal noise threshold or per-endpoint normative distance is applied.
 */
export function compareAnalyses(
  before: readonly ComparableMeasurement[],
  after: readonly ComparableMeasurement[],
): Comparison {
  const beforeBy = new Map(before.filter(item => item.code !== "EXT_INDEX").map((item) => [item.code, item]));
  const afterBy = new Map(after.filter(item => item.code !== "EXT_INDEX").map((item) => [item.code, item]));

  const measurements: ComparedMeasurement[] = [];
  for (const [code, first] of beforeBy) {
    const second = afterBy.get(code);
    if (!second || first.unit !== second.unit || !Number.isFinite(first.value) || !Number.isFinite(second.value)) continue;
    // Never mix a sealed algorithm with an unversioned/live result or silently
    // equate the same code produced by a different implementation.
    if ((first.provenanceKey || second.provenanceKey) && first.provenanceKey !== second.provenanceKey) continue;
    const delta = second.value - first.value;
    if (!Number.isFinite(delta)) continue;
    measurements.push({ key: code, name: second.name, unit: second.unit,
      before: first.value, after: second.value, delta,
      gapBefore: null, gapAfter: null, direction: "ungraded" });
  }

  return {
    interpretation: CEPH_COMPARISON_INTERPRETATION,
    measurements,
    onlyBefore: [...beforeBy.keys()].filter((code) => !afterBy.has(code)),
    onlyAfter: [...afterBy.keys()].filter((code) => !beforeBy.has(code)),
    improved: 0, worsened: 0, steady: 0,
  };
}

/** Derive trusted descriptive copy, never echo legacy/injected grade counters. */
export function comparisonSummary(comparison: Pick<Comparison, "measurements">): { ar: string; en: string } {
  if (comparison.measurements.length === 0) {
    return {
      ar: `لا قياسَ مشتركًا متوافقَ المصدر والوحدة بين التحليلين — لا يُقارَنان. ${CEPH_COMPARISON_INTERPRETATION_NOTICE.ar}`,
      en: `No shared measurement has compatible calculation provenance and units; the analyses cannot be compared. ${CEPH_COMPARISON_INTERPRETATION_NOTICE.en}`,
    };
  }
  return CEPH_COMPARISON_INTERPRETATION_NOTICE;
}

export interface OrderableStudy {
  id: number;
  /** Only the image acquisition calendar date establishes chronology. */
  xrayDate?: string | null;
}

export type CephOrderReason = "missing_date" | "invalid_date" | "equal_dates";
export type CephComparisonOrdering = {
  mode: "acquisition_date";
  chronology: "known";
  referenceId: number;
  comparisonId: number;
} | {
  mode: "explicit_reference";
  chronology: "unknown";
  referenceId: number;
  comparisonId: number;
};
export type CephOrderResolution<T> =
  | { state: "resolved"; before: T; after: T; ordering: CephComparisonOrdering }
  | { state: "unresolved"; reason: CephOrderReason }
  | { state: "invalid" };

export const CEPH_ORDER_REQUIRED_NOTICE = "الترتيب الزمني غير محسوم: تاريخ التصوير مفقود أو غير صالح أو متساوٍ. اختر تحليلًا مرجعيًا صراحةً لعرض فرق وصفي، دون استنتاج تسلسل زمني أو تحسّن.";
export const CEPH_REFERENCE_NOTICE = "الترتيب الزمني غير محسوم. المرجع مختار يدويًا؛ الفرق = تحليل المقارنة ناقص المرجع، وليس دليلًا على تحسّن أو تراجع أو نموّ.";

/** Strict, timezone-independent Gregorian date, with no timestamp or locale guessing. */
export function isCephAcquisitionDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** No ID, upload-date, phase or legacy date-alias fallback, including on ties. */
export function resolveCephComparisonOrder<T extends OrderableStudy>(one: T, two: T, referenceId?: number): CephOrderResolution<T> {
  if (!Number.isSafeInteger(one.id) || one.id <= 0 || !Number.isSafeInteger(two.id) || two.id <= 0 || one.id === two.id
      || (referenceId !== undefined && referenceId !== one.id && referenceId !== two.id)) return { state: "invalid" };
  const validOne = isCephAcquisitionDate(one.xrayDate), validTwo = isCephAcquisitionDate(two.xrayDate);
  if (validOne && validTwo && one.xrayDate !== two.xrayDate) {
    // A reference parameter cannot silently change or pretend to confirm known chronology.
    if (referenceId !== undefined) return { state: "invalid" };
    const [before, after] = one.xrayDate! < two.xrayDate! ? [one, two] : [two, one];
    return { state: "resolved", before, after, ordering: { mode: "acquisition_date", chronology: "known", referenceId: before.id, comparisonId: after.id } };
  }
  if (referenceId !== undefined) {
    const [before, after] = one.id === referenceId ? [one, two] : [two, one];
    return { state: "resolved", before, after, ordering: { mode: "explicit_reference", chronology: "unknown", referenceId: before.id, comparisonId: after.id } };
  }
  return { state: "unresolved", reason: one.xrayDate == null || two.xrayDate == null ? "missing_date"
    : !validOne || !validTwo ? "invalid_date" : "equal_dates" };
}

/** Route and print query contract. Duplicate values are never coerced to IDs. */
export function parseCephComparisonQuery(params: { first?: unknown; second?: unknown; reference?: unknown }): { first: number; second: number; referenceId?: number } | null {
  const id = (value: unknown) => typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const first = id(params.first), second = id(params.second);
  const referenceId = params.reference === undefined ? undefined : id(params.reference);
  if (first === null || second === null || first === second || referenceId === null
      || (referenceId !== undefined && referenceId !== first && referenceId !== second)) return null;
  return { first, second, referenceId };
}

export function cephComparisonUrlParams(params: URLSearchParams) {
  const single = (key: string): unknown => { const values = params.getAll(key); return values.length === 0 ? undefined : values.length === 1 ? values[0] : values; };
  return parseCephComparisonQuery({ first: single("first"), second: single("second"), reference: single("reference") });
}

/** Re-resolve untrusted response metadata against the exact requested orientation. */
export function matchesCephComparisonOrdering(ordering: unknown, one: OrderableStudy, two: OrderableStudy, referenceId?: number): ordering is CephComparisonOrdering {
  if (!ordering || typeof ordering !== "object") return false;
  const resolved = resolveCephComparisonOrder(one, two, referenceId);
  if (resolved.state !== "resolved" || resolved.before.id !== one.id || resolved.after.id !== two.id) return false;
  const value = ordering as Record<string, unknown>, expected = resolved.ordering;
  return value.mode === expected.mode && value.chronology === expected.chronology
    && value.referenceId === expected.referenceId && value.comparisonId === expected.comparisonId;
}

export function cephOrderLabels(ordering: CephComparisonOrdering) {
  return ordering.mode === "acquisition_date"
    ? { before: "التصوير الأسبق", after: "التصوير اللاحق", notice: "الترتيب بحسب تاريخ التصوير المسجل. الفرق = التصوير اللاحق ناقص التصوير الأسبق؛ لا يثبت ذلك أثر العلاج." }
    : { before: "المرجع", after: "المقارنة", notice: CEPH_REFERENCE_NOTICE };
}

/** Browser-safe exact identity, including source hash (version label alone is insufficient). */
export function cephComparisonProvenanceKey(algorithm: {id:string;version:string;sourceSha256:string;calculationVersion:string|null;rounding:string}): string {
  return JSON.stringify([algorithm.id,algorithm.version,algorithm.sourceSha256,algorithm.calculationVersion,algorithm.rounding]);
}
