import type { RxItem } from "./prescription";

/** Generic-name metadata is not approval of a dosing regimen. Every new line,
 * including free entry (id=manual), requires this review contract. Legacy stored
 * rows may omit it and are read/printed without invoking issuance validation. */
export const MEDICATION_NAME_CHOICES = [
  { id: "paracetamol", name: "Paracetamol (Acetaminophen)" },
  { id: "ibuprofen", name: "Ibuprofen" },
  { id: "amoxicillin", name: "Amoxicillin" },
  { id: "chlorhexidine", name: "Chlorhexidine" },
] as const;
export type MedicationNameChoiceId = typeof MEDICATION_NAME_CHOICES[number]["id"];
export interface ManualMedicationSelection { id: MedicationNameChoiceId | "manual"; amount: string; confirmed: boolean }
export function createManualMedicationSelection(id: string): RxItem | null {
  const choice = MEDICATION_NAME_CHOICES.find(value => value.id === id);
  return choice ? { name: choice.name, dose: "", form: "", frequency: "", duration: "", instructions: "", instructionsEn: "",
    selection: { id: choice.id, amount: "", confirmed: false } } : null;
}
export function manualMedicationSelectionError(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item || typeof item !== "object") return `بيانات الدواء في السطر ${index + 1} غير صالحة.`;
    const selection = item.selection;
    if (!selection || typeof selection !== "object" || (selection.id !== "manual" && !MEDICATION_NAME_CHOICES.some(choice => choice.id === selection.id)))
      return `بيانات مقدار الجرعة ومراجعة الطبيب في السطر ${index + 1} مفقودة أو غير صالحة.`;
    if (![item.name, item.form, item.dose, selection.amount, item.frequency, item.duration].every(value => typeof value === "string" && value.trim())
      || !/[A-Za-z]/.test(item.name))
      return `أكمل اسم الدواء والشكل والتركيز ومقدار الجرعة والتكرار والمدة في السطر ${index + 1} قبل الإصدار أو المعاينة.`;
    if (selection.confirmed !== true) return `راجع وأكّد تفاصيل الدواء في السطر ${index + 1} قبل الإصدار أو المعاينة.`;
  }
  return null;
}
