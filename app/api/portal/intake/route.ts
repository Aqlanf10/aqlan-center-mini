import { NextResponse } from "next/server";
import { createIntakeForm, latestIntakeForm, recordAudit } from "@/lib/db";
import { validateIntake } from "@/lib/portal";
import { requirePortalSession } from "@/lib/portal-server";

export const dynamic = "force-dynamic";

/**
 * الاستمارة الصحية الرقمية.
 *
 * القراءة تعيد آخر نسخة لتُعرى الشاشة؛ والكتابة تُضيف نسخة جديدة لا تستبدل —
 * تاريخ الصحة لا يُعدَّل. كل إرسال يُدقَّق بهوية صاحبه.
 */
export async function GET() {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }
  try {
    const latest = await latestIntakeForm(session.patientId);
    return NextResponse.json({ latest });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الاستمارة." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const validation = validateIntake(body);
  if (!validation.ok) {
    return NextResponse.json({ message: validation.message }, { status: 400 });
  }
  try {
    const created = await createIntakeForm(session.patientId, validation.value);
    await recordAudit({
      action: "portal.intake",
      entity: "patient",
      entityId: session.patientId,
      details: { formId: created.id, conditions: validation.value.conditions.length },
      actor: `مريض: ${session.fullName}`,
    });
    return NextResponse.json(created, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر إرسال الاستمارة الآن." }, { status: 500 });
  }
}
