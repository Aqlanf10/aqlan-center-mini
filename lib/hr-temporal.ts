/** Standalone valid-time contracts. No app wiring, database globals, or inferred history. */
export class HrTemporalError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'HrTemporalError'; }
}
export function temporalFail(code: string, message: string): never { throw new HrTemporalError(code, message); }
export function assertDay(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) temporalFail('invalid_date', 'A real YYYY-MM-DD calendar date is required.');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) temporalFail('invalid_date', 'The calendar date does not exist.');
}
export function addCalendarDays(day: string, days: number): string {
  assertDay(day);
  if (!Number.isSafeInteger(days)) temporalFail('invalid_date', 'Day offset must be integral.');
  const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days);
  if (!Number.isFinite(date.getTime())) temporalFail('invalid_date', 'Day offset exceeds the supported calendar.');
  const result = date.toISOString().slice(0, 10); assertDay(result); return result;
}
export function assertRange(from: string, to: string | null): void {
  assertDay(from); if (to !== null) { assertDay(to); if (to <= from) temporalFail('invalid_range', 'Effective ranges are nonempty and end-exclusive.'); }
}
/** DTO snapshots cannot retain mutable references, getters, class instances or non-JSON values. */
export function immutableJson<T>(value: T): T {
  const check = (input: unknown, depth: number): void => {
    if (depth > 32) temporalFail('invalid_snapshot', 'Snapshot nesting is too deep.');
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return;
    if (typeof input === 'number' && Number.isFinite(input)) return;
    if (!input || typeof input !== 'object' || (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) temporalFail('invalid_snapshot', 'Snapshot values must be plain JSON.');
    if (Object.getOwnPropertySymbols(input).length) temporalFail('invalid_snapshot', 'Symbol fields are not JSON.');
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(input))) {
      if (descriptor.get || descriptor.set) temporalFail('invalid_snapshot', 'Snapshot accessors are not accepted.');
      check(descriptor.value, depth + 1);
    }
  };
  check(value, 0);
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (input: unknown): void => { if (input && typeof input === 'object') { Object.values(input).forEach(freeze); Object.freeze(input); } };
  freeze(copy); return copy;
}
export type TemporalFact<T> =
  | { readonly id: string; readonly kind: 'known'; readonly from: string; readonly to: string | null; readonly value: T }
  | { readonly id: string; readonly kind: 'unknown'; readonly value: T };
export interface TemporalTimeline<T> { readonly revision: number; readonly facts: readonly TemporalFact<T>[] }
export interface TemporalChange<T> {
  readonly expectedRevision: number;
  readonly reason: string;
  readonly supersedeIds: readonly string[];
  readonly append: readonly TemporalFact<T>[];
}
export function validateTimeline<T>(timeline: TemporalTimeline<T>): TemporalTimeline<T> {
  if (!Number.isSafeInteger(timeline.revision) || timeline.revision < 0 || !Array.isArray(timeline.facts) || timeline.facts.length > 1000) temporalFail('invalid_timeline', 'Invalid timeline revision or fact list.');
  if (timeline.revision === 0 && timeline.facts.length) temporalFail('invalid_timeline', 'Revision zero has no asserted history.');
  const copy = immutableJson(timeline), ids = new Set<string>();
  for (const fact of copy.facts) {
    if (!fact || typeof fact.id !== 'string' || !fact.id.trim() || fact.id.length > 100 || ids.has(fact.id) || !Object.hasOwn(fact, 'value')) temporalFail('invalid_fact', 'Fact IDs must be unique nonempty strings.');
    ids.add(fact.id);
    if (fact.kind === 'known') assertRange(fact.from, fact.to);
    else if (fact.kind !== 'unknown' || Object.hasOwn(fact, 'from') || Object.hasOwn(fact, 'to')) temporalFail('invalid_fact', 'Unknown history must not assert effective dates.');
  }
  const known = copy.facts.filter(f => f.kind === 'known').sort((a, b) => a.from.localeCompare(b.from));
  for (let i = 1; i < known.length; i++) if (known[i - 1].to === null || known[i].from < known[i - 1].to!) temporalFail('overlap', 'Effective facts overlap; no latest-ID tie-break is allowed.');
  return copy;
}
export function reviseTimeline<T>(current: TemporalTimeline<T>, change: TemporalChange<T>): TemporalTimeline<T> {
  const before = validateTimeline(current);
  if (!Number.isSafeInteger(change.expectedRevision) || change.expectedRevision !== before.revision) temporalFail('stale_revision', 'The timeline changed; reload before applying a new decision.');
  if (typeof change.reason !== 'string' || !change.reason.trim() || change.reason.length > 1000) temporalFail('reason_required', 'A bounded reason is required.');
  if (!Array.isArray(change.supersedeIds) || !Array.isArray(change.append) || (!change.supersedeIds.length && !change.append.length)) temporalFail('invalid_change', 'An explicit change is required.');
  const ids = new Set(before.facts.map(f => f.id)), retired = new Set(change.supersedeIds);
  if (retired.size !== change.supersedeIds.length || [...retired].some(id => !ids.has(id)) || change.append.some(f => ids.has(f.id))) temporalFail('invalid_change', 'Superseded facts must exist and replacements need new IDs.');
  return validateTimeline({ revision: before.revision + 1, facts: [...before.facts.filter(f => !retired.has(f.id)), ...change.append] });
}
export type TemporalSelection<T> =
  | { readonly kind: 'known'; readonly revision: number; readonly fact: Extract<TemporalFact<T>, { kind: 'known' }> }
  | { readonly kind: 'unknown'; readonly revision: number; readonly observations: readonly Extract<TemporalFact<T>, { kind: 'unknown' }>[] };
export function selectTemporal<T>(timeline: TemporalTimeline<T>, day: string): TemporalSelection<T> {
  assertDay(day); const saved = validateTimeline(timeline);
  const fact = saved.facts.find(f => f.kind === 'known' && f.from <= day && (f.to === null || day < f.to));
  return immutableJson(fact?.kind === 'known'
    ? { kind: 'known' as const, revision: saved.revision, fact }
    : { kind: 'unknown' as const, revision: saved.revision, observations: saved.facts.filter(f => f.kind === 'unknown') });
}
export function partitionTemporal<T>(timeline: TemporalTimeline<T>, from: string, to: string) {
  assertRange(from, to); const saved = validateTimeline(timeline), boundaries = new Set([from, to]);
  for (const fact of saved.facts) if (fact.kind === 'known') for (const day of [fact.from, fact.to]) if (day !== null && day > from && day < to) boundaries.add(day);
  const days = [...boundaries].sort();
  return immutableJson(days.slice(0, -1).map((day, i) => ({ from: day, to: days[i + 1], selection: selectTemporal(saved, day) })));
}
