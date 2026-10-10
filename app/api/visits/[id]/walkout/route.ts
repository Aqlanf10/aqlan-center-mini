import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, getVisitOwner, visitWalkout } from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { visitCheckoutSummary } from "@/lib/checkout-db";
import { authorizeVisit } from "@/lib/operational-access";
import { requireSession } from "@/lib/session";
import { canSeeWalkout } from "@/lib/walkout-access";
import { canReadReceptionHandoff } from "@/lib/reception-handoff";
import { readReceptionHandoff } from "@/lib/reception-handoff-db";

export const dynamic = "force-dynamic";

/**
 * (CHAIR-1 Slice 5) ملخّص المغادرة لزيارة — قراءةٌ فقط من بياناتٍ قائمة: عمل الزيارة (وما شُمل
 * بالخطة)، وفاتورتها، وسندات يومها، والرصيد بكل عملة، والموعد القادم.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });
  }
  const allowed = await authorizeVisit(session, id);
  if (!allowed.ok) return NextResponse.json({ message: allowed.message }, { status: allowed.status });
  try {
    const owner = await getVisitOwner(id);
    if (!(await canSeeWalkout(session, owner.patientId))) {
      return NextResponse.json({ message: "ملخّص المغادرة فيه أرقامٌ مالية — للاستقبال والمدير." }, { status: 403 });
    }
    const walkout = await visitWalkout(id);
    if (!walkout) return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
    /* (P0-G) الملخص المالي بكل عملة + قسط الرصيد السابق المقترح (P0-C) — من الخادم لا من الواجهة. */
    const summary = await visitCheckoutSummary(walkout);
    // (OP-03) «وُقِّعت اليوم» بتوقيت العيادة المضبوط في الخادم لا بافتراض العميل — لاستعادة الشبّاك.
    const signedToday = walkout.signedAt !== null
      && clinicDateString(new Date(walkout.signedAt), CLINIC_TIME_ZONE) === clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const handoff = canReadReceptionHandoff(session.role) && walkout.signedAt
      ? await readReceptionHandoff(id, walkout) : null;
    return NextResponse.json({ ...walkout, summary, signedToday,
      ...(handoff ? { receptionHandoff: { status: handoff.status, handledReason: handoff.handledReason } } : {}),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل ملخّص المغادرة." }, { status: 500 });
  }
}

