/** Patient-safe, preformatted presentation shared by preview, print and local file export.
 * Never add receipt notes, staff identities, audit history or raw ledger objects here. */
export interface PatientStatementDocument {
  patient: { name: string; number: string; phone?: string | null };
  title: string;
  subtitle?: string;
  generatedAt: string;
  clinic: { name: string; doctor?: string; credentials?: string; address?: string; phone?: string };
  sections: { title: string; columns: string[]; rows: string[][] }[];
  notices: string[];
  /** Selection metadata only. Neither this nor patient.phone is printed/exported. */
  treatments: { id: number; title: string }[];
}

export const PATIENT_STATEMENT_TYPES = {
  summary: "مختصر للمريض",
  detailed: "تفصيلي",
  ongoing: "الأعمال القائمة",
  period: "كشف فترة",
  treatment: "علاج أو اتفاق محدد",
} as const;

export type PatientStatementType = keyof typeof PATIENT_STATEMENT_TYPES;
