import { readSignedReceptionProof, sameVisitReceivable, type SignedReceptionProof } from "./operational-checkout";
import { operationalDecisionForSigned, lockReceptionReceivable, signedReceptionFinancialState } from "./operational-checkout-db";
import { CLINIC_TIME_ZONE, ensureSchema, getPool, insertAuditRow, visitWalkout, type VisitActor, type VisitWalkout } from "./db";
import { onClinicDaysSql } from "./clinic-day-sql";
import { clinicDateString } from "./schedule";
import { canReadReceptionHandoff, isHandoffDate, type ReceptionHandoff } from "./reception-handoff";
import { walkoutNeedsReview } from "./walkout-presentation";

// Keep the database's full signature precision in the audit identity. The public
// signedAt remains the canonical ISO timestamp returned by visitWalkout.
const SIGNATURE_VERSION_SQL = `to_char(v.signed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const COMPLETED_ACTION = "visit.reception_handoff_completed";

interface HandoffRow {
  id: number;
  patient_id: number;
  full_name: string;
  patient_number: string;
  signed_at: Date;
  signature_version: string;
  eligible_invoice_id: number | null;
  handled_reason: string | null;
  completed_details?: Record<string, unknown> | null;
  deferred_details?: Record<string, unknown> | null;
  deferred: boolean;
}

const HANDOFF_SELECT = `SELECT v.id, v.patient_id, p.full_name, p.patient_number, v.signed_at, ${SIGNATURE_VERSION_SQL} AS signature_version,
            i.id AS eligible_invoice_id, completed.handled_reason, completed.details AS completed_details,
            (SELECT a.details FROM audit_log a WHERE a.entity = 'visit' AND a.entity_id = v.id::text
              AND a.action = 'visit.payment_deferred' AND a.created_at >= v.signed_at ORDER BY a.id DESC LIMIT 1) AS deferred_details,
            EXISTS (SELECT 1 FROM audit_log a
                     WHERE a.entity = 'visit' AND a.entity_id = v.id::text
                       AND a.action = 'visit.payment_deferred'
                       AND a.created_at >= v.signed_at) AS deferred
       FROM visits v JOIN patients p ON p.id = v.patient_id
       LEFT JOIN invoices i ON i.id = v.invoice_id AND i.patient_id = v.patient_id
         AND i.status <> 'cancelled' AND i.total_minor - i.discount_minor > 0
       LEFT JOIN LATERAL (
         SELECT a.details->>'reason' AS handled_reason, a.details FROM audit_log a
          WHERE a.entity = 'visit' AND a.entity_id = v.id::text
            AND a.action = '${COMPLETED_ACTION}'
            AND a.details->>'patientId' = v.patient_id::text
            AND a.details->>'signatureVersion' = ${SIGNATURE_VERSION_SQL}
            AND length(btrim(a.details->>'reason')) > 0
          ORDER BY a.id LIMIT 1
       ) completed ON true`;

/** Payment-derived status is deliberately narrower than a patient balance.
 * A refund reopens it on the next read; no completion audit is written by payment.
 * Zero-charge, missing/cancelled/wrong-patient invoices and unresolved clinical
 * billing decisions always need a human decision, even if account balance is zero.
 */
function isCollected(row: HandoffRow, walkout: VisitWalkout | null): boolean {
  return walkout !== null && walkout.visitId === row.id && walkout.patientId === row.patient_id
    && walkout.signedAt === row.signed_at.toISOString()
    && row.eligible_invoice_id !== null && walkout.invoice !== null && walkout.invoice.id === row.eligible_invoice_id
    && Number.isSafeInteger(walkout.invoice.netMinor) && walkout.invoice.netMinor > 0
    && Number.isSafeInteger(walkout.checkout.invoicePaidMinor)
    && walkout.checkout.invoicePaidMinor >= walkout.invoice.netMinor
    && !walkoutNeedsReview(walkout);
}

async function toHandoff(row: HandoffRow, walkout?: VisitWalkout | null): Promise<ReceptionHandoff> {
  let status: ReceptionHandoff["status"] = row.handled_reason !== null ? "handled" : row.deferred ? "deferred" : "pending";
  if (status === "pending" && row.eligible_invoice_id !== null
    && isCollected(row, walkout === undefined ? await visitWalkout(row.id) : walkout)) status = "collected";
  const carried = !row.handled_reason && !row.deferred ? await operationalDecisionForSigned(row.id, row.patient_id, row.signed_at.toISOString()) : null;
  if (carried) status = carried.status;
  const decisionDetails = row.handled_reason !== null ? row.completed_details : row.deferred_details;
  const originalProof = decisionDetails?.patientId === row.patient_id && decisionDetails?.signatureVersion === row.signature_version
    ? decisionDetails.receivable : undefined;
  const financial = row.handled_reason !== null || row.deferred
    ? await signedReceptionFinancialState(row.id, row.patient_id, row.signed_at.toISOString(), originalProof)
    : { reviewRequired: carried?.reviewRequired ?? false, invoiceSettled: carried?.invoiceSettled ?? status === "collected" };
  return { visitId: row.id, patientId: row.patient_id, patientName: row.full_name,
    patientNumber: row.patient_number, signedAt: row.signed_at.toISOString(), signatureVersion: row.signature_version,
    status, handledReason: carried?.reason ?? row.handled_reason ?? (typeof row.deferred_details?.reason === "string" ? row.deferred_details.reason : typeof row.deferred_details?.السبب === "string" ? row.deferred_details.السبب : null),
    financialReviewRequired: financial.reviewRequired, visitInvoiceSettled: financial.invoiceSettled };
}

/** Also serves the exact-visit checkout, including signatures outside today's window. */
export async function readReceptionHandoff(visitId: number, walkout: VisitWalkout): Promise<ReceptionHandoff | null> {
  await ensureSchema();
  const { rows: [row] } = await getPool().query<HandoffRow>(
    `${HANDOFF_SELECT} WHERE v.id = $1 AND v.signed_at IS NOT NULL`, [visitId]);
  // A concurrent change cannot attach a different patient's/signature's decision
  // to a walkout payload already read by the caller.
  if (!row || walkout.visitId !== row.id || walkout.patientId !== row.patient_id
    || walkout.signedAt !== row.signed_at.toISOString()) return null;
  return toHandoff(row, walkout);
}

/** Signed visits remain visible in history; status never clears the patient's debt. */
export async function listReceptionHandoffs(throughDate?: string) {
  const toDate = throughDate ?? clinicDateString(new Date(), CLINIC_TIME_ZONE);
  if (!isHandoffDate(toDate)) throw new Error("Invalid signing date");
  const fromDate = new Date(new Date(`${toDate}T00:00:00.000Z`).getTime() - 86_400_000).toISOString().slice(0, 10);
  await ensureSchema();
  const { rows } = await getPool().query<HandoffRow>(
    `${HANDOFF_SELECT}
      WHERE v.signed_at IS NOT NULL
        AND ${onClinicDaysSql("v.signed_at", "$1", "$2::date", "$3::date")}
      ORDER BY v.signed_at DESC, v.id DESC`,
    [CLINIC_TIME_ZONE, fromDate, toDate],
  );
  const items: ReceptionHandoff[] = [];
  // Bound financial reads so a busy two-day register neither serializes every
  // ledger read nor floods the database pool. Preserve the signing sort order.
  for (let offset = 0; offset < rows.length; offset += 3) {
    items.push(...await Promise.all(rows.slice(offset, offset + 3).map(row => toHandoff(row))));
  }
  return { fromDate, toDate, clinicTimeZone: CLINIC_TIME_ZONE, items };
}

export type CompleteReceptionHandoffInput = SignedReceptionProof & { visitId: number; reason: string };
export type CompleteReceptionHandoffResult =
  | { ok: true; visitId: number; patientId: number; signedAt: string; status: "handled" | "deferred"; handledReason: string; already: boolean; invoiceId: number | null }
  | { ok: false; reason: "forbidden" | "invalid" | "not_found" | "stale" | "not_signed" };

export function isHandoffSignature(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Patient → visit → invoice locks serialize first decisions and retries with finance writers. */
export async function completeReceptionHandoff(input: CompleteReceptionHandoffInput, actor: VisitActor): Promise<CompleteReceptionHandoffResult> {
  return decideSignedReceptionHandoff(input, actor, "handled");
}
export async function decideSignedReceptionHandoff(input: CompleteReceptionHandoffInput, actor: VisitActor, status: "handled" | "deferred"): Promise<CompleteReceptionHandoffResult> {
  if (!canReadReceptionHandoff(actor.actorRole) || !actor.actor.trim()) return { ok: false, reason: "forbidden" };
  if (!Number.isSafeInteger(input.visitId) || input.visitId <= 0 || !readSignedReceptionProof(input)
    || !isHandoffSignature(input.signedAt) || typeof input.reason !== "string"
    || input.reason.trim().length < 3 || input.reason.trim().length > 300) return { ok: false, reason: "invalid" };
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const financial = await lockReceptionReceivable(client, input.visitId);
    if (!financial.ok) { await client.query("ROLLBACK"); return { ok: false, reason: financial.reason }; }
    if (financial.patientId !== input.patientId || financial.signedAt !== input.signedAt || financial.signatureVersion !== input.signatureVersion
      || !sameVisitReceivable(financial.receivable, input.receivable)) {
      await client.query("ROLLBACK"); return { ok: false, reason: financial.signedAt === null ? "not_signed" : "stale" };
    }
    const { rows: [prior] } = await client.query<{ action: string; details: Record<string, unknown> }>(
      `SELECT action, details FROM audit_log WHERE entity = 'visit' AND entity_id = $1
        AND action IN ('visit.reception_handoff_completed', 'visit.payment_deferred')
        AND details->>'patientId' = $2 AND details->>'signatureVersion' = $3
        ORDER BY id LIMIT 1`, [String(input.visitId), String(input.patientId), financial.signatureVersion]);
    // History is immutable. Changed financial circumstances use the separate review route.
    if (prior && (!readSignedReceptionProof(prior.details) || !sameVisitReceivable(readSignedReceptionProof(prior.details)!.receivable, financial.receivable))) {
      await client.query("ROLLBACK"); return { ok: false, reason: "stale" };
    }
    const savedStatus = prior ? (prior.action === COMPLETED_ACTION ? "handled" : "deferred") : status;
    const savedReason = prior ? String(prior.details.reason ?? prior.details.السبب ?? "") : input.reason.trim();
    if (!prior) await insertAuditRow(client, {
      action: status === "handled" ? COMPLETED_ACTION : "visit.payment_deferred", entity: "visit", entityId: input.visitId,
      details: { patientId: input.patientId, signedAt: input.signedAt, signatureVersion: financial.signatureVersion,
        reason: savedReason, receivable: financial.receivable,
        ...(status === "deferred" ? { السبب: savedReason, الفاتورة: financial.receivable?.invoiceId ?? null,
          "صافي الفاتورة": financial.receivable?.netMinor ?? null, العملة: financial.receivable?.currency ?? null } : {}) },
      actor: actor.actor, actorRole: actor.actorRole });
    await client.query("COMMIT");
    return { ok: true, visitId: input.visitId, patientId: input.patientId, signedAt: input.signedAt,
      status: savedStatus, handledReason: savedReason, already: !!prior, invoiceId: financial.receivable?.invoiceId ?? null };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}
