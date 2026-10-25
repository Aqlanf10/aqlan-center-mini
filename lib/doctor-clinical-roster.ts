import { createHash } from 'node:crypto';
import { isKnownZone, resolveClinicZone } from './clinicZone';

/** Internal, unmounted read model. Not an appointment authorization or capacity check.
 * A date is the clinic-local shift START date; overnight tails belong to that
 * assignment. A calendar-day booking resolver must also read the preceding date.
 * Attendance punches, payroll, contracts and documented-only HR history are not inputs.
 */
export interface RosterStaff {
  id: number; userId: number | null; department: string; workStatus: string;
  hireDate: string | null; endDate: string | null;
}
export interface RosterSchedule {
  id: number; staffId: number | null; department: string | null; active: boolean;
  effectiveFrom: string; effectiveTo: string | null; workingDays: unknown;
  start: string; end: string; secondStart: string | null; secondEnd: string | null;
  crossesMidnight: boolean; scheduleType: string; updatedAt: string;
}
export interface RosterLeave {
  id: number; staffId: number; startDate: string; endDate: string;
  status: string; partial: boolean; updatedAt: string;
}
export interface RosterSources {
  staff: RosterStaff[];
  accounts: { id: number; partyId: number | null; active: boolean }[];
  parties: { id: number; kind: string; active: boolean }[];
  /** Only currently open explicit links. null means the optional link table is absent. */
  partyLinks: { staffId: number; partyId: number }[] | null;
  schedules: RosterSchedule[];
  leaves: RosterLeave[];
}
export interface RosterInterval {
  startTime: string; endTime: string; startDayOffset: 0 | 1; endDayOffset: 0 | 1 | 2;
}
export type RosterUnresolvedReason = 'invalid_request' | 'missing_doctor' | 'invalid_doctor'
  | 'missing_mapping' | 'ambiguous_mapping' | 'invalid_mapping' | 'inactive_staff'
  | 'missing_schedule' | 'ambiguous_schedule' | 'invalid_schedule'
  | 'unsupported_partial_leave' | 'invalid_leave' | 'schema_unavailable';
export type DoctorClinicalRoster = {
  date: string; doctorPartyId: number; clinicTimeZone: string;
  status: 'resolved' | 'unresolved'; unresolvedReason: RosterUnresolvedReason | null;
  staffId: number | null; sourceScheduleId: number | null; sourceScheduleRevision: string | null;
  /** Fingerprint of this read snapshot, not a persisted version or booking lock. */
  revision: string | null; effectiveFrom: string | null; effectiveTo: string | null;
  scheduledIntervals: RosterInterval[];
  approvedClosureIntervals: (RosterInterval & { leaveId: number })[];
  /** Roster minus approved leave only; never synonymous with bookable availability. */
  intervals: RosterInterval[];
};
const validDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const minute = (value: unknown): number | null => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
  ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
const clock = (n: number) => `${String(Math.floor(n % 1440 / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const interval = (start: number, end: number): RosterInterval => ({ startTime: clock(start), endTime: clock(end),
  startDayOffset: Math.floor(start / 1440) as 0 | 1, endDayOffset: Math.floor(end / 1440) as 0 | 1 | 2 });

/** Strict normalization: reject malformed legacy rows instead of expanding availability. */
export function normalizeClinicalSchedule(row: RosterSchedule): [number, number][] | null {
  if (!validDate(row.effectiveFrom) || (row.effectiveTo !== null && (!validDate(row.effectiveTo) || row.effectiveTo < row.effectiveFrom))
    || !Array.isArray(row.workingDays) || !row.workingDays.length
    || row.workingDays.some(d => !Number.isInteger(d) || d < 0 || d > 6)
    || !['morning', 'evening', 'split', 'variable', 'night'].includes(row.scheduleType)) return null;
  const start = minute(row.start), end = minute(row.end);
  if (start === null || end === null || start === end || (end < start && !row.crossesMidnight)) return null;
  // An asserted overnight flag on a same-day interval is contradictory, not a 24h+ shift.
  if (row.crossesMidnight && end > start) return null;
  if (row.scheduleType === 'split' || row.secondStart !== null || row.secondEnd !== null) {
    const secondStart = minute(row.secondStart), secondEnd = minute(row.secondEnd);
    if (row.crossesMidnight || secondStart === null || secondEnd === null || secondStart < end || secondEnd <= secondStart) return null;
    return [[start, end], [secondStart, secondEnd]];
  }
  return [[start, end + (row.crossesMidnight ? 1440 : 0)]];
}

export function resolveDoctorClinicalRoster(sources: RosterSources, doctorPartyId: number, date: string, clinicTimeZone: string): DoctorClinicalRoster {
  const result: DoctorClinicalRoster = { date, doctorPartyId, clinicTimeZone, status: 'unresolved', unresolvedReason: null,
    staffId: null, sourceScheduleId: null, sourceScheduleRevision: null, revision: null, effectiveFrom: null, effectiveTo: null,
    scheduledIntervals: [], approvedClosureIntervals: [], intervals: [] };
  const fail = (reason: RosterUnresolvedReason) => ({ ...result, status: 'unresolved' as const, unresolvedReason: reason, intervals: [] });
  if (!Number.isSafeInteger(doctorPartyId) || doctorPartyId <= 0 || !validDate(date) || !isKnownZone(clinicTimeZone)) return fail('invalid_request');
  const doctors = sources.parties.filter(p => p.id === doctorPartyId);
  if (!doctors.length) return fail('missing_doctor');
  if (doctors.length !== 1 || doctors[0].kind !== 'doctor' || !doctors[0].active) return fail('invalid_doctor');
  const mappings = sources.staff.map(staff => {
    const links = (sources.partyLinks ?? []).filter(l => l.staffId === staff.id);
    const accounts = sources.accounts.filter(a => a.id === staff.userId);
    const parties = [...links.map(l => l.partyId), ...accounts.flatMap(a => a.partyId === null ? [] : [a.partyId])];
    return { staff, links, accounts, parties: [...new Set(parties)] };
  });
  const matches = mappings.filter(m => m.parties.includes(doctorPartyId));
  if (!matches.length) return fail('missing_mapping');
  if (matches.length !== 1) return fail('ambiguous_mapping');
  const mapping = matches[0], staff = mapping.staff;
  result.staffId = staff.id;
  if (mapping.parties.length !== 1 || mapping.links.length > 1 || mapping.accounts.length > 1
    || (staff.userId !== null && (mapping.accounts.length !== 1 || !mapping.accounts[0].active))) return fail('invalid_mapping');
  if (staff.workStatus !== 'active' || (staff.hireDate !== null && (!validDate(staff.hireDate) || staff.hireDate > date))
    || (staff.endDate !== null && (!validDate(staff.endDate) || staff.endDate < date))) return fail('inactive_staff');
  const candidates = sources.schedules.filter(s => s.active && s.effectiveFrom <= date && (s.effectiveTo === null || s.effectiveTo >= date));
  const assigned = candidates.filter(s => s.staffId === staff.id);
  const applicable = assigned.length ? assigned : candidates.filter(s => s.staffId === null && s.department === staff.department);
  if (!applicable.length) return fail('missing_schedule');
  if (applicable.length !== 1) return fail('ambiguous_schedule');
  const schedule = applicable[0], normalized = normalizeClinicalSchedule(schedule);
  result.sourceScheduleId = schedule.id;
  result.sourceScheduleRevision = hash(schedule);
  result.effectiveFrom = schedule.effectiveFrom;
  result.effectiveTo = schedule.effectiveTo;
  if (!normalized) return fail('invalid_schedule');
  const segments = (schedule.workingDays as number[]).includes(new Date(`${date}T00:00:00Z`).getUTCDay()) ? normalized : [];
  result.scheduledIntervals = segments.map(([start, end]) => interval(start, end));
  const tomorrow = nextDate(date), tail = segments.some(([, end]) => end > 1440);
  const leaves = sources.leaves.filter(l => l.staffId === staff.id && l.status === 'approved'
    && l.startDate <= (tail ? tomorrow : date) && l.endDate >= date).sort((a, b) => a.id - b.id);
  const closures: [number, number][] = [];
  for (const leave of leaves) {
    if (!validDate(leave.startDate) || !validDate(leave.endDate) || leave.endDate < leave.startDate) return fail('invalid_leave');
    if (leave.partial) return fail('unsupported_partial_leave');
    // Full-day leave on the operational START date closes the entire assigned
    // shift, including its overnight tail. Never expose a tail from a day off.
    // Next-civil-day leave also conservatively closes the tail at midnight;
    // it does not erase the prior evening before that boundary.
    if (leave.startDate <= date && leave.endDate >= date) {
      const end = Math.max(1440, ...segments.map(([, finish]) => finish));
      closures.push([0, end]);
      result.approvedClosureIntervals.push({ ...interval(0, end), leaveId: leave.id });
    }
    if (tail && leave.startDate <= tomorrow && leave.endDate >= tomorrow) {
      closures.push([1440, 2880]);
      result.approvedClosureIntervals.push({ ...interval(1440, 2880), leaveId: leave.id });
    }
  }
  let remaining = segments;
  for (const [closedStart, closedEnd] of closures) remaining = remaining.flatMap(([start, end]): [number, number][] => {
    if (end <= closedStart || start >= closedEnd) return [[start, end]];
    return [...(start < closedStart ? [[start, closedStart] as [number, number]] : []), ...(end > closedEnd ? [[closedEnd, end] as [number, number]] : [])];
  });
  result.intervals = remaining.map(([start, end]) => interval(start, end));
  result.status = 'resolved';
  result.revision = hash({ date, clinicTimeZone, mapping, schedule, leaves });
  return result;
}

/** Consistent read-only snapshot. Never ensures schema, activates HR history or writes.
 * Missing optional identity links fall back ONLY to explicit staff.user_id -> users.party_id.
 * Callers must authorize access; do not expose internal staff/leave IDs in public APIs.
 */
export async function readDoctorClinicalRoster(doctorPartyId: number, date: string,
  clinicTimeZone = resolveClinicZone(process.env.CLINIC_TIME_ZONE)): Promise<DoctorClinicalRoster> {
  const empty: RosterSources = { staff: [], accounts: [], parties: [], partyLinks: null, schedules: [], leaves: [] };
  if (!validDate(date) || !Number.isSafeInteger(doctorPartyId) || doctorPartyId <= 0 || !isKnownZone(clinicTimeZone))
    return resolveDoctorClinicalRoster(empty, doctorPartyId, date, clinicTimeZone);
  const { getPool } = await import('./db');
  const client = await getPool().connect();
  let discardClient = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const sources = await readClinicalRosterSources(client, doctorPartyId, date);
    if (!sources) {
      await client.query('COMMIT');
      return { ...resolveDoctorClinicalRoster(empty, doctorPartyId, date, clinicTimeZone), unresolvedReason: 'schema_unavailable' };
    }
    const result = resolveDoctorClinicalRoster(sources, doctorPartyId, date, clinicTimeZone);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { discardClient = true; }
    throw error;
  } finally { client.release(discardClient); }
}

/** Caller owns the snapshot/transaction. Includes yesterday for civil-day night tails. */
export async function readClinicalRosterSources(client: Pick<import('./db').DbClient, 'query'>, doctorPartyId: number, date: string): Promise<RosterSources | null> {
    const { rows: tables } = await client.query(`SELECT to_regclass('public.hr_staff') IS NOT NULL AND
      to_regclass('public.hr_work_schedules') IS NOT NULL AND to_regclass('public.hr_leave_requests') IS NOT NULL AS ready,
      to_regclass('public.hr_staff_party_links') IS NOT NULL AS links`);
    if (!tables[0]?.ready) {
      return null;
    }
    // Bound reads to candidates for this doctor, but retain ALL matching staff
    // (including inactive ones) so conflicting identities cannot disappear.
    const staff: RosterStaff[] = (await client.query(`SELECT s.id,s.user_id AS "userId",s.department,s.work_status AS "workStatus",
      s.hire_date::text AS "hireDate",s.end_date::text AS "endDate" FROM hr_staff s
      LEFT JOIN users u ON u.id=s.user_id WHERE u.party_id=$1
      ${tables[0].links ? 'OR EXISTS (SELECT 1 FROM hr_staff_party_links l WHERE l.staff_id=s.id AND l.party_id=$1 AND l.closed_at IS NULL)' : ''}
      ORDER BY s.id`, [doctorPartyId])).rows;
    const staffIds = staff.map(s => s.id), userIds = staff.flatMap(s => s.userId === null ? [] : [s.userId]);
    const sources: RosterSources = {
      staff,
      accounts: (await client.query('SELECT id,party_id AS "partyId",is_active AS active FROM users WHERE id=ANY($1::int[]) ORDER BY id', [userIds])).rows,
      parties: (await client.query('SELECT id,kind,is_active AS active FROM parties WHERE id=$1', [doctorPartyId])).rows,
      partyLinks: tables[0].links ? (await client.query(`SELECT staff_id AS "staffId",party_id AS "partyId"
        FROM hr_staff_party_links WHERE closed_at IS NULL AND staff_id=ANY($1::int[]) ORDER BY id`, [staffIds])).rows : null,
      schedules: (await client.query(`SELECT id,staff_id AS "staffId",department,is_active AS active,
        effective_from::text AS "effectiveFrom",effective_to::text AS "effectiveTo",working_days AS "workingDays",
        shift_start_time AS start,shift_end_time AS end,second_shift_start AS "secondStart",second_shift_end AS "secondEnd",
        crosses_midnight AS "crossesMidnight",schedule_type AS "scheduleType",updated_at::text AS "updatedAt"
        FROM hr_work_schedules WHERE is_active AND effective_from<=$1::date AND (effective_to IS NULL OR effective_to>=$1::date-1)
        AND (staff_id=ANY($2::int[]) OR (staff_id IS NULL AND department=ANY($3::text[]))) ORDER BY id`,
        [date, staffIds, [...new Set(staff.map(s => s.department))]])).rows,
      leaves: (await client.query(`SELECT id,staff_id AS "staffId",start_date::text AS "startDate",end_date::text AS "endDate",
        status,is_partial_day AS partial,updated_at::text AS "updatedAt" FROM hr_leave_requests
        WHERE status='approved' AND start_date<=$1::date+1 AND end_date>=$1::date-1 AND staff_id=ANY($2::int[]) ORDER BY id`, [date, staffIds])).rows,
    };
  return sources;
}
