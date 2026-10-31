import { LabFinancialBoundaryError } from "@/lib/lab-financial-boundary";
import { labClinicalEditProblem, parseLabClinicalSnapshot } from "@/lib/lab-clinical-edit";
import { parseLabShadeSpecification } from "@/lib/lab-shades";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { deleteCanonicalLabOrderResponse, patchCanonicalLabOrderResponse } from "@/lib/canonical-lab";
import { NO_STORE } from "@/lib/canonical-patient-http";
import {
  createLabOrderRemake,
  deleteLabOrder,
  findUserByUsername,
  getLabOrderById,
  getSettings,
  labOrderEvents,
  recordAudit,
  setLabOrderDueDate,
  setLabOrderStatus,
  updateLabOrderAccounting,
  updateLabOrderShades,
  updateLabOrderClinical,
} from "@/lib/db";
import { canDoctorViewCostPrices } from "@/lib/doctor-permissions";
import { canAccessPatient } from "@/lib/patient-access";
import { canHandleMoney, isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { isCurrency, parseAmount, type Currency, CLINIC_BASE_CURRENCY } from "@/lib/money";
import { rateFromSettings } from "@/lib/settings";
import type { LabOrderStatus } from "@/lib/lab";
import { isLabAccountingRate } from "@/lib/lab-accounting-edit";

import { completeLabPrescription, LabPrescriptionError } from "@/lib/lab-prescription-write";
import { validateLabPrescription } from "@/lib/lab-prescription-input";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/* المختبرات السنية V2: في طور التصنيع والإعادة حالتان كاملتان — بلا `needed`
 * (يولّده توقيع الزيارة وحده) ولا قفزات إلى الوراء. */
const STATUSES: LabOrderStatus[] = [
  "needed", "sent", "in_progress", "received", "delivered", "remake", "cancelled",
];

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  }
  if (selected.kind === "canonical") {
    const { id: rawId } = await context.params;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ message: "رقم العمل غير صالح." }, { status: 400, headers: NO_STORE });
    }
    let body: unknown;
    try {
      body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    } catch (error) {
      const bounded = bodyErrorResponse(error);
      if (bounded) return bounded;
      return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
    }
    return patchCanonicalLabOrderResponse(selected.handle, id, (body ?? {}) as Record<string, unknown>);
  }
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
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  try {
    if (source.action === "complete_prescription") {
      if (typeof source.expected !== "string" || typeof source.dispatch !== "boolean") {
        return NextResponse.json({ message: "بيانات مراجعة الطلب غير صالحة." }, { status: 400 });
      }
      let prescription;
      try { prescription = validateLabPrescription(source.prescription, source.dispatch); }
      catch (error) { return NextResponse.json({ message: error instanceof Error ? error.message : "بيانات غير صالحة." }, { status: 400 }); }
      const result = await completeLabPrescription(id, prescription, source.expected, source.dispatch, session);
      return NextResponse.json(result);
    }

    if (source.action === "update_clinical") {
      if (!["admin", "doctor", "reception"].includes(session.role)) return NextResponse.json({ message: "غير مصرح بتصحيح الإرسالية." }, { status: 403 });
      const clinical = parseLabClinicalSnapshot(source.clinical);
      const expectedClinical = parseLabClinicalSnapshot(source.expectedClinical);
      if (!clinical || !expectedClinical) return NextResponse.json({ message: "بيانات الإرسالية أو نسختها السابقة غير صالحة." }, { status: 400 });
      const problem = labClinicalEditProblem(clinical, expectedClinical);
      if (problem) return NextResponse.json({ message: problem }, { status: 400 });
      const result = await updateLabOrderClinical(id, { clinical, expectedClinical, session });
      if (result === "forbidden") return NextResponse.json({ message: "غير مصرح لهذا المريض أو الطبيب." }, { status: 403 });
      if (result === "not_found") return NextResponse.json({ message: "الإرسالية غير موجودة." }, { status: 404 });
      if (result === "invalid") return NextResponse.json({ message: "بيانات الطبيب أو المعمل أو الأسنان غير صالحة؛ أعد مراجعتها." }, { status: 400 });
      if (result === "financial_doctor_locked") return NextResponse.json({ message: "تغيير الطبيب قد يعيد توزيع العمولة التاريخية؛ لهذه الإرسالية أثر مالي أو فاتورة مرتبطة ويحتاج تصحيح الطبيب مراجعة مالية مستقلة." }, { status: 409 });
      if (result === "financial_lab_locked") return NextResponse.json({ message: "للإرسالية تكلفة أو التزام مالي؛ تغيير المعمل يحتاج مراجعة الربط المالي أولًا ولا يُنفّذ من التصحيح السريري." }, { status: 409 });
      if (result === "conflict") return NextResponse.json({ message: "تغيّرت الإرسالية منذ فتحها؛ أغلق النافذة وأعد تحميلها قبل التصحيح." }, { status: 409 });
      return NextResponse.json({ ok: true });
    }

    if (source.action === "update_shade") {
      if (!["admin", "doctor", "reception"].includes(session.role)) return NextResponse.json({ message: "غير مصرح بتعديل ألوان المعمل." }, { status: 403 });
      const next = parseLabShadeSpecification(source.shadeSpecification);
      const expected = parseLabShadeSpecification(source.expectedShadeSpecification);
      if (!next.ok || !expected.ok) return NextResponse.json({ message: "مواصفات الألوان أو نسختها السابقة غير صالحة." }, { status: 400 });
      const result = await updateLabOrderShades(id, { shadeSpecification: next.value, expectedShadeSpecification: expected.value, session });
      if (result === "forbidden") return NextResponse.json({ message: "غير مصرح لهذا المريض." }, { status: 403 });
      if (result === "not_found") return NextResponse.json({ message: "الإرسالية غير موجودة." }, { status: 404 });
      if (result === "invalid") return NextResponse.json({ message: "الألوان تخص أسنانًا غير موجودة في الإرسالية؛ راجع الاختيار." }, { status: 400 });
      if (result === "conflict") return NextResponse.json({ message: "تغيّرت الألوان منذ فتح الإرسالية؛ أعد تحميلها قبل التعديل." }, { status: 409 });
      return NextResponse.json({ ok: true, shadeSpecification: next.value });
    }
    /* سجل أحداث الطلب (المختبرات V2) — قبل أي تغيير أو بدونه عند الطلب المجرد. */
    if (source.action === "events") {
      if (session.role === "doctor") {
        const existing = await getLabOrderById(id);
        if (!existing) return NextResponse.json({ message: "أمر المختبر غير موجود." }, { status: 404 });
        if (!(await canAccessPatient(session, existing.patientId))) {
          return NextResponse.json({ message: "غير مصرح لهذا المريض." }, { status: 403 });
        }
      }
      const events = await labOrderEvents(id);
      return NextResponse.json({ events });
    }

    /* (CLIN-05) طلب إعادة تصنيع (Remake) مرتبط بالإرسالية الأصلية بلا تكلفة إضافية. */
    if (source.action === "remake") {
      if (!["admin", "doctor", "reception"].includes(session.role)) {
        return NextResponse.json({ message: "غير مصرح بطلب إعادة تصنيع." }, { status: 403 });
      }
      const remakeReason = typeof source.remakeReason === "string" ? source.remakeReason.trim().slice(0, 300) : "";
      const newDueDate = typeof source.newDueDate === "string" ? source.newDueDate.trim() : "";
      if (remakeReason.length < 2) {
        return NextResponse.json({ message: "اكتب سبب إعادة التصنيع بوضوح." }, { status: 400 });
      }
      if (!DATE_PATTERN.test(newDueDate)) {
        return NextResponse.json({ message: "حدد موعد تسليم صحيح للإعادة." }, { status: 400 });
      }
      const existing = await getLabOrderById(id);
      if (!existing) {
        return NextResponse.json({ message: "أمر المختبر غير موجود." }, { status: 404 });
      }
      if (!(await canAccessPatient(session, existing.patientId))) {
        return NextResponse.json({ message: "غير مصرح لهذا المريض." }, { status: 403 });
      }
      if (existing.status !== "received" && existing.status !== "delivered") {
        return NextResponse.json({ message: "إعادة التصنيع متاحة للأعمال المستلمة أو المسلمة فقط." }, { status: 409 });
      }
      const remake = await createLabOrderRemake(id, {
        remakeReason,
        newDueDate,
        details: typeof source.details === "string" && source.details.trim() ? source.details.trim().slice(0, 300) : null,
        shade: typeof source.shade === "string" && source.shade.trim() ? source.shade.trim().slice(0, 30) : null,
        stumpShade: typeof source.stumpShade === "string" && source.stumpShade.trim() ? source.stumpShade.trim().slice(0, 30) : null,
        actor: session.username,
        actorRole: session.role,
      });
      if (!remake) {
        return NextResponse.json({ message: "أمر المختبر غير موجود." }, { status: 404 });
      }
      await recordAudit({
        action: "lab_order.create",
        entity: "lab_order",
        entityId: String(remake.id),
        entityLabel: `إعادة تصنيع معمل: ${remake.patientName} (${remake.labName})`,
        details: { الأصل: id, السبب: remakeReason, التسليم: newDueDate },
        actor: session.username,
        actorRole: session.role,
      });
      const hideRemakeCosts = session.role === "doctor"
        && !canDoctorViewCostPrices((await findUserByUsername(session.username).catch(() => null))?.permissions, session.role);
      return NextResponse.json(hideRemakeCosts
        ? { ...remake, costMinor: null, costCurrency: null, baseAmountMinor: null, exchangeRate: null, payableId: null }
        : remake);
    }

    /* إجراءات الربط المحاسبي والترحيل النهائي (بنود المصروفات): تحديث البند
     * والحسابين، أو ترحيل نهائي، أو إلغاء ترحيل — عمل المسؤول المالي. */
    if (source.action === "update_accounting" || source.action === "post" || source.action === "unpost") {
      if (!canHandleMoney(session.role)) {
        return NextResponse.json({ message: "الربط والترحيل المحاسبي للإدارة والاستقبال." }, { status: 403 });
      }
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
        if (!isCurrency(source.costCurrency)) {
          return NextResponse.json({ code: "lab_accounting_currency_required", message: "اختر عملة التكلفة الفعلية؛ لا تُفترض عملة تلقائيًا." }, { status: 400 });
        }
        costCurrency = source.costCurrency;
        costMinor = parseAmount(String(source.cost), costCurrency);
        if (costMinor === null || costMinor < 0) {
          return NextResponse.json({ message: "اكتب تكلفة صحيحة أو اتركها فارغة." }, { status: 400 });
        }
        // سعر الصرف من الإعدادات عند تغيّر التكلفة بعملة أجنبية — لا سعرَ افتراضيًّا.
        const settings = await getSettings();
        // (TD-05) الأساس دستوري من الكود — والإعدادات لأسعار الصرف.
        const baseCurrency: Currency = CLINIC_BASE_CURRENCY;
        const rate = costCurrency === baseCurrency ? 1 : rateFromSettings(settings, costCurrency, baseCurrency);
        exchangeRate = rate != null && rate > 0 ? rate : undefined;
        // Optional UI quote fence; unchanged-money requests omit all these fields.
        // The server still owns the current rate and the existing writer owns money.
        if (source.expectedExchangeRate !== undefined) {
          if (!isLabAccountingRate(source.expectedExchangeRate)) {
            return NextResponse.json({ code: "lab_accounting_rate_invalid", message: "سعر معاينة غير صالح. أعد تحميل المعاينة." }, { status: 400 });
          }
          if (!isLabAccountingRate(exchangeRate) || source.expectedExchangeRate !== exchangeRate) {
            return NextResponse.json({ code: "lab_accounting_rate_changed", message: "تغيّر سعر الصرف أو تعذّر التحقق منه. حدّث المعاينة وراجعها قبل الحفظ." }, { status: 409 });
          }
        }
        if (!isLabAccountingRate(exchangeRate)) {
          return NextResponse.json({ code: "lab_accounting_rate_invalid", message: "سعر صرف عملة التكلفة غير صالح؛ راجع الإعدادات قبل الحفظ." }, { status: 409 });
        }
      } else if (source.cost === null || source.cost === "") {
        costMinor = null;
      }

      const updated = await updateLabOrderAccounting(id, {
        session,
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

    const maskLabCostsIfNeeded = async <T extends { costMinor?: number | null; costCurrency?: Currency | null; baseAmountMinor?: number | null; exchangeRate?: number | null; payableId?: number | null }>(order: T): Promise<T> => {
      if (session.role !== "doctor") return order;
      const user = await findUserByUsername(session.username).catch(() => null);
      if (canDoctorViewCostPrices(user?.permissions, session.role)) return order;
      return { ...order, costMinor: null, costCurrency: null, baseAmountMinor: null, exchangeRate: null, payableId: null };
    };

    if (typeof source.dueDate === "string") {
      if (!DATE_PATTERN.test(source.dueDate)) {
        return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });
      }
      if (session.role === "doctor") {
        const existing = await getLabOrderById(id);
        if (!existing) return NextResponse.json({ message: "أمر المختبر غير موجود." }, { status: 404 });
        if (!(await canAccessPatient(session, existing.patientId))) {
          return NextResponse.json({ message: "غير مصرح لهذا المريض." }, { status: 403 });
        }
      }
      const updated = await setLabOrderDueDate(id, source.dueDate);
      if (!updated) {
        return NextResponse.json(
          { message: "لا يمكن تأجيل عمل وصل أو أُلغي." },
          { status: 409 },
        );
      }
      return NextResponse.json(await maskLabCostsIfNeeded(updated));
    }

    const status = typeof source.status === "string" ? source.status : "";
    if (!STATUSES.includes(status as LabOrderStatus)) {
      return NextResponse.json({ message: "حالة غير معروفة." }, { status: 400 });
    }
    if (session.role === "doctor") {
      const existingForScope = await getLabOrderById(id);
      if (existingForScope && !(await canAccessPatient(session, existingForScope.patientId))) {
        return NextResponse.json({ message: "غير مصرح لهذا المريض." }, { status: 403 });
      }
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
    if (status === "sent") {
      const existing = await getLabOrderById(id);
      if (existing?.status === "needed") {
        return NextResponse.json({ message: "استكمل بيانات الإرسالية وراجعها من زر استكمال الإرسالية أولًا." }, { status: 409 });
      }
    }
    const updated = await setLabOrderStatus(id, status as LabOrderStatus, {
      session,
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
    return NextResponse.json(await maskLabCostsIfNeeded(updated));
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") return NextResponse.json({ code: "lab_status_busy", message: "يوجد تحديث جارٍ؛ حدّث الإرسالية وأعد المحاولة." }, { status: 409 });
    if (error instanceof LabFinancialBoundaryError) return NextResponse.json({ message: error.message, code: error.code }, { status: error.status });
    if (error instanceof LabPrescriptionError) return NextResponse.json({ message: error.message }, { status: error.status });
    const code = error instanceof Error ? error.message : "";
    if (code === "lab_order_accounting_price_invalid") return NextResponse.json({ code, message: "التكلفة المعدّلة يجب أن تكون مبلغًا موجبًا؛ لا يمكن مسح الالتزام المالي من هذا الإجراء." }, { status: 400 });
    const accountingConflicts: Record<string, string> = {
      lab_order_accounting_settled: "للإرسالية أثر سداد؛ لا يمكن تغيير بياناتها المالية. راجع التسوية المحاسبية دون تعديل المدفوعات السابقة.",
      lab_order_accounting_period_locked: "الفترة المالية للإرسالية مقفلة؛ لا يمكن تعديل بياناتها المالية.",
      lab_order_accounting_busy: "تُحدّث بيانات الإرسالية أو سدادها الآن؛ أعد تحميلها ثم حاول مجددًا.",
      lab_order_accounting_link_invalid: "ربط الالتزام المالي للإرسالية غير متسق؛ راجعه قبل التعديل.",
    };
    if (accountingConflicts[code]) return NextResponse.json({ code, message: accountingConflicts[code] }, { status: 409 });
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء. أعد المحاولة." }, { status: 500 });
  }
}

/* حذف أمر مختبر نهائيًا — المدير وحده، والالتزام المسدَّد يمنعه (يُلغى سريريًا
 * بدله). الإلغاء للموقف الطبيعي، والحذف للسجل الخاطئ الذي لا مكان له أصلًا. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  }
  if (selected.kind === "canonical") {
    const { id: rawId } = await context.params;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ message: "رقم العمل غير صالح." }, { status: 400, headers: NO_STORE });
    }
    let reason: string | null = null;
    try {
      const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
      const source = (body ?? {}) as Record<string, unknown>;
      if (typeof source.reason === "string" && source.reason.trim()) {
        reason = source.reason.trim().slice(0, 300);
      }
    } catch (error) {
      const bounded = bodyErrorResponse(error);
      if (bounded) return bounded;
    }
    return deleteCanonicalLabOrderResponse(selected.handle, id, reason);
  }
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
    const body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    const source = (body ?? {}) as Record<string, unknown>;
    if (typeof source.reason === "string" && source.reason.trim()) {
      reason = source.reason.trim().slice(0, 300);
    }
  } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    /* جسمٌ غير مقروء: يُعامل كغياب السبب — فيُرفض أدناه. */
  }
  /* (FIA-3) سبب الحذف النهائي إلزامي — الإلغاء الطبيعي ليس حذفًا. */
  if (!reason || reason.length < 3) {
    return NextResponse.json({ message: "اكتب سبب الحذف النهائي — يُسجَّل في التدقيق. (للإلغاء الطبيعي استعمل «إلغاء» لا الحذف.)" }, { status: 400 });
  }

  try {
    const result = await deleteLabOrder(id, {
      actor: session.username,
      actorRole: session.role,
      reason,
    });
    if (!result.ok) {
      if (result.reason === "reason_required") {
        return NextResponse.json({ message: "اكتب سبب الحذف النهائي — يُسجَّل في التدقيق." }, { status: 400 });
      }
      if (result.reason === "source_linked") {
        return NextResponse.json({ code: "lab_source_linked", message: "الإرسالية مرتبطة بمصدر علاجي أو فاتورة؛ لا يمكن حذف هويتها. استخدم الإلغاء المسموح مع حفظ الأثر." }, { status: 409 });
      }
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
