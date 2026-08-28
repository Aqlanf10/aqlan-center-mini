import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, recordPlanConsent, schedulePlanInstallments } from "@/lib/db";
import { canHandleMoney } from "@/lib/roles";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * موافقة المريض على الخطة — واللحظة التي تصير فيها المسوّدة اتفاقًا.
 *
 * ويجوز أن يُجدوَل التقسيط في الطلب نفسه، لأنه ما يحدث فعلًا على الكرسي: يوافق
 * المريض على البنود ويسأل «أقدر أقسّطها؟» في النَّفَس نفسه. وفصلُهما إلى شاشتين
 * يجعل نصف الخطط تُوافَق ولا تُجدوَل.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "خطط العلاج للإدارة والاستقبال." }, { status: 403 });
  }

  const { id } = await context.params;
  const planId = Number(id);
  if (!Number.isInteger(planId) || planId <= 0) {
    return NextResponse.json({ message: "رقم الخطة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  try {
    const consent = await recordPlanConsent({
      planId,
      actor: session.username,
      note: typeof source.note === "string" ? source.note.slice(0, 300) : null,
    });
    if (!consent.ok) return NextResponse.json({ message: consent.message }, { status: 409 });

    // التقسيط اختياري — والموافقة قائمة سواءٌ قُسّطت أم دُفعت نقدًا عند التنفيذ.
    const count = Math.round(Number(source.count ?? 0));
    if (!Number.isFinite(count) || count < 1) {
      return NextResponse.json({ totalMinor: consent.totalMinor, installments: 0 }, { status: 201 });
    }
    if (count > 60) {
      return NextResponse.json({ message: "عدد الأقساط بين 1 و60." }, { status: 400 });
    }

    const everyDays = Math.round(Number(source.everyDays ?? 30));
    if (!Number.isFinite(everyDays) || everyDays < 1 || everyDays > 365) {
      return NextResponse.json({ message: "المدة بين الأقساط بين 1 و365 يومًا." }, { status: 400 });
    }
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const firstDueDate = typeof source.firstDueDate === "string" && DATE_PATTERN.test(source.firstDueDate)
      ? source.firstDueDate : today;

    const scheduled = await schedulePlanInstallments({ planId, count, everyDays, firstDueDate });
    if (!scheduled.ok) {
      // الموافقة سُجّلت فعلًا؛ فالجدولة وحدها هي التي تعذّرت — ويُقال ذلك صراحةً.
      return NextResponse.json(
        { message: `سُجّلت الموافقة، وتعذّرت الجدولة: ${scheduled.message}` }, { status: 409 },
      );
    }
    return NextResponse.json(
      { totalMinor: consent.totalMinor, installments: scheduled.count }, { status: 201 },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل الموافقة." }, { status: 500 });
  }
}
