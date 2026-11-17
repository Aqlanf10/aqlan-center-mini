export interface PagesApiEntry { file: string; route: string; methods: Record<string, string>; coreFiles: string[] }
export interface PagesApiIssue { file: string; reason: string; classification: 'unknown' }
export function inspectPagesHandler(file: string, source: string): Record<string, string>;
export function discoverPagesApi(root: string): { entries: PagesApiEntry[]; issues: PagesApiIssue[] };
export function readPagesCoreSource(root: string, relative: string): string;
