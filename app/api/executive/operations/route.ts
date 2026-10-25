import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, getPool } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canReadOperationalOverview, parseOperationalQuery } from "@/lib/leadership-operations";
import { readOperationalOverview } from "@/lib/leadership-operations-db";

export const dynamic = "force-dynamic";
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401);
  if (!canReadOperationalOverview(session.role)) return json({ message: "المراجعة التشغيلية للإدارة فقط." }, 403);
  const input = parseOperationalQuery(new URL(request.url).searchParams, new Date(), CLINIC_TIME_ZONE);
  if (!input) return json({ message: "اختر يومًا صحيحًا ومسار مراجعة صالحًا." }, 400);
  const overview = await readOperationalOverview(getPool(), input, CLINIC_TIME_ZONE);
  // A role change, logout, expiry or disabled account during the read must not publish the result.
  const current = await requireSession();
  if (!current || current.userId !== session.userId || !canReadOperationalOverview(current.role)) {
    return json({ message: "تغيّرت الجلسة. سجّل الدخول من جديد." }, 401);
  }
  return json(overview);
}
