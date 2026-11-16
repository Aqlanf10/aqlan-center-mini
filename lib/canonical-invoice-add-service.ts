import "server-only";
import { doctorOwnsPatient, getPool, patientInDoctorScopeWith, type DbClient } from "./db";
import { runCanonicalReadSnapshot, type CanonicalSnapshotScope } from "./canonical-read-snapshot";
import { addInvoiceServiceOn, addServiceFailure, InvoiceAddServiceError, parseInvoiceAddServiceCommand, previewInvoiceAddServiceOn, readInvoiceAddServiceOn } from "./invoice-add-service-db";
import { canonicalInvoiceActor, type InvoiceActorGrants } from "./invoice-template-db";
import { canonicalLabActor } from "./lab-work-intent-db";
import { staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * Adding a service to an issued invoice on the canonical runtime (M2 slice 93b-2; owner
 * decisions G4-1, G4-8; contract section 7). The addition is a new dated invoice linked to the
 * original, never a rewrite.
 *  - `finance.invoices.create` (legacy: the administrator label) with the price controls by
 *    grants; the explicit grant replaces the label, as in every slice.
 *  - GET (context) and PUT (preview): the registered read `read:invoices.add-service`, one
 *    snapshot, the invoice's patient inside the scope (outside = missing 404).
 *  - POST: one admitted operation on the legacy writer (`addInvoiceServiceOn`): the key lock,
 *    replay, lock order, source proof, writer and audits; the branded invoice actor re-proves
 *    the operation and its grants wherever the legacy writer revalidated its session; the scope
 *    decided right after the patient row lock (own: an ownership witness FOR SHARE NOWAIT).
 *    A stale attempt's rejection evidence commits before the refusal, as legacy.
 */
const MISSING = "الفاتورة غير موجودة.";
function invoiceIdOf(raw: unknown): number {
  const id = typeof raw === "string" && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : typeof raw === "number" ? raw : NaN;
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw new InvoiceAddServiceError("invalid", "رقم الفاتورة غير صالح.");
  return id;
}

async function invoicePatientInside(client: DbClient, patientScope: CanonicalSnapshotScope["patientScope"], invoiceId: number): Promise<void> {
  if (patientScope.kind === "none") throw new InvoiceAddServiceError("missing", MISSING);
  const { rows: [invoice] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM invoices WHERE id = $1", [invoiceId]);
  if (!invoice) throw new InvoiceAddServiceError("missing", MISSING);
  if (patientScope.kind === "own" && !await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, invoice.patient_id)) throw new InvoiceAddServiceError("missing", MISSING);
}

function snapshotGrants(scope: CanonicalSnapshotScope): InvoiceActorGrants {
  const has = (capability: Parameters<CanonicalSnapshotScope["granted"]>[0]) => scope.isProtectedOwner() || scope.granted(capability);
  return { create: has("finance.invoices.create"), labWork: has("clinical.visits.document"),
    price: { discount: has("finance.discounts.apply"), discountOverride: has("finance.discounts.override"), increase: has("finance.price-increases.apply") } };
}

/** GET: the original, the account due, the catalogue and the plan choices for the form. */
export async function readCanonicalInvoiceAddService(session: VerifiedDurableSession, rawInvoiceId: unknown) {
  const invoiceId = invoiceIdOf(rawInvoiceId);
  return runCanonicalReadSnapshot(session, "read:invoices.add-service", async (query, scope) => {
    await invoicePatientInside(query as DbClient, scope.patientScope, invoiceId);
    return readInvoiceAddServiceOn(query as DbClient, invoiceId);
  }, { errorPrefix: "STAFF_READ", maxBytes: 2 * 1024 * 1024 });
}

/** PUT: the preview, with the same price controls by the same grants as the save. */
export async function previewCanonicalInvoiceAddService(session: VerifiedDurableSession, rawInvoiceId: unknown, body: unknown) {
  const invoiceId = invoiceIdOf(rawInvoiceId);
  return runCanonicalReadSnapshot(session, "read:invoices.add-service", async (query, scope) => {
    await invoicePatientInside(query as DbClient, scope.patientScope, invoiceId);
    const grants = snapshotGrants(scope);
    // The request fingerprint binds the actor exactly as the save will (userId, username, role).
    const actor = canonicalInvoiceActor({ userId: scope.userId, username: scope.username, role: scope.role }, async () => grants, { lab: null, debt: null });
    return previewInvoiceAddServiceOn(query as DbClient, invoiceId, body, actor, grants.price);
  }, { errorPrefix: "STAFF_READ", maxBytes: 2 * 1024 * 1024 });
}

const PRICE = ["finance.discounts.apply", "finance.discounts.override", "finance.price-increases.apply"] as const;
async function operationGrants(client: DbClient, handle: StaffOperationHandle): Promise<InvoiceActorGrants> {
  const held = await staffOperationCapabilities(client, handle, "finance.invoices.create", ["finance.invoices.create", "clinical.visits.document", ...PRICE] as const);
  return { create: held.has("finance.invoices.create"), labWork: held.has("clinical.visits.document"),
    price: { discount: held.has("finance.discounts.apply"), discountOverride: held.has("finance.discounts.override"), increase: held.has("finance.price-increases.apply") } };
}

/** POST: the addition. */
export async function commandCanonicalInvoiceAddService(session: VerifiedDurableSession, rawInvoiceId: unknown, body: unknown, pool = getPool()) {
  const invoiceId = invoiceIdOf(rawInvoiceId);
  const command = parseInvoiceAddServiceCommand(body);
  const outcome = await withStaffOperation(pool, session, "finance.invoices.create", async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, "finance.invoices.create");
    const early = await staffOperationPatientScope(client, handle, "finance.invoices.create");
    if (early.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    // An early unlocked look: an outside invoice reads like a missing one before anything else.
    const { rows: [owner] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM invoices WHERE id = $1", [invoiceId]);
    if (!owner || (early.kind === "own" && !await patientInDoctorScopeWith(client, early.clinicianPartyId, owner.patient_id))) {
      throw new InvoiceAddServiceError("missing", MISSING);
    }
    const actor = canonicalInvoiceActor(identity, async current => {
      if (current !== client) throw new InvoiceAddServiceError("unauthorized", "تغيّر اتصال العملية.");
      return operationGrants(current, handle);
    }, { lab: canonicalLabActor(identity), debt: null });
    try {
      return await addInvoiceServiceOn(client, invoiceId, command, actor, async patientId => {
        const scope = await staffOperationPatientScope(client, handle, "finance.invoices.create");
        if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
        if (scope.kind === "all") return;
        let inside: boolean;
        try { inside = await doctorOwnsPatient(scope.clinicianPartyId, patientId, client, "nowait"); }
        catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "55P03") throw new InvoiceAddServiceError("conflict", "تعذّر تثبيت نطاق المريض. احتفظ بالطلب نفسه وأعد المحاولة.");
          throw error;
        }
        if (!inside) throw new InvoiceAddServiceError("missing", MISSING);
      });
    } catch (error) { return addServiceFailure(error); }
  });
  // The rejection evidence of a stale attempt is committed with the operation; then refuse.
  if (outcome.kind === "rejected") throw outcome.error;
  return outcome.receipt;
}
