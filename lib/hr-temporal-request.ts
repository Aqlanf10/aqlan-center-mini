import { immutableJson, validateTimeline, type TemporalFact, type TemporalTimeline } from './hr-temporal';
import { validateEffectiveSchedule, type HrEffectiveSchedule } from './hr-schedule-segments';
import type { EmploymentFact } from './hr-effective-policy';

export class HrHistoryError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = 'HrHistoryError'; }
}
export function historyFail(code: string, message: string, status = 409): never { throw new HrHistoryError(code, message, status); }
export type HrHistoryKind = 'employment' | 'schedule';
export type HrHistoryValue = EmploymentFact | HrEffectiveSchedule;
export interface HrHistoryCommand {
  readonly requestId: string;
  /** Continuity assertion only. It never grants authority or chooses the audit actor. */
  readonly expectedUsername: string;
  readonly staffId: number;
  readonly operation: 'employment.record' | 'schedule.record';
  readonly expectedRevision: number;
  readonly reason: string;
  readonly supersedeIds: readonly string[];
  readonly append: readonly TemporalFact<HrHistoryValue>[];
}
export interface HrHistoryReceipt {
  readonly requestId: string;
  readonly intentDigest: string;
  readonly intent: HrHistoryCommand;
  readonly staffId: number;
  readonly operation: HrHistoryCommand['operation'];
  readonly actorUserId: number;
  readonly actorUsername: string;
  readonly recordedAt: string;
  readonly revision: number;
  readonly timeline: TemporalTimeline<HrHistoryValue>;
  readonly activation: 'documented_only';
}
export class HrHistoryWriteRefusal extends HrHistoryError {
  constructor(code: string, message: string, status: number, readonly refusal: { readonly intent: HrHistoryCommand; readonly confirmedNoCommitAttempt: true }) { super(code, message, status); }
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) historyFail('invalid_request', 'حقول الطلب غير صالحة؛ الهوية والصلاحيات تأتيان من الجلسة فقط.', 400);
  return value as Record<string, unknown>;
}
/** Plain immutable intent shared by browser receipt checks and the server digest. */
export function canonicalHrIntent(value: unknown): string {
  const copy = immutableJson(value);
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sorted(entry)])) : item;
  return JSON.stringify(sorted(copy));
}
export function parseHrHistoryCommand(raw: unknown, kind: HrHistoryKind, staffId: number): HrHistoryCommand {
  if (!Number.isSafeInteger(staffId) || staffId < 1 || staffId > 2147483647 || !['employment', 'schedule'].includes(kind)) historyFail('invalid_subject', 'رقم الموظف أو نوع السجل غير صالح.', 400);
  const body = object(immutableJson(raw), ['requestId', 'expectedUsername', 'expectedRevision', 'reason', 'supersedeIds', 'append']);
  if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(body.requestId)) historyFail('invalid_request_id', 'مفتاح الطلب مطلوب وبطول16 إلى128 حرفًا.', 400);
  if (typeof body.expectedUsername !== 'string' || !body.expectedUsername.trim() || body.expectedUsername.length > 150 || [...body.expectedUsername].some(char => char.charCodeAt(0) < 32)) historyFail('expected_owner_required', 'هوية صاحب المسودة المتوقعة مطلوبة للتحقق من استمرار الجلسة.', 400);
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) historyFail('invalid_revision', 'رقم المراجعة المقروءة مطلوب.', 400);
  if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 1000) historyFail('reason_required', 'اكتب سببًا موثقًا حتى1000 حرف.', 400);
  if (!Array.isArray(body.supersedeIds) || body.supersedeIds.length > 1000 || body.supersedeIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 100) || new Set(body.supersedeIds).size !== body.supersedeIds.length) historyFail('invalid_change', 'معرفات التصحيح غير صالحة.', 400);
  if (!Array.isArray(body.append) || !body.append.length || body.append.length > 1000) historyFail('invalid_change', 'أضف فترة موثقة واحدة على الأقل.', 400);
  for (const rawFact of body.append) {
    const fact = object(rawFact, ['id', 'kind', 'from', 'to', 'value']);
    if (fact.kind !== 'known') historyFail('explicit_dates_required', 'التوثيق الجديد يحتاج فترة سريان صريحة؛ لا يُستنتج تاريخ للملاحظات القديمة.', 400);
    if (kind === 'employment') {
      const value = object(fact.value, ['status']);
      if (!['active', 'suspended', 'ended'].includes(String(value.status))) historyFail('invalid_employment', 'اختر حالة العمل.', 400);
    } else {
      const value = object(fact.value, ['timeZone', 'workingDays', 'graceMins', 'segments']);
      if (Array.isArray(value.segments)) for (const segment of value.segments) object(segment, ['id', 'start', 'end', 'startDayOffset', 'endDayOffset']);
      validateEffectiveSchedule(value as unknown as HrEffectiveSchedule);
    }
  }
  validateTimeline({ revision: 1, facts: body.append as TemporalFact<HrHistoryValue>[] });
  return immutableJson({ requestId: body.requestId, expectedUsername: body.expectedUsername, staffId, operation: `${kind}.record` as HrHistoryCommand['operation'], expectedRevision: Number(body.expectedRevision),
    reason: body.reason.trim(), supersedeIds: body.supersedeIds as string[], append: body.append as TemporalFact<HrHistoryValue>[] });
}
export function matchingHrHistoryReceipt(raw: unknown, command: HrHistoryCommand, username: string): raw is HrHistoryReceipt {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as HrHistoryReceipt;
  try {
    const timeline = validateTimeline(value.timeline);
    return value.requestId === command.requestId && value.staffId === command.staffId && value.operation === command.operation
    && value.actorUsername === username && value.revision === command.expectedRevision + 1 && value.activation === 'documented_only'
    && Number.isSafeInteger(value.actorUserId) && value.actorUserId > 0 && typeof value.recordedAt === 'string' && Number.isFinite(Date.parse(value.recordedAt))
    && /^[a-f0-9]{64}$/.test(value.intentDigest) && canonicalHrIntent(value.intent) === canonicalHrIntent(command)
    && timeline.revision === value.revision
    && command.append.every(fact => timeline.facts.some(saved => canonicalHrIntent(saved) === canonicalHrIntent(fact)))
    && !timeline.facts.some(fact => command.supersedeIds.includes(fact.id)); } catch { return false; }
}
