import "server-only";
import { getPool, insertAuditRow, type DbClient } from "./db";
import { CanonicalPlanRefusal, earlyInside, lockedAdmission } from "./canonical-plan-writes";
import { CanonicalLegacyArchiveRefusal } from "./canonical-legacy-reads";
import {
  cancelLegacyBalanceArrangementOn, createLegacyBalanceArrangementOn, type CancelLegacyArrangementResult, type CreateLegacyArrangementResult,
} from "./legacy-balance-arrangements-db";
import type { LegacyArrangementCadence } from "./legacy-balance-arrangements";
import type { Currency } from "./money";
import { staffOperationCapabilities, staffOperationIdentity, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * The previous-balance collection arrangement on the canonical runtime (M2 slice 95d; G4-1, G4-6;
 * contract section 15, "95d detail", point 9). Create and cancel by `finance.legacy.record` with
 * `finance.patient-ledger.view` (the response and the offering screen show the opening position).
 * An arrangement schedules what is already owed and never changes an opening, so opening
 * management is not needed. The writers run on the admitted operation's transaction; the scope is
 * decided right after the patient row lock (outside reads as missing); the audit row is written in
 * the same transaction. The label decides nothing.
 */
const ACTION = "finance.legacy.record" as const;
const LEDGER = "finance.patient-ledger.view" as const;
type CreateReason = Extract<CreateLegacyArrangementResult, { ok: false }>["reason"];
type CancelReason = Extract<CancelLegacyArrangementResult, { ok: false }>["reason"];

/** A writer refusal with the legacy reason; the route maps it to the legacy message and status. */
export class CanonicalLegacyArrangementRefusal extends Error {
  readonly code: string;
  constructor(readonly reason: CreateReason | CancelReason) { super(reason); this.name = "CanonicalLegacyArrangementRefusal"; this.code = reason; }
}

async function admitted<T>(session: VerifiedDurableSession, patientId: number, missing: "patient_not_found" | "not_found", pool: ReturnType<typeof getPool>,
  write: (client: DbClient, actor: { username: string; role: string }, afterLocks: (patientId: number) => Promise<void>) => Promise<T>) {
  return withStaffOperation(pool, session, ACTION, async (client, handle: StaffOperationHandle) => {
    const identity = await staffOperationIdentity(client, handle, ACTION);
    const held = await staffOperationCapabilities(client, handle, ACTION, [LEDGER] as const);
    if (!held.has(LEDGER)) throw new CanonicalLegacyArchiveRefusal();
    const { rows: [row] } = Number.isSafeInteger(patientId) && patientId > 0
      ? await client.query<{ id: number }>("SELECT id FROM patients WHERE id = $1", [patientId]) : { rows: [] };
    if (!row || !await earlyInside(client, handle, ACTION, patientId)) throw new CanonicalLegacyArrangementRefusal(missing);
    const admit = lockedAdmission(client, handle, ACTION, "");
    const afterLocks = async (locked: number) => {
      try { await admit(locked); }
      catch (error) { if (error instanceof CanonicalPlanRefusal && error.code === "plan_not_found") throw new CanonicalLegacyArrangementRefusal(missing); throw error; }
    };
    const result = await write(client, identity, afterLocks);
    // The decision used the ledger view: prove it is still held before the operation commits.
    if (!(await staffOperationCapabilities(client, handle, ACTION, [LEDGER] as const)).has(LEDGER)) throw new CanonicalLegacyArchiveRefusal();
    return result;
  });
}

/** POST /api/patients/[id]/legacy-balance-arrangement. */
export async function commandCanonicalLegacyArrangement(session: VerifiedDurableSession, patientId: number, input: {
  currency: Currency; cadence: LegacyArrangementCadence; installmentMinor: number; firstDueDate: string | null; note: string | null; today: string;
}, pool = getPool()) {
  try {
    return await admitted(session, patientId, "patient_not_found", pool, async (client, actor, afterLocks) => {
      const result = await createLegacyBalanceArrangementOn(client, { patientId, ...input, createdBy: actor.username }, afterLocks);
      if (!result.ok) throw new CanonicalLegacyArrangementRefusal(result.reason);
      await insertAuditRow(client, {
        action: "legacy_balance_arrangement.create", entity: "patient", entityId: patientId, actor: actor.username, actorRole: actor.role,
        details: {
          العملة: result.arrangement.currency, الرصيد_عند_الترتيب: result.arrangement.startingDueMinor, القسط: result.arrangement.installmentMinor,
          النمط: result.arrangement.cadence, أول_استحقاق: result.arrangement.firstDueDate, ملاحظة: result.arrangement.note,
        },
      });
      return result.arrangement;
    });
  } catch (error) {
    // One active arrangement per patient and currency (the unique index): the legacy refusal.
    if ((error as { code?: string } | null)?.code === "23505") throw new CanonicalLegacyArrangementRefusal("already_active");
    throw error;
  }
}

/** PATCH /api/patients/[id]/legacy-balance-arrangement: cancel with a reason. */
export async function commandCanonicalLegacyArrangementCancel(session: VerifiedDurableSession, patientId: number,
  input: { arrangementId: number; reason: string }, pool = getPool()) {
  return admitted(session, patientId, "not_found", pool, async (client, actor, afterLocks) => {
    const result = await cancelLegacyBalanceArrangementOn(client, { patientId, ...input, actor: actor.username }, afterLocks);
    if (!result.ok) throw new CanonicalLegacyArrangementRefusal(result.reason);
    await insertAuditRow(client, {
      action: "legacy_balance_arrangement.cancel", entity: "patient", entityId: patientId, actor: actor.username, actorRole: actor.role,
      details: { الترتيب: input.arrangementId, العملة: result.arrangement.currency, القسط: result.arrangement.installmentMinor, السبب: input.reason },
    });
    return { ok: true as const };
  });
}
