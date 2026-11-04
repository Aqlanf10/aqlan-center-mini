import type { DbClient } from "./db";
/** Shape diagnostic only; never an admission capability. */
export function inspectStaffRuntimeSchema(source: Pick<DbClient, "query">, schema?: string): Promise<Readonly<{version:2;schema:string;fingerprint:string}>>;
