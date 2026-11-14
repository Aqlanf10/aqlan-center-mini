import "server-only";
import { getInvoice, listPatientInvoices, patientInDoctorScopeWith, type DbClient, type Invoice } from "./db";
import { CanonicalPatientReadRefusal, readCanonicalPatientRecord } from "./canonical-patient-reads";
import { runCanonicalReadSnapshot, type CanonicalSnapshotQuery, type CanonicalSnapshotScope } from "./canonical-read-snapshot";
import { invoiceArchiveViewWith, listInvoiceArchiveWith } from "./invoice-archive-db";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * Invoice reads on the canonical runtime (M2 slice 92; group 4 design:
 * docs/review/financial-group4-contract-design-20261104.md).
 *
 * `read:invoices.patient`: `finance.invoices.view`, one read-only snapshot, the legacy
 * bodies from the same readers. `finance.patient-ledger.view` never substitutes, and the
 * invoice grant never reveals the patient statement (owner decision 6629149113, point 2).
 *
 * Scope: the map lists these reads with no record scope. The canonical reads keep them
 * inside the actor's patient scope, the same as the patient account (slice 88), so an
 * `own`-scoped actor granted the invoice view reads only its patients' invoices. This is
 * narrower than the map and never wider than legacy (reception, cashier, accountant labels
 * read every invoice; a doctor read none). Whether a finance-only role should read
 * invoices without a patient scope is the owner's choice; the patient scope `all` grants it.
 * An invoice outside the scope reads exactly like a missing one.
 */
const MAX_BYTES = 4 * 1024 * 1024;
const missingInvoice = () => new CanonicalPatientReadRefusal("patient_not_found", "الفاتورة غير موجودة.");

/** One invoice inside the scope, or the missing-invoice refusal (never which). */
async function invoiceInScope(query: CanonicalSnapshotQuery, scope: CanonicalSnapshotScope, invoiceId: number): Promise<Invoice> {
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw new CanonicalPatientReadRefusal("invalid_patient_query", "رقم الفاتورة غير صالح.");
  const invoice = await getInvoice(invoiceId, query as DbClient);
  if (!invoice) throw missingInvoice();
  if (scope.patientScope.kind === "all") return invoice;
  if (scope.patientScope.kind === "own" && await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, invoice.patientId)) return invoice;
  throw missingInvoice();
}

/** `GET /api/invoices?patientId=`: the patient's invoices (legacy `listPatientInvoices`). */
export async function readCanonicalPatientInvoices(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:invoices.patient", patientId,
    async query => listPatientInvoices(patientId, query as DbClient), MAX_BYTES);
}

/** `GET /api/invoices/[id]`: one invoice (legacy `getInvoice`). */
export async function readCanonicalInvoice(session: VerifiedDurableSession, invoiceId: number) {
  return runCanonicalReadSnapshot(session, "read:invoices.patient", (query, scope) => invoiceInScope(query, scope, invoiceId),
    { errorPrefix: "STAFF_READ", maxBytes: MAX_BYTES });
}

/** `GET /api/invoices/archive?patientId=`: the patient's archive list. */
export async function readCanonicalInvoiceArchiveList(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:invoices.patient", patientId,
    async query => listInvoiceArchiveWith(query as DbClient, patientId), MAX_BYTES);
}

/** `GET /api/invoices/[id]/archive`: one invoice's archive state. */
export async function readCanonicalInvoiceArchive(session: VerifiedDurableSession, invoiceId: number) {
  return runCanonicalReadSnapshot(session, "read:invoices.patient",
    async (query, scope) => invoiceArchiveViewWith(query as DbClient, await invoiceInScope(query, scope, invoiceId)),
    { errorPrefix: "STAFF_READ", maxBytes: MAX_BYTES });
}
