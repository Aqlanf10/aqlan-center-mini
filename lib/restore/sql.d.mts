export declare function prepareBackupSql(sql: string, options?: {migrationFiles?: ReadonlyArray<{version: string; checksum: string}>}): {
  sql: string;
  dataSql: string;
  skippedMigrationRecordLines: number;
  sqlRowsStatementLines: number;
};
export declare const CANONICAL_SOURCE_SQL_MARKER: string;
export declare function isCanonicalSourceSql(sql: string): boolean;
