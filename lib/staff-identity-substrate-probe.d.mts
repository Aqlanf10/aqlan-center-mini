import type { SubstrateClient } from "./staff-identity-substrate.mjs";
export interface SubstrateCatalogue {
 relations: readonly Record<string, unknown>[];
 columns: readonly Record<string, unknown>[];
 constraints: readonly Record<string, unknown>[];
 indexes: readonly Record<string, unknown>[];
 triggers: readonly Record<string, unknown>[];
 functions: readonly Record<string, unknown>[];
}
export function readStaffIdentitySubstrateCatalogue(source: SubstrateClient, schema?: string): Promise<SubstrateCatalogue>;
export function inspectStaffIdentitySubstrate(source: SubstrateClient, schema?: string): Promise<Readonly<{version: 1; schema: string; fingerprint: string}>>;
