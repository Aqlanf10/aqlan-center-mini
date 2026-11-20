import { AsyncLocalStorage } from "node:async_hooks";
import { PATIENT_NUMBER_SQL } from "./document-numbers";
import { parseCanonicalPatientNumber } from "./patient-numbering-policy";

export interface PatientNumberingQueryClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
type Allocate = (client: PatientNumberingQueryClient) => Promise<string>;
const scopes = new AsyncLocalStorage<{ active: boolean; allocate: Allocate }>();

/** Private server-side injection point. No environment configuration or route
 * installs this in the app. Only the isolated browser/PG fixture supplies one.
 * Installed failures must never fall back to the legacy counter. */
export function withPatientNumberingInsertScope<T>(allocate: Allocate, work: () => Promise<T>): Promise<T> {
  if (scopes.getStore()) throw new Error("Nested patient numbering context refused");
  const scope = { active: true, allocate };
  return scopes.run(scope, async () => {
    try { return await work(); }
    finally { scope.active = false; }
  });
}

export async function patientNumberingInsertValue(client: PatientNumberingQueryClient, position: number) {
  const scope = scopes.getStore();
  if (!scope) return { sql: PATIENT_NUMBER_SQL, values: [] as string[] };
  if (!scope.active || !Number.isSafeInteger(position) || position < 1 || position > 100) {
    throw new Error("Invalid or expired patient numbering context");
  }
  const number = await scope.allocate(client);
  if (!scope.active || !parseCanonicalPatientNumber(number)) throw new Error("Invalid allocated patient identifier");
  return { sql: `$${position}::text`, values: [number] };
}
