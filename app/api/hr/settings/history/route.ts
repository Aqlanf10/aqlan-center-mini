import { NextResponse } from 'next/server';
import { NO_STORE } from '@/lib/canonical-patient-http';
import { hrSettingsHistoryGetCanonicalResponse } from '@/lib/canonical-hr';
import { getPool } from '@/lib/db';
import { admittedHrHistoryAuthority, hrHistoryErrorResponse } from '@/lib/hr-temporal-http';
import { readHrPolicyHistories, withHrHistoryRead } from '@/lib/hr-temporal-read';
import { requireSession } from '@/lib/session';
import { selectRequestStaffEnvelope } from '@/lib/staff-session-admission';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === 'denied') {
    return NextResponse.json({ message: 'انتهت الجلسة. سجّل الدخول من جديد.' }, { status: 401, headers: NO_STORE });
  }
  if (selected.kind === 'canonical') {
    return hrSettingsHistoryGetCanonicalResponse(request, selected.handle);
  }
  try {
    const authority = admittedHrHistoryAuthority(request, await requireSession());
    return NextResponse.json(await withHrHistoryRead(getPool(), authority, async client => ({ activation: 'documented_only', policies: await readHrPolicyHistories(client), warning: 'شروط موثقة وليست معادلات مالية؛ غياب السياسة أو اعتمادها يبقى غير محسوم.' })));
  } catch (error) { return hrHistoryErrorResponse(error); }
}
