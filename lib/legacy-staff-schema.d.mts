export interface LegacySchemaSource { query(sql: string, values?: unknown[]): Promise<{rows: any[]}> }
export function staffLifecycleLockKey(schema?: string): string;
export function readLegacyStaffSchema(source: LegacySchemaSource, schema?: string): Promise<"base" | "empty">;
