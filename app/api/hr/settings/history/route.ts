import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { admittedHrHistoryAuthority, hrHistoryErrorResponse } from '@/lib/hr-temporal-http';
import { readHrPolicyHistories, withHrHistoryRead } from '@/lib/hr-temporal-read';
import { requireSession } from '@/lib/session';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const authority = admittedHrHistoryAuthority(request, await requireSession());
    return NextResponse.json(await withHrHistoryRead(getPool(), authority, async client => ({ activation: 'documented_only', policies: await readHrPolicyHistories(client), warning: 'شروط موثقة وليست معادلات مالية؛ غياب السياسة أو اعتمادها يبقى غير محسوم.' })));
  } catch (error) { return hrHistoryErrorResponse(error); }
}
