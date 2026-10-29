import "server-only";
import {
  browsePatientsWith, computeDebtRowsInSnapshot, getPatientWith, getSettingsWith, listMedicalHistoryWith, listPatientAppointmentsWith,
  listPatientProblemsWith, listPatientVisitsWith, listVitalsWith, patientInDoctorScopeWith, patientTimelineWith, searchPatientsWith,
  listPatientDiagnosesWith, listIntakeFormsWith, listPatientReferralsWith, listContactConsentsWith, contactConsentStatesWith,
  CLINIC_TIME_ZONE, type PatientListRow,
} from "./db";
import { deriveAlerts, reviewDue } from "./medical-history";
import { parseConsentMode } from "./patient-identity";
import { clinicDateString } from "./schedule";
import type { TimelineEvent } from "./workflow";
import type { CanonicalSnapshotQuery } from "./canonical-read-snapshot";
import type { CanonicalRecordRead } from "./canonical-record-reads";
import type { Patient } from "./patient";
import type { Visit } from "./flow";
import type { Appointment } from "./schedule";
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
 * Projection by current grant and scope (M2_ROUTE_CAPABILITY_MAP.md §5). Release-gated:
 * which delegated grants see which group is owner policy still under review (Dot
 * 6480538845 item 4), so this keeps the narrowest technical default:
 *  - identity (id, file number, name, phone, gender, age): every admitted actor;
 *  - schedule (operational appointment context: last visit, next appointment): an
 *    `all` appointment scope;
 *  - care (clinical: medical alert, active orthodontics, flags): a clinical grant
 *    (PATIENT_CARE_CAPABILITIES). Appointment grants never reveal clinical fields;
 *  - balances: `finance.patient-ledger.view`.
 * The protected owner holds every group. Hidden groups are omitted, never replaced by
 * neutral values (an empty balance list would wrongly read as "no debt"); filters and
 * sorts that select on a hidden group refuse, so they cannot reveal it through counts.
 */
export const PATIENT_CARE_CAPABILITIES: readonly StaffCapability[] = Object.freeze([
  "clinical.plans.view", "clinical.visits.document", "clinical.xrays.view",
]);
export const PATIENT_DIRECTORY_MAX_BYTES = 1024 * 1024;
const SEARCH_LIMIT = 20;
export const PATIENT_PAGE_SIZE = 25;
const MAX_PAGE = 4000;

/** Bounded domain refusal (fixed code, Arabic message, no driver text). */
export class CanonicalPatientReadRefusal extends Error {
  constructor(readonly code: "patient_filter_not_granted" | "invalid_patient_query" | "patient_not_found", message: string) {
    super(message);
    this.name = "CanonicalPatientReadRefusal";
  }
}

export interface PatientDirectoryProjection { readonly care: boolean; readonly schedule: boolean; readonly balances: boolean }
export interface CanonicalPatientIdentity { id: number; patientNumber: string; fullName: string; phone: string | null }
export type CanonicalPatientRow = CanonicalPatientIdentity & Partial<Omit<PatientListRow, keyof CanonicalPatientIdentity>>;

export function patientDirectoryProjection(scope: Pick<CanonicalSnapshotScope, "granted" | "appointmentScope">): PatientDirectoryProjection {
  return Object.freeze({
    care: PATIENT_CARE_CAPABILITIES.some(capability => scope.granted(capability)),
    schedule: scope.appointmentScope.kind === "all",
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
  if ("gender" in row) Object.assign(out, { gender: row.gender, age: row.age });
  if (projection.schedule && "gender" in row) Object.assign(out, { lastVisitAt: row.lastVisitAt, nextAppointment: row.nextAppointment });
  if (projection.care) {
    out.medicalAlert = row.medicalAlert;
    if ("gender" in row) Object.assign(out, { activeOrtho: row.activeOrtho, flags: row.flags });
  }
  // The photo is served by /api/documents/[id], which is not canonical yet: no
  // reference is published until that route proves its own document grant.
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
    if (((["alert", "ortho"] as PatientListFilter[]).includes(input.filter) || input.flag) && !projection.care) {
      throw new CanonicalPatientReadRefusal("patient_filter_not_granted", "هذه التصفية تعتمد على بيانات العلاج، ولا تملك صلاحية عرضها.");
    }
    if ((input.filter === "no_next" || input.sort === "last_visit") && !projection.schedule) {
      throw new CanonicalPatientReadRefusal("patient_filter_not_granted", "هذه التصفية تعتمد على مواعيد المرضى، ولا تملك نطاق عرضها.");
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

/* ---------------------------------------------------------------------------
 * One patient's record (M2 slice 2).
 *
 * `readCanonicalPatientRecord` is the single entry for every per-patient canonical
 * read: one owning RR snapshot admitted by a registered patient record read, then,
 * in that same snapshot, the patient must exist AND be inside the actor's patient
 * scope (`all`, or `own` = the validated clinician's patients by the same predicate as
 * the list). A patient outside the scope is reported exactly like a missing one
 * (`patient_not_found`, 404): the response never reveals whether a file exists.
 * ------------------------------------------------------------------------- */
export async function readCanonicalPatientRecord<T>(
  session: VerifiedDurableSession,
  read: CanonicalRecordRead,
  patientId: number,
  reader: (query: CanonicalSnapshotQuery, scope: CanonicalSnapshotScope) => Promise<T>,
  maxBytes = PATIENT_DIRECTORY_MAX_BYTES,
): Promise<T> {
  if (!Number.isSafeInteger(patientId) || patientId <= 0) {
    throw new CanonicalPatientReadRefusal("invalid_patient_query", "رقم المريض غير صالح.");
  }
  return runCanonicalReadSnapshot(session, read, async (query, scope) => {
    const exists = (await query.query<{ found: boolean }>("SELECT EXISTS (SELECT 1 FROM patients WHERE id = $1) AS found", [patientId])).rows[0]?.found === true;
    const inside = exists && (scope.patientScope.kind === "all"
      || (scope.patientScope.kind === "own" && await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, patientId)));
    if (!inside) throw new CanonicalPatientReadRefusal("patient_not_found", "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
    return reader(query, scope);
  }, { errorPrefix: "STAFF_READ", maxBytes });
}

/** Identity and contact: every actor admitted to the record. */
const IDENTITY_FIELDS = ["id", "patientNumber", "fullName", "phone", "altPhone", "gender", "birthYear", "birthDate", "address",
  "guardianName", "guardianPhone", "nationalId", "email", "preferredChannel", "createdAt"] as const;
/** Care (clinical): one of PATIENT_CARE_CAPABILITIES — never an appointment grant. */
const CARE_FIELDS = ["medicalAlert", "flags", "note", "referralSource", "referredBy"] as const;
export type CanonicalPatientCore = Pick<Patient, typeof IDENTITY_FIELDS[number]> & Partial<Pick<Patient, typeof CARE_FIELDS[number]>>;
export interface CanonicalPatientFile {
  readonly patient: CanonicalPatientCore;
  /** Present only with the care summary. */
  readonly visits?: readonly Visit[];
  /** Present only with an appointment scope; `own` lists this clinician's appointments. */
  readonly appointments?: readonly Appointment[];
  readonly projection: PatientDirectoryProjection & { readonly appointments: "none" | "own" | "all" };
}

export async function readCanonicalPatientFile(session: VerifiedDurableSession, patientId: number): Promise<CanonicalPatientFile> {
  return readCanonicalPatientRecord(session, "read:patients.record", patientId, async (query, scope) => {
    const projection = patientDirectoryProjection(scope);
    const patient = await getPatientWith(query, patientId);
    if (!patient) throw new CanonicalPatientReadRefusal("patient_not_found", "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
    const core = Object.fromEntries(IDENTITY_FIELDS.map(field => [field, patient[field] ?? null])) as unknown as CanonicalPatientCore;
    if (projection.care) for (const field of CARE_FIELDS) (core as Record<string, unknown>)[field] = patient[field] ?? null;
    const appointmentScope = scope.appointmentScope;
    return {
      patient: core,
      ...(projection.care ? { visits: await listPatientVisitsWith(query, patientId) } : {}),
      ...(appointmentScope.kind === "none" ? {} : {
        appointments: await listPatientAppointmentsWith(query, patientId, appointmentScope.kind === "own" ? appointmentScope.clinicianPartyId : null),
      }),
      projection: { ...projection, appointments: appointmentScope.kind },
    };
  });
}

/* ---------------------------------------------------------------------------
 * Clinical sub-reads and the timeline (M2 slice 3).
 * ------------------------------------------------------------------------- */
/** Medical history: latest version, version list, derived alerts, review due, vitals. */
export async function readCanonicalMedicalHistory(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:patients.clinical", patientId, async query => {
    const versions = await listMedicalHistoryWith(query, patientId);
    const vitals = await listVitalsWith(query, patientId);
    const settings = await getSettingsWith(query);
    const latest = versions[0] ?? null;
    const months = Number(settings["clinical.medical_history_review_months"]) || 6;
    return {
      latest,
      versions: versions.map(version => ({ id: version.id, recordedAt: version.recordedAt, recordedBy: version.recordedBy })),
      alerts: latest ? deriveAlerts(latest) : [],
      review: reviewDue(latest?.recordedAt ?? null, months, clinicDateString(new Date(), CLINIC_TIME_ZONE)),
      vitals,
    };
  });
}
export async function readCanonicalVitals(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:patients.clinical", patientId, async query => ({ vitals: await listVitalsWith(query, patientId, 30) }));
}
export async function readCanonicalProblems(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:patients.clinical", patientId, async query => listPatientProblemsWith(query, patientId));
}

/** Timeline event groups (Dot 6480538845 item 3): a hidden group's events are omitted
 * entirely, never masked, so neither amounts nor the existence of hidden events leak. */
const FINANCIAL_EVENTS = new Set<TimelineEvent["kind"]>(["invoice", "payment"]);
const SCHEDULE_EVENTS = new Set<TimelineEvent["kind"]>(["appointment"]);
export async function readCanonicalTimeline(session: VerifiedDurableSession, patientId: number, limit: number) {
  const bounded = Number.isFinite(limit) ? Math.max(10, Math.min(200, Math.round(limit))) : 60;
  return readCanonicalPatientRecord(session, "read:patients.record", patientId, async (query, scope) => {
    const projection = patientDirectoryProjection(scope);
    const events = (await patientTimelineWith(query, patientId, bounded)).filter(event =>
      FINANCIAL_EVENTS.has(event.kind) ? projection.balances
        : SCHEDULE_EVENTS.has(event.kind) ? projection.schedule
          : projection.care);
    return { events, canSeeFinancial: projection.balances, projection };
  });
}

/* ---------------------------------------------------------------------------
 * More patient file reads (M2 slice 4).
 * ------------------------------------------------------------------------- */
export async function readCanonicalDiagnoses(session: VerifiedDurableSession, patientId: number, orthoCaseId: number | null) {
  return readCanonicalPatientRecord(session, "read:patients.clinical", patientId, async query =>
    ({ diagnoses: await listPatientDiagnosesWith(query, patientId, orthoCaseId ?? undefined) }));
}
export async function readCanonicalIntakeHistory(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:patients.clinical", patientId, async query => ({ forms: await listIntakeFormsWith(query, patientId) }));
}
export async function readCanonicalReferrals(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:patients.clinical", patientId, async query => listPatientReferralsWith(query, patientId));
}
/** Contact consents: communication preferences of a patient inside the scope. Whether
 * the screen offers recording follows the write's capability (`patients.edit`), never a
 * role label; the write route proves it again. */
export async function readCanonicalContactConsents(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:patients.record", patientId, async (query, scope) => {
    const history = await listContactConsentsWith(query, patientId);
    const states = await contactConsentStatesWith(query, [patientId]);
    const settings = await getSettingsWith(query);
    return { mode: parseConsentMode(settings["messaging.consent_mode"]), states: states.get(patientId), history, canRecord: scope.granted("patients.edit") };
  });
}

