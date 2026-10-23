import { encodeFollowupCursor, type FollowupPageOptions } from "./appointment-followup-page";
import { createHash } from "node:crypto";
import { getPool, insertAuditRow, CLINIC_TIME_ZONE, type DbClient, type DbPool } from "./db";
import type { SessionPayload } from "./auth";
import { revalidateSessionInTransaction } from "./session";
import { canAccessPatient } from "./patient-access";
import { PURCHASE_RESET_FENCE } from "./clinic-reset";
import { PLANNED_REBOOK_GENERATION_SQL } from "./planned-visit-rebooking-contract";
import { parseFollowupCommand, followupFingerprintInput } from "./appointment-followup-contract";
import { followupEligibilitySql } from "./appointment-followup-eligibility";

/** Shared with isolated EXPLAIN acceptance; limits and generation remain bound parameters. */
export const FOLLOWUP_QUEUE_SQL = `SELECT f.id,f.revision,f.source_appointment_id,f.source_created_at,f.generation,
      f.assignee_user_id,f.due_at,f.outcome,f.next_step,f.due_at < clock_timestamp() AS overdue,
      p.id AS patient_id,p.full_name,to_char(f.due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_due,${followupEligibilitySql("$1")} AS eligible
      FROM appointment_followups f
      LEFT JOIN appointment_followup_links l ON l.followup_id=f.id
      LEFT JOIN appointments a ON a.id=l.appointment_id AND a.id=f.source_appointment_id
        AND EXTRACT(EPOCH FROM a.created_at)::text=f.source_created_at AND a.patient_id=l.patient_id
      LEFT JOIN patients p ON p.id=a.patient_id
      WHERE f.generation=$6 AND f.status='open'
      AND ($2::int IS NULL OR p.id=$2)
      AND ($3::timestamptz IS NULL OR (f.due_at,f.id)>($3::timestamptz,$4::int))
      ORDER BY f.due_at,f.id LIMIT $5`;

export class FollowupRejected extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409, readonly code: string) { super(code); }
}
function reject(status: FollowupRejected["status"], code: string): never { throw new FollowupRejected(status, code); }
function allowed(role: string): boolean { return role === "admin" || role === "reception"; }

/** Local transaction wrapper: discard uncertain connections, preserve original errors.
 * A failed COMMIT can have committed: the caller must retain its exact request. */
export async function followupTransaction<T>(pool: DbPool, work: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let began = false;
  let committing = false;
  let destroy = false;
  let value: T;
  try {
    try { await client.query("BEGIN"); began = true; } catch (error) { destroy = true; throw error; }
    value = await work(client);
    committing = true;
    await client.query("COMMIT");
  } catch (error) {
    if (committing) destroy = true;
    if (began) { try { await client.query("ROLLBACK"); } catch { destroy = true; } }
    try { client.release(destroy); } catch { /* Keep the original transaction failure. */ }
    throw error;
  }
  client.release(false);
  return value;
}

interface Source { id: number; patient_id: number; source_created_at: string; eligible: boolean }
interface Task { id: number; revision: number; status: string }
interface LiveLink { patient_id: number | null; appointment_id: number | null }
export interface FollowupSaved { followupId: number; revision: number; replayed: boolean }

/** Server-produced draft identity. A later command must still revalidate these
 * witnesses against the locked source, including before returning any receipt. */
export async function readAppointmentFollowupSource(appointmentId: number, admitted: SessionPayload) {
  if (!Number.isInteger(appointmentId) || appointmentId <= 0 || appointmentId > 2147483647) reject(400, "INVALID_FOLLOWUP_SOURCE");
  if (!allowed(admitted.role)) reject(403, "FOLLOWUP_ROLE");
  return followupTransaction(getPool(), async client => {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [PURCHASE_RESET_FENCE]);
    const session = await revalidateSessionInTransaction(admitted, client);
    if (!session) reject(401, "FOLLOWUP_SESSION_CHANGED");
    if (!allowed(session.role)) reject(403, "FOLLOWUP_ROLE");
    const { rows: [source] } = await client.query<{
      appointmentId: number; expectedPatientId: number; sourceCreatedAt: string; generation: string;
    }>(`SELECT a.id AS "appointmentId",p.id AS "expectedPatientId",
      EXTRACT(EPOCH FROM a.created_at)::text AS "sourceCreatedAt",${PLANNED_REBOOK_GENERATION_SQL} AS generation
      FROM appointments a JOIN patients p ON p.id=a.patient_id WHERE a.id=$1`, [appointmentId]);
    if (!source) reject(404, "FOLLOWUP_SOURCE_UNAVAILABLE");
    if (!await canAccessPatient(session, source.expectedPatientId, undefined, client)) reject(403, "FOLLOWUP_PATIENT_ACCESS");
    if (session.expiresAt < Date.now()) reject(401, "FOLLOWUP_SESSION_CHANGED");
    return source;
  });
}

/** Current open backlog, independent of the leadership selected-day counters.
 * Patient context is live, behind current authority, and never persisted here.
 * Missing/reassigned/reused sources expose no patient context. No bootstrap/write. */
export async function readAppointmentFollowupQueue(admitted: SessionPayload, options: FollowupPageOptions = { limit: 100, patientId: null, cursor: null }) {
  if (!allowed(admitted.role)) reject(403, "FOLLOWUP_ROLE");
  return followupTransaction(getPool(), async client => {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [PURCHASE_RESET_FENCE]);
    const session = await revalidateSessionInTransaction(admitted, client);
    if (!session) reject(401, "FOLLOWUP_SESSION_CHANGED");
    if (!allowed(session.role)) reject(403, "FOLLOWUP_ROLE");
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) reject(400, "INVALID_FOLLOWUP_PAGE");
    if (options.patientId !== null && !await canAccessPatient(session, options.patientId, undefined, client)) reject(403, "FOLLOWUP_PATIENT_ACCESS");
    const { rows: [generation] } = await client.query<{ value: string }>(`SELECT ${PLANNED_REBOOK_GENERATION_SQL} AS value`);
    if (options.cursor && (options.cursor.generation !== generation.value || options.cursor.patientId !== options.patientId)) reject(409, "FOLLOWUP_GENERATION_CHANGED");
    // Only these two roles have unrestricted patient-read authority. Keep this
    // hard boundary if roles are ever expanded; do not reuse the query for HR.
    const { rows } = await client.query<{
      id: number; revision: number; source_appointment_id: number; source_created_at: string; generation: string;
      assignee_user_id: number; due_at: Date; outcome: string; next_step: string; overdue: boolean;
      patient_id: number | null; full_name: string | null; eligible: boolean; cursor_due: string;
    }>(FOLLOWUP_QUEUE_SQL, [CLINIC_TIME_ZONE, options.patientId, options.cursor?.due ?? null, options.cursor?.id ?? null, options.limit + 1, generation.value]);
    if (session.expiresAt < Date.now()) reject(401, "FOLLOWUP_SESSION_CHANGED");
    const selected = rows.slice(0, options.limit);
    const last = selected.at(-1);
    return { timeZone: CLINIC_TIME_ZONE, items: selected.map(({ cursor_due: _cursorDue, ...row }) => ({ ...row,
      sourceState: row.patient_id === null ? "source_unavailable_review_required" as const
        : !row.eligible ? "source_ineligible_review_required" as const : "available" as const,
      contactBlocked: row.patient_id === null || !row.eligible,
      // First slice never claims a proved replacement booking.
      rebookingBlocked: true,
      sourceIdentity: row.patient_id === null ? null : {
        appointmentId: row.source_appointment_id, expectedPatientId: row.patient_id,
        sourceCreatedAt: row.source_created_at, generation: row.generation,
      },
    })), hasMore: rows.length > options.limit,
      nextCursor: rows.length > options.limit && last ? encodeFollowupCursor({ due: last.cursor_due, id: last.id, generation: generation.value, patientId: options.patientId }) : null };
  });
}

/** Schema bootstrap is owned by ensureSchema / numbered migration 0070.
 * Lock order: shared reset fence -> actor/key -> source -> task/link NOWAIT -> users NOWAIT ->
 * patient NOWAIT. Conflicting merge/session writers fail closed without lock inversion.
 * No booking, attendance, visit, payment or HR writer is invoked. */
export interface FollowupRetirementProof {
  outcome: "committed" | "retired";
  requestId: string;
  actorUserId: number;
  fingerprint: string;
}
export function saveAppointmentFollowup(value: unknown, admitted: SessionPayload): Promise<FollowupSaved> {
  return mutateAppointmentFollowup(value, admitted, false);
}
export function retireAppointmentFollowup(value: unknown, admitted: SessionPayload): Promise<FollowupRetirementProof> {
  return mutateAppointmentFollowup(value, admitted, true);
}
function mutateAppointmentFollowup(value: unknown, admitted: SessionPayload, retire: false): Promise<FollowupSaved>;
function mutateAppointmentFollowup(value: unknown, admitted: SessionPayload, retire: true): Promise<FollowupRetirementProof>;
async function mutateAppointmentFollowup(value: unknown, admitted: SessionPayload, retire: boolean): Promise<FollowupSaved | FollowupRetirementProof> {
  const command = parseFollowupCommand(value);
  if (!command) reject(400, "INVALID_FOLLOWUP");
  if (!allowed(admitted.role)) reject(403, "FOLLOWUP_ROLE");
  const fingerprint = createHash("sha256").update(followupFingerprintInput(command)).digest("hex");
  try {
    return await followupTransaction(getPool(), async client => {
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [PURCHASE_RESET_FENCE]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`appointment-followup:${admitted.userId}:${command.requestId}`]);
      // Lock source before evaluating eligibility in a fresh READ COMMITTED snapshot.
      await client.query("SELECT id FROM appointments WHERE id=$1 FOR UPDATE", [command.appointmentId]);
      const { rows: [source] } = await client.query<Source>(`SELECT a.id, a.patient_id,
        EXTRACT(EPOCH FROM a.created_at)::text AS source_created_at,
        ${followupEligibilitySql("$2")} AS eligible
        FROM appointments a WHERE a.id=$1`, [command.appointmentId, CLINIC_TIME_ZONE]);
      const { rows: [generation] } = await client.query<{ value: string }>(`SELECT ${PLANNED_REBOOK_GENERATION_SQL} AS value`);
      if (generation.value !== command.generation) reject(409, "FOLLOWUP_GENERATION_CHANGED");
      if (!source || source.source_created_at !== command.sourceCreatedAt
        || source.patient_id !== command.expectedPatientId) reject(409, "FOLLOWUP_SOURCE_CHANGED");
      // Patient merge updates FKs alphabetically: followup_links before appointments.
      // We already hold the appointment, so never wait on its task or live link:
      // abort with 55P03/FOLLOWUP_BUSY and release the source for the merge.
      const { rows: [task] } = await client.query<Task>(`SELECT id, revision, status
        FROM appointment_followups WHERE source_appointment_id=$1 AND source_created_at=$2 AND generation=$3 FOR UPDATE NOWAIT`,
      [command.appointmentId, command.sourceCreatedAt, command.generation]);
      if (task) {
        const { rows: [link] } = await client.query<LiveLink>(
          "SELECT appointment_id, patient_id FROM appointment_followup_links WHERE followup_id=$1 FOR UPDATE NOWAIT", [task.id]);
        // Never reconstruct a vanished link from the immutable numeric source ID.
        if (!link || link.appointment_id !== source.id || link.patient_id !== source.patient_id) reject(409, "FOLLOWUP_SOURCE_CHANGED");
      }
      // Prelock accounts NOWAIT before canonical session revalidation (which uses SHARE).
      const { rows: users } = await client.query<{ id: number; role: string; is_active: boolean }>(
        "SELECT id, role, is_active FROM users WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE NOWAIT",
        [[admitted.userId, command.assigneeUserId]]);
      const session = await revalidateSessionInTransaction(admitted, client);
      if (!session) reject(401, "FOLLOWUP_SESSION_CHANGED");
      if (!allowed(session.role)) reject(403, "FOLLOWUP_ROLE");
      if (command.expectedActorUserId !== session.userId) reject(409, "FOLLOWUP_ACTOR_CHANGED");
      const { rows: patients } = await client.query("SELECT id FROM patients WHERE id=$1 FOR KEY SHARE NOWAIT", [source.patient_id]);
      if (!patients.length || !await canAccessPatient(session, source.patient_id, undefined, client)) reject(403, "FOLLOWUP_PATIENT_ACCESS");
      const { rows: [receipt] } = await client.query<{ fingerprint: string; followup_id: number; revision: number }>(
        `SELECT r.fingerprint, e.followup_id, e.revision FROM appointment_followup_receipts r
         JOIN appointment_followup_events e ON e.id=r.event_id WHERE r.actor_user_id=$1 AND r.request_id=$2`,
      [session.userId, command.requestId]);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint || receipt.followup_id !== task?.id) reject(409, "FOLLOWUP_KEY_CONFLICT");
        if (session.expiresAt < Date.now()) reject(401, "FOLLOWUP_SESSION_CHANGED");
        if (retire) return { outcome: "committed", requestId: command.requestId, actorUserId: session.userId, fingerprint };
        return { followupId: receipt.followup_id, revision: receipt.revision, replayed: true };
      }
      const { rows: [retired] } = await client.query<{ fingerprint: string }>(
        "SELECT fingerprint FROM appointment_followup_retirements WHERE actor_user_id=$1 AND request_id=$2",
        [session.userId, command.requestId]);
      if (retired) {
        if (retired.fingerprint !== fingerprint) reject(409, "FOLLOWUP_KEY_CONFLICT");
        if (!retire) reject(409, "FOLLOWUP_ATTEMPT_RETIRED");
        if (session.expiresAt < Date.now()) reject(401, "FOLLOWUP_SESSION_CHANGED");
        return { outcome: "retired", requestId: command.requestId, actorUserId: session.userId, fingerprint };
      }
      if (!source.eligible) reject(409, "FOLLOWUP_SOURCE_NOT_NO_SHOW");
      if ((task?.revision ?? 0) !== command.expectedRevision || task?.status === "closed") reject(409, "FOLLOWUP_REVISION_CHANGED");
      if (retire) {
        const { rows: [expiry] } = await client.query<{ expired: boolean }>(
          "SELECT $1::timestamptz <= clock_timestamp() AS expired", [command.dueAt]);
        if (command.status !== "open" || !expiry.expired) reject(409, "FOLLOWUP_ATTEMPT_NOT_EXPIRED");
        await client.query(`INSERT INTO appointment_followup_retirements
          (actor_user_id,request_id,fingerprint,source_appointment_id,source_created_at,patient_id,generation,expected_revision,original_due_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [session.userId,command.requestId,fingerprint,source.id,command.sourceCreatedAt,source.patient_id,command.generation,command.expectedRevision,command.dueAt]);
        await insertAuditRow(client, { action: "appointment_followup.attempt_retire", entity: "appointment_followup_attempt", entityId: null,
          actor: session.username, actorRole: session.role,
          details: { actorUserId: session.userId, requestId: command.requestId, fingerprint, reason: "expired_uncommitted" } });
        if (!await revalidateSessionInTransaction(admitted, client)) reject(401, "FOLLOWUP_SESSION_CHANGED");
        return { outcome: "retired", requestId: command.requestId, actorUserId: session.userId, fingerprint };
      }
      const assignee = users.find(user => user.id === command.assigneeUserId);
      if (!assignee?.is_active || !allowed(assignee.role)) reject(400, "FOLLOWUP_ASSIGNEE_UNAVAILABLE");
      const { rows: [due] } = await client.query<{ future: boolean }>("SELECT $1::timestamptz > clock_timestamp() AS future", [command.dueAt]);
      if (command.status === "open" && !due.future) reject(400, "FOLLOWUP_DUE_MUST_BE_FUTURE");
      let followupId = task?.id;
      const revision = command.expectedRevision + 1;
      const state = [command.assigneeUserId, command.dueAt, command.status, command.outcome, command.nextStep, revision];
      if (task) {
        await client.query(`UPDATE appointment_followups SET assignee_user_id=$1,due_at=$2,status=$3,outcome=$4,
          next_step=$5,revision=$6,updated_at=clock_timestamp() WHERE id=$7`, [...state, task.id]);
      } else {
        const { rows: [created] } = await client.query<{ id: number }>(`INSERT INTO appointment_followups
          (assignee_user_id,due_at,status,outcome,next_step,revision,source_appointment_id,source_created_at,generation)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [...state, source.id, command.sourceCreatedAt, command.generation]);
        followupId = created.id;
        await client.query(`INSERT INTO appointment_followup_links (followup_id,appointment_id,patient_id)
          VALUES ($1,$2,$3)`, [followupId, source.id, source.patient_id]);
      }
      const { rows: [event] } = await client.query<{ id: number }>(`INSERT INTO appointment_followup_events
        (assignee_user_id,due_at,status,outcome,next_step,revision,followup_id,actor_user_id,request_id,fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [...state, followupId, session.userId, command.requestId, fingerprint]);
      await client.query(`INSERT INTO appointment_followup_receipts (actor_user_id,request_id,fingerprint,event_id)
        VALUES ($1,$2,$3,$4)`, [session.userId, command.requestId, fingerprint, event.id]);
      await insertAuditRow(client, { action: task ? "appointment_followup.update" : "appointment_followup.create",
        entity: "appointment_followup", entityId: followupId, actor: session.username, actorRole: session.role,
        details: { actorUserId: session.userId, requestId: command.requestId, fingerprint, eventId: event.id, revision,
          outcome: command.outcome, nextStep: command.nextStep, status: command.status } });
      if (!await revalidateSessionInTransaction(admitted, client)) reject(401, "FOLLOWUP_SESSION_CHANGED");
      return { followupId: followupId!, revision, replayed: false };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "followup attempt retired") reject(409, "FOLLOWUP_ATTEMPT_RETIRED");
    if ((error as { code?: string }).code === "55P03") reject(409, "FOLLOWUP_BUSY");
    throw error;
  }
}

/** Fresh editor context; the save writer rechecks all witnesses under locks. */
export async function readAppointmentFollowupEditor(appointmentId: number, expectedPatientId: number, admitted: SessionPayload) {
  const source = await readAppointmentFollowupSource(appointmentId, admitted);
  if (source.expectedPatientId !== expectedPatientId) reject(409, "FOLLOWUP_SOURCE_CHANGED");
  return followupTransaction(getPool(), async client => {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [PURCHASE_RESET_FENCE]);
    const session = await revalidateSessionInTransaction(admitted, client);
    if (!session) reject(401, "FOLLOWUP_SESSION_CHANGED");
    if (!allowed(session.role)) reject(403, "FOLLOWUP_ROLE");
    const { rows: [row] } = await client.query<{ eligible: boolean; revision: number; status: string | null; assignee_user_id: number | null; due_at: Date | null; linked: boolean }>(`
      SELECT ${followupEligibilitySql("$5")} AS eligible, COALESCE(f.revision,0) AS revision,
        f.status,f.assignee_user_id,f.due_at,(f.id IS NULL OR (l.appointment_id=a.id AND l.patient_id=a.patient_id)) AS linked
      FROM appointments a LEFT JOIN appointment_followups f ON f.source_appointment_id=a.id AND f.source_created_at=$3 AND f.generation=$4
      LEFT JOIN appointment_followup_links l ON l.followup_id=f.id
      WHERE a.id=$1 AND a.patient_id=$2 AND EXTRACT(EPOCH FROM a.created_at)::text=$3
        AND ${PLANNED_REBOOK_GENERATION_SQL}=$4`, [appointmentId, expectedPatientId, source.sourceCreatedAt, source.generation, CLINIC_TIME_ZONE]);
    if (!row) reject(409, "FOLLOWUP_SOURCE_CHANGED");
    if (!await canAccessPatient(session, expectedPatientId, undefined, client)) reject(403, "FOLLOWUP_PATIENT_ACCESS");
    const { rows: assignees } = await client.query<{ id: number; display_name: string }>("SELECT id,display_name FROM users WHERE is_active=true AND role IN ('admin','reception') ORDER BY id");
    if (session.expiresAt < Date.now()) reject(401, "FOLLOWUP_SESSION_CHANGED");
    return { source, revision: row.revision, closed: row.status === "closed", blocked: !row.eligible || !row.linked,
      assigneeUserId: row.assignee_user_id ?? session.userId, assignees, actorUserId: session.userId };
  });
}
