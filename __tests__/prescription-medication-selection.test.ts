import { describe, expect, it } from "vitest";
import { createManualMedicationSelection, manualMedicationSelectionError, MEDICATION_NAME_CHOICES } from "../lib/prescription-medication-selection";
import { checkPrescriptionDraft, sanitizeRxItems, buildSuggestions } from "../lib/prescription";
import { MEDICATION_TEMPLATES } from "../lib/prescription-medication-templates";
const selected = () => ({ ...createManualMedicationSelection("amoxicillin")!, dose: "synthetic concentration", form: "synthetic form", frequency: "synthetic frequency", duration: "synthetic duration", selection: { id: "amoxicillin" as const, amount: "synthetic amount", confirmed: true } });
const check = (items: unknown) => checkPrescriptionDraft({ patientId: 1, visitId: null, diagnosis: "", notes: "", instructionsLang: "both", items });
describe("explicit manual generic name selection", () => {
  it.each(MEDICATION_NAME_CHOICES)("%s adds only a name and requires review", choice => {
    const item = createManualMedicationSelection(choice.id)!;
    expect(item.name).toBe(choice.name);
    expect([item.form, item.dose, item.frequency, item.duration, item.instructions, item.instructionsEn, item.selection!.amount]).toEqual(Array(7).fill(""));
    expect(item.selection!.confirmed).toBe(false); expect(check([item]).ok).toBe(false);
    expect(MEDICATION_TEMPLATES).toEqual([]);
  });
  it("does not provide an automatic alternative or unknown choice", () => {
    expect(MEDICATION_NAME_CHOICES).toHaveLength(4);
    for (const value of ["clindamycin", "azithromycin", "unknown"]) expect(createManualMedicationSelection(value)).toBeNull();
    expect(createManualMedicationSelection("chlorhexidine")!.name).toBe("Chlorhexidine");
  });
  it.each(["name", "dose", "form", "frequency", "duration"])("server draft validation rejects missing %s before sanitization can drop the line", field => {
    expect(check([{ ...selected(), [field]: " " }]).ok).toBe(false);
  });
  it.each([{ id: "amoxicillin", amount: "", confirmed: true }, { id: "amoxicillin", amount: "fixture", confirmed: false }, { id: "amoxicillin", amount: "fixture", confirmed: "true" }, { id: "invalid", amount: "fixture", confirmed: true }, null])("rejects incomplete or forged review shape %j", selection => {
    expect(check([{ ...selected(), selection }]).ok).toBe(false);
  });
  it("preserves the manually confirmed dose in the stored JSON and prior suggestions", () => {
    const item = selected(); expect(check([item]).ok).toBe(true);
    expect(sanitizeRxItems([item])[0].selection).toEqual(item.selection);
    expect(buildSuggestions([{ items: [item], createdAt: "2026-10-30" }])[0].frequency).toBe("synthetic amount; synthetic frequency");
  });
  it("does not silently truncate a selected line beyond the item limit", () => {
    expect(check(Array.from({ length: 21 }, selected)).ok).toBe(false);
  });
  it("rejects missing review for new issuance while preserving legacy reads", () => {
    const legacy = { name: "Synthetic legacy item" };
    expect(manualMedicationSelectionError([legacy])).not.toBeNull();
    expect(check([legacy]).ok).toBe(false);
    expect(sanitizeRxItems([legacy])[0].name).toBe(legacy.name);
    const { selection: _selection, ...completeWithoutReview } = selected();
    expect(check([completeWithoutReview]).ok).toBe(false);
    expect(check([{ ...selected(), selection: { id: "manual", amount: "synthetic amount", confirmed: true } }]).ok).toBe(true);
  });
  it.each(["name", "form", "dose", "frequency", "duration"])("manual origin cannot omit %s", field => {
    const manual = { ...selected(), selection: { id: "manual", amount: "synthetic amount", confirmed: true } };
    expect(check([{ ...manual, [field]: "" }]).ok).toBe(false);
  });
  it("manual review cannot omit amount or confirmation and mixed invalid rows cannot disappear", () => {
    for (const selection of [{ id: "manual", confirmed: true }, { id: "manual", amount: "fixture" }, { id: "manual", amount: "fixture", confirmed: "true" }]) {
      expect(check([{ ...selected(), selection }]).ok).toBe(false);
    }
    expect(check([selected(), { ...selected(), name: "1".repeat(200) + "A" }]).ok).toBe(false);
    expect(check(Array.from({ length: 21 }, () => ({ name: "legacy-shaped" }))).ok).toBe(false);
  });

});
