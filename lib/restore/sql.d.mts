type MigrationProvenance = ReadonlyArray<{ version: string; checksum: string }>;
export declare function prepareBackupSql(sql: string, options?: { migrationFiles?: MigrationProvenance }): {
  sql: string;
  dataSql: string;
  skippedMigrationRecordLines: number;
  sqlRowsStatementLines: number;
};
export declare function prepareBackupSql(sql: string, options: { inspectHistorical0079: true; migrationFiles?: MigrationProvenance }): {
  sql: string;
  dataSql: string;
  skippedMigrationRecordLines: number;
  sqlRowsStatementLines: number;
  historical0079: { appliedAt: string } | null;
  historical0079Footprint: boolean;
};
export declare const CANONICAL_SOURCE_SQL_MARKER: string;
export declare function isCanonicalSourceSql(sql: string): boolean;
