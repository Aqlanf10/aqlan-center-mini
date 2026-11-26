import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, getVisitOwner } from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { readVisitCheckout } from "@/lib/checkout-db";
import { authorizeVisit } from "@/lib/operational-access";
import { requireSession } from "@/lib/session";
import { patientAppointmentId } from "@/lib/patient-appointments-contract";
import { walkoutNeedsReview } from "@/lib/walkout-presentation";
import { canSeeWalkout } from "@/lib/walkout-access";
import { canReadReceptionHandoff } from "@/lib/reception-handoff";
import { readReceptionHandoff } from "@/lib/reception-handoff-db";
import { InvoiceSettlementError } from "@/lib/invoice-settlement-position";

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
  const patientRef = new URL(_request.url).searchParams.getAll("patientId");
  if (patientRef.length > 0 && (patientRef.length !== 1 || patientAppointmentId(patientRef[0]) !== allowed.patientId
    || allowed.patientId === null)) {
    return NextResponse.json({ message: "الزيارة غير متاحة لهذا المريض." }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
  try {
    const owner = await getVisitOwner(id);
    if (!(await canSeeWalkout(session, owner.patientId))) {
      return NextResponse.json({ message: "ملخّص المغادرة فيه أرقامٌ مالية — للاستقبال والمدير." }, { status: 403 });
    }
    const checkout = await readVisitCheckout(id);
    if (!checkout) return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
    const { walkout, summary, dueRecommendation, today } = checkout;
    // Refuse an owner changed between authorization and the money snapshot.
    if (walkout.patientId !== owner.patientId || walkout.patientId !== allowed.patientId) {
      return NextResponse.json({ message: "تغيّر ارتباط الزيارة؛ أعد تحميل الملف." }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
    }
    // (OP-03) «وُقِّعت اليوم» بتوقيت العيادة المضبوط في الخادم لا بافتراض العميل — لاستعادة الشبّاك.
    const signedToday = walkout.signedAt !== null
      && clinicDateString(new Date(walkout.signedAt), CLINIC_TIME_ZONE) === today;
    const handoff = canReadReceptionHandoff(session.role) && walkout.signedAt
      ? await readReceptionHandoff(id, walkout) : null;
    if (session.role === "reception") {
      // The checkout UI also reads the review verdict: redact the underlying
      // clinical lines only after deriving the verdict from the real snapshot.
      const { visitId, patientId, patientName, arrivedAt, signedAt, deferred, invoice, balances, nextAppointment } = walkout;
      return NextResponse.json({
        visitId, patientId, patientName, arrivedAt, signedAt, signedToday, deferred,
        financialReviewRequired: walkoutNeedsReview(walkout), lines: [], orthoAdjustment: null,
        invoice: invoice && { id: invoice.id, currency: invoice.currency, netMinor: invoice.netMinor, number: invoice.number },
        balances: balances.map(({ currency, balanceMinor }) => ({ currency, balanceMinor })),
        nextAppointment: nextAppointment && { date: nextAppointment.date, time: nextAppointment.time },
        checkout: { previous: walkout.checkout.previous, current: walkout.checkout.current, invoicePaidMinor: walkout.checkout.invoicePaidMinor },
        summary, dueRecommendation,
        ...(handoff ? { receptionHandoff: { status: handoff.status, handledReason: null } } : {}),
      }, { headers: { "Cache-Control": "private, no-store" } });
    }
    return NextResponse.json({ ...walkout, summary, dueRecommendation, signedToday,
      ...(handoff ? { receptionHandoff: { status: handoff.status, handledReason: handoff.handledReason } } : {}),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof InvoiceSettlementError) {
      return NextResponse.json({ message: error.message }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
    }
    return NextResponse.json({ message: "تعذّر تحميل ملخّص المغادرة." }, { status: 500 });
  }
}

