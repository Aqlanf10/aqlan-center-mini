import { NextResponse } from "next/server";
import { doctorOwnsPatient, patientTimeline } from "@/lib/db";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import type { TimelineEvent } from "@/lib/workflow";

export const dynamic = "force-dynamic";

const idFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

/**
 * الخط الزمني الموحَّد (§٢٩-٣٠): كل أحداث المريض من كل مصادرها في خطٍّ واحد.
 *
 * والمال يُسلب في الخادم لمن لا يملكه — الطبيب افتراضيًا يرى الأحداث بلا مبالغ
 * الفواتير والدفعات (§٣٦): الأثر في الخادم لا في الشاشة.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const patientId = await idFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم ملف غير صالح." }, { status: 400 });

  // عزل الطبيب (§٣٩): مرضاه فقط — والفحص في الخادم.
  if (session.role === "doctor" && typeof session.partyId === "number" && session.partyId) {
    const owns = await doctorOwnsPatient(session.partyId, patientId).catch(() => false);
    if (!owns) {
      return NextResponse.json({ message: "هذا الملف ليس من مرضاك." }, { status: 403 });
    }
  }

  const limitRaw = Number(new URL(request.url).searchParams.get("limit") ?? 60);
  const limit = Number.isFinite(limitRaw) ? Math.max(10, Math.min(200, limitRaw)) : 60;

  try {
    const events = await patientTimeline(patientId, limit);
    const maySeeFinancial = canHandleMoney(session.role);
    const scoped: TimelineEvent[] = maySeeFinancial
      ? events
      : events.map((event) =>
          event.kind === "invoice" || event.kind === "payment"
            ? { ...event, amountMinor: null, currency: null, title: event.kind === "invoice" ? "فاتورة" : "دفعة" }
            : event,
        );
    return NextResponse.json({ events: scoped, canSeeFinancial: maySeeFinancial });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الخط الزمني." }, { status: 500 });
  }
}
