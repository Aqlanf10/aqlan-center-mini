import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, recordPlanConsent } from "@/lib/db";
import { parseConsentSchedule } from "@/lib/plan-consent";
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
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const parsed = parseConsentSchedule(source, clinicDateString(new Date(), CLINIC_TIME_ZONE));
  if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: 400 });

  try {
    const consent = await recordPlanConsent({
      planId,
      actor: session.username,
      actorRole: session.role,
      note: typeof source.note === "string" ? source.note.slice(0, 300) : null,
      schedule: parsed.schedule,
    });
    if (!consent.ok) return NextResponse.json({ message: consent.message }, { status: consent.status ?? 409 });
    return NextResponse.json(
      { totalMinor: consent.totalMinor, installments: consent.installments ?? 0 }, { status: 201 },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل الموافقة." }, { status: 500 });
  }
}
