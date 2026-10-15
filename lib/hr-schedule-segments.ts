import { addCalendarDays, assertDay, immutableJson, selectTemporal, temporalFail, validateTimeline, type TemporalTimeline } from './hr-temporal';

export interface HrScheduleSegment {
  readonly id: string;
  readonly start: string;
  readonly startDayOffset: 0 | 1;
  readonly end: string;
  readonly endDayOffset: 0 | 1;
}
export interface HrSegmentWindow { readonly id: string; readonly start: string; readonly end: string }
export interface HrEffectiveSchedule {
  readonly timeZone: string;
  readonly workingDays: readonly number[];
  readonly graceMins: number;
  readonly segments: readonly HrScheduleSegment[];
}
export function validateEffectiveSchedule(value: HrEffectiveSchedule): HrEffectiveSchedule {
  const copy = immutableJson(value);
  if (!copy || typeof copy.timeZone !== 'string') temporalFail('invalid_schedule', 'An explicit time zone is required.');
  try { new Intl.DateTimeFormat('en', { timeZone: copy.timeZone }); } catch { temporalFail('invalid_timezone', 'Invalid time zone.'); }
  if (!Array.isArray(copy.workingDays) || !copy.workingDays.length || copy.workingDays.length > 7 || new Set(copy.workingDays).size !== copy.workingDays.length || copy.workingDays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) temporalFail('invalid_schedule', 'Working days must be distinct weekday numbers.');
  if (!Number.isInteger(copy.graceMins) || copy.graceMins < 0 || copy.graceMins > 120) temporalFail('invalid_schedule', 'Grace must match the supported 0–120 minute range.');
  validateScheduleSegments(copy.segments);
  // Offsets are 0/1, so only consecutive anchor days can overlap in one zone.
  // Include Saturday→Sunday; compare segments, not the envelope around split shifts.
  for (const day of copy.workingDays) if (copy.workingDays.includes((day + 1) % 7)) {
    for (const left of copy.segments) for (const right of copy.segments) {
      if (minute(left.start) + left.startDayOffset * 1440 < minute(right.end) + (right.endDayOffset + 1) * 1440
          && minute(right.start) + (right.startDayOffset + 1) * 1440 < minute(left.end) + left.endDayOffset * 1440) {
        temporalFail('occurrence_overlap', 'occurrence_overlap: recurring schedule segments overlap across anchor days.');
      }
    }
  }
  return copy;
}
function minute(clock: string): number {
  if (typeof clock !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) temporalFail('invalid_clock', 'Use HH:MM and an explicit day offset.');
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
}
/** One clinic-day occurrence may extend into the next day; this is a representation, not a work entitlement. */
export function validateScheduleSegments(segments: readonly HrScheduleSegment[]): readonly HrScheduleSegment[] {
  if (!Array.isArray(segments) || !segments.length || segments.length > 16) temporalFail('invalid_segments', 'Provide between one and sixteen explicit segments.');
  const copy = immutableJson(segments), ids = new Set<string>(); let previousEnd = -1;
  for (const [index, segment] of copy.entries()) {
    if (!segment || typeof segment.id !== 'string' || !segment.id.trim() || segment.id.length > 100 || ids.has(segment.id)) temporalFail('invalid_segments', 'Segment IDs must be unique.');
    ids.add(segment.id);
    if (![0, 1].includes(segment.startDayOffset) || ![0, 1].includes(segment.endDayOffset) || (index === 0 && segment.startDayOffset !== 0)) temporalFail('invalid_segments', 'The first segment starts on the anchor day; offsets are explicit zero or one.');
    const start = minute(segment.start) + segment.startDayOffset * 1440, end = minute(segment.end) + segment.endDayOffset * 1440;
    if (end <= start || start < previousEnd) temporalFail('segment_overlap', 'Segments must be ordered, positive and non-overlapping. Touching boundaries are allowed.');
    previousEnd = end;
  }
  return copy;
}
/** Reject nonexistent or ambiguous wall times instead of silently selecting a DST fold. */
function uniqueWallInstant(day: string, clock: string, timeZone: string): string {
  assertDay(day); minute(clock);
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { return temporalFail('invalid_timezone', 'Use an explicit valid IANA time zone.'); }
  const wall = `${day}T${clock}:00`, nominal = Date.parse(`${wall}Z`);
  const local = (epoch: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(epoch)).map(p => [p.type, p.value]));
    return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  };
  const offsets = new Set([-36, -24, -12, 0, 12, 24, 36].map(hours => {
    const probe = nominal + hours * 3600000;
    return Date.parse(`${local(probe)}Z`) - probe;
  }));
  const matches = [...offsets].map(offset => nominal - offset).filter(candidate => local(candidate) === wall);
  if (matches.length !== 1) temporalFail(matches.length ? 'ambiguous_wall_time' : 'nonexistent_wall_time', 'This wall time requires explicit time-zone resolution; no punch is inferred.');
  // A technical search bound for version transitions, not a maximum shift length.
  if (Math.abs(nominal - matches[0]) >= 86400000) temporalFail('timezone_offset_unresolved', 'An offset outside the supported ±24-hour bound requires review.');
  return new Date(matches[0]).toISOString();
}
export function materializeScheduleSegments(anchorDay: string, timeZone: string, segments: readonly HrScheduleSegment[]) {
  assertDay(anchorDay);
  const windows = validateScheduleSegments(segments).map(segment => ({ id: segment.id,
    start: uniqueWallInstant(addCalendarDays(anchorDay, segment.startDayOffset), segment.start, timeZone),
    end: uniqueWallInstant(addCalendarDays(anchorDay, segment.endDayOffset), segment.end, timeZone),
  }));
  for (const [i, window] of windows.entries()) if (window.end <= window.start || (i > 0 && window.start < windows[i - 1].end)) temporalFail('segment_overlap', 'Materialized windows overlap or reverse.');
  return immutableJson({ anchorDay, timeZone, calculationVersion: 'hr-segments-v1', windows });
}
/** Validate dated versions as well as each repeating value, before writing or calculating. */
export function validateScheduleTimeline(timeline: TemporalTimeline<HrEffectiveSchedule>): TemporalTimeline<HrEffectiveSchedule> {
  const saved = validateTimeline(timeline);
  const facts = saved.facts.filter(fact => fact.kind === 'known').sort((a, b) => a.from.localeCompare(b.from));
  for (const fact of facts) validateEffectiveSchedule(fact.value);
  for (let i = 0; i < facts.length; i++) for (let j = i + 1; j < facts.length; j++) {
    const left = facts[i], right = facts[j];
    // Local endpoints are in [anchor, anchor+2 days), offsets strictly within ±24h.
    // Anchors >=4 days apart cannot overlap in UTC, even when the zone changes.
    if (Date.parse(`${right.from}T00:00:00Z`) - Date.parse(`${left.to}T00:00:00Z`) >= 3 * 86400000) break;
    const prior: HrSegmentWindow[] = [], next: HrSegmentWindow[] = [];
    for (let offset = 1; offset <= 3; offset++) {
      const epoch = Date.parse(`${left.to}T00:00:00Z`) - offset * 86400000;
      if (epoch >= Date.parse(`${left.from}T00:00:00Z`)) {
        const day = new Date(epoch).toISOString().slice(0, 10);
        if (left.value.workingDays.includes(new Date(epoch).getUTCDay())) prior.push(...materializeScheduleSegments(day, left.value.timeZone, left.value.segments).windows);
      }
    }
    for (let offset = 0; offset < 3; offset++) {
      const epoch = Date.parse(`${right.from}T00:00:00Z`) + offset * 86400000;
      if (epoch <= Date.parse('9999-12-31T00:00:00Z') && (right.to === null || epoch < Date.parse(`${right.to}T00:00:00Z`))) {
        const day = new Date(epoch).toISOString().slice(0, 10);
        if (right.value.workingDays.includes(new Date(epoch).getUTCDay())) next.push(...materializeScheduleSegments(day, right.value.timeZone, right.value.segments).windows);
      }
    }
    for (const a of prior) for (const b of next) if (a.start < b.end && b.start < a.end) {
      temporalFail('occurrence_overlap', 'occurrence_overlap: dated schedule versions overlap in UTC.');
    }
  }
  return saved;
}
export function selectHrSchedule(timeline: TemporalTimeline<HrEffectiveSchedule>, anchorDay: string) {
  const selected = selectTemporal(validateScheduleTimeline(timeline), anchorDay);
  if (selected.kind === 'unknown') return immutableJson({ kind: 'blocked' as const, code: 'schedule_history_unknown', selection: selected });
  const value = validateEffectiveSchedule(selected.fact.value);
  const identity = { timelineRevision: selected.revision, factId: selected.fact.id, graceMins: value.graceMins, workingDays: value.workingDays };
  if (!value.workingDays.includes(new Date(`${anchorDay}T00:00:00Z`).getUTCDay())) return immutableJson({ kind: 'not_scheduled' as const, ...identity, anchorDay });
  return immutableJson({ kind: 'selected' as const, ...identity,
    ...materializeScheduleSegments(anchorDay, value.timeZone, value.segments) });
}

export interface HrSegmentPunch { readonly id: string; readonly type: 'check_in' | 'check_out'; readonly at: string }
export interface HrSegmentCorrection {
  readonly segmentId: string;
  readonly status: 'pending' | 'rejected' | 'approved';
  readonly expectedSegmentVersion: number;
  readonly newIn: string;
  readonly newOut: string;
  readonly reason: string;
  readonly requestedBy: number;
  readonly decidedBy: number | null;
}
function instant(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/.test(value)) temporalFail('invalid_instant', 'An explicit offset-bearing instant is required.');
  assertDay(value.slice(0, 10)); const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) temporalFail('invalid_instant', 'The instant is invalid.'); return epoch;
}
export interface HrSegmentEvidence {
  readonly id: string;
  readonly version: number;
  readonly rawPunches: readonly HrSegmentPunch[];
  readonly actualIn: string | null;
  readonly actualOut: string | null;
  readonly workMinutes: number | null;
  readonly state: 'complete' | 'incomplete' | 'ambiguous' | 'corrected';
  readonly corrections: readonly HrSegmentCorrection[];
}
/** Assign events to a segment explicitly before pairing; a boundary event cannot serve two segments. */
export function collectSegmentEvidence(id: string, punches: readonly HrSegmentPunch[], version = 1): HrSegmentEvidence {
  if (!id?.trim() || !Number.isSafeInteger(version) || version < 1) temporalFail('invalid_segment', 'A segment identity and version are required.');
  const ids = new Set<string>(), dedup = new Map<string, HrSegmentPunch>();
  for (const punch of punches) {
    if (!punch.id?.trim() || ids.has(punch.id) || !['check_in', 'check_out'].includes(punch.type)) temporalFail('invalid_punch', 'Each raw event needs a unique ID and known type.');
    ids.add(punch.id); const time = instant(punch.at); dedup.set(`${punch.type}:${time}`, punch);
  }
  const events = [...dedup.values()].sort((a, b) => instant(a.at) - instant(b.at));
  const complete = events.length === 2 && events[0].type === 'check_in' && events[1].type === 'check_out' && instant(events[1].at) > instant(events[0].at);
  const ambiguous = !complete && (events.length > 2 || (events.length === 2));
  return immutableJson({ id, version, rawPunches: punches, actualIn: complete ? new Date(instant(events[0].at)).toISOString() : null,
    actualOut: complete ? new Date(instant(events[1].at)).toISOString() : null,
    workMinutes: complete ? (instant(events[1].at) - instant(events[0].at)) / 60000 : null,
    state: complete ? 'complete' : ambiguous ? 'ambiguous' : 'incomplete', corrections: [] });
}
export function collectOccurrenceEvidence(windows: readonly HrSegmentWindow[], assignments: readonly { segmentId: string; punches: readonly HrSegmentPunch[] }[]) {
  const ids = new Set(windows.map(w => w.id)), assigned = new Map<string, readonly HrSegmentPunch[]>(), rawIds = new Set<string>();
  if (!windows.length || ids.size !== windows.length) temporalFail('invalid_segments', 'Occurrence windows must have unique identities.');
  for (const [i, window] of windows.entries()) if (instant(window.end) <= instant(window.start) || (i > 0 && instant(window.start) < instant(windows[i - 1].end))) temporalFail('segment_overlap', 'Occurrence windows are invalid.');
  for (const assignment of assignments) {
    if (!ids.has(assignment.segmentId) || assigned.has(assignment.segmentId)) temporalFail('invalid_assignment', 'Assign each known segment once.');
    for (const punch of assignment.punches) { if (rawIds.has(punch.id)) temporalFail('reused_punch', 'A raw event cannot complete two segments.'); rawIds.add(punch.id); }
    assigned.set(assignment.segmentId, assignment.punches);
  }
  const segments = windows.map(window => collectSegmentEvidence(window.id, assigned.get(window.id) ?? []));
  return summarizeOccurrence(windows, segments);
}
function summarizeOccurrence(windows: readonly HrSegmentWindow[], segments: readonly HrSegmentEvidence[]) {
  // Early/late evidence is allowed, but overlapping actual work cannot be counted twice.
  let previousEnd = -Infinity;
  for (const segment of segments) if (segment.actualIn && segment.actualOut) {
    if (instant(segment.actualIn) < previousEnd) temporalFail('actual_segment_overlap', 'Actual segment intervals overlap and require review.');
    previousEnd = instant(segment.actualOut);
  }
  const complete = segments.every(segment => segment.state === 'complete' || segment.state === 'corrected');
  const provenWorkMinutes = segments.reduce((sum, segment) => sum + (segment.workMinutes ?? 0), 0);
  return immutableJson({ windows, segments, complete, provenWorkMinutes, totalWorkMinutes: complete ? provenWorkMinutes : null });
}
export function correctOccurrenceSegment(current: ReturnType<typeof collectOccurrenceEvidence>, correction: HrSegmentCorrection) {
  if (!current.segments.some(segment => segment.id === correction.segmentId)) temporalFail('invalid_assignment', 'Correction refers to an unknown segment.');
  return summarizeOccurrence(current.windows, current.segments.map(segment => segment.id === correction.segmentId ? correctSegmentEvidence(segment, correction) : segment));
}
export function correctSegmentEvidence(current: HrSegmentEvidence, correction: HrSegmentCorrection): HrSegmentEvidence {
  if (correction.segmentId !== current.id || correction.expectedSegmentVersion !== current.version) temporalFail('stale_revision', 'The segment changed before the correction decision.');
  if (!['pending', 'rejected', 'approved'].includes(correction.status) || !correction.reason?.trim()) temporalFail('invalid_correction', 'A known decision and reason are required.');
  const start = instant(correction.newIn), end = instant(correction.newOut);
  if (end <= start) temporalFail('invalid_correction', 'Corrected bounds must be ordered.');
  if (!Number.isSafeInteger(correction.requestedBy) || correction.requestedBy < 1) temporalFail('invalid_correction', 'The requester identity is required.');
  if (correction.status !== 'pending' && (!Number.isSafeInteger(correction.decidedBy) || correction.decidedBy! < 1)) temporalFail('invalid_correction', 'A decision actor is required.');
  if (correction.status === 'approved' && correction.decidedBy === correction.requestedBy) temporalFail('self_approval', 'A requester cannot approve their own correction.');
  return immutableJson({ ...current, version: current.version + 1, corrections: [...current.corrections, correction],
    ...(correction.status === 'approved' ? { actualIn: new Date(start).toISOString(), actualOut: new Date(end).toISOString(), workMinutes: (end - start) / 60000, state: 'corrected' as const } : {}),
  });
}
export function appendSegmentEvidence(current: HrSegmentEvidence, punches: readonly HrSegmentPunch[]): HrSegmentEvidence {
  const next = collectSegmentEvidence(current.id, [...current.rawPunches, ...punches], current.version + 1);
  // Even conflicting later raw evidence cannot silently undo an approved decision.
  return immutableJson({ ...next, corrections: current.corrections,
    ...(current.state === 'corrected' ? { state: current.state, actualIn: current.actualIn, actualOut: current.actualOut, workMinutes: current.workMinutes } : {}),
  });
}

/** One employee / one calculation batch. Durable event ownership still requires integration. */
export function collectScheduleEvidence(timeline: TemporalTimeline<HrEffectiveSchedule>, assignments: readonly {
  anchorDay: string; segments: readonly { segmentId: string; punches: readonly HrSegmentPunch[] }[];
}[]) {
  const days = new Set<string>();
  const occurrences = assignments.map(assignment => {
    if (days.has(assignment.anchorDay)) temporalFail('duplicate_occurrence', 'An anchor day can be assigned only once.');
    days.add(assignment.anchorDay);
    const selected = selectHrSchedule(timeline, assignment.anchorDay);
    if (selected.kind !== 'selected') temporalFail(selected.kind === 'blocked' ? selected.code : 'not_scheduled', 'The occurrence is not resolved; no work total can be calculated.');
    return { anchorDay: assignment.anchorDay, timelineRevision: selected.timelineRevision, factId: selected.factId,
      evidence: collectOccurrenceEvidence(selected.windows, assignment.segments) };
  });
  return summarizeScheduleEvidence(occurrences);
}
function summarizeScheduleEvidence(occurrences: readonly { anchorDay: string; timelineRevision: number; factId: string; evidence: ReturnType<typeof collectOccurrenceEvidence> }[]) {
  const rawIds = new Set<string>(), actual: { start: number; end: number }[] = [];
  for (const occurrence of occurrences) for (const segment of occurrence.evidence.segments) {
    for (const punch of segment.rawPunches) {
      if (rawIds.has(punch.id)) temporalFail('reused_punch', 'A raw event cannot belong to two occurrences.');
      rawIds.add(punch.id);
    }
    if (segment.actualIn && segment.actualOut) actual.push({ start: instant(segment.actualIn), end: instant(segment.actualOut) });
  }
  actual.sort((a, b) => a.start - b.start);
  for (let i = 1; i < actual.length; i++) if (actual[i].start < actual[i - 1].end) temporalFail('actual_occurrence_overlap', 'Actual work overlaps across occurrences and requires review.');
  const complete = occurrences.length > 0 && occurrences.every(occurrence => occurrence.evidence.complete);
  const provenWorkMinutes = occurrences.reduce((sum, occurrence) => sum + occurrence.evidence.provenWorkMinutes, 0);
  return immutableJson({ occurrences, complete, provenWorkMinutes, totalWorkMinutes: complete ? provenWorkMinutes : null });
}
export function correctScheduleSegment(current: ReturnType<typeof collectScheduleEvidence>, anchorDay: string, correction: HrSegmentCorrection) {
  if (!current.occurrences.some(occurrence => occurrence.anchorDay === anchorDay)) temporalFail('invalid_assignment', 'Unknown occurrence.');
  return summarizeScheduleEvidence(current.occurrences.map(occurrence => occurrence.anchorDay === anchorDay
    ? { ...occurrence, evidence: correctOccurrenceSegment(occurrence.evidence, correction) } : occurrence));
}
