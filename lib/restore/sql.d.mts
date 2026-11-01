export declare function prepareBackupSql(sql: string, options?: {migrationFiles?: ReadonlyArray<{version: string; checksum: string}>}): {
  sql: string;
  dataSql: string;
  skippedMigrationRecordLines: number;
  sqlRowsStatementLines: number;
};
