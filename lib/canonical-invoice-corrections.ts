import "server-only";
import { doctorOwnsPatient, getPool, patientInDoctorScopeWith, type DbClient } from "./db";
import { canonicalDebtActor } from "./debt-installments-db";
import { InvoiceArchiveError, parseInvoiceArchiveCommand } from "./invoice-archive";
import { changeInvoiceArchiveOn } from "./invoice-archive-db";
import { readInvoiceRevisionOn, reviseInvoiceOn } from "./invoice-revision-db";
import { DebtRepaymentError } from "./debt-installments-db";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation, type StaffOperationHandle, type StaffRuntimeAction } from "./staff-operation-runtime";
import type { StaffCapability } from "./staff-capability-catalogue";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * Archiving, restoring and correcting issued invoices on the canonical runtime (M2 slice 93c;
 * owner decisions G4-1, G4-8; contract section 8). The legacy routes were for the administrator
 * label only; the explicit grant replaces the label:
 *  - archive or restore: `finance.invoices.cancel`;
 *  - correct: `finance.invoices.correct`.
 * One admitted operation each on the legacy writer, whose session revalidation points receive
 * the slice-91 branded actor re-proving the operation and its grant on the same client. The
 * invoice's patient is admitted right after the writer's patient row lock (own: an ownership
 * witness FOR SHARE NOWAIT), after an early unlocked look; outside reads like missing.
 */
const MISSING = "الفاتورة غير موجودة.";
export function invoiceIdOf(raw: unknown, invalid: (message: string) => Error): number {
  const id = typeof raw === "string" && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw invalid("رقم الفاتورة غير صالح.");
  return id;
}

/** The early unlocked look and the after-lock admission for an invoice's patient. */
export async function invoiceScope(client: DbClient, handle: StaffOperationHandle, action: StaffRuntimeAction, invoiceId: number,
  refuse: { missing: () => Error; conflict: () => Error }) {
  const early = await staffOperationPatientScope(client, handle, action);
  if (early.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const { rows: [owner] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM invoices WHERE id = $1", [invoiceId]);
  if (!owner || (early.kind === "own" && !await patientInDoctorScopeWith(client, early.clinicianPartyId, owner.patient_id))) throw refuse.missing();
  return async (patientId: number) => {
    const scope = await staffOperationPatientScope(client, handle, action);
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (scope.kind === "all") return;
    let inside: boolean;
    try { inside = await doctorOwnsPatient(scope.clinicianPartyId, patientId, client, "nowait"); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "55P03") throw refuse.conflict();
      throw error;
    }
    if (!inside) throw refuse.missing();
  };
}

/** The branded actor for a writer that revalidated a session: re-proves the operation and its grant. */
export async function invoiceWriteActor(client: DbClient, handle: StaffOperationHandle, action: StaffRuntimeAction, grant: StaffCapability) {
  const identity = await staffOperationIdentity(client, handle, action);
  return canonicalDebtActor(identity, async current => current === client
    && (await staffOperationCapabilities(current, handle, action, [grant] as const)).has(grant));
}

/** `POST /api/invoices/[id]/archive`: archive or restore. */
export async function commandCanonicalInvoiceArchive(session: VerifiedDurableSession, rawInvoiceId: unknown, body: unknown, pool = getPool()) {
  const invoiceId = invoiceIdOf(rawInvoiceId, message => new InvoiceArchiveError("invalid", message));
  const command = parseInvoiceArchiveCommand(body);
  const outcome = await withStaffOperation(pool, session, "finance.invoices.cancel", async (client, handle) => {
    const admit = await invoiceScope(client, handle, "finance.invoices.cancel", invoiceId, {
      missing: () => new InvoiceArchiveError("missing", MISSING),
      conflict: () => new InvoiceArchiveError("conflict", "تعذّر تثبيت نطاق المريض. احتفظ بالطلب نفسه وأعد المحاولة."),
    });
    const actor = await invoiceWriteActor(client, handle, "finance.invoices.cancel", "finance.invoices.cancel");
    return changeInvoiceArchiveOn(client, invoiceId, command, actor, admit);
  });
  // A durable rejection's evidence is committed with the operation; then refuse.
  if (outcome.kind === "rejected") throw outcome.error;
  return outcome.result;
}

/** `GET /api/invoices/[id]/correct`: the correction context (read:invoices.correct). */
export async function readCanonicalInvoiceRevision(session: VerifiedDurableSession, rawInvoiceId: unknown) {
  const invoiceId = invoiceIdOf(rawInvoiceId, message => new DebtRepaymentError("invalid", message));
  return runCanonicalReadSnapshot(session, "read:invoices.correct", async (query, scope) => {
    const client = query as DbClient, patientScope = scope.patientScope;
    if (patientScope.kind === "none") throw new DebtRepaymentError("missing", MISSING);
    const { rows: [owner] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM invoices WHERE id = $1", [invoiceId]);
    if (!owner || (patientScope.kind === "own" && !await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, owner.patient_id))) {
      throw new DebtRepaymentError("missing", MISSING);
    }
    return readInvoiceRevisionOn(client, invoiceId);
  }, { errorPrefix: "STAFF_READ", maxBytes: 2 * 1024 * 1024 });
}

/** `POST /api/invoices/[id]/correct`: the correction (a replacement invoice and its lineage). */
export async function commandCanonicalInvoiceRevision(session: VerifiedDurableSession, rawInvoiceId: unknown, body: unknown, pool = getPool()) {
  const invoiceId = invoiceIdOf(rawInvoiceId, message => new DebtRepaymentError("invalid", message));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new DebtRepaymentError("invalid", "طلب التصحيح غير صالح.");
  return withStaffOperation(pool, session, "finance.invoices.correct", async (client, handle) => {
    const admit = await invoiceScope(client, handle, "finance.invoices.correct", invoiceId, {
      missing: () => new DebtRepaymentError("missing", MISSING),
      conflict: () => new DebtRepaymentError("conflict", "تعذّر تثبيت نطاق المريض. احتفظ بالطلب نفسه وأعد المحاولة."),
    });
    const actor = await invoiceWriteActor(client, handle, "finance.invoices.correct", "finance.invoices.correct");
    return reviseInvoiceOn(client, invoiceId, body as Record<string, unknown>, actor, admit);
  });
}
