import "server-only";
import {
  CLINIC_TIME_ZONE, addWaitingEntryWith, getPool, getSettingsWith, getWaitingEntryWith, insertAuditRow, listWaitingContactEventsForWith,
  listWaitingContactEventsWith, listWaitingEntriesWith, markWaitingOfferedWith, patientInDoctorScopeWith,
  recordWaitingContactWith, resolveWaitingEntryWith, updateWaitingPreferencesWith, type DbClient,
} from "./db";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { markStale } from "./waiting-list-match";
import { clinicDateString } from "./schedule";
import {
  CONTACT_CHANNELS, CONTACT_OUTCOMES, PERIODS, SHIFTS, URGENCIES, normalizeWeekdays,
  type ContactChannel, type ContactEvent, type ContactOutcome, type PreferredPeriod, type PreferredShift, type WaitingEntry, type WaitingEntryInput, type WaitingUrgency,
} from "./waiting-list";
import type { StaffRecordConstraint } from "./staff-capabilities";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationAppointmentScope, staffOperationIdentity, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";

/**
 * Canonical waiting list (M2 slice 14): GET/POST /api/waiting-list and GET/PATCH
 * /api/waiting-list/[id].
 *
 * A scheduling record, so the APPOINTMENT scope decides (map: scope appointment), with
 * the meaning it has for appointments (slice 2): `all` lists every entry; `own` lists
 * the entries assigned to the actor's clinician party. A role label never widens it.
 * An entry or patient outside the scope answers exactly like a missing one.
 *
 * Reads: the record read `read:waiting-list`, one owning snapshot; the hold-days
 * setting and the contact history come from the same snapshot.
 * Writes: one admitted `appointments.edit` transaction each (add, offer, contact,
 * preferences, cancel, expire). The entry row is locked first, then checked against the
 * scope; the audit row is written in the same transaction (the legacy path keeps its
 * best-effort audit after the write). An `own`-scope actor adds entries only for its
 * own patients (the patient list's condition), assigned to its own clinician party
 * (the default), so the entry stays inside its scope; any named doctor must be active
 * and any service must exist.
 * Not canonical yet (409): the free-slot matching mode of the list and `book` (both go
 * through the appointment engine, migrated with the appointment routes).
 */
export const WAITING_LIST_MAX_BYTES = 1024 * 1024;

export class CanonicalWaitingRefusal extends Error {
  constructor(
    readonly code: "invalid_waiting_input" | "waiting_not_found" | "patient_not_found" | "waiting_conflict" | "waiting_doctor_not_allowed" | "waiting_action_not_canonical",
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "CanonicalWaitingRefusal";
  }
}

const NOT_FOUND = "الانتظار غير موجود ضمن مواعيدك.";
const PATIENT_NOT_FOUND = "لا يوجد مريض بهذا الرقم ضمن مواعيدك.";

function clinicianOf(scope: StaffRecordConstraint): number | null {
  if (scope.kind === "all") return null;
  if (scope.kind === "own") return scope.clinicianPartyId;
  throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
}

function scopeEntries(scope: StaffRecordConstraint, entries: WaitingEntry[]): WaitingEntry[] {
  const clinician = clinicianOf(scope);
  return clinician === null ? entries : entries.filter(entry => entry.doctorId === clinician);
}

async function holdDaysWith(q: Pick<DbClient, "query">): Promise<number> {
  const raw = Number((await getSettingsWith(q))["scheduling.waiting_list_hold_days"] ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export async function readCanonicalWaitingList(session: VerifiedDurableSession, input: { includeResolved: boolean; withHistory: boolean }) {
  return runCanonicalReadSnapshot(session, "read:waiting-list", async (query, scope) => {
    const scoped = scopeEntries(scope.appointmentScope, await listWaitingEntriesWith(query, { includeResolved: input.includeResolved }));
    const entries = markStale(scoped, clinicDateString(new Date(), CLINIC_TIME_ZONE), await holdDaysWith(query));
    let history: Record<number, ContactEvent[]> = {};
    if (input.withHistory && entries.length > 0) history = Object.fromEntries(await listWaitingContactEventsForWith(query, entries.map(entry => entry.id)));
    return { entries, history, canEdit: scope.granted("appointments.edit") };
  }, { errorPrefix: "STAFF_READ", maxBytes: WAITING_LIST_MAX_BYTES });
}

export async function readCanonicalWaitingEntry(session: VerifiedDurableSession, id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "رقم الانتظار غير صالح.");
  return runCanonicalReadSnapshot(session, "read:waiting-list", async (query, scope) => {
    const entry = await getWaitingEntryWith(query, id);
    if (!entry || scopeEntries(scope.appointmentScope, [entry]).length === 0) throw new CanonicalWaitingRefusal("waiting_not_found", 404, NOT_FOUND);
    return { entry, events: await listWaitingContactEventsWith(query, id) };
  }, { errorPrefix: "STAFF_READ", maxBytes: WAITING_LIST_MAX_BYTES });
}

/* ------------------------------------------------------------------------ writes */

const positive = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};
const trimmed = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

/** The add body, validated before admission (the legacy route's rules). */
export function parseCanonicalWaitingAdd(body: unknown): WaitingEntryInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "طلب غير صالح.");
  const source = body as Record<string, unknown>;
  const patientId = positive(source.patientId);
  if (patientId === null) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "اختر المريض أولًا.");
  const period = trimmed(source.preferredPeriod) ?? "any", urgency = trimmed(source.urgency) ?? "normal", shift = trimmed(source.preferredShift) ?? "any";
  if (!PERIODS.includes(period as PreferredPeriod)) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "الفترة المفضّلة غير معروفة.");
  if (!URGENCIES.includes(urgency as WaitingUrgency)) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "درجة الإلحاح غير معروفة.");
  if (!SHIFTS.includes(shift as PreferredShift)) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "الوردية المفضّلة غير معروفة.");
  const days = source.preferredDays === undefined ? [] : normalizeWeekdays(source.preferredDays);
  if (days === null) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "أيام الأسبوع المفضّلة غير صالحة.");
  return {
    patientId, serviceId: positive(source.serviceId), doctorId: positive(source.doctorId),
    earliestDate: trimmed(source.earliestDate), latestDate: trimmed(source.latestDate),
    preferredPeriod: period as PreferredPeriod, preferredShift: shift as PreferredShift, preferredDays: days,
    sameDayAvailable: source.sameDayAvailable === undefined ? true : source.sameDayAvailable !== false,
    urgency: urgency as WaitingUrgency, durationMinutes: source.durationMinutes == null ? null : Number(source.durationMinutes),
    note: trimmed(source.note),
  };
}

export type CanonicalWaitingMove =
  | { readonly action: "offer" }
  | { readonly action: "contact"; readonly outcome: ContactOutcome; readonly channel: ContactChannel; readonly note: string | null; readonly slotDate: string | null; readonly slotTime: string | null }
  | { readonly action: "preferences"; readonly patch: Partial<WaitingEntryInput> }
  | { readonly action: "cancelled" | "expired"; readonly reason: string | null };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{1,2}:\d{2}$/;

/** The PATCH body, validated before admission (the legacy route's rules). */
export function parseCanonicalWaitingMove(body: unknown): CanonicalWaitingMove {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "طلب غير صالح.");
  const source = body as Record<string, unknown>;
  switch (source.action) {
    case "offer": return { action: "offer" };
    case "contact": {
      const outcome = String(source.outcome ?? ""), channel = String(source.channel ?? "phone");
      if (!CONTACT_OUTCOMES.includes(outcome as ContactOutcome)) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "نتيجة الاتصال غير معروفة.");
      if (!CONTACT_CHANNELS.includes(channel as ContactChannel)) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "وسيلة الاتصال غير معروفة.");
      return {
        action: "contact", outcome: outcome as ContactOutcome, channel: channel as ContactChannel,
        note: trimmed(source.note)?.slice(0, 300) ?? null,
        slotDate: typeof source.slotDate === "string" && DATE_PATTERN.test(source.slotDate) ? source.slotDate : null,
        slotTime: typeof source.slotTime === "string" && TIME_PATTERN.test(source.slotTime) ? source.slotTime : null,
      };
    }
    case "preferences": {
      const patch: Partial<WaitingEntryInput> = {};
      if (source.preferredPeriod !== undefined) {
        if (!PERIODS.includes(String(source.preferredPeriod) as PreferredPeriod)) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "الفترة المفضّلة غير معروفة.");
        patch.preferredPeriod = source.preferredPeriod as PreferredPeriod;
      }
      if (source.preferredShift !== undefined) {
        if (!SHIFTS.includes(String(source.preferredShift) as PreferredShift)) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "الوردية المفضّلة غير معروفة.");
        patch.preferredShift = source.preferredShift as PreferredShift;
      }
      if (source.urgency !== undefined) {
        if (!URGENCIES.includes(String(source.urgency) as WaitingUrgency)) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "درجة الإلحاح غير معروفة.");
        patch.urgency = source.urgency as WaitingUrgency;
      }
      if (source.preferredDays !== undefined) {
        const days = normalizeWeekdays(source.preferredDays);
        if (days === null) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "أيام الأسبوع المفضّلة غير صالحة.");
        patch.preferredDays = days;
      }
      if (source.sameDayAvailable !== undefined) patch.sameDayAvailable = source.sameDayAvailable !== false;
      for (const key of ["earliestDate", "latestDate", "note"] as const) if (source[key] !== undefined) patch[key] = trimmed(source[key]);
      for (const key of ["serviceId", "doctorId", "durationMinutes"] as const) if (source[key] !== undefined) patch[key] = positive(source[key]);
      if (Object.keys(patch).length === 0) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "لا يوجد تعديل.");
      return { action: "preferences", patch };
    }
    case "cancelled":
    case "expired": {
      const reason = trimmed(source.reason);
      if (source.action === "cancelled" && !reason) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "اكتب سبب الإلغاء.");
      return { action: source.action, reason };
    }
    case "booked":
      throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "«حُجز» لا تُكتب يدويًّا. استعمل «احجز له» ليُنشأ الموعد ويُربط بصفّه.");
    case "book":
      throw new CanonicalWaitingRefusal("waiting_action_not_canonical", 409, "الحجز من قائمة الانتظار لم يُنقل بعد إلى الهوية الموحّدة.");
    default:
      throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "إجراء غير معروف.");
  }
}

/** Doctor and service references: an own-scope actor assigns only its own party; a named
 * doctor must be active and a named service must exist. */
async function checkReferences(client: DbClient, scope: StaffRecordConstraint, input: { doctorId?: number | null; serviceId?: number | null }): Promise<void> {
  const clinician = clinicianOf(scope);
  if (input.doctorId !== undefined && input.doctorId !== null) {
    if (clinician !== null && input.doctorId !== clinician) throw new CanonicalWaitingRefusal("waiting_doctor_not_allowed", 403, "تسجّل انتظار مرضاك على اسمك فقط.");
    const { rows } = await client.query("SELECT 1 FROM parties WHERE id = $1 AND kind = 'doctor' AND is_active FOR SHARE", [input.doctorId]);
    if (rows.length !== 1) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "الطبيب المحدد غير موجود أو غير نشط.");
  }
  if (input.serviceId !== undefined && input.serviceId !== null) {
    const { rows } = await client.query("SELECT 1 FROM appointment_services WHERE id = $1 FOR SHARE", [input.serviceId]);
    if (rows.length !== 1) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "الخدمة المحددة غير موجودة.");
  }
}

async function actorAndAudit(client: DbClient, handle: StaffOperationHandle) {
  const identity = await staffOperationIdentity(client, handle, "appointments.edit");
  return {
    actor: { actor: identity.username, actorRole: identity.role },
    audit: (input: Parameters<typeof insertAuditRow>[1]) => insertAuditRow(client, input),
  };
}

export async function commandCanonicalWaitingAdd(session: VerifiedDurableSession, input: WaitingEntryInput, pool = getPool()): Promise<WaitingEntry> {
  return withStaffOperation(pool, session, "appointments.edit", async (client, handle) => {
    const scope = await staffOperationAppointmentScope(client, handle, "appointments.edit");
    const clinician = clinicianOf(scope);
    const { rows } = await client.query("SELECT id FROM patients WHERE id = $1 FOR SHARE", [input.patientId]);
    const inside = rows.length === 1 && (clinician === null || await patientInDoctorScopeWith(client, clinician, input.patientId));
    if (!inside) throw new CanonicalWaitingRefusal("patient_not_found", 404, PATIENT_NOT_FOUND);
    await checkReferences(client, scope, input);
    const { actor, audit } = await actorAndAudit(client, handle);
    const result = await addWaitingEntryWith(client, { ...input, doctorId: input.doctorId ?? clinician }, actor, audit);
    if (!result.ok) throw new CanonicalWaitingRefusal("waiting_conflict", 409, result.message);
    return result.entry;
  });
}

export type CanonicalWaitingMoveResult =
  | { readonly kind: "ok" }
  | { readonly kind: "contact"; readonly event: ContactEvent }
  | { readonly kind: "entry"; readonly entry: WaitingEntry };

export async function commandCanonicalWaitingMove(session: VerifiedDurableSession, id: number, move: CanonicalWaitingMove, pool = getPool()): Promise<CanonicalWaitingMoveResult> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new CanonicalWaitingRefusal("invalid_waiting_input", 400, "رقم الانتظار غير صالح.");
  return withStaffOperation(pool, session, "appointments.edit", async (client, handle) => {
    const scope = await staffOperationAppointmentScope(client, handle, "appointments.edit");
    // The entry row first, then the scope check: missing and outside answer alike.
    const { rows: [locked] } = await client.query<{ doctor_id: number | null }>(
      "SELECT doctor_id FROM waiting_list WHERE id = $1 FOR UPDATE", [id]);
    const clinician = clinicianOf(scope);
    const inside = locked !== undefined && (clinician === null || locked.doctor_id === clinician);
    if (!inside) throw new CanonicalWaitingRefusal("waiting_not_found", 404, NOT_FOUND);
    const { actor, audit } = await actorAndAudit(client, handle);
    switch (move.action) {
      case "offer": {
        const result = await markWaitingOfferedWith(client, id, actor, audit);
        if (!result.ok) throw new CanonicalWaitingRefusal("waiting_conflict", 409, "هذا الانتظار نودي أو أُغلق سلفًا.");
        return { kind: "ok" };
      }
      case "contact": {
        const result = await recordWaitingContactWith(client, id, { outcome: move.outcome, channel: move.channel, note: move.note, slotDate: move.slotDate, slotTime: move.slotTime }, actor, audit);
        if (!result.ok) throw new CanonicalWaitingRefusal("waiting_conflict", 409, result.message);
        return { kind: "contact", event: result.event };
      }
      case "preferences": {
        // An own-scope actor cannot move the entry out of its scope by clearing the doctor.
        if (clinician !== null && move.patch.doctorId === null) throw new CanonicalWaitingRefusal("waiting_doctor_not_allowed", 403, "تسجّل انتظار مرضاك على اسمك فقط.");
        await checkReferences(client, scope, move.patch);
        const result = await updateWaitingPreferencesWith(client, id, move.patch, actor, audit);
        if (!result.ok) throw new CanonicalWaitingRefusal("waiting_conflict", 409, result.message);
        return { kind: "entry", entry: result.entry };
      }
      case "cancelled":
      case "expired": {
        const result = await resolveWaitingEntryWith(client, id, { status: move.action, reason: move.reason, appointmentId: null }, actor, audit);
        if (!result.ok) throw new CanonicalWaitingRefusal("waiting_conflict", 409, "هذا الانتظار مُغلقٌ سلفًا.");
        return { kind: "ok" };
      }
    }
  });
}
