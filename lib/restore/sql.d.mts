export declare function prepareBackupSql(sql: string): {
  sql: string;
  dataSql: string;
  skippedMigrationRecordLines: number;
  sqlRowsStatementLines: number;
};
export declare function prepareBackupSql(sql: string, options: { inspectHistorical0079: true }): {
  sql: string;
  dataSql: string;
  skippedMigrationRecordLines: number;
  sqlRowsStatementLines: number;
  historical0079: { appliedAt: string } | null;
};
export declare const CANONICAL_SOURCE_SQL_MARKER: string;
export declare function isCanonicalSourceSql(sql: string): boolean;
