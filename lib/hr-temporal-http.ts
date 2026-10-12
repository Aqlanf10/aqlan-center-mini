import { NextResponse } from 'next/server';
import type { SessionPayload } from './auth';
import { getPool } from './db';
import { hrTemporalAuthority } from './hr-temporal-authority';
import { HrHistoryError, HrHistoryWriteRefusal, parseHrHistoryCommand, type HrHistoryKind } from './hr-temporal-request';
import { HrTemporalError } from './hr-temporal';
import { readHrRecordedHistory } from './hr-temporal-read';
import { recordHrHistory } from './hr-temporal-write';
import { JSON_BODY_LIMIT_BYTES } from './security-limits';
import { bodyErrorResponse, readJsonBody } from './http-body';

export function hrHistoryErrorResponse(error: unknown) {
  if (error instanceof HrHistoryError) return NextResponse.json({ code: error.code, message: error.message,
    ...(error instanceof HrHistoryWriteRefusal ? { refusal: error.refusal } : {}) }, { status: error.status });
  if (error instanceof HrTemporalError) return NextResponse.json({ code: error.code, message: error.code === 'stale_revision'
    ? 'تغيّرت المراجعة؛ أعد التحميل وراجع التصحيح دون الكتابة فوقها.' : `الفترة أو الجدول يحتاج تصحيحًا (${error.code}).` }, { status: error.code === 'stale_revision' ? 409 : 400 });
  const bounded = bodyErrorResponse(error); if (bounded) return bounded;
  return NextResponse.json({ code: 'outcome_unconfirmed', message: 'تعذّر تأكيد النتيجة. احتفظ بمفتاح الطلب ومحتواه وأعد الطلب نفسه للتحقق.' }, { status: 500 });
}
export function admittedHrHistoryAuthority(request: Request, session: SessionPayload | null) {
  if (!session) throw new HrHistoryError('unauthenticated', 'انتهت الجلسة. سجّل الدخول من جديد.', 401);
  if (session.role !== 'admin') throw new HrHistoryError('forbidden', 'التاريخ الموثق للمدير وحده.', 403);
  return hrTemporalAuthority(session, request.signal);
}
export async function hrStaffHistoryGet(request: Request, context: { params: Promise<{ id: string }> }, kind: HrHistoryKind, session: SessionPayload | null) {
  try {
    const authority = admittedHrHistoryAuthority(request, session), { id } = await context.params, url = new URL(request.url);
    if (!/^[1-9]\d*$/.test(id) || [...url.searchParams.keys()].some(key => !['revision', 'day'].includes(key))) throw new HrHistoryError('invalid_request', 'معلمات قراءة السجل غير صالحة.', 400);
    const revision = url.searchParams.get('revision');
    if (revision !== null && !/^(0|[1-9]\d*)$/.test(revision)) throw new HrHistoryError('invalid_revision', 'رقم المراجعة غير صالح.', 400);
    return NextResponse.json(await readHrRecordedHistory(getPool(), authority, Number(id), kind, { revision: revision === null ? undefined : Number(revision), day: url.searchParams.get('day') ?? undefined }));
  } catch (error) { return hrHistoryErrorResponse(error); }
}
export async function hrStaffHistoryPost(request: Request, context: { params: Promise<{ id: string }> }, kind: HrHistoryKind, session: SessionPayload | null) {
  try {
    const authority = admittedHrHistoryAuthority(request, session), { id } = await context.params;
    if (!/^[1-9]\d*$/.test(id)) throw new HrHistoryError('invalid_subject', 'رقم الموظف غير صالح.', 400);
    const command = parseHrHistoryCommand(await readJsonBody(request, JSON_BODY_LIMIT_BYTES), kind, Number(id));
    return NextResponse.json(await recordHrHistory(getPool(), authority, command));
  } catch (error) { return hrHistoryErrorResponse(error); }
}
