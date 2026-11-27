import type { PatientNumberSequenceSnapshot } from "./patient-number-sequence.mjs";

export declare function prepareBackupSql(sql: string): {
  sql: string;
  dataSql: string;
  skippedMigrationRecordLines: number;
  sqlRowsStatementLines: number;
  patientNumberSequence: PatientNumberSequenceSnapshot | null;
};
export declare function prepareBackupSql(sql: string, options: { inspectHistorical0079: true; rejectUnsupportedHistoricalSchema?: true }): {
  sql: string;
  dataSql: string;
  skippedMigrationRecordLines: number;
  sqlRowsStatementLines: number;
  patientNumberSequence: PatientNumberSequenceSnapshot | null;
  historical0079: { appliedAt: string } | null;
  historical0079Footprint: boolean;
};
export declare function prepareBackupSql(sql: string, options: { inspectHistorical0079: true }): {
  sql: string;
  dataSql: string;
  skippedMigrationRecordLines: number;
  sqlRowsStatementLines: number;
  historical0079: { appliedAt: string } | null;
  historical0079Footprint: boolean;
};
export declare const CANONICAL_SOURCE_SQL_MARKER: string;
export declare function isCanonicalSourceSql(sql: string): boolean;
