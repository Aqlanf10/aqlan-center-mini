import { CLINIC_TIME_ZONE, ensureSchema, getPool, insertAuditRow, type DbClient, type VisitActor } from "./db";
import type { AuditAction } from "./audit";
import { onClinicDaysSql } from "./clinic-day-sql";
import { clinicDateString } from "./schedule";
import { canReadReceptionHandoff, isHandoffDate } from "./reception-handoff";
import { CLINIC_BASE_CURRENCY, isCurrency } from "./money";
import { isFinishVersion, readVisitReceivable, receivableNotIncreased, type OperationalHandoff, type VisitReceivable } from "./operational-checkout";

export const RECEPTION_VERIFICATION_ACTION = "visit.reception_handoff_verified" satisfies AuditAction;
const SIGNATURE_SQL = `to_char(v.signed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const OPERATIONAL_HANDOFF_ACTION = "visit.operational_handoff_decided" satisfies AuditAction;
const VERSION_SQL = `(CASE WHEN v.finished_at IS NULL THEN 'arrival_fallback:' ELSE 'finished:' END)
  || to_char(COALESCE(v.finished_at, v.arrived_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
interface Row {
  link_changed?: boolean;
  id: number; patient_id: number | null; patient_name: string; patient_number: string | null;
  finished_at: Date; finish_version: string; date_basis: "finished" | "arrival_fallback";
  signed_at: Date | null; signature_version: string | null; verification: unknown; status: string; decision: unknown;
  linked_id: number | null; invoice_id: number | null; invoice_status: string | null;
  currency: string | null; net: string | null; paid: string;
}
const SELECT = `SELECT v.id, v.patient_id, COALESCE(p.full_name, v.patient_name) AS patient_name,
  p.patient_number, COALESCE(v.finished_at, v.arrived_at) AS finished_at,
  ${VERSION_SQL} AS finish_version,
  CASE WHEN v.finished_at IS NULL THEN 'arrival_fallback' ELSE 'finished' END AS date_basis,
  v.signed_at, ${SIGNATURE_SQL} AS signature_version, verified.details AS verification, v.status, decided.details AS decision,
  v.invoice_id AS linked_id, i.id AS invoice_id, i.status AS invoice_status,
  i.base_currency AS currency, (i.total_minor - i.discount_minor)::text AS net,
  COALESCE((SELECT SUM((CASE WHEN y.kind = 'refund' THEN -1 ELSE 1 END) *
    CASE WHEN y.currency = i.base_currency THEN y.amount_minor
         WHEN i.base_currency = '${CLINIC_BASE_CURRENCY}' THEN y.base_amount_minor ELSE 0 END)
    FROM payments y WHERE y.patient_id = v.patient_id AND y.invoice_id = i.id), 0)::text AS paid
  FROM visits v LEFT JOIN patients p ON p.id = v.patient_id
  LEFT JOIN invoices i ON i.id = v.invoice_id AND i.patient_id = v.patient_id
  LEFT JOIN LATERAL (SELECT a.details FROM audit_log a
    WHERE a.entity = 'visit' AND a.entity_id = v.id::text AND a.action = '${OPERATIONAL_HANDOFF_ACTION}'
      AND a.details->>'patientId' = v.patient_id::text
      AND a.details->>'finishVersion' = ${VERSION_SQL}
    ORDER BY a.id DESC LIMIT 1) decided ON true
  LEFT JOIN LATERAL (SELECT a.details FROM audit_log a
    WHERE a.entity = 'visit' AND a.entity_id = v.id::text AND a.action = '${RECEPTION_VERIFICATION_ACTION}'
      AND a.details->>'patientId' = v.patient_id::text AND a.details->>'signatureVersion' = ${SIGNATURE_SQL}
    ORDER BY a.id DESC LIMIT 1) verified ON true`;
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
function decision(x: unknown) {
  if (!object(x) || !["handled", "deferred"].includes(typeof x.status === "string" ? x.status : "")
    || typeof x.reason !== "string" || x.reason.trim().length < 3 || x.reason.length > 300) return null;
  const receivable = readVisitReceivable(x.receivable);
  if (receivable === undefined) return null;
  return { status: x.status as "handled" | "deferred", reason: x.reason, receivable };
}
/** Values were read together with the exact owner, finish version and clinical phase. */
function receivableFromRow(row: Row): VisitReceivable | null {
  if (row.linked_id === null) return null;
  if (row.invoice_id !== row.linked_id || !isCurrency(row.currency)) throw new Error("Unverified visit invoice");
  if (row.invoice_status !== "open" && row.invoice_status !== "paid" && row.invoice_status !== "cancelled") throw new Error("Unverified invoice status");
  const accepted = readVisitReceivable({ invoiceId: row.invoice_id, currency: row.currency,
    status: row.invoice_status, netMinor: Number(row.net), paidMinor: Number(row.paid) });
  if (!accepted) throw new Error("Unverified visit receivable");
  return accepted;
}
function item(row: Row, current: VisitReceivable | null): OperationalHandoff {
  const prior = decision(row.decision);
  const carried = prior && receivableNotIncreased(prior.receivable, current) ? prior : null;
  return { visitId: row.id, patientId: row.patient_id, patientName: row.patient_name,
    patientNumber: row.patient_number, finishedAt: row.finished_at.toISOString(), finishVersion: row.finish_version,
    dateBasis: row.date_basis, signedAt: null, financialReviewRequired: prior !== null && carried === null,
    visitInvoiceSettled: current !== null && current.status !== "cancelled" && current.netMinor > 0 && current.paidMinor >= current.netMinor, status: carried?.status ?? "pending", handledReason: carried?.reason ?? (prior ? `تغيّرت فاتورة الزيارة أو استحقاقها؛ يلزم قرار جديد. القرار السابق: ${prior.reason}` : null) };
}
export async function listOperationalHandoffs(throughDate?: string) {
  const toDate = throughDate ?? clinicDateString(new Date(), CLINIC_TIME_ZONE);
  if (!isHandoffDate(toDate)) throw new Error("Invalid operational date");
  const fromDate = new Date(Date.parse(`${toDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  await ensureSchema();
  const { rows } = await getPool().query<Row>(`${SELECT} WHERE v.status = 'done' AND v.signed_at IS NULL
    AND ${onClinicDaysSql("COALESCE(v.finished_at, v.arrived_at)", "$1", "$2::date", "$3::date")}
    ORDER BY COALESCE(v.finished_at, v.arrived_at) DESC, v.id DESC`, [CLINIC_TIME_ZONE, fromDate, toDate]);
  const items = rows.map(row => item(row, receivableFromRow(row)));
  return { fromDate, toDate, clinicTimeZone: CLINIC_TIME_ZONE, items };
}
export async function readOperationalHandoff(visitId: number, patientId: number) {
  await ensureSchema();
  const { rows: [row] } = await getPool().query<Row>(`${SELECT} WHERE v.id = $1 AND v.patient_id = $2
    AND v.status = 'done' AND v.signed_at IS NULL`, [visitId, patientId]);
  if (!row) return null;
  const receivable = receivableFromRow(row);
  return { version: 1 as const, item: item(row, receivable), receivable };
}

/** Signature guards stay with the signed reader. Carry only this exact visit's durable decision. */
export async function operationalDecisionForSigned(visitId: number, patientId: number, signedAt: string): Promise<{ status: "handled" | "deferred" | "pending"; reason: string } | null> {
  const { rows: [row] } = await getPool().query<Row>(`${SELECT} WHERE v.id = $1 AND v.patient_id = $2 AND v.signed_at IS NOT NULL`, [visitId, patientId]);
  if (!row || row.signed_at?.toISOString() !== signedAt) return null;
  const prior = decision(row.decision);
  if (!prior) return null;
  return receivableNotIncreased(prior.receivable, receivableFromRow(row))
    ? { status: prior.status, reason: prior.reason }
    : { status: "pending", reason: `تغيّرت فاتورة الزيارة أو استحقاقها بعد القرار التشغيلي؛ يلزم قرار جديد. القرار السابق: ${prior.reason}` };
}

export interface OperationalDecisionInput {
  visitId: number; patientId: number; finishVersion: string; status: "handled" | "deferred";
  reason: string; receivable: VisitReceivable | null;
}
export async function decideOperationalHandoff(input: OperationalDecisionInput, actor: VisitActor) {
  if (!canReadReceptionHandoff(actor.actorRole) || !actor.actor.trim()) return { ok: false as const, reason: "forbidden" };
  if (!Number.isSafeInteger(input.visitId) || input.visitId <= 0 || !Number.isSafeInteger(input.patientId) || input.patientId <= 0
    || !isFinishVersion(input.finishVersion) || !["handled", "deferred"].includes(input.status)
    || typeof input.reason !== "string" || input.reason.trim().length < 3 || input.reason.trim().length > 300
    || readVisitReceivable(input.receivable) === undefined) return { ok: false as const, reason: "invalid" };
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const row = await lockReceptionRow(client, input.visitId);
    if (!row || row.link_changed || row.patient_id !== input.patientId || row.status !== "done" || row.signed_at !== null || row.finish_version !== input.finishVersion) {
      await client.query("ROLLBACK"); return { ok: false as const, reason: row ? "stale" : "not_found" };
    }
    const current = receivableFromRow(row);
    const prior = decision(row.decision);
    // An uncertain-response retry returns the first still-applicable decision unchanged.
    if (prior && receivableNotIncreased(prior.receivable, current)) {
      await client.query("COMMIT"); return { ok: true as const, item: item(row, current) };
    }
    if (JSON.stringify(current) !== JSON.stringify(readVisitReceivable(input.receivable))) {
      await client.query("ROLLBACK"); return { ok: false as const, reason: "stale" };
    }
    const details = { patientId: input.patientId, finishVersion: input.finishVersion,
      status: input.status, reason: input.reason.trim(), receivable: current };
    await insertAuditRow(client, { action: OPERATIONAL_HANDOFF_ACTION, entity: "visit", entityId: input.visitId,
      actor: actor.actor, actorRole: actor.actorRole, details });
    await client.query("COMMIT");
    return { ok: true as const, item: item({ ...row, decision: details }, current) };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}

// Both supported database backends expose this adapter, not pg's stream/config overloads.
type QueryClient = Pick<DbClient, "query">;
async function lockReceptionRow(client: QueryClient, visitId: number): Promise<Row | null> {
  const { rows: [discovered] } = await client.query<{ invoice_id: number | null }>(
    `SELECT invoice_id FROM visits WHERE id = $1`, [visitId]);
  if (discovered?.invoice_id !== null && discovered?.invoice_id !== undefined) {
    await client.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [discovered.invoice_id]);
  }
  await client.query(`SELECT v.id FROM visits v WHERE v.id = $1 FOR UPDATE OF v`, [visitId]);
  // The statement after a waited lock sees the preceding decision/payment/correction commit.
  const { rows: [row] } = await client.query<Row>(`${SELECT} WHERE v.id = $1`, [visitId]);
  if (!row) return null;
  return { ...row, link_changed: row.linked_id !== discovered?.invoice_id };
}
/** Called only inside the authorized signed-decision transaction; no independent write. */
export async function lockReceptionReceivable(client: QueryClient, visitId: number) {
  const row = await lockReceptionRow(client, visitId);
  if (!row) return { ok: false as const, reason: "not_found" as const };
  if (row.link_changed) return { ok: false as const, reason: "stale" as const };
  return { ok: true as const, patientId: row.patient_id, signedAt: row.signed_at?.toISOString() ?? null,
    signatureVersion: row.signature_version, receivable: receivableFromRow(row) };
}
export async function signedReceptionFinancialState(visitId: number, patientId: number, signedAt: string, originalProof: unknown) {
  const { rows: [row] } = await getPool().query<Row>(`${SELECT} WHERE v.id = $1 AND v.patient_id = $2 AND v.signed_at IS NOT NULL`, [visitId, patientId]);
  if (!row || row.signed_at?.toISOString() !== signedAt) return { reviewRequired: true, invoiceSettled: false };
  const current = receivableFromRow(row);
  const recorded = object(row.verification) ? row.verification.receivable : originalProof;
  const previous = readVisitReceivable(recorded);
  return { reviewRequired: previous === undefined || !receivableNotIncreased(previous, current),
    invoiceSettled: current !== null && current.status !== "cancelled" && current.netMinor > 0 && current.paidMinor >= current.netMinor };
}
export async function readSignedReceptionVerification(visitId: number, patientId: number) {
  await ensureSchema();
  const { rows: [row] } = await getPool().query<Row>(`${SELECT} WHERE v.id = $1 AND v.patient_id = $2 AND v.signed_at IS NOT NULL`, [visitId, patientId]);
  return row ? { visitId, patientId, signedAt: row.signed_at!.toISOString(), receivable: receivableFromRow(row) } : null;
}
export async function verifySignedReception(input: { visitId: number; patientId: number; signedAt: string; reason: string; receivable: VisitReceivable | null }, actor: VisitActor) {
  if (!canReadReceptionHandoff(actor.actorRole) || !actor.actor.trim()) return { ok: false as const, reason: "forbidden" };
  if (!Number.isSafeInteger(input.visitId) || input.visitId <= 0 || !Number.isSafeInteger(input.patientId) || input.patientId <= 0
    || typeof input.signedAt !== "string" || !Number.isFinite(Date.parse(input.signedAt))
    || typeof input.reason !== "string" || input.reason.trim().length < 3 || input.reason.trim().length > 300
    || readVisitReceivable(input.receivable) === undefined) return { ok: false as const, reason: "invalid" };
  await ensureSchema(); const client = await getPool().connect();
  try {
    await client.query("BEGIN"); const row = await lockReceptionRow(client, input.visitId);
    if (!row || row.link_changed || row.patient_id !== input.patientId || !row.signed_at || row.signed_at.toISOString() !== input.signedAt) {
      await client.query("ROLLBACK"); return { ok: false as const, reason: "stale" };
    }
    const current = receivableFromRow(row);
    if (JSON.stringify(current) !== JSON.stringify(readVisitReceivable(input.receivable))) {
      await client.query("ROLLBACK"); return { ok: false as const, reason: "stale" };
    }
    const prior = object(row.verification) ? readVisitReceivable(row.verification.receivable) : undefined;
    if (prior === undefined || JSON.stringify(prior) !== JSON.stringify(current)) {
      await insertAuditRow(client, { action: RECEPTION_VERIFICATION_ACTION, entity: "visit", entityId: input.visitId,
        actor: actor.actor, actorRole: actor.actorRole, details: { patientId: input.patientId, signedAt: input.signedAt,
          signatureVersion: row.signature_version, reason: input.reason.trim(), receivable: current } });
    }
    await client.query("COMMIT"); return { ok: true as const, visitId: input.visitId, patientId: input.patientId, signedAt: input.signedAt };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}
