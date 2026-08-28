import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, fxReport, postRevaluation, recordAudit } from "@/lib/db";
import { isCurrency } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/** إعادة التقييم تُغيّر ربح الفترة — للمدير وحده. */
const forbidden = () =>
  NextResponse.json({ message: "إعادة تقييم العملات للمدير وحده." }, { status: 403 });

function asOfFrom(request: Request): string {
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const raw = new URL(request.url).searchParams.get("asOf");
  return raw && DATE_PATTERN.test(raw) && raw <= today ? raw : today;
}

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) return forbidden();

  try {
    return NextResponse.json(await fxReport(asOfFrom(request)));
  } catch {
    return NextResponse.json({ message: "تعذّر حساب مراكز العملات." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) return forbidden();

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  if (!isCurrency(source.currency)) {
    return NextResponse.json({ message: "اختر العملة." }, { status: 400 });
  }

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const asOf = typeof source.asOf === "string" && DATE_PATTERN.test(source.asOf) && source.asOf <= today
    ? source.asOf : today;

  try {
    const { entryId, reason } = await postRevaluation({
      currency: source.currency, asOf, createdBy: session.username,
    });
    if (reason === "locked") {
      return NextResponse.json(
        { message: "الفترة مقفلة. لا يُرحَّل فيها قيد." }, { status: 409 },
      );
    }
    if (reason === "no_rate") {
      return NextResponse.json(
        { message: "سعر الصرف غير مضبوط. اضبطه في الإعدادات أولًا." }, { status: 409 },
      );
    }
    if (reason === "nothing" || entryId === null) {
      return NextResponse.json(
        { message: "لا فرق يستحق قيدًا — الدفاتر مطابقة لسعر اليوم." }, { status: 409 },
      );
    }
    await recordAudit({
      action: "fx.revalue", entity: "journal", entityId: entryId,
      entityLabel: source.currency,
      details: { العملة: source.currency, التاريخ: asOf },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json({ entryId }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر ترحيل قيد إعادة التقييم." }, { status: 500 });
  }
}
