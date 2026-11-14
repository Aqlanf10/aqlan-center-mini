import { isAdjustmentDate } from "./ortho-adjustment-date";
import { createHash } from "node:crypto";
import type { SessionPayload } from "./auth";
import type { DbClient } from "./db";
import { IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key";
import { canAccessPatient } from "./patient-access";
import { revalidateSessionInTransaction } from "./session";
import type { ElasticClass, OrthoPhase } from "./ortho";

export interface OrthoAdjustmentRequest {
  key: string; patientId: number; session: SessionPayload;
  /** Server-derived raw-text refusal. Never copied from the HTTP payload.
   * Existing normalized journal matches may still reconcile; new writes may not. */
  newTextAdmissionError?: string | null;
  /** Server-derived interval refusal, with the same legacy replay ordering. */
  newIntervalAdmissionError?: string | null;
  /** Server-derived explicit date refusal; omitted/null API dates retain their legacy default. */
  newDateAdmissionError?: string | null;
  /** Only the HTTP route derives this from raw omission/null, never a body flag. */
  omittedDateForReplay?: boolean;
  /** Server-derived explicit visit identity refusal, after legacy receipt matching. */
  newVisitAdmissionError?: string | null;
  /** Server-derived enum refusal, never copied from an HTTP flag. */
  newEnumAdmissionError?: string | null;
}
interface CommandInput {
  caseId: number; visitId: number | null; doneOn: string; phase: OrthoPhase | null;
  upperWire: string | null; lowerWire: string | null; elastics: ElasticClass;
  elasticNote: string | null; done: string | null; nextWeeks: number; note: string | null;
  recordedBy: string; actorRole?: string | null;
  upperWireAction?: "remove"; lowerWireAction?: "remove";
  auxiliaries?: readonly string[] | null; auxiliaryOther?: string | null;
}
export interface AdjustmentResult { id: number; visitId: number | null; attachedToToday: boolean }
export class OrthoAdjustmentRequestError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 409, readonly code: string, message: string) { super(message); }
}
const fail = (status: 400 | 401 | 403 | 409, code: string, message: string): never => {
  throw new OrthoAdjustmentRequestError(status, code, message);
};
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
export interface PreparedAdjustmentRequest {
  request: OrthoAdjustmentRequest; hash: string; caseId: number; current: SessionPayload;
  prior: AdjustmentResult | null;
}
export async function revalidateAdjustmentRequestAuthority(client: DbClient, request: OrthoAdjustmentRequest): Promise<SessionPayload> {
  const current = await revalidateSessionInTransaction(request.session, client);
  if (!current || current.userId !== request.session.userId || current.username !== request.session.username
    || current.role !== request.session.role || current.expiresAt < Date.now()) {
    return fail(401, "session_expired", "انتهت الجلسة أو تغيّرت صلاحياتها؛ لم تُسجّل شدّة أخرى.");
  }
  if (!["admin", "doctor", "reception"].includes(current.role)
    || !await canAccessPatient(current, request.patientId, undefined, client, "nowait")) {
    fail(403, "patient_access_denied", "غير مصرّح لك بتسجيل شدّة لهذا المريض.");
  }
  return current;
}
/** Per-actor key is locked before automatic visit selection, so a retry cannot
 * be silently attached to a new visit that appeared after the first response. */
export async function prepareAdjustmentRequest(client: DbClient, input: CommandInput,
  request: OrthoAdjustmentRequest): Promise<PreparedAdjustmentRequest> {
  if (!request || typeof request.key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(request.key)
    || !positive(request.patientId) || !positive(request.session?.userId)
    || request.session.username !== input.recordedBy || request.session.role !== input.actorRole) {
    fail(400, "invalid_adjustment_request", "معرّف محاولة تسجيل الشدّة أو هويتها غير صالح.");
  }
  const hashForDate = (doneOn: string) => createHash("sha256").update(JSON.stringify({ version: 1, actorId: request.session.userId,
    patientId: request.patientId, caseId: input.caseId, visitId: input.visitId, doneOn, phase: input.phase,
    upperWire: input.upperWire, lowerWire: input.lowerWire, elastics: input.elastics, elasticNote: input.elasticNote,
    done: input.done, nextWeeks: input.nextWeeks, note: input.note,
    // Explicit removal is newer than the v1 fingerprint; it is hashed only when present,
    // so every earlier request keeps its exact hash and a toggled removal is a different body.
    ...(input.upperWireAction === "remove" ? { upperWireAction: "remove" } : {}),
    ...(input.lowerWireAction === "remove" ? { lowerWireAction: "remove" } : {}),
    // 0132 auxiliaries follow the same rule: hashed only when recorded (an empty list included), so a
    // request without them keeps its earlier hash and "none" differs from "not recorded".
    ...(input.auxiliaries == null ? {} : { auxiliaries: [...input.auxiliaries], auxiliaryOther: input.auxiliaryOther ?? null }) })).digest("hex");
  let hash = hashForDate(input.doneOn);
  // Fence reset before taking patient/visit/plan locks. Reset protects nonempty
  // command history and must never erase a key while an adjustment is in flight.
  await client.query("LOCK TABLE ortho_adjustment_requests IN ROW EXCLUSIVE MODE");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `aqlan-ortho-adjustment:${request.session.userId}:${request.key}`,
  ]);
  // Sign-off and patient merge lock the patient before visit and plan rows.
  // Ownership can hold a plan SHARE witness, so it must follow that same gate.
  await client.query("SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE", [request.patientId]);
  const current = await revalidateAdjustmentRequestAuthority(client, request);
  const { rows: [owner] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM ortho_cases WHERE id=$1", [input.caseId]);
  if (!owner || owner.patient_id !== request.patientId) fail(409, "case_scope_changed", "تغيّرت هوية حالة التقويم؛ أعد تحميل الملف.");
  const { rows: [row] } = await client.query<{
    request_hash: string; patient_id: number; case_id: number; adjustment_id: number;
    visit_id: number | null; attached_to_today: boolean; valid_scope: boolean;
  }>(`SELECT r.*, EXISTS (SELECT 1 FROM ortho_adjustments a JOIN ortho_cases c ON c.id=a.case_id
      LEFT JOIN visits v ON v.id=a.visit_id
      WHERE a.id=r.adjustment_id AND a.case_id=r.case_id AND c.patient_id=r.patient_id
        AND a.visit_id IS NOT DISTINCT FROM r.visit_id AND (a.visit_id IS NULL OR v.patient_id=r.patient_id)) AS valid_scope
    FROM ortho_adjustment_requests r WHERE r.actor_user_id=$1 AND r.request_key=$2`, [current.userId, request.key]);
  if (row && row.request_hash !== hash && row.patient_id === request.patientId
    && row.case_id === input.caseId && row.valid_scope && request.omittedDateForReplay === true) {
    // A recorded date is only a candidate. The complete unchanged v1 fingerprint
    // must prove it; neither mutable clinical data nor an absent raw field proves
    // the original command date by itself. No searching, rebinding, or rewriting.
    // Preserve patient → visit → adjustment ordering even though the candidate
    // lock itself is NOWAIT. Holding it before waiting on a visit could invert
    // a concurrent visit writer. The normal replay path rechecks this same visit.
    if (row.visit_id !== null) {
      await client.query("SELECT id FROM visits WHERE id = $1 FOR UPDATE", [row.visit_id]);
    }
    let candidate: { done_on: string } | undefined;
    try {
      const result = await client.query<{ done_on: string }>(`SELECT a.done_on::text AS done_on
        FROM ortho_adjustments a JOIN ortho_cases c ON c.id=a.case_id
        WHERE a.id=$1 AND a.case_id=$2 AND c.patient_id=$3
          AND a.visit_id IS NOT DISTINCT FROM $4::int FOR SHARE OF a NOWAIT`,
      [row.adjustment_id, input.caseId, request.patientId, row.visit_id]);
      candidate = result.rows[0];
    } catch (error) {
      // The caller rolls back before returning this typed busy result. Never wait
      // for a concurrent adjustment writer; the visit lock is already held.
      if ((error as { code?: string }).code === "55P03") {
        fail(409, "adjustment_receipt_busy", "سجل الجلسة قيد التعديل؛ أعد المحاولة بالمفتاح نفسه.");
      }
      throw error;
    }
    if (candidate && isAdjustmentDate(candidate.done_on)) {
      const candidateHash = hashForDate(candidate.done_on);
      if (candidateHash === row.request_hash) hash = candidateHash;
    }
  }
  if (row && (row.request_hash !== hash || row.patient_id !== request.patientId || row.case_id !== input.caseId)) {
    fail(409, "adjustment_request_conflict", "مفتاح المحاولة مستخدم بمحتوى أو حالة أخرى؛ لم تُسجّل شدّة جديدة.");
  }
  if (row && !row.valid_scope) fail(409, "adjustment_receipt_scope_changed", "تغيّر رابط الشدّة المحفوظة؛ راجع السجل قبل إعادة التسجيل.");
  return { request, hash, caseId: input.caseId, current, prior: row ? {
    id: row.adjustment_id, visitId: row.visit_id, attachedToToday: row.attached_to_today,
  } : null };
}
/** Same transaction as the adjustment and its audit: no orphaned command proof. */
export async function saveAdjustmentRequest(client: DbClient, prepared: PreparedAdjustmentRequest, result: AdjustmentResult): Promise<void> {
  await revalidateAdjustmentRequestAuthority(client, prepared.request);
  await client.query(`INSERT INTO ortho_adjustment_requests
    (actor_user_id, request_key, request_hash, patient_id, case_id, adjustment_id, visit_id, attached_to_today)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [prepared.current.userId, prepared.request.key, prepared.hash,
    prepared.request.patientId, prepared.caseId, result.id, result.visitId, result.attachedToToday]);
}
