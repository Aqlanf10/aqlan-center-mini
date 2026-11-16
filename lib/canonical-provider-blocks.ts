import "server-only";
import { CLINIC_TIME_ZONE, cancelProviderBlockWith, createProviderBlockWith, getPool, insertAuditRow, listProviderBlocks } from "./db";
import { addDays, clinicDateString } from "./schedule";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationAppointmentScope, staffOperationIdentity, withStaffOperation } from "./staff-operation-runtime";

/**
 * Canonical provider blocks (M2 slice 25): GET/POST /api/provider-blocks and
 * DELETE /api/provider-blocks/[id] — hours in which a doctor takes no booking.
 *
 * - Read `read:provider-blocks`: one doctor, one clinic day, inside the appointment
 *   scope. `own` sees only the actor's own clinician party; another doctor answers like
 *   a doctor without blocks (an empty list, as the legacy route answers a missing one).
 * - Create / cancel: one admitted `appointments.schedule.manage` transaction (the map's
 *   requirement; the legacy route allowed the admin role label). The appointment scope
 *   bounds the doctor: `all` any active doctor, `own` the actor's own party, `none`
 *   refused. The create takes the booking engine's day locks (`appointments-day:` for
 *   every clinic day the block touches, ascending, as bookings do), so a booking and a
 *   block for the same day serialize instead of crossing; it reports how many active
 *   appointments of that doctor the block overlaps (a warning; they are not moved).
 *   The audit row commits with the write.
 */
export class CanonicalProviderBlockRefusal extends Error {
  constructor(readonly code: "invalid_provider_block" | "provider_block_not_found" | "provider_block_conflict", readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "CanonicalProviderBlockRefusal";
  }
}
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** A block longer than this is a leave, not a block; it would also hold many day locks. */
export const MAX_BLOCK_DAYS = 92;
const invalid = (message: string) => new CanonicalProviderBlockRefusal("invalid_provider_block", 400, message);

export async function readCanonicalProviderBlocks(session: VerifiedDurableSession, rawProvider: unknown, rawDate: unknown) {
  // Without a doctor: the day panel — every in-scope active doctor and its blocks.
  const dayPanel = rawProvider === null || rawProvider === undefined || rawProvider === "";
  const providerId = dayPanel ? 0 : Number(rawProvider);
  if (!dayPanel && (!Number.isSafeInteger(providerId) || providerId <= 0)) throw invalid("حدّد الطبيب.");
  if (typeof rawDate !== "string" || !DATE_PATTERN.test(rawDate)) throw invalid("تاريخ غير صالح.");
  return runCanonicalReadSnapshot(session, "read:provider-blocks", async (query, scope) => {
    const canManage = scope.granted("appointments.schedule.manage");
    const own = scope.appointmentScope.kind === "own" ? scope.appointmentScope.clinicianPartyId : null;
    if (!dayPanel) {
      const visible = scope.appointmentScope.kind === "all" || own === providerId;
      return { blocks: visible ? await listProviderBlocks(providerId, rawDate, query) : [], canManage };
    }
    const { rows: doctors } = await query.query<{ id: number; name: string }>(
      `SELECT id, name FROM parties WHERE kind = 'doctor' AND is_active AND ($1::int IS NULL OR id = $1) ORDER BY name, id LIMIT 100`, [own]);
    const blocks = [];
    // One snapshot, read in order (a client runs one statement at a time).
    for (const doctor of doctors) blocks.push(...await listProviderBlocks(doctor.id, rawDate, query));
    return { doctors, blocks, canManage };
  }, { errorPrefix: "STAFF_READ", maxBytes: 256 * 1024 });
}

/** Clinic days touched by [startsAt, endsAt): the end instant itself is excluded. */
function clinicDaysOf(startsAt: Date, endsAt: Date): string[] {
  const first = clinicDateString(startsAt, CLINIC_TIME_ZONE);
  const last = clinicDateString(new Date(endsAt.getTime() - 1), CLINIC_TIME_ZONE);
  const days: string[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) {
    days.push(day);
    if (days.length > MAX_BLOCK_DAYS) throw invalid(`الحجب أطول من ${MAX_BLOCK_DAYS} يومًا؛ قسّمه أو سجّله إجازة.`);
  }
  return days;
}

export async function commandCanonicalProviderBlockCreate(session: VerifiedDurableSession, body: Record<string, unknown>, pool = getPool()) {
  const providerId = Number(body.providerId);
  const startsAt = typeof body.startsAt === "string" ? body.startsAt : "";
  const endsAt = typeof body.endsAt === "string" ? body.endsAt : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!Number.isSafeInteger(providerId) || providerId <= 0) throw invalid("حدّد الطبيب.");
  const start = new Date(startsAt), end = new Date(endsAt);
  if (!startsAt || !endsAt || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw invalid("وقت الحجب غير صالح.");
  if (end.getTime() <= start.getTime()) throw invalid("نهاية الحجب يجب أن تكون بعد بدايته.");
  /* السبب مطلوبٌ لا مستحبّ: حجبٌ بلا سبب لا يُراجَع ولا يُلغى بثقة. */
  if (!reason) throw invalid("اكتب سبب الحجب.");
  if (reason.length > 300) throw invalid("سبب الحجب طويل جدًا (300 حرف على الأكثر).");
  const days = clinicDaysOf(start, end);
  return withStaffOperation(pool, session, "appointments.schedule.manage", async (client, handle) => {
    const scope = await staffOperationAppointmentScope(client, handle, "appointments.schedule.manage");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (scope.kind === "own" && scope.clinicianPartyId !== providerId) throw invalid("يمكنك حجب أوقاتك أنت فقط.");
    for (const day of days) await client.query("SELECT pg_advisory_xact_lock(hashtext('appointments-day:' || $1))", [day]);
    const { rows: [doctor] } = await client.query<{ kind: string; is_active: boolean }>("SELECT kind, is_active FROM parties WHERE id = $1 FOR SHARE", [providerId]);
    if (!doctor || doctor.kind !== "doctor" || !doctor.is_active) throw invalid("الطبيب غير موجود أو غير نشط.");
    const identity = await staffOperationIdentity(client, handle, "appointments.schedule.manage");
    const created = await createProviderBlockWith(client, { providerId, startsAt: start.toISOString(), endsAt: end.toISOString(), reason, actor: identity.username, actorRole: identity.role });
    if (!created.ok) throw invalid(created.message);
    const { rows: [overlap] } = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM appointments a
        WHERE a.doctor_id = $1 AND a.status IN ('booked', 'arrived') AND a.scheduled_date = ANY($4::date[])
          AND ((a.scheduled_date + a.scheduled_time) AT TIME ZONE $5) < $3::timestamptz
          AND ((a.scheduled_date + a.scheduled_time) AT TIME ZONE $5) + make_interval(mins => a.duration_minutes) > $2::timestamptz`,
      [providerId, start.toISOString(), end.toISOString(), days, CLINIC_TIME_ZONE]);
    await insertAuditRow(client, { ...created.audit, details: { ...created.audit.details, مواعيد_متداخلة: overlap.count } });
    return { id: created.id, overlappingAppointments: overlap.count };
  });
}

export async function commandCanonicalProviderBlockCancel(session: VerifiedDurableSession, rawId: string, pool = getPool()) {
  if (!/^[1-9][0-9]{0,17}$/.test(rawId)) throw invalid("رقم الحجب غير صالح.");
  return withStaffOperation(pool, session, "appointments.schedule.manage", async (client, handle) => {
    const scope = await staffOperationAppointmentScope(client, handle, "appointments.schedule.manage");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const { rows: [block] } = await client.query<{ provider_id: number }>("SELECT provider_id FROM provider_blocks WHERE id = $1::bigint FOR UPDATE", [rawId]);
    // Another doctor's block is answered like a missing one.
    if (!block || (scope.kind === "own" && block.provider_id !== scope.clinicianPartyId)) {
      throw new CanonicalProviderBlockRefusal("provider_block_not_found", 404, "الحجب غير موجود.");
    }
    const identity = await staffOperationIdentity(client, handle, "appointments.schedule.manage");
    const result = await cancelProviderBlockWith(client, rawId, { actor: identity.username, actorRole: identity.role });
    if (!result.ok) {
      if (result.reason === "already_cancelled") throw new CanonicalProviderBlockRefusal("provider_block_conflict", 409, "هذا الحجب مُلغى سلفًا.");
      throw new CanonicalProviderBlockRefusal("provider_block_not_found", 404, "الحجب غير موجود.");
    }
    await insertAuditRow(client, result.audit);
    return { ok: true as const };
  });
}
