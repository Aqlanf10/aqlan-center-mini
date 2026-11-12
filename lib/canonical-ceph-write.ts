import "server-only";
import type { SessionPayload } from "./auth";
import { canonicalCephAdmission } from "./canonical-ceph-admission";
import type { CephCanonicalAdmit } from "./ceph-draft-authority";
import { ClinicalMutationAuthorityError } from "./clinical-mutation-authority";
import { getPool, patientInDoctorScopeWith, runCephWritersInTransaction, type DbClient } from "./db";
import { revalidateVerifiedDurableSession, type VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationIdentity, staffOperationPatientScope, withStaffOperation, type StaffOperationHandle, type StaffRuntimeAction } from "./staff-operation-runtime";

/** Outcome a canonical ceph command turns into its own refusal class. */
export class CanonicalCephWriteFailure extends Error {
  constructor(readonly kind: "not_found" | "conflict" | "expired", message: string) { super(message); this.name = "CanonicalCephWriteFailure"; }
}
const NOT_AVAILABLE = "الدراسة غير متاحة ضمن مرضاك.";

export interface CanonicalCephWriteContext {
  client: DbClient;
  handle: StaffOperationHandle;
  patientId: number;
  documentId: number;
  admit: CephCanonicalAdmit;
  /** The admitted operation actor, for writers that take a signer up front (completion). */
  actor: SessionPayload;
}

/** No record scope at all is the runtime's 403 refusal; a patient outside "own" scope is "not available" (404). */
async function scopeAllows(client: DbClient, handle: StaffOperationHandle, action: StaffRuntimeAction, patientId: number) {
  const scope = await staffOperationPatientScope(client, handle, action);
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  return scope.kind === "all" || await patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId);
}

/**
 * Runs one of staging's protected ceph writers inside the admitted staff operation. The writer
 * keeps its own lock order, snapshot/source/provenance checks, replay rules and audit; its
 * transaction becomes a savepoint of this operation. A refused write (`ok: false`) rolls the
 * whole operation back, so nothing it did survives. Out-of-scope studies are "not available"
 * before and after the writer's patient lock; the capability is re-asserted before commit.
 */
export async function runCanonicalCephWrite<T>(
  session: VerifiedDurableSession, action: StaffRuntimeAction,
  target: { kind: "study"; id: number } | { kind: "patient"; patientId: number; documentId: number },
  write: (context: CanonicalCephWriteContext) => Promise<{ ok: true; value: T } | { ok: false; message: string }>,
  pool = getPool(),
): Promise<T> {
  try {
    return await withStaffOperation(pool, session, action, async (client, handle) => {
      let patientId: number, documentId: number;
      if (target.kind === "study") {
        const { rows: [study] } = await client.query<{ patient_id: number; document_id: number }>(
          "SELECT patient_id, document_id FROM ceph_analyses WHERE id = $1 AND status <> 'discarded'", [target.id]);
        if (!study) throw new CanonicalCephWriteFailure("not_found", NOT_AVAILABLE);
        patientId = study.patient_id; documentId = study.document_id;
      } else ({ patientId, documentId } = target);
      if (!await scopeAllows(client, handle, action, patientId)) throw new CanonicalCephWriteFailure("not_found", NOT_AVAILABLE);
      const identity = await staffOperationIdentity(client, handle, action);
      const claims = revalidateVerifiedDurableSession(session);
      if (!claims || claims.userId !== identity.userId || claims.username !== identity.username) throw new CanonicalCephWriteFailure("expired", "انتهت الجلسة أو تغيّرت صلاحياتها.");
      const actor = { userId: identity.userId, username: identity.username, role: identity.role, expiresAt: claims.expiresAt };
      const admit = canonicalCephAdmission(session, handle, action);
      const result = await runCephWritersInTransaction(client, () => write({ client, handle, patientId, documentId, admit, actor }));
      if (!result.ok) throw new CanonicalCephWriteFailure("conflict", result.message);
      return result.value;
    });
  } catch (error) {
    if (error instanceof CanonicalCephWriteFailure) throw error;
    if (error instanceof ClinicalMutationAuthorityError) {
      throw new CanonicalCephWriteFailure(error.status === 403 ? "not_found" : error.status === 401 ? "expired" : "conflict",
        error.status === 403 ? NOT_AVAILABLE : error.message);
    }
    if (error && typeof error === "object" && "code" in error && ["55P03", "40P01", "40001"].includes(String((error as { code: unknown }).code))) {
      throw new CanonicalCephWriteFailure("conflict", "تغيّرت الدراسة أو مراجعها أثناء الحفظ؛ لم يُحفظ شيء. حدّث الدراسة وأعد المحاولة.");
    }
    throw error;
  }
}

/** Positive int4 identity from a route segment. */
export function cephRouteId(raw: string): number | null {
  const id = Number(raw);
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(id) && id <= 2147483647 ? id : null;
}
