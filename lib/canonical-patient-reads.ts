import "server-only";
import { browsePatientsWith, computeDebtRowsInSnapshot, searchPatientsWith, type PatientListRow } from "./db";
import { runCanonicalReadSnapshot, type CanonicalSnapshotScope } from "./canonical-read-snapshot";
import type { PatientListFilter, PatientListSort } from "./patient-browse";
import type { VerifiedDurableSession } from "./staff-durable-session";
import type { StaffCapability } from "./staff-capability-catalogue";

/**
 * Canonical patient directory (M2 slice 1, GET /api/patients).
 *
 * Admission: the registered record read `read:patients.directory`, inside one owning
 * RR READ ONLY snapshot. The actor's patient scope must not be `none`; `own` limits
 * rows to the validated clinician link (the same "this doctor's patients" condition
 * the legacy path uses), `all` lists every patient. A role label never decides.
 *
 * Projection by current grant (M2_ROUTE_CAPABILITY_MAP.md §5, for review):
 *  - identity (id, file number, name, phone): every admitted actor;
 *  - care summary (medical alert, gender, age, last visit, next appointment, active
 *    orthodontics, flags): one of PATIENT_CARE_CAPABILITIES;
 *  - balances: `finance.patient-ledger.view`.
 * Hidden groups are omitted, never replaced by neutral values (an empty balance list
 * would wrongly read as "no debt"). Filters that select on a hidden group refuse.
 */
export const PATIENT_CARE_CAPABILITIES: readonly StaffCapability[] = Object.freeze([
  "clinical.plans.view", "clinical.visits.document", "clinical.xrays.view", "appointments.create", "appointments.edit",
]);
export const PATIENT_DIRECTORY_MAX_BYTES = 1024 * 1024;
const SEARCH_LIMIT = 20;
export const PATIENT_PAGE_SIZE = 25;
const MAX_PAGE = 4000;

/** Bounded domain refusal (fixed code, Arabic message, no driver text). */
export class CanonicalPatientReadRefusal extends Error {
  constructor(readonly code: "patient_filter_not_granted" | "invalid_patient_query", message: string) {
    super(message);
    this.name = "CanonicalPatientReadRefusal";
  }
}

export interface PatientDirectoryProjection { readonly care: boolean; readonly balances: boolean }
export interface CanonicalPatientIdentity { id: number; patientNumber: string; fullName: string; phone: string | null }
export type CanonicalPatientRow = CanonicalPatientIdentity & Partial<Omit<PatientListRow, keyof CanonicalPatientIdentity>>;

export function patientDirectoryProjection(scope: Pick<CanonicalSnapshotScope, "granted">): PatientDirectoryProjection {
  return Object.freeze({
    care: PATIENT_CARE_CAPABILITIES.some(capability => scope.granted(capability)),
    balances: scope.granted("finance.patient-ledger.view"),
  });
}
function doctorPartyOf(scope: CanonicalSnapshotScope): number | null {
  // The reader never runs a record read with scope `none`; `own` carries the
  // validated clinician party from the same proof.
  if (scope.patientScope.kind === "own") return scope.patientScope.clinicianPartyId;
  if (scope.patientScope.kind === "all") return null;
  throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
}
function project(row: PatientListRow | { id: number; patientNumber: string; fullName: string; phone: string | null; medicalAlert: string | null }, projection: PatientDirectoryProjection): CanonicalPatientRow {
  const out: CanonicalPatientRow = { id: row.id, patientNumber: row.patientNumber, fullName: row.fullName, phone: row.phone };
  if (projection.care) {
    out.medicalAlert = row.medicalAlert;
    if ("gender" in row) {
      Object.assign(out, {
        gender: row.gender, age: row.age, lastVisitAt: row.lastVisitAt, nextAppointment: row.nextAppointment,
        activeOrtho: row.activeOrtho, flags: row.flags,
      });
      // The photo is served by /api/documents/[id], which is not canonical yet: no
      // reference is published until that route proves its own document grant.
    }
  }
  if (projection.balances && "balances" in row) out.balances = row.balances;
  return out;
}

export interface CanonicalPatientSearch { readonly kind: "search"; readonly term: string }
export interface CanonicalPatientBrowse {
  readonly kind: "browse"; readonly page: number; readonly filter: PatientListFilter; readonly sort: PatientListSort;
  readonly flag: string | null; readonly today: string;
}

export async function readCanonicalPatientSearch(session: VerifiedDurableSession, input: CanonicalPatientSearch) {
  const term = input.term.trim().slice(0, 100);
  return runCanonicalReadSnapshot(session, "read:patients.directory", async (query, scope) => {
    const projection = patientDirectoryProjection(scope);
    const rows = await searchPatientsWith(query, term, SEARCH_LIMIT, doctorPartyOf(scope));
    return { rows: rows.map(row => project(row, projection)), projection };
  }, { errorPrefix: "STAFF_READ", maxBytes: PATIENT_DIRECTORY_MAX_BYTES });
}

export async function readCanonicalPatientBrowse(session: VerifiedDurableSession, input: CanonicalPatientBrowse) {
  if (!Number.isSafeInteger(input.page) || input.page < 0 || input.page > MAX_PAGE || !/^\d{4}-\d{2}-\d{2}$/.test(input.today)) {
    throw new CanonicalPatientReadRefusal("invalid_patient_query", "طلب قائمة المرضى غير صالح.");
  }
  return runCanonicalReadSnapshot(session, "read:patients.directory", async (query, scope) => {
    const projection = patientDirectoryProjection(scope);
    if (input.filter === "debt" && !projection.balances) {
      throw new CanonicalPatientReadRefusal("patient_filter_not_granted", "تصفية المرضى بالمبالغ تحتاج صلاحية عرض حساب المريض.");
    }
    if ((["alert", "ortho", "no_next"] as PatientListFilter[]).includes(input.filter) || input.flag || input.sort === "last_visit") {
      if (!projection.care) {
        throw new CanonicalPatientReadRefusal("patient_filter_not_granted", "هذه التصفية تعتمد على بيانات العلاج، ولا تملك صلاحية عرضها.");
      }
    }
    const { rows, total } = await browsePatientsWith(query, {
      offset: input.page * PATIENT_PAGE_SIZE, limit: PATIENT_PAGE_SIZE, filter: input.filter, sort: input.sort,
      doctorPartyId: doctorPartyOf(scope), flag: input.flag, today: input.today,
    }, ids => projection.balances || input.filter === "debt"
      ? computeDebtRowsInSnapshot(ids === null ? null : [...ids], false, query)
      : Promise.resolve([]));
    return {
      rows: rows.map(row => project(row, projection)), total, page: input.page, pageSize: PATIENT_PAGE_SIZE,
      filter: input.filter, sort: input.sort, flag: input.flag, projection,
    };
  }, { errorPrefix: "STAFF_READ", maxBytes: PATIENT_DIRECTORY_MAX_BYTES });
}
