import { NextResponse } from "next/server";
import {
  deleteLabOrder,
  getLabOrderById,
  getSettings,
  labOrderEvents,
  recordAudit,
  setLabOrderDueDate,
  setLabOrderStatus,
  updateLabOrderAccounting,
} from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { isCurrency, parseAmount, type Currency } from "@/lib/money";
import { rateFromSettings } from "@/lib/settings";
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

    /* إجراءات الربط المحاسبي والترحيل النهائي (بنود المصروفات): تحديث البند
     * والحسابين، أو ترحيل نهائي، أو إلغاء ترحيل — عمل المسؤول المالي. */
    if (source.action === "update_accounting" || source.action === "post" || source.action === "unpost") {
      const isPosted =
        source.action === "post"
          ? true
          : source.action === "unpost"
            ? false
            : source.isPosted !== undefined
              ? Boolean(source.isPosted)
              : undefined;

      const expenseCategoryIdRaw = Number(source.expenseCategoryId);
      const expenseCategoryId =
        Number.isInteger(expenseCategoryIdRaw) && expenseCategoryIdRaw > 0
          ? expenseCategoryIdRaw
          : source.expenseCategoryId === null
            ? null
            : undefined;

      const expenseAccountCode =
        typeof source.expenseAccountCode === "string" && source.expenseAccountCode.trim()
          ? source.expenseAccountCode.trim().slice(0, 10)
          : undefined;

      const payableAccountCode =
        typeof source.payableAccountCode === "string" && source.payableAccountCode.trim()
          ? source.payableAccountCode.trim().slice(0, 10)
          : undefined;

      let costMinor: number | null | undefined = undefined;
      let costCurrency: Currency | undefined = undefined;
      let exchangeRate: number | undefined = undefined;
      if (source.cost !== undefined && String(source.cost).trim() !== "") {
        const curr = typeof source.costCurrency === "string" ? source.costCurrency : "YER";
        costCurrency = isCurrency(curr) ? curr : "YER";
        costMinor = parseAmount(String(source.cost), costCurrency);
        if (costMinor === null || costMinor < 0) {
          return NextResponse.json({ message: "اكتب تكلفة صحيحة أو اتركها فارغة." }, { status: 400 });
        }
        // سعر الصرف من الإعدادات عند تغيّر التكلفة بعملة أجنبية — لا سعرَ افتراضيًّا.
        const settings = await getSettings();
        const baseCurrency = isCurrency(settings["finance.base_currency"])
          ? settings["finance.base_currency"] : "YER";
        const rate = costCurrency === baseCurrency ? 1 : rateFromSettings(settings, costCurrency, baseCurrency);
        exchangeRate = rate != null && rate > 0 ? rate : undefined;
      } else if (source.cost === null || source.cost === "") {
        costMinor = null;
      }

      const updated = await updateLabOrderAccounting(id, {
        expenseCategoryId,
        expenseAccountCode,
        payableAccountCode,
        isPosted,
        costMinor,
        costCurrency,
        exchangeRate,
        actor: session.username,
        actorRole: session.role,
      });

      if (!updated) {
        return NextResponse.json({ message: "أمر المختبر غير موجود." }, { status: 404 });
      }
      return NextResponse.json(updated);
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
    /* إلغاء الإرسالية قرار إداري لا تشغيلي: يمسّ المال (يعكس الالتزام غير
     * المسدَّد) ويوقف عملًا قائمًا عند المختبر — للمدير وحده. طلب «لم يُرسل بعد»
     * استثناء: لم يغادر العيادة ولم يدخل الدفاتر، فإلغاؤه حقٌّ تشغيلي للجميع. */
    if (status === "cancelled") {
      const existing = await getLabOrderById(id);
      if (existing && existing.status !== "needed" && !isAdmin(session.role)) {
        return NextResponse.json(
          { message: "إلغاء إرسالية أُرسلت للمختبر للمدير وحده." },
          { status: 403 },
        );
      }
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
    if (status === "cancelled") {
      await recordAudit({
        action: "lab_order.cancel",
        entity: "lab_order",
        entityId: id,
        entityLabel: `${updated.patientName} — ${updated.workType}`,
        details: {
          labName: updated.labName,
          teeth: updated.toothNumbers ?? null,
          costMinor: updated.costMinor ?? null,
          costCurrency: updated.costCurrency ?? null,
          note: typeof source.note === "string" ? source.note.slice(0, 300) : null,
        },
        actor: session.username,
        actorRole: session.role,
      });
    }
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء. أعد المحاولة." }, { status: 500 });
  }
}

/* حذف أمر مختبر نهائيًا — المدير وحده، والالتزام المسدَّد يمنعه (يُلغى سريريًا
 * بدله). الإلغاء للموقف الطبيعي، والحذف للسجل الخاطئ الذي لا مكان له أصلًا. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "حذف أوامر المختبر للمدير وحده." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم العمل غير صالح." }, { status: 400 });
  }

  let reason: string | null = null;
  try {
    const body = await request.json();
    const source = (body ?? {}) as Record<string, unknown>;
    if (typeof source.reason === "string" && source.reason.trim()) {
      reason = source.reason.trim().slice(0, 300);
    }
  } catch {
    /* لا سبب — ليس شرطًا */
  }

  try {
    const result = await deleteLabOrder(id, {
      actor: session.username,
      actorRole: session.role,
      reason,
    });
    if (!result.ok) {
      if (result.reason === "settled") {
        return NextResponse.json(
          { message: "التزام هذا العمل مسدَّد بسند صرف — ألغِه سريريًا بدل حذفه ليبقى الأثر المالي." },
          { status: 409 },
        );
      }
      return NextResponse.json({ message: "أمر المختبر غير موجود." }, { status: 404 });
    }
    return NextResponse.json({ message: "حُذف أمر المختبر وسُجِّل في التدقيق." });
  } catch {
    return NextResponse.json({ message: "تعذّر حذف أمر المختبر. أعد المحاولة." }, { status: 500 });
  }
}
