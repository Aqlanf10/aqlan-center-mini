import "server-only";
import { getPool, getSettingsWith, type DbClient } from "./db";
import { CanonicalPlanRefusal, earlyInside, lockedAdmission, type ScopedAction } from "./canonical-plan-writes";
import { readCanonicalPatientRecord } from "./canonical-patient-reads";
import { canonicalDebtActor } from "./debt-installments-db";
import type { LegacyTreatmentRefusal, LegacyTreatmentRequest, LegacyVoidRefusal } from "./legacy-treatment";
import { createLegacyTreatmentOn, getLegacyVoidPreviewWith, previewLegacyTreatmentWith, voidLegacyTreatmentOn } from "./legacy-treatment-db";
import type { LegacyVoidMode } from "./legacy-treatment-void";
import { effectiveTemplates } from "./specialty-templates";
import { staffOperationCapabilities, staffOperationIdentity, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * Pre-system treatments on the canonical runtime (M2 slice 95b; G4-1, G4-2, G4-6; contract
 * section 15). Record and preview by `finance.legacy.record`; increasing an existing opening also
 * needs `finance.opening-balances.manage`. Void (preview and apply) by `finance.legacy.void` and
 * `finance.patient-ledger.view`; the administrator exception mode also needs opening management.
 * The legacy writers run on the admitted operation's transaction; the scope is decided right after
 * the patient row lock (outside reads as missing). A refusal carries the legacy reason, message and
 * status, and the operation rolls back. Labels and the reception setting decide nothing.
 */
const LEDGER = "finance.patient-ledger.view" as const;
const OPENING = "finance.opening-balances.manage" as const;

/** A writer refusal with the legacy reason; `code` lets it pass the read snapshot as a bounded
 * domain refusal (fixed lower-case code, no driver text). */
export class CanonicalLegacyRefusal extends Error {
  readonly code: string;
  constructor(readonly reason: LegacyTreatmentRefusal | LegacyVoidRefusal) { super(reason); this.name = "CanonicalLegacyRefusal"; this.code = reason; }
}

/** The early unlocked look: missing or outside reads as the writer's own missing refusal. */
async function early(client: DbClient, handle: StaffOperationHandle, action: ScopedAction, patientId: number, missing: "no_patient" | "not_found") {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) throw new CanonicalLegacyRefusal(missing);
  const { rows: [row] } = await client.query<{ id: number }>("SELECT id FROM patients WHERE id = $1", [patientId]);
  if (!row || !await earlyInside(client, handle, action, patientId)) throw new CanonicalLegacyRefusal(missing);
}

/** After the writer's patient row lock: the authoritative decision; outside reads as missing. */
function admitAfterLock(client: DbClient, handle: StaffOperationHandle, action: ScopedAction, missing: "no_patient" | "not_found") {
  const admit = lockedAdmission(client, handle, action, "");
  return async (patientId: number) => {
    try { await admit(patientId); }
    catch (error) { if (error instanceof CanonicalPlanRefusal && error.code === "plan_not_found") throw new CanonicalLegacyRefusal(missing); throw error; }
  };
}

/** POST /api/patients/[id]/legacy-treatments. */
export async function commandCanonicalLegacyTreatment(session: VerifiedDurableSession, patientId: number, request: LegacyTreatmentRequest, pool = getPool()) {
  const action = "finance.legacy.record" as const;
  return withStaffOperation(pool, session, action, async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, action);
    await early(client, handle, action, patientId, "no_patient");
    const held = await staffOperationCapabilities(client, handle, action, [action, OPENING] as const);
    const canEditOpening = held.has(OPENING);
    const needed = canEditOpening ? [action, OPENING] as const : [action] as const;
    const actor = canonicalDebtActor(identity, async current => {
      if (current !== client) return false;
      const now = await staffOperationCapabilities(current, handle, action, [action, OPENING] as const);
      return needed.every(capability => now.has(capability));
    });
    const settings = await getSettingsWith(client);
    const result = await createLegacyTreatmentOn(client, {
      patientId, request, actor: identity.username, actorRole: identity.role, canEditOpening, session: actor,
      templates: effectiveTemplates(settings["plans.specialty_templates"]).templates,
    }, admitAfterLock(client, handle, action, "no_patient"));
    if (!result.ok) throw new CanonicalLegacyRefusal(result.reason);
    return { agreement: result.agreement, replayed: result.replayed, caseCreated: result.caseCreated };
  });
}

/** POST /api/patients/[id]/legacy-treatments/preview: read-only; opening amounts with the ledger view. */
export async function readCanonicalLegacyTreatmentPreview(session: VerifiedDurableSession, patientId: number, request: LegacyTreatmentRequest) {
  return readCanonicalPatientRecord(session, "read:legacy.record", patientId, async (query, scope) => {
    const result = await previewLegacyTreatmentWith(query as DbClient, { patientId, request, canEditOpening: scope.granted(OPENING) });
    if (result.ok && result.preview.opening && !scope.granted(LEDGER)) {
      result.preview.opening = { ...result.preview.opening, beforeMinor: null, afterMinor: null };
    }
    return result;
  });
}

function voidAllowed(granted: (capability: typeof LEDGER | typeof OPENING) => boolean, mode: LegacyVoidMode) {
  return granted(LEDGER) && (mode !== "manager_authorized" || granted(OPENING));
}

/** GET /api/patients/[id]/legacy-treatments/[agreementId]/void: the impact preview. */
export async function readCanonicalLegacyVoidPreview(session: VerifiedDurableSession, patientId: number, agreementId: number, mode: LegacyVoidMode) {
  return readCanonicalPatientRecord(session, "read:legacy.void", patientId, async (query, scope) => {
    if (!voidAllowed(capability => scope.granted(capability), mode)) throw new CanonicalLegacyRefusal("void_forbidden");
    const identity = { actor: scope.username, actorRole: scope.role };
    const result = await getLegacyVoidPreviewWith(query as DbClient, { patientId, agreementId, mode, ...identity });
    if (!result.ok) throw new CanonicalLegacyRefusal(result.reason);
    return { preview: result.preview };
  });
}

/** POST /api/patients/[id]/legacy-treatments/[agreementId]/void. */
export async function commandCanonicalLegacyVoid(session: VerifiedDurableSession, patientId: number, agreementId: number,
  input: { reason: string; mode: LegacyVoidMode; previewToken?: string }, pool = getPool()) {
  const action = "finance.legacy.void" as const;
  return withStaffOperation(pool, session, action, async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, action);
    const held = await staffOperationCapabilities(client, handle, action, [LEDGER, OPENING] as const);
    if (!voidAllowed(capability => held.has(capability), input.mode)) throw new CanonicalLegacyRefusal("void_forbidden");
    await early(client, handle, action, patientId, "not_found");
    const result = await voidLegacyTreatmentOn(client, { patientId, agreementId, ...input, actor: identity.username, actorRole: identity.role },
      admitAfterLock(client, handle, action, "not_found"));
    if (!result.ok) throw new CanonicalLegacyRefusal(result.reason);
    return { agreement: result.agreement };
  });
}
