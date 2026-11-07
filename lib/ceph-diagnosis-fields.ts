export interface CephDiagnosisFields {
  skeletal: string;
  dental: string;
  softTissue: string;
  finalDx: string;
  note: string;
}

/** Explicit UI assistance may fill empty observations, never replace authored
 * text or the clinician's notes. Saving still requires the existing save action. */
export function fillEmptyCephDiagnosisFields(
  current: CephDiagnosisFields,
  suggestion: Pick<CephDiagnosisFields, "skeletal" | "dental" | "softTissue" | "finalDx">,
): CephDiagnosisFields {
  const next = { ...current };
  for (const field of ["skeletal", "dental", "softTissue", "finalDx"] as const) {
    if (!current[field].trim()) next[field] = suggestion[field];
  }
  return next;
}
