import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { readSessionPayload } from '@/lib/session';
import { readHrIdentityPreview } from '@/lib/hr-identity-read';
import { IdentityPreviewError } from '@/lib/hr-identity-preview';
import { readJsonBody, bodyErrorResponse } from '@/lib/http-body';
import { JSON_BODY_LIMIT_BYTES } from '@/lib/security-limits';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
async function preview(request?: Request) {
  try {
    const session = await readSessionPayload();
    if (!session) return NextResponse.json({ message: 'انتهت الجلسة. سجّل الدخول من جديد.' }, { status: 401, headers });
    if (session.role !== 'admin') return NextResponse.json({ message: 'معاينة هوية الطاقم للمدير وحده.' }, { status: 403, headers });
    // POST analyzes a bounded, temporary selection. There is deliberately no apply endpoint.
    const input = request ? await readJsonBody(request, Math.min(JSON_BODY_LIMIT_BYTES, 16_384)) : undefined;
    return NextResponse.json(await readHrIdentityPreview(getPool(), session, input), { headers });
  } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: error instanceof IdentityPreviewError ? error.message : 'تعذّر قراءة مصادر الهوية. لم تُنفّذ أي تغييرات.' },
      { status: error instanceof IdentityPreviewError ? error.status : 503, headers });
  }
}
export async function GET() { return preview(); }
export async function POST(request: Request) { return preview(request); }
