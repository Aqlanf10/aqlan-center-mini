export declare function loadRestoreMigrationChecksums(): Promise<Array<{
  version: string;
  name: string;
  filename: string;
  checksum: string;
}>>;
