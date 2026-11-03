import { NextResponse } from 'next/server';
import { NO_STORE } from '@/lib/canonical-patient-http';
import {
  hrStaffHistoryGetCanonicalResponse,
  hrStaffHistoryPostCanonicalResponse,
} from '@/lib/canonical-hr';
import { selectRequestStaffEnvelope } from '@/lib/staff-session-admission';
import { hrStaffHistoryGet, hrStaffHistoryPost } from '@/lib/hr-temporal-http';
import { requireSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === 'denied') {
    return NextResponse.json({ message: 'انتهت الجلسة. سجّل الدخول من جديد.' }, { status: 401, headers: NO_STORE });
  }
  if (selected.kind === 'canonical') {
    return hrStaffHistoryGetCanonicalResponse(request, context, 'employment', selected.handle);
  }
  return hrStaffHistoryGet(request, context, 'employment', await requireSession());
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === 'denied') {
    return NextResponse.json({ message: 'انتهت الجلسة. سجّل الدخول من جديد.' }, { status: 401, headers: NO_STORE });
  }
  if (selected.kind === 'canonical') {
    return hrStaffHistoryPostCanonicalResponse(request, context, 'employment', selected.handle);
  }
  return hrStaffHistoryPost(request, context, 'employment', await requireSession());
}
