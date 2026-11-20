export interface PatientNumberSequenceSnapshot {
  lastValue: string;
  isCalled: boolean;
}

export type PatientNumberSequenceRestoreStatus = "not-recorded" | "reconciled";

export const patientNumberSequenceMarker: string;
export function parsePatientNumberSequence(lastValue: unknown, isCalled: unknown): PatientNumberSequenceSnapshot;
export function patientNumberSequenceBackupLine(lastValue: unknown, isCalled: unknown): string;
export function restorePatientNumberSequence(
  client: { query(sql: string): Promise<{ rows: Record<string, unknown>[] }> },
  snapshot: PatientNumberSequenceSnapshot | null,
): Promise<PatientNumberSequenceRestoreStatus>;
