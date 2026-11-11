import "server-only";
import { getPool, type DbClient } from "./db";
import { CanonicalPlanRefusal, earlyInside, lockedAdmission } from "./canonical-plan-writes";
import { readCanonicalPatientRecord } from "./canonical-patient-reads";
import { CanonicalLegacyArchiveRefusal } from "./canonical-legacy-reads";
import { canonicalDebtActor, DebtRepaymentError } from "./debt-installments-db";
import {
  correctHistoricalDocumentOn, createHistoricalDocumentOn, previewHistoricalDocumentWith, type HistoricalCanonicalAuthority,
} from "./legacy-treatment-document-db";
import type { StaffCapability } from "./staff-capability-catalogue";
import { staffOperationCapabilities, staffOperationIdentity, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * Historical documents on the canonical runtime (M2 slice 95c; G4-1, G4-2, G4-6; contract
 * section 15, points 7 and 8). Record and preview by `patients.history.record` with
 * `finance.patient-ledger.view` (the request carries the account position); changing an existing
 * opening also needs `finance.opening-balances.manage`; line prices and the discount by the price
 * grants (discounts.apply / discounts.override / price-increases.apply). Correct by
 * `patients.history.correct`, `finance.opening-balances.manage` and the ledger view. The writers
 * run on the admitted operation's transaction; the scope is decided right after the patient row
 * lock and before the replay (outside reads as missing). Labels and the reception setting decide
 * nothing; `created_role` records the authority class (point 8).
 */
const RECORD = "patients.history.record" as const;
const CORRECT = "patients.history.correct" as const;
const LEDGER = "finance.patient-ledger.view" as const;
const OPENING = "finance.opening-balances.manage" as const;
const DISCOUNT = "finance.discounts.apply" as const;
const OVERRIDE = "finance.discounts.override" as const;
const INCREASE = "finance.price-increases.apply" as const;
const RECORD_HELD = [RECORD, LEDGER, OPENING, DISCOUNT, OVERRIDE, INCREASE] as const;
const MISSING = "المريض غير موجود.";

function authority(granted: (capability: StaffCapability) => boolean): HistoricalCanonicalAuthority {
  return {
    access: { add: true, edit: granted(OPENING) },
    grants: { discount: granted(DISCOUNT), discountOverride: granted(OVERRIDE), increase: granted(INCREASE) },
  };
}

function validPatient(patientId: number) {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw new DebtRepaymentError("invalid", "رقم المريض غير صالح.");
}

/** The early unlocked look: missing or outside reads as the writer's own missing refusal. */
async function early(client: DbClient, handle: StaffOperationHandle, action: typeof RECORD | typeof CORRECT, patientId: number) {
  const { rows: [row] } = await client.query<{ id: number }>("SELECT id FROM patients WHERE id = $1", [patientId]);
  if (!row || !await earlyInside(client, handle, action, patientId)) throw new DebtRepaymentError("missing", MISSING);
}

/** After the writer's patient row lock: the authoritative decision; outside reads as missing. */
function admitAfterLock(client: DbClient, handle: StaffOperationHandle, action: typeof RECORD | typeof CORRECT) {
  const admit = lockedAdmission(client, handle, action, "");
  return async (patientId: number) => {
    try { await admit(patientId); }
    catch (error) { if (error instanceof CanonicalPlanRefusal && error.code === "plan_not_found") throw new DebtRepaymentError("missing", MISSING); throw error; }
  };
}

/** POST /api/patients/[id]/historical-documents/preview: read-only under read:history.record. */
export async function readCanonicalHistoricalDocumentPreview(session: VerifiedDurableSession, patientId: number, source: Record<string, unknown>) {
  validPatient(patientId);
  return readCanonicalPatientRecord(session, "read:history.record", patientId, async (query, scope) => {
    if (!scope.granted(LEDGER)) throw new CanonicalLegacyArchiveRefusal();
    // The preview never reaches assertDebtSession; the actor only names the request.
    const actor = canonicalDebtActor({ userId: scope.userId, username: scope.username, role: scope.role }, async () => false);
    return previewHistoricalDocumentWith(query as DbClient, patientId, source, actor, authority(capability => scope.granted(capability)));
  });
}

/** POST /api/patients/[id]/historical-documents. */
export async function commandCanonicalHistoricalDocument(session: VerifiedDurableSession, patientId: number, source: Record<string, unknown>, pool = getPool()) {
  validPatient(patientId);
  return withStaffOperation(pool, session, RECORD, async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, RECORD);
    const held = await staffOperationCapabilities(client, handle, RECORD, RECORD_HELD);
    if (!held.has(LEDGER)) throw new CanonicalLegacyArchiveRefusal();
    await early(client, handle, RECORD, patientId);
    // The decision is taken once; the recheck proves every grant it used is still held.
    const needed = RECORD_HELD.filter(capability => held.has(capability));
    const actor = canonicalDebtActor(identity, async current => {
      if (current !== client) return false;
      const now = await staffOperationCapabilities(current, handle, RECORD, RECORD_HELD);
      return needed.every(capability => now.has(capability));
    });
    return createHistoricalDocumentOn(client, patientId, source, actor, authority(capability => held.has(capability as typeof RECORD_HELD[number])),
      admitAfterLock(client, handle, RECORD));
  });
}

/** POST /api/patients/[id]/historical-documents/[documentId]/correct. */
export async function commandCanonicalHistoricalCorrection(session: VerifiedDurableSession, patientId: number, documentId: number,
  source: Record<string, unknown>, pool = getPool()) {
  validPatient(patientId);
  if (!Number.isSafeInteger(documentId) || documentId <= 0) throw new DebtRepaymentError("invalid", "هوية الاتفاق غير صالحة.");
  const needed = [CORRECT, OPENING, LEDGER] as const;
  const PRICE = { discount: DISCOUNT, discountOverride: OVERRIDE, increase: INCREASE } as const;
  return withStaffOperation(pool, session, CORRECT, async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, CORRECT);
    const held = await staffOperationCapabilities(client, handle, CORRECT, [...needed, DISCOUNT, OVERRIDE, INCREASE] as const);
    // The correction and opening grants are not a price exception: the price grants decide what
    // the correction changes in prices and discount, and the re-proof covers the grants it used.
    let used: Array<keyof typeof PRICE> = [];
    if (!held.has(LEDGER)) throw new CanonicalLegacyArchiveRefusal();
    if (!held.has(OPENING)) throw new DebtRepaymentError("unauthorized", "تصحيح الاتفاق التاريخي يحتاج صلاحية إدارة الأرصدة الافتتاحية.");
    await early(client, handle, CORRECT, patientId);
    const actor = canonicalDebtActor(identity, async current => {
      if (current !== client) return false;
      const now = await staffOperationCapabilities(current, handle, CORRECT, [...needed, DISCOUNT, OVERRIDE, INCREASE] as const);
      return needed.every(capability => now.has(capability)) && used.every(grant => now.has(PRICE[grant]));
    });
    return correctHistoricalDocumentOn(client, patientId, documentId, source, actor, admitAfterLock(client, handle, CORRECT),
      { grants: authority(capability => held.has(capability as typeof needed[number])).grants, used: list => { used = list; } });
  });
}
