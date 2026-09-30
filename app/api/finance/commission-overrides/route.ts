import { NextResponse } from "next/server";
import { caseOverrideTargets, createCaseOverride, listCaseOverrides } from "@/lib/db";
import { parseCaseOverrideRequest } from "@/lib/commission-override-input";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (COMM-DETAIL-1 · F-11) النسبة الخاصة بالحالة — للمدير وحده: قراءةً وتعيينًا وإلغاءً.
 * كل كتابة صفٌّ جديد مسبَّب في سجلٍّ إلحاقيّ مع سطر تدقيق في المعاملة نفسها.
 * (الكاشير والمحاسب خارج هذا المسار عند الباب — lib/role-routes.ts.)
 */
const FORBIDDEN = "النسب الخاصة بالحالات للمدير وحده.";

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!isAdmin(session.role)) return NextResponse.json({ message: FORBIDDEN }, { status: 403 });
  const raw = new URL(request.url).searchParams.get("patientId");
  const patientId = raw && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
  try {
    const [overrides, targets] = await Promise.all([
      listCaseOverrides({ patientId }),
      patientId ? caseOverrideTargets(patientId) : Promise.resolve(null),
    ]);
    return NextResponse.json({ overrides, targets });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل النسب الخاصة." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!isAdmin(session.role)) return NextResponse.json({ message: FORBIDDEN }, { status: 403 });
  const body = await request.json().catch(() => null);
  const parsed = parseCaseOverrideRequest(body);
  if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: 400 });
  try {
    const result = await createCaseOverride({ ...parsed.value, actor: session.username, actorRole: session.role });
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: result.status });
    return NextResponse.json({ override: result.override }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ النسبة الخاصة." }, { status: 500 });
  }
}
