import type { PrescriptionDraft } from "./prescription";
/** Versioned clinical semantics; ephemeral safety tokens and mutable registry
 * labels are deliberately excluded. Actor binding is added on the server. */
export function canonicalPrescriptionCommand(draft: PrescriptionDraft): string {
  return JSON.stringify({ version: 1, patientId: draft.patientId, visitId: draft.visitId,
    prescribingDoctorPartyId: draft.prescribingDoctorPartyId ?? null,
    diagnosis: draft.diagnosis, notes: draft.notes, instructionsLang: draft.instructionsLang,
    items: draft.items.map(item => [item.name, item.dose, item.form, item.frequency, item.duration,
      item.instructions, item.instructionsEn, item.selection?.id ?? null, item.selection?.amount ?? null, item.selection?.confirmed ?? null]),
  });
}
export function validPrescriptionCommandKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
