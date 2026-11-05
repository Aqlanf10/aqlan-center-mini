import { getClinicalInterpretation, getSeverityStars, interpret, MEASUREMENTS, type MeasurementResult } from "./ceph";

/** Quarantined clinical outputs stay in archival storage, but must not be
 * restored as a current value, grade, recommendation or comparison endpoint. */
export const CEPH_UNAVAILABLE_NOTICE = "مؤشر الخلع EXT_INDEX غير متاح حتى اكتمال التحقق من تعريفه السريري. القيم القديمة المحفوظة لا تُعرض ولا تُستخدم للتوصية بالخلع.";
export const isQuarantinedCephMeasurement = (code: string) => code === "EXT_INDEX";

export function displayableCephSnapshot<T extends { code: string }>(snapshot: readonly T[]): T[] {
  return snapshot.filter((row) => !isQuarantinedCephMeasurement(row.code));
}

/** Null means a live draft; an empty sealed snapshot still means no values,
 * never permission to recompute historical clinical measurements. */
export function presentCephMeasurements(
  live: MeasurementResult[], sealed: readonly { code: string; value: number }[] | null,
): MeasurementResult[] {
  const snapshot = sealed === null ? null : new Map(sealed.map((row) => [row.code, row.value]));
  return live.map((row) => {
    const quarantined = isQuarantinedCephMeasurement(row.code);
    const value = quarantined ? null : snapshot ? snapshot.get(row.code) ?? null : row.value;
    const finite = value !== null && Number.isFinite(value) ? value : null;
    const definition = MEASUREMENTS.find((item) => item.code === row.code);
    const interpretation = getClinicalInterpretation(row.code, finite);
    return { ...row, value: finite, display: finite === null ? "—" : String(finite),
      status: finite !== null && definition ? interpret(finite, definition) : null,
      severityStars: finite !== null && definition ? getSeverityStars(finite, definition.mean, definition.tol) : "",
      interpretationEn: interpretation.en, interpretationAr: interpretation.ar,
      ...(quarantined ? { note: CEPH_UNAVAILABLE_NOTICE } : {}),
    };
  });
}
