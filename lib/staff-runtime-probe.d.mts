import type { SubstrateClient } from "./staff-identity-substrate.mjs";
/** Shape diagnostic only; never an admission capability. */
export function inspectStaffRuntimeSchema(source: SubstrateClient, schema?: string): Promise<Readonly<{version:2;schema:string;fingerprint:string}>>;
