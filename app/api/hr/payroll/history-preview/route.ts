import { NextResponse } from 'next/server';
import { NO_STORE } from '@/lib/canonical-patient-http';
import { hrPayrollHistoryPreviewGetCanonicalResponse } from '@/lib/canonical-hr';
import { getPool } from '@/lib/db';
import { HrHistoryError } from '@/lib/hr-temporal-request';
import { admittedHrHistoryAuthority, hrHistoryErrorResponse } from '@/lib/hr-temporal-http';
import { readHrPayrollHistory } from '@/lib/hr-payroll-temporal-read';
import { requireSession } from '@/lib/session';
import { selectRequestStaffEnvelope } from '@/lib/staff-session-admission';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === 'denied') {
    return NextResponse.json({ message: 'انتهت الجلسة. سجّل الدخول من جديد.' }, { status: 401, headers: NO_STORE });
  }
  if (selected.kind === 'canonical') {
    return hrPayrollHistoryPreviewGetCanonicalResponse(request, selected.handle);
  }
  try {
    const authority = admittedHrHistoryAuthority(request, await requireSession()), params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['staffId', 'from', 'to'].includes(key)) || !/^[1-9]\d*$/.test(params.get('staffId') ?? '')) throw new HrHistoryError('invalid_request', 'اختر الموظف وحدود الفترة فقط؛ لا يقبل الطلب صلاحيات أو قرار تناسب من العميل.', 400);
    return NextResponse.json(await readHrPayrollHistory(getPool(), authority, Number(params.get('staffId')), params.get('from') ?? '', params.get('to') ?? ''));
  } catch (error) { return hrHistoryErrorResponse(error); }
}
