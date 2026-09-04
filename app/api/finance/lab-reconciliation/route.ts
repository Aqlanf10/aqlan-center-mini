import { NextResponse } from "next/server";
import {
  CLINIC_TIME_ZONE,
  ensureSchema,
  getOpenShift,
  getPool,
  getSettingsSafe,
  listAppointmentsByDate,
  listLabOrders,
  listParties,
  recordAudit,
  recordExpense,
} from "@/lib/db";
import { addDays, clinicDateString } from "@/lib/schedule";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import {
  buildBatchSettlementNote,
  detectLabAppointmentMismatches,
  reconcileLabStatement,
  type ReconcileOrderItem,
} from "@/lib/lab-reconciliation";
import type { Currency } from "@/lib/money";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

  const { searchParams } = new URL(request.url);
  const partyIdParam = searchParams.get("partyId");
  const targetPartyId = partyIdParam ? Number(partyIdParam) : null;

  try {
    const now = new Date();
    const todayStr = clinicDateString(now, CLINIC_TIME_ZONE);
    const tomorrowStr = addDays(todayStr, 1);
    const afterTomorrowStr = addDays(todayStr, 2);

    const [labParties, allOrders, todayAppts, tomorrowAppts, afterAppts] = await Promise.all([
      listParties("lab"),
      listLabOrders({ limit: 300 }),
      listAppointmentsByDate(todayStr),
      listAppointmentsByDate(tomorrowStr),
      listAppointmentsByDate(afterTomorrowStr),
    ]);

    const upcomingAppts = [...todayAppts, ...tomorrowAppts, ...afterAppts];
    const risks = detectLabAppointmentMismatches(upcomingAppts, allOrders, todayStr);

    // إذا طُلب مختبر بعينه:
    if (targetPartyId) {
      const party = labParties.find((p) => p.id === targetPartyId);
      if (!party) {
        return NextResponse.json({ message: "المختبر غير موجود." }, { status: 404 });
      }

      // الأوامر الخاصة بهذا المختبر غير المسددة أو المستلمة حديثاً
      const partyOrders = allOrders.filter(
        (o) => o.partyId === targetPartyId || o.labName === party.name,
      );

      const reconcileItems: ReconcileOrderItem[] = partyOrders.map((o) => ({
        orderId: o.id,
        patientName: o.patientName,
        patientNumber: o.patientNumber,
        workType: o.workType,
        teeth: o.toothNumbers,
        sentDate: o.sentDate,
        dueDate: o.dueDate,
        systemCostMinor: o.costMinor || 0,
        currency: (o.costCurrency as Currency) || (party.currency as Currency) || "YER",
        status: o.status,
        financialStatus: o.financialStatus || "pending_delivery",
        notes: o.details,
      }));

      return NextResponse.json({
        party,
        orders: reconcileItems,
        unsettledCount: reconcileItems.filter((i) => i.financialStatus !== "paid").length,
        risks: risks.filter((r) => r.labName === party.name),
      });
    }

    // إحصائيات عامة لكافة المختبرات
    const labStats = labParties.map((party) => {
      const partyOrders = allOrders.filter(
        (o) => o.partyId === party.id || o.labName === party.name,
      );
      const unsettled = partyOrders.filter((o) => o.financialStatus !== "paid");
      const totalUnsettledMinor = unsettled.reduce((sum, o) => sum + (o.costMinor || 0), 0);

      return {
        partyId: party.id,
        partyName: party.name,
        currency: party.currency,
        phone: party.phone,
        activeOrdersCount: partyOrders.filter(
          (o) => o.status === "sent" || o.status === "in_progress" || o.status === "received",
        ).length,
        unsettledOrdersCount: unsettled.length,
        unsettledCostMinor: totalUnsettledMinor,
      };
    });

    return NextResponse.json({
      labs: labStats,
      risks,
      totalRisksCount: risks.length,
    });
  } catch (error) {
    console.error("Failed to load lab reconciliation data:", error);
    return NextResponse.json({ message: "تعذّر تحميل بيانات المطابقة." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json(
      { message: "اعتماد التسويات وسندات الصرف للمدير وحده." },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const source = (body ?? {}) as Record<string, unknown>;
  const partyId = Number(source.partyId);
  const orderIdsRaw = Array.isArray(source.orderIds) ? source.orderIds : [];
  const orderIds = orderIdsRaw.map(Number).filter((id) => Number.isInteger(id) && id > 0);

  if (!Number.isInteger(partyId) || partyId <= 0) {
    return NextResponse.json({ message: "يرجى تحديد المختبر." }, { status: 400 });
  }

  if (orderIds.length === 0) {
    return NextResponse.json({ message: "يرجى تحديد أمر عمل واحد على الأقل للمطابقة والتسوية." }, { status: 400 });
  }

  const amountMinor = Number(source.amountMinor);
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    return NextResponse.json({ message: "مبلغ التسوية غير صالح." }, { status: 400 });
  }

  const currency = (typeof source.currency === "string" ? source.currency : "YER") as Currency;
  const exchangeRate = typeof source.exchangeRate === "number" && source.exchangeRate > 0 ? source.exchangeRate : 1;
  const monthLabel = typeof source.monthLabel === "string" ? source.monthLabel.trim() : undefined;

  try {
    await ensureSchema();

    // 1. التحقق من وجود وردية صندوق مفتوحة
    const openShift = await getOpenShift();
    if (!openShift) {
      return NextResponse.json(
        { message: "لا توجد وردية صندوق مفتوحة حالياً. يرجى فتح وردية جديدة في الصندوق أولاً لإصدار سند الصرف." },
        { status: 409 },
      );
    }

    const [parties, settings] = await Promise.all([
      listParties("lab"),
      getSettingsSafe(),
    ]);

    const labParty = parties.find((p) => p.id === partyId);
    if (!labParty) {
      return NextResponse.json({ message: "جهة المختبر غير مسجلة بالنظام." }, { status: 404 });
    }

    const baseCurrency = (settings["finance.base_currency"] as Currency) || "YER";

    // توليد بيان السند المنظم
    const noteText =
      typeof source.note === "string" && source.note.trim()
        ? source.note.trim()
        : `تسوية وسداد كشف حساب مختبر [${labParty.name}]${monthLabel ? ` (${monthLabel})` : ""} لعدد (${orderIds.length}) أوامر عمل: [${orderIds.map((id) => `RX-${id}`).join(", ")}]`;

    // 2. تسجيل سند الصرف المجمع في الصندوق
    const expenseResult = await recordExpense({
      category: "lab",
      partyId: labParty.id,
      payeeText: labParty.name,
      amountMinor,
      currency,
      exchangeRate,
      baseCurrency,
      payableId: null,
      note: noteText,
      createdBy: session.username,
    });

    if (!expenseResult.expense) {
      return NextResponse.json(
        { message: "تعذّر تسجيل سند الصرف في الوردية المفتوحة." },
        { status: 500 },
      );
    }

    const expense = expenseResult.expense;

    // 3. تحديث حالة كافة الأوامر المحددة إلى paid وتدوين الحدث في جدول التتبع
    const pool = getPool();
    await pool.query(
      `UPDATE lab_orders SET financial_status = 'paid' WHERE id = ANY($1::int[])`,
      [orderIds],
    );

    // إضافة أحداث تتبع للأوامر المسددة
    await pool.query(
      `INSERT INTO lab_order_tracking (lab_order_id, action, from_status, to_status, notes, actor, actor_role)
       SELECT id, 'financial_settlement', status, status, $1, $2, 'manager'
         FROM lab_orders WHERE id = ANY($3::int[])`,
      [
        `تمت التسوية المالية المجمعة بسند صرف رقم ${expense.voucherNumber} بمبلغ ${amountMinor} ${currency}`,
        session.username,
        orderIds,
      ],
    );

    // 4. تسجيل في سجل التدقيق
    await recordAudit({
      action: "expense.create",
      actor: session.username,
      entity: "expense",
      entityId: expense.id,
      details: {
        type: "lab_batch_reconciliation",
        partyId: labParty.id,
        partyName: labParty.name,
        voucherNumber: expense.voucherNumber,
        settledOrdersCount: orderIds.length,
        orderIds,
        amountMinor,
        currency,
      },
    });

    return NextResponse.json({
      ok: true,
      voucherNumber: expense.voucherNumber,
      expenseId: expense.id,
      settledCount: orderIds.length,
      totalPaidMinor: amountMinor,
      currency,
      message: `تم بنجاح سداد وتسوية ${orderIds.length} أمر مختبر بسند صرف رقم ${expense.voucherNumber}.`,
    });
  } catch (error) {
    console.error("Batch reconciliation failed:", error);
    return NextResponse.json({ message: "تعذّر إتمام التسوية المجمعة للمختبر." }, { status: 500 });
  }
}
