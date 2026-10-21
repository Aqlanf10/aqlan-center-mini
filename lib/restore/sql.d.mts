export declare function scanBackupSqlStatements(sql: string): Array<{
  start: number;
  end: number;
  text: string;
}>;

export declare function createBackupSqlByteBoundaryMapper(bytes: Uint8Array): {
  sql: string;
  byteOffset(characterOffset: number): number;
};

export declare function prepareBackupSql(sql: string): {
  sql: string;
  dataSql: string;
  skippedMigrationRecordLines: number;
  sqlRowsStatementLines: number;
};
