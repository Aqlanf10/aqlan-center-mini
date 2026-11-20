import type { PatientNumberSequenceSnapshot } from "./patient-number-sequence.mjs";

export declare function prepareBackupSql(sql: string): {
  sql: string;
  dataSql: string;
  skippedMigrationRecordLines: number;
  sqlRowsStatementLines: number;
  patientNumberSequence: PatientNumberSequenceSnapshot | null;
};
