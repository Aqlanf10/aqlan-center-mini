export const OFFICIAL_BRACES_INTEGRITY: string;
export const OFFICIAL_BRACES_ARCHIVE: string;
export interface OfficialBracesFixture {
  directory: string;
  hashes: Record<string, string>;
  integrity: string;
  cleanup(): void;
}
export function verifyFixtureDirectory(directory: string): Record<string, string>;
export function extractOfficialBracesFixture(archivePath?: string): OfficialBracesFixture;
export function loadOfficialBracesFixture(options?: { dependencyRequire?: NodeRequire }): OfficialBracesFixture & { module: any };
