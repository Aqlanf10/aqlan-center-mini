import "server-only";
import { NextResponse } from "next/server";
import { getPool, patientInDoctorScopeWith, type DbClient } from "./db";
import {
  PatientNumberingError, changePatientNumberOn, numberingDatabaseError, numberingLocks, parsePatientNumberChange, snapshot,
} from "./patient-numbering-db";
import { patientNumberingErrorResponse } from "./patient-numbering-response";
import { NO_STORE, canonicalPatientReadFailure } from "./canonical-patient-http";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import { JSON_BODY_LIMIT_BYTES } from "./security-limits";
import { selectRequestStaffEnvelope } from "./staff-session-admission";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  assertStaffOperation, staffOperationIdentity, staffOperationPatientScope, withStaffOperation, type StaffOperationHandle,
} from "./staff-operation-runtime";

/**
 * Canonical patient file number (M2 slice 78): GET/PATCH /api/patients/[id]/number.
 *
 * - One admitted `patients.number.manage` operation (the legacy admin label; the catalogue
 *   makes it depend on `patients.edit`), inside the patient scope; outside reads and
 *   writes like missing (404). The GET is an operation too: it takes the same numbering
 *   locks as the legacy read, so it never shows a number a running import is changing.
 * - Lock order as legacy: admission (identity) first, then the numbering locks (import,
 *   numbering), then the patient row FOR UPDATE; the operation is re-asserted after the
 *   row wait (a revoked grant fails closed), as the legacy path re-authorized.
 * - The body (`changePatientNumberOn`) is the legacy one: stale version or number 409,
 *   same number 400, the update and the `patient.number.change` audit row together; the
 *   old number is retired by the database. No money.
 */
const missing = () => new PatientNumberingError("missing", "لم يُعثر على ملف المريض.");
function patientIdOf(raw: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(raw) || Number(raw) > 2147483647) throw new PatientNumberingError("invalid", "معرّف المريض غير صالح.");
  return Number(raw);
}

async function numberOperation<T>(session: VerifiedDurableSession, patientId: number, pool: ReturnType<typeof getPool>,
  work: (client: DbClient, handle: StaffOperationHandle) => Promise<T>): Promise<T> {
  try {
    return await withStaffOperation(pool, session, "patients.number.manage", async (client, handle) => {
      const scope = await staffOperationPatientScope(client, handle, "patients.number.manage");
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      if (scope.kind !== "all" && !await patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId)) throw missing();
      await numberingLocks(client);
      // Expiry or revocation while waiting on the domain locks fails closed.
      await assertStaffOperation(client, handle, "patients.number.manage");
      return work(client, handle);
    });
  } catch (error) {
    throw numberingDatabaseError(error);
  }
}

export async function readCanonicalPatientNumber(session: VerifiedDurableSession, rawPatientId: string, pool = getPool()) {
  const patientId = patientIdOf(rawPatientId);
  return numberOperation(session, patientId, pool, client => snapshot(client, patientId));
}

export async function commandCanonicalPatientNumber(session: VerifiedDurableSession, rawPatientId: string, body: Record<string, unknown>, pool = getPool()) {
  const patientId = patientIdOf(rawPatientId);
  const change = parsePatientNumberChange({
    patientNumber: body.patientNumber, expectedPatientNumber: body.expectedPatientNumber,
    expectedVersion: body.expectedVersion, reason: body.reason,
  });
  return numberOperation(session, patientId, pool, async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, "patients.number.manage");
    return changePatientNumberOn(client, patientId, change, { actor: identity.username, actorRole: identity.role },
      () => assertStaffOperation(client, handle, "patients.number.manage"));
  });
}

/** The canonical branch of the number routes (null for a legacy envelope). */
export async function canonicalPatientNumberRoute(
  request: Request | null,
  run: (handle: VerifiedDurableSession, body: Record<string, unknown>) => Promise<unknown>,
): Promise<NextResponse | null> {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind !== "canonical") return null;
  let body: Record<string, unknown> = {};
  if (request) {
    try {
      const raw = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return NextResponse.json({ message: "الطلب غير صالح." }, { status: 400, headers: NO_STORE });
      body = raw as Record<string, unknown>;
    } catch (error) {
      return bodyErrorResponse(error) ?? NextResponse.json({ message: "الطلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
  }
  try {
    return NextResponse.json(await run(selected.handle, body), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof PatientNumberingError) {
      const response = patientNumberingErrorResponse(error);
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    return canonicalPatientReadFailure(error, "تعذّر إتمام عملية الترقيم. حدّث المعاينة قبل المحاولة مجددًا.");
  }
}
