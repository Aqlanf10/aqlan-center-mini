import { ClinicalDoctorIdentityConflict } from "@/lib/clinical-doctor-identity";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { addVisitAddendum, getClinicalVisit, getSettings, recordAudit, saveClinicalNotes, setVisitProcedures, signClinicalVisit, ClinicalPlanConflict, ProcedurePriceRejected, InventoryShortage, type ProcedurePriceOverride } from "@/lib/db";
import { CLINIC_BASE_CURRENCY, isCurrency } from "@/lib/money";
import { foreignRatesFromSettings } from "@/lib/service-pricing";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { checkOrthoSessionDraft } from "@/lib/ortho-baseline";
import { CLINIC_TIME_ZONE } from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { assistantProcedureChange } from "@/lib/clinical-finalizer";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const clinicalOnly = () =>
  NextResponse.json({ message: "التوثيق السريري للطبيب والمدير والمساعد السريري." }, { status: 403 });

/** (P0-F) المساعد السريري يعمل على زيارات اليوم وحدها — زيارةٌ قديمة مفتوحة ليست له. */
const assistantOutsideToday = (visit: { arrivedAt: string }) =>
  clinicDateString(new Date(visit.arrivedAt), CLINIC_TIME_ZONE) !== clinicDateString(new Date(), CLINIC_TIME_ZONE);

const idFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const visitId = await idFrom(context);
  if (!visitId) return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });

  try {
    const visit = await getClinicalVisit(visitId, { actorPartyId: session.partyId ?? null });
    if (!visit) return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });

    // عزل الطبيب (§٣٩): زيارة مريضٍ ليس من مرضاه لا تُفتح — الفحص في الخادم.
    // والزيارة الحرّة غير المربوطة بمريضٍ تبقى مفتوحة: من يعالجها هو من يربطها.
    if (visit.patientId !== null && !(await canAccessPatient(session, visit.patientId))) {
      return NextResponse.json({ message: "هذه زيارة مريضٍ ليس من مرضاك." }, { status: 403 });
    }
    if (session.role === "assistant" && assistantOutsideToday(visit)) {
      return NextResponse.json({ message: "المساعد السريري يعمل على زيارات اليوم وحدها." }, { status: 403 });
    }

    return NextResponse.json(visit);
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الزيارة." }, { status: 500 });
  }
}

/**
 * حفظ التوثيق والإجراءات، أو توقيع الزيارة، أو إضافة ملحق.
 *
 * والتوقيع هو **الحلقة**: يولّد الفاتورة ويحدّث المخطط في معاملة واحدة. ولذلك يُطلب
 * بفعلٍ صريح (`action: "sign"`) لا كأثر جانبي لحفظ — فعملٌ يترتّب عليه مالٌ لا يقع
 * بالخطأ.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (session.role !== "doctor" && session.role !== "admin" && session.role !== "assistant") return clinicalOnly();
  const assistant = session.role === "assistant";

  const visitId = await idFrom(context);
  if (!visitId) return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const action = String(source.action ?? "save");
  const text = (value: unknown, max = 2000) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

  try {
    const visit = await getClinicalVisit(visitId, { actorPartyId: session.partyId ?? null });
    if (!visit) return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
    if (visit.patientId !== null && !(await canAccessPatient(session, visit.patientId))) {
      return NextResponse.json({ message: "هذه زيارة مريضٍ ليس من مرضاك." }, { status: 403 });
    }
    if (assistant && assistantOutsideToday(visit)) {
      return NextResponse.json({ message: "المساعد السريري يعمل على زيارات اليوم وحدها." }, { status: 403 });
    }
    if (action === "addendum") {
      const note = text(source.text, 1000);
      if (!note) return NextResponse.json({ message: "اكتب نصّ الملحق." }, { status: 400 });
      const added = await addVisitAddendum({ visitId, text: note, author: session.username });
      if (!added) {
        return NextResponse.json(
          { message: "الملحق يُضاف على زيارة موقَّعة فقط." }, { status: 409 },
        );
      }
      await recordAudit({
        action: "visit.addendum", entity: "visit", entityId: visitId,
        details: { النص: note }, actor: session.username, actorRole: session.role,
      });
      return NextResponse.json(await getClinicalVisit(visitId, { actorPartyId: session.partyId ?? null }));
    }

    if (action === "sign") {
      /* (P0-F) المساعد يُنهي الزيارة ولا يكتب سجلًّا سريريًّا جديدًا: شدّة التقويم (الأسلاك والمطاطات
         وما نُفّذ) للطبيب — تُرفض صراحةً لا تُتجاهل. */
      if (session.role === "assistant" && source.orthoSession !== undefined && source.orthoSession !== null) {
        return NextResponse.json({ message: "تسجيل شدّة التقويم للطبيب — المساعد يُنهي الزيارة كما وثّقها الطبيب." }, { status: 403 });
      }
      /* (P1-C) «بلا رسوم» لشدّة خارج العقد قرارٌ سريريّ-ماليّ للطبيب أو المدير وحدهما. */
      const rawDecision = (source.outsideContractDecision ?? null) as { decision?: unknown; reason?: unknown } | null;
      let outsideContractDecision: { decision: "no_charge"; reason: string } | null = null;
      if (rawDecision !== null) {
        if (session.role !== "admin" && session.role !== "doctor") {
          return NextResponse.json({ message: "قرار فوترة الشدّة للطبيب أو المدير." }, { status: 403 });
        }
        if (rawDecision.decision !== "no_charge" || typeof rawDecision.reason !== "string") {
          return NextResponse.json({ message: "قرار الشدّة غير صالح — «بلا رسوم» مع سببٍ مكتوب." }, { status: 400 });
        }
        outsideContractDecision = { decision: "no_charge", reason: rawDecision.reason };
      }
      // (CASE-1) شدّة التقويم تُوقَّع مع الزيارة — ناقصةً تُرفض قبل أي أثر.
      const orthoSession = checkOrthoSessionDraft(source.orthoSession);
      if (!orthoSession.ok) return NextResponse.json({ message: orthoSession.message }, { status: 400 });
      // (TD-05) الأساس دستوري من الكود — وعملة فاتورة الزيارة ترث عملة خطة بنودها.
      const result = await signClinicalVisit({
        visitId, baseCurrency: CLINIC_BASE_CURRENCY, signedBy: session.username,
        /* (P0-F) المُنهي ليس الطبيب المعالج: المساعد لا يصير طبيبًا افتراضيًا لسطرٍ بلا طبيب. */
        signerDoctorPartyId: assistant ? null : session.partyId ?? null,
        dependencyOverrideReason: typeof source.dependencyOverrideReason === "string" ? source.dependencyOverrideReason : null,
        orthoSession: orthoSession.value,
        outsideContractDecision,
        signerRole: session.role,
      });
      const messages: Record<string, string> = {
        not_found: "الزيارة غير موجودة.",
        already_signed: "الزيارة موقَّعة سلفًا. التصحيح يكون بملحق.",
        empty: "سجّل إجراءً أو تشخيصًا قبل توقيع الزيارة.",
        no_patient: "اربط الزيارة بملف مريض قبل التوقيع — الفاتورة تدخل كشف حسابه.",
        mixed_plan_currencies: "الزيارة تجمع بنود خطط بعملات اتفاقٍ مختلفة — لا تُفوتر فاتورةً واحدة. أفصل الإجراءات على زياراتٍ أو خططٍ بعملةٍ واحدة.",
        no_treating_doctor: "حدّد الطبيب المعالج للزيارة (أو لكل إجراء) قبل التوقيع — لا يُفوتر إجراءٌ بلا طبيب، وإلا ضاعت عمولته.",
        unmet_dependency: "بنودٌ في هذه الزيارة تتطلب ما لم يكتمل بعد — اكتب سبب المتابعة لتُكمل التوقيع.",
        invalid_override_reason: "سبب المتابعة طويل جدًا — الحد الأقصى ٣٠٠ حرف.",
        ortho_case_invalid: "حالة التقويم المرسلة مغلقة أو لا تخص مريض هذه الزيارة — حدّث الشاشة وأعد التوقيع.",
        plan_session_unlinked: "إجراءٌ حرّ يطابق بندًا متعدد الجلسات في خطة المريض — اربطه ببنده ليُحسب جلسةً منه، لا علاجًا يُفوتَر كاملًا من جديد.",
        invalid_decision_reason: "اكتب سبب «بلا رسوم» للشدّة (من ٣ أحرف إلى ٣٠٠).",
      };
      if (result.reason) {
        return NextResponse.json(
          result.reason === "unmet_dependency"
            ? { message: messages[result.reason], unmetRequirements: result.unmetRequirements ?? [] }
            : result.reason === "plan_session_unlinked"
              ? { message: messages[result.reason], sessionConflicts: result.sessionConflicts ?? [] }
              : { message: messages[result.reason] },
          { status: result.reason === "invalid_override_reason" || result.reason === "invalid_decision_reason" ? 400 : 409 },
        );
      }
      await recordAudit({
        action: "visit.sign", entity: "visit", entityId: visitId,
        entityLabel: result.visit?.patientName,
        details: {
          الإجراءات: result.visit?.procedures.length ?? 0,
          الإجمالي: result.duesMinor,
          الفاتورة: result.invoiceId,
          عملة_الفاتورة: result.invoiceCurrency,
          تحديثات_المخطط: result.chartUpdates,
          بنود_اكتملت: result.planItemsDone,
          جلسات_منجزة: result.sessionsCompleted,
          طلبات_معمل_تلقائية: result.labOrdersCreated,
          حركات_مستهلكات: result.materialsDeducted,
          الجلسة_القادمة: result.nextPlannedVisit?.title ?? null,
          شدّة_التقويم: result.orthoAdjustmentId,
          تصنيف_فوترة_الشدّة: result.orthoBillingClass,
          /* (P0-F) المُنهي (signed_by) غير الطبيب المعالج: يُسجَّلان معًا. */
          المنهي: session.username,
          دور_المنهي: session.role,
          الطبيب_المعالج: result.visit?.doctorId ?? null,
          ...(result.orthoBillingDecision ? { قرار_الشدّة: result.orthoBillingDecision === "billed" ? "فوتِرت" : "بلا رسوم" } : {}),
        },
        actor: session.username, actorRole: session.role,
      });
      /*
       * الاستجابة تحمل نتيجة الرحلة كاملة: الاستحقاق الذي تولّد وفق قواعد الفوترة
       * بعملة فاتورته الفعلية (TD-05 owner review — الشبّاك يعرض استحقاق اليوم
       * بعملتها، والتحصيل يستهدف فاتورتها بها)، والجلسات المنجَزة، والزيارة
       * المخطَّطة المقترحة التالية — فتفتح الشبّاك (Checkout) والاستقبال يعرفان
       * ماذا يحصّلان وماذا يُحجَز من غير بحث.
       */
      return NextResponse.json({
        ...result.visit,
        invoiceId: result.invoiceId,
        invoiceCurrency: result.invoiceCurrency,
        duesMinor: result.duesMinor,
        sessionsCompleted: result.sessionsCompleted,
        nextPlannedVisit: result.nextPlannedVisit,
        labOrdersCreated: result.labOrdersCreated,
        materialsDeducted: result.materialsDeducted,
        orthoAdjustmentId: result.orthoAdjustmentId,
        orthoBillingClass: result.orthoBillingClass,
      });
    }

    /* (P0-F) المساعد يكمل الملاحظات فقط: لا يغيّر الطبيب المعالج ولا الإجراءات ولا أسعارها ولا أطباءها. */
    if (assistant) {
      const requestedDoctor = Number(source.doctorId) || null;
      if (requestedDoctor !== (visit.doctorId ?? null)) {
        return NextResponse.json({ message: "المساعد السريري لا يغيّر الطبيب المعالج." }, { status: 403 });
      }
      if (Array.isArray(source.procedures) && assistantProcedureChange(visit.procedures, source.procedures)) {
        return NextResponse.json(
          { message: "المساعد السريري لا يعدّل الإجراءات أو أسعارها أو أطباءها — يعدّلها الطبيب." }, { status: 403 },
        );
      }
    }

    // حفظ التوثيق والإجراءات معًا: الطبيب يكتب ويختار في شاشة واحدة.
    const clinicalNotes = {
      chiefComplaint: text(source.chiefComplaint, 500),
      examination: text(source.examination),
      diagnosis: text(source.diagnosis),
      treatmentDone: text(source.treatmentDone),
      nextPlan: text(source.nextPlan, 500),
      doctorId: Number(source.doctorId) || null,
    };

    if (Array.isArray(source.procedures) && !assistant) {
      const procedures = source.procedures
        .map((row) => row as Record<string, unknown>)
        .filter((row) => Number(row.serviceId) > 0)
        .map((row) => ({
          serviceId: Number(row.serviceId),
          toothCode: Number(row.toothCode) || null,
          surfaces: typeof row.surfaces === "string" ? row.surfaces : null,
          quantity: Math.max(1, Math.round(Number(row.quantity) || 1)),
          unitPriceMinor: Math.max(0, Math.round(Number(row.unitPriceMinor) || 0)),
          priceReason: text(row.priceReason, 300),
          doctorId: Number(row.doctorId) || null,
          note: text(row.note, 300),
          // الربط ببند الخطة: السعر يأتي عندها من الخطة وفق قاعدة الفوترة — لا من الطلب.
          planItemId: Number(row.planItemId) > 0 ? Number(row.planItemId) : null,
        }));
      /* (P1-6) السعر من الدليل؛ الخصم بسببٍ وضمن حد الإعدادات، والرفع للمدير وحده. */
      const settings = await getSettings();
      const maxDiscount = Number(settings["billing.max_discount_percent"]);
      const overrides: ProcedurePriceOverride[] = [];
      // (DAY1) عملة الزيارة للإجراءات الحرّة، وأسعار الصرف للتحويل حين لا سعر خاص بها.
      if (source.billingCurrency !== undefined && source.billingCurrency !== null && !isCurrency(source.billingCurrency)) {
        return NextResponse.json({ message: "عملة الزيارة غير صالحة." }, { status: 400 });
      }
      const ok = await setVisitProcedures({
        visitId,
        procedures,
        clinicalNotes,
        authority: { role: session.role, maxDiscountPercent: Number.isFinite(maxDiscount) ? maxDiscount : 0 },
        overrides,
        billingCurrency: isCurrency(source.billingCurrency) ? source.billingCurrency : undefined,
        rates: foreignRatesFromSettings(settings),
      });
      if (!ok) {
        return NextResponse.json({ message: "الزيارة موقَّعة — لا تُعدَّل إجراءاتها." }, { status: 409 });
      }
      for (const override of overrides) {
        await recordAudit({
          action: "visit.price_override", entity: "visit", entityId: visitId,
          entityLabel: `${visit.patientName ?? ""} — ${override.serviceName}`,
          details: {
            الخدمة: override.serviceName,
            العملة: override.currency,
            النوع: override.kind === "discount" ? "خصم" : override.kind === "increase" ? "رفع فوق الدليل" : "سعر يدوي لخدمة غير مسعّرة",
            سعر_الدليل: override.catalogMinor,
            السعر_المعتمد: override.requestedMinor,
            نسبة_الخصم: override.discountPercent,
            السبب: override.reason,
          },
          actor: session.username, actorRole: session.role,
        });
      }
    } else if (!(await saveClinicalNotes({ ...clinicalNotes, visitId }))) {
      return NextResponse.json(
        { message: "الزيارة موقَّعة — لا تُعدَّل. أضف ملحقًا." }, { status: 409 },
      );
    }

    return NextResponse.json(await getClinicalVisit(visitId, { actorPartyId: session.partyId ?? null }));
  } catch (error) {
    if (error instanceof ClinicalDoctorIdentityConflict) {
      return NextResponse.json({ message: error.message, code: error.code }, { status: 409 });
    }
    if (error instanceof ClinicalPlanConflict) {
      return NextResponse.json({ message: error.message }, { status: 409 });
    }
    if (error instanceof ProcedurePriceRejected) {
      return NextResponse.json({ message: error.message, code: "price_authority" }, { status: 409 });
    }
    if (error instanceof InventoryShortage) {
      return NextResponse.json({ message: error.message, code: "inventory_shortage" }, { status: 409 });
    }
    return NextResponse.json({ message: "تعذّر حفظ الزيارة." }, { status: 500 });
  }
}
