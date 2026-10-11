import { CLINICAL_CONTEXT_IDS, ORTHO_PILLARS, clinicalContextSearch, isClinicalId,
  type ClinicalNavigationContext, type PatientLocation } from "./patient-navigation";

/** A response already verified for one synchronous, same-owner pillar navigation. */
export interface VerifiedPillarContext {
  owner: object;
  patientId: number;
  authority: string;
  context: ClinicalNavigationContext;
}

export function samePatientLocation(a: PatientLocation, b: PatientLocation): boolean {
  return a.tab === b.tab && a.sub === b.sub && a.contextError === b.contextError
    && clinicalContextSearch(a.context ?? {}) === clinicalContextSearch(b.context ?? {});
}

/** Pillar is a view only. Every clinical edge, including absent edges, must remain identical. */
export function isSameOrthoPillarTransition(from: PatientLocation, to: PatientLocation): boolean {
  const a = from.context, b = to.context;
  if (from.contextError || to.contextError || from.tab !== "treatment" || to.tab !== "treatment"
    || from.sub !== "ortho" || to.sub !== "ortho" || !a || !b
    || !isClinicalId(a.patientId) || !isClinicalId(a.orthoCaseId)
    || a.endoTreatmentId !== undefined || b.endoTreatmentId !== undefined
    || !a.pillar || !b.pillar || !ORTHO_PILLARS.includes(a.pillar) || !ORTHO_PILLARS.includes(b.pillar)
    || a.pillar === b.pillar) return false;
  return CLINICAL_CONTEXT_IDS.every(key => a[key] === b[key]
    && (a[key] === undefined || isClinicalId(a[key])));
}
