import { NextResponse } from "next/server";
import { labOrderEvents, setLabOrderDueDate, setLabOrderStatus } from "@/lib/db";
import { requireSession } from "@/lib/session";
import type { LabOrderStatus } from "@/lib/lab";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/* المختبرات السنية V2: في طور التصنيع والإعادة حالتان كاملتان — بلا `needed`
 * (يولّده توقيع الزيارة وحده) ولا قفزات إلى الوراء. */
const STATUSES: LabOrderStatus[] = [
  "needed", "sent", "in_progress", "received", "delivered", "remake", "cancelled",
];

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم العمل غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  try {
    /* سجل أحداث الطلب (المختبرات V2) — قبل أي تغيير أو بدونه عند الطلب المجرد. */
    if (source.action === "events") {
      const events = await labOrderEvents(id);
      return NextResponse.json({ events });
    }

    if (typeof source.dueDate === "string") {
      if (!DATE_PATTERN.test(source.dueDate)) {
        return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });
      }
      const updated = await setLabOrderDueDate(id, source.dueDate);
      if (!updated) {
        return NextResponse.json(
          { message: "لا يمكن تأجيل عمل وصل أو أُلغي." },
          { status: 409 },
        );
      }
      return NextResponse.json(updated);
    }

    const status = typeof source.status === "string" ? source.status : "";
    if (!STATUSES.includes(status as LabOrderStatus)) {
      return NextResponse.json({ message: "حالة غير معروفة." }, { status: 400 });
    }
    const updated = await setLabOrderStatus(id, status as LabOrderStatus, {
      actor: session.username,
      actorRole: session.role,
      notes: typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null,
    });
    if (!updated) {
      // الرفض هنا يعني أن جهازًا آخر سبقنا، أو أن الانتقال غير منطقي (مركَّب ثم مُرسَل).
      return NextResponse.json(
        { message: "حالة العمل تغيّرت من جهاز آخر. حدّثت القائمة — راجعها." },
        { status: 409 },
      );
    }
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء. أعد المحاولة." }, { status: 500 });
  }
}
