import { NextResponse } from "next/server";
import { CLINIC_BASE_CURRENCY, isCurrency } from "@/lib/money";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, ensureSchema, getSettings, listAppointmentsByDate, listLabOrders, listParties, ratesFromSettings, recordAudit, settleLabOrdersBatch } from "@/lib/db";
import { refusalStatus } from "@/lib/expense-request";
import { rateOf, refusalMessage, type SupplierPaymentRefusal } from "@/lib/supplier-payments";
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
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
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

  /* (P0-2) العملة تُتحقّق، والسعر من الإعدادات لحظة الدفع — لا من العميل؛ والمدير
     وحده يقرّ سعرًا غيره بسببٍ مكتوب (كسند الصرف تمامًا). */
  if (!isCurrency(source.currency)) {
    return NextResponse.json({ message: "اختر عملة التسوية." }, { status: 400 });
  }
  const currency: Currency = source.currency;
  const monthLabel = typeof source.monthLabel === "string" ? source.monthLabel.trim() : undefined;
  const note = typeof source.note === "string" && source.note.trim() ? source.note.trim() : null;
  const prepaymentReason = source.prepayment === true && typeof source.prepaymentReason === "string"
    && source.prepaymentReason.trim().length >= 3 ? source.prepaymentReason.trim().slice(0, 300) : null;
  if (source.prepayment === true && !prepaymentReason) {
    return NextResponse.json({ message: "اكتب سبب الدفعة المقدمة — يُحفظ في السند ويُدقَّق." }, { status: 400 });
  }

  try {
    await ensureSchema();
    const settingsRates = ratesFromSettings(await getSettings());
    const settingsRate = rateOf(currency, settingsRates);
    const overrideRaw = typeof source.exchangeRate === "number" ? source.exchangeRate : null;
    const overridden = currency !== CLINIC_BASE_CURRENCY && overrideRaw !== null && overrideRaw > 0
      && overrideRaw !== settingsRate;
    const rateOverrideReason = typeof source.rateOverrideReason === "string" && source.rateOverrideReason.trim().length >= 3
      ? source.rateOverrideReason.trim().slice(0, 300) : null;
    if (overridden && !rateOverrideReason) {
      return NextResponse.json(
        { message: "اكتب سبب اختلاف سعر الصرف عن سعر الإعدادات — يُحفظ في السند ويُدقَّق." },
        { status: 400 },
      );
    }
    const exchangeRate = overridden ? overrideRaw! : settingsRate;
    if (exchangeRate === null) {
      return NextResponse.json(
        { message: "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل الصرف بعملة أجنبية." },
        { status: 409 },
      );
    }

    // (TD-05) الأساس دستوري من الكود.
    const baseCurrency: Currency = CLINIC_BASE_CURRENCY;
    const result = await settleLabOrdersBatch({
      partyId, orderIds, amountMinor, currency, baseCurrency, exchangeRate, note, monthLabel,
      createdBy: session.username, actorRole: session.role, rates: settingsRates,
      rateOverrideReason: overridden ? rateOverrideReason : null, prepaymentReason,
    });

    if (!result.ok) {
      const ids = result.orderIds?.map((id) => `RX-${id}`).join("، ") ?? "";
      const byReason: Record<string, [number, string]> = {
        not_lab: [404, "جهة المختبر غير مسجلة بالنظام."],
        orders_invalid: [409, `أوامر لا تخص هذا المختبر أو غير موجودة: ${ids}.`],
        orders_cancelled: [409, `أوامر ملغاة لا تُسدَّد: ${ids}.`],
        orders_already_paid: [409, `أوامر مسدّدة من قبل — لا تُسدَّد مرتين: ${ids}.`],
      };
      const [status, message] = byReason[result.reason]
        ?? [refusalStatus(result.reason), refusalMessage(result.reason as SupplierPaymentRefusal, result.quote)];
      return NextResponse.json({ message, code: result.reason, orderIds: result.orderIds, quote: result.quote }, { status });
    }

    const expense = result.expense;

    // تسجيل في سجل التدقيق
    await recordAudit({
      action: "expense.create",
      actor: session.username,
      actorRole: session.role,
      entity: "expense",
      entityId: expense.id,
      entityLabel: expense.voucherNumber,
      details: {
        type: "lab_batch_reconciliation",
        partyId,
        partyName: result.partyName,
        voucherNumber: expense.voucherNumber,
        settledOrdersCount: result.orderIds.length,
        orderIds: result.orderIds,
        amountMinor,
        currency,
        سعر_الدفع: expense.exchangeRate,
        المكافئ: expense.baseAmountMinor,
      },
    });
    if (expense.rateOverrideReason) {
      await recordAudit({
        action: "expense.rate_override",
        entity: "expense", entityId: expense.id, entityLabel: expense.voucherNumber,
        details: {
          العملة: currency, سعر_الإعدادات: settingsRate, السعر_المستعمل: expense.exchangeRate,
          السبب: expense.rateOverrideReason,
        },
        actor: session.username, actorRole: session.role,
      });
    }
    if (result.quote?.party?.prepayment) {
      await recordAudit({
        action: "expense.prepayment",
        entity: "expense", entityId: expense.id, entityLabel: expense.voucherNumber,
        details: {
          الجهة: partyId, المبلغ: amountMinor, العملة: currency,
          المستحق_قبل: result.quote.party.outstandingBeforeMinor, السبب: prepaymentReason,
        },
        actor: session.username, actorRole: session.role,
      });
    }

    return NextResponse.json({
      ok: true,
      voucherNumber: expense.voucherNumber,
      expenseId: expense.id,
      settledCount: result.orderIds.length,
      totalPaidMinor: amountMinor,
      currency,
      message: `تم بنجاح سداد وتسوية ${result.orderIds.length} أمر مختبر بسند صرف رقم ${expense.voucherNumber}.`,
    });
  } catch (error) {
    console.error("Batch reconciliation failed:", error);
    return NextResponse.json({ message: "تعذّر إتمام التسوية المجمعة للمختبر." }, { status: 500 });
  }
}
