import "server-only";
import { PATIENT_CREATE_SHARED_LOCK_SQL, createPatientWith, duplicateCandidatesWith, getPool, insertAuditRow } from "./db";
import { PATIENT_AUDIT_FIELDS, auditSnapshot } from "./audit-diff";
import { duplicateWarning, findDuplicates, type DuplicateMatch } from "./duplicates";
import type { PatientInput } from "./patient";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";

/**
 * Canonical patient creation (M2 slice 1b, POST /api/patients).
 *
 * One admitted operation for the exact capability `patients.create` (withStaffOperation:
 * READ COMMITTED, shared identity fence, FOR SHARE proof). In that same transaction:
 *  1. the shared patient-import lock (a running import is never interleaved);
 *  2. duplicate detection against the rows as they are at that moment;
 *  3. the INSERT;
 *  4. the audit row, written atomically with the patient: no create without its audit.
 * Duplicate candidates are other patients' identities. They are disclosed only to an
 * actor whose CURRENT patient scope is `all`; any other actor gets the bounded warning
 * (how many, never who), and may still confirm the creation.
 * The previous-balance step is a finance operation outside this capability and is not
 * canonical yet (`finance.opening-balances.manage` is a proposed name), so the route
 * refuses it rather than silently dropping it.
 */
export type CanonicalPatientCreateResult =
  | { readonly kind: "created"; readonly patient: { id: number; patientNumber: string; fullName: string } }
  | { readonly kind: "duplicates"; readonly message: string; readonly duplicates: readonly DuplicateMatch[]; readonly disclosed: boolean };

export async function commandCanonicalPatientCreate(
  session: VerifiedDurableSession,
  input: PatientInput,
  confirmDuplicate: boolean,
  pool = getPool(),
): Promise<CanonicalPatientCreateResult> {
  return withStaffOperation(pool, session, "patients.create", async (client, handle) => {
    await client.query(PATIENT_CREATE_SHARED_LOCK_SQL);
    if (!confirmDuplicate) {
      const matches = findDuplicates(input, await duplicateCandidatesWith(client, input));
      if (matches.length > 0) {
        const disclosed = (await staffOperationPatientScope(client, handle, "patients.create")).kind === "all";
        return { kind: "duplicates", message: duplicateWarning(matches), duplicates: disclosed ? matches : [], disclosed };
      }
    }
    const created = await createPatientWith(client, input);
    const actor = await staffOperationIdentity(client, handle, "patients.create");
    await insertAuditRow(client, {
      action: "patient.create",
      entity: "patient", entityId: created.id, entityLabel: `${created.fullName} (${created.patientNumber})`,
      details: { ...auditSnapshot(created as unknown as Record<string, unknown>, PATIENT_AUDIT_FIELDS), تأكيد_رغم_التكرار: confirmDuplicate },
      actor: actor.username, actorRole: actor.role,
    });
    return { kind: "created", patient: { id: created.id, patientNumber: created.patientNumber, fullName: created.fullName } };
  });
}
