export declare function patientNumberRestoreGuard(sourceHasPolicy: boolean): string;
export declare const managedPatientNumberRestoreGuard: string;
export declare function prepareBackupSql(sql: string): {
  sql: string;
  dataSql: string;
  skippedMigrationRecordLines: number;
  sqlRowsStatementLines: number;
};
