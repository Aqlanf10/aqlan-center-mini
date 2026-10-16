import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { HrHistoryError } from '@/lib/hr-temporal-request';
import { admittedHrHistoryAuthority, hrHistoryErrorResponse } from '@/lib/hr-temporal-http';
import { readHrPayrollHistory } from '@/lib/hr-payroll-temporal-read';
import { requireSession } from '@/lib/session';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const authority = admittedHrHistoryAuthority(request, await requireSession()), params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['staffId', 'from', 'to'].includes(key)) || !/^[1-9]\d*$/.test(params.get('staffId') ?? '')) throw new HrHistoryError('invalid_request', 'اختر الموظف وحدود الفترة فقط؛ لا يقبل الطلب صلاحيات أو قرار تناسب من العميل.', 400);
    return NextResponse.json(await readHrPayrollHistory(getPool(), authority, Number(params.get('staffId')), params.get('from') ?? '', params.get('to') ?? ''));
  } catch (error) { return hrHistoryErrorResponse(error); }
}
