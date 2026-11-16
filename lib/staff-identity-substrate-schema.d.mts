export const STAFF_IDENTITY_SUBSTRATE_VERSION: 1;
export const FROZEN_0076_SHA256: string;
export const IDENTITY_TABLES: readonly string[];
export function staffIdentitySchemaName(value?: unknown): string;
export function substrateFunctions(schema?: string): Record<string, string>;
/** Returns unregistered proposal SQL. Does not execute or install it. */
export function staffIdentitySubstrateSql(schema?: string): string;
