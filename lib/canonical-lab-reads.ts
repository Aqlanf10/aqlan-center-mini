import "server-only";
import { CLINIC_TIME_ZONE, labCountsWith, listLabNamesWith, listLabOrdersWith, listLabServicesWith } from "./db";
import type { LabOrder, LabOrderClinicalDTO } from "./lab";
import type { LabBacklogFilter } from "./lab-backlog";
import { readLabBacklogWith } from "./lab-backlog-db";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * Canonical lab reads (M2 slice 66): GET /api/lab and GET /api/lab/backlog.
 *
 * - Orders (`read:lab.orders`, clinical.lab.view): one owning REPEATABLE READ snapshot.
 *   The patient scope is applied in SQL before the list limit (`own` = the central
 *   DOCTOR_PATIENT_CONDITION; a patient outside it answers like a patient without
 *   orders). The legacy route listed every clinic order to every admitted role.
 * - Money: the clinical fields are an ALLOWLIST; cost, base amount, rate, payable,
 *   accounts and posting are added only with `finance.cost-prices.view`. The legacy
 *   route hid only cost/currency from doctors (the base amount and rate stayed visible).
 * - Badge counts (`summary=1`) follow the same scope.
 * - Backlog (`read:lab.backlog`): the whole clinic's open work, so the WHOLE patient
 *   scope is required (`all`; `own` is refused). Linked tasks (titles, assignees) only
 *   with `tasks.use`; private tasks of others never (unchanged SQL).
 */
export class CanonicalLabReadRefusal extends Error {
  constructor(readonly code: "invalid_lab_query", readonly status: 400, message: string) {
    super(message);
    this.name = "CanonicalLabReadRefusal";
  }
}

const CLINICAL_KEYS = Object.freeze([
  "id", "patientId", "patientName", "patientNumber", "patientPhone", "labName", "labPhone", "partyId", "labServiceId", "serviceName",
  "workType", "details", "toothNumbers", "shade", "shadeSpecification", "shadeSpecificationWarning", "stumpShade", "priority", "impressionType",
  "sentDate", "dueDate", "status", "receivedAt", "deliveredAt", "doctorId", "doctorName", "visitId", "toothCode", "source",
  "qualityCheck", "qualityNotes", "remakeOriginalId", "remakeReason", "technicianName", "note", "createdAt",
] as const satisfies readonly (keyof LabOrderClinicalDTO)[]);

/** The clinical projection of an order: only allowlisted fields, never the money group. */
export function clinicalLabOrder(order: LabOrder): LabOrderClinicalDTO {
  const out: Record<string, unknown> = {};
  for (const key of CLINICAL_KEYS) if (key in order) out[key] = (order as unknown as Record<string, unknown>)[key];
  return out as unknown as LabOrderClinicalDTO;
}

export async function readCanonicalLabOrders(session: VerifiedDurableSession, params: URLSearchParams) {
  const summaryOnly = params.get("summary") === "1";
  const withServices = params.get("services") === "1";
  const rawPatient = params.get("patientId");
  let patientId: number | null = null;
  if (rawPatient !== null && rawPatient !== "") {
    // Digits only: `Number("1e9")` is an integer too.
    if (!/^[1-9][0-9]{0,9}$/.test(rawPatient) || Number(rawPatient) > 2147483647) throw new CanonicalLabReadRefusal("invalid_lab_query", 400, "رقم المريض غير صالح.");
    patientId = Number(rawPatient);
  }
  return runCanonicalReadSnapshot(session, "read:lab.orders", async (query, scope) => {
    const clinician = scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null;
    const costs = scope.granted("finance.cost-prices.view");
    if (summaryOnly) return labCountsWith(query, undefined, clinician);
    // One snapshot, read in order (a client runs one statement at a time).
    const orders = await listLabOrdersWith(query, patientId !== null ? { patientId } : undefined, clinician);
    const labs = await listLabNamesWith(query);
    const labServices = withServices ? await listLabServicesWith(query) : null;
    return {
      orders: costs ? orders : orders.map(clinicalLabOrder),
      labs,
      ...(labServices ? { labServices } : {}),
      projection: { costs },
    };
  }, { errorPrefix: "STAFF_READ", maxBytes: 4 * 1024 * 1024 });
}

export async function readCanonicalLabBacklog(session: VerifiedDurableSession, input: { filter: LabBacklogFilter; page: number }) {
  return runCanonicalReadSnapshot(session, "read:lab.backlog", async (query, scope) => {
    // The whole clinic's open work: a clinician's own scope is not enough.
    if (scope.patientScope.kind !== "all") throw new Error("STAFF_READ_RECORD_SCOPE_DENIED");
    return readLabBacklogWith(query, input, CLINIC_TIME_ZONE, { userId: scope.userId, tasks: scope.granted("tasks.use") });
  }, { errorPrefix: "STAFF_READ", maxBytes: 1024 * 1024 });
}
