/** Year-only approximation at the recorded radiograph date, never a maturity
 * assessment. An undated archive cannot borrow the patient's age today. */
export function cephAgeAtXray(birthYear: number | null | undefined, xrayDate: string | null | undefined): number | undefined {
  if (typeof birthYear !== "number" || !Number.isInteger(birthYear) || birthYear <= 0 || !xrayDate || !/^\d{4}-\d{2}-\d{2}$/.test(xrayDate)) return undefined;
  const date = new Date(`${xrayDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== xrayDate) return undefined;
  const age = date.getUTCFullYear() - birthYear;
  return age >= 0 ? age : undefined;
}
