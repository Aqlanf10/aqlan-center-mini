/**
 * أدوات استعلام المرضى والملفات السريرية (Patient AI Tools)
 *
 * تنفذ عزل الأطباء الصارم (§39): لا يستطيع الطبيب الوصول لأي مريض لا يملكه.
 */

import {
  getPatientFile,
  searchPatients,
  patientLedger,
  listPatientPlans,
  listAppointmentsByDate,
  asPaymentLikes,
  type PatientSummary,
} from "../db";
import { canAccessPatient } from "../patient-access";
import type { SessionPayload } from "../auth";
import { patientBalance, balanceText, formatMoney, CLINIC_BASE_CURRENCY } from "../money";
import type { AiToolContext, ToolExecutionResult, KpiCard, ActionButton } from "./types";
import { toWhatsAppNumber } from "../reminders";

/**
 * أداة البحث عن مريض بالاسم أو الهاتف أو رقم الملف
 */
export async function searchPatient(
  params: { term: string },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const term = params.term.trim();
  if (!term) {
    return { success: false, textSummary: "يرجى كتابة اسم المريض أو رقم هاتفه أو رقم ملفه." };
  }

  if (!context.isDbConnected) {
    const text = `🔍 **استعلام عن المريض «${term}»:**\n⚠️ خدمة قاعدة البيانات غير متصلة في هذا الوضع التجريبي. عند التشغيل الحي بالعيادة، سيعرض النظام كامل الملف المالي والسجلات السريرية فوراً.`;
    return {
      success: true,
      textSummary: text,
      message: text,
      cards: [{ title: "المريض المطلوب", value: term, tone: "info" }],
      warnings: ["خدمة قاعدة البيانات غير متصلة في هذا الوضع التجريبي"],
    };
  }

  try {
    const doctorScopeId = !context.canViewAllPatients && context.role === "doctor" ? context.doctorPartyId : null;
    let matches: PatientSummary[] = [];

    // فحص رقمي صريح (رقم هوية أو ملف)
    if (/^\d+$/.test(term) && Number(term) > 0 && Number(term) < 100000) {
      const file = await getPatientFile(Number(term)).catch(() => null);
      if (file) {
        matches = [{
          id: file.patient.id,
          patientNumber: file.patient.patientNumber,
          fullName: file.patient.fullName,
          phone: file.patient.phone,
          medicalAlert: file.patient.medicalAlert,
        }];
      }
    }

    if (matches.length === 0) {
      matches = await searchPatients(term, 8, doctorScopeId).catch(() => []);
    }

    if (matches.length === 0) {
      return {
        success: false,
        textSummary: `🔍 **استعلام عن مريض:** لم أجد أي مريض في النظام يطابق «${term}»${
          context.role === "doctor" && !context.canViewAllPatients ? " ضمن الحالات المسندة إليك" : ""
        }.\n- تأكد من صحة الاسم أو ابحث برقم الهاتف أو رقم الملف (P-001).`,
      };
    }

    // إذا وجدنا أكثر من نتيجة مطابقة
    if (matches.length > 1 && !matches.some((m) => m.fullName.trim() === term)) {
      const listText = matches
        .map((m, idx) => `${idx + 1}. **${m.fullName}** (ملف: \`${m.patientNumber}\` | هاتف: \`${m.phone || "غير مسجل"}\`)${
          m.medicalAlert ? ` ⚠️ ${m.medicalAlert}` : ""
        }`)
        .join("\n");

      return {
        success: true,
        textSummary: `🔍 **وجدت (${matches.length}) نتائج تطابق «${term}»:**\n\n${listText}\n\n💡 *يرجى تحديد اسم المريض كاملاً أو كتابة رقم ملفه السكني للإجابة الدقيقة.*`,
        data: matches,
      };
    }

    // مطابقة مريض واحد محدد
    return getPatientSummary({ patientId: matches[0].id }, context);
  } catch (err) {
    return {
      success: false,
      textSummary: `تعذر البحث عن المريض: ${(err as Error).message}`,
      warnings: [(err as Error).message],
    };
  }
}

/**
 * أداة جلب الملف الشامل للمريض (Patient 360° Profile)
 */
export async function getPatientSummary(
  params: { patientId: number },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const patientId = Number(params.patientId);
  if (!patientId || patientId <= 0) {
    return { success: false, textSummary: "رقم المريض غير صالح." };
  }

  // فحص عزل الطبيب والصلاحيات
  const session: SessionPayload = {
    userId: context.userId ?? 1,
    username: context.username || "anonymous",
    role: (context.role || context.userRole || "doctor") as string,
    expiresAt: Date.now() + 3600_000,
    partyId: context.doctorPartyId ?? undefined,
  };

  const allowed = await canAccessPatient(session, patientId);
  if (!allowed) {
    return {
      success: false,
      textSummary: "🔒 **تنبيه أمني:** ليس لديك صلاحية للوصول إلى ملف هذا المريض (عزل الكادر السريري §39).",
      warnings: ["محاولة وصول لملف مريض غير مسند للطبيب"],
    };
  }

  /* الرصيد والمدفوعات بياناتٌ مالية: تظهر فقط لمن يملك رؤية مدفوعات المرضى —
     فالمسار الرسمي (كشف الحساب) يفرضها، فلا يُتسرب عبر المساعد أضعف مما في
     النظام (canViewPatientPayments: المدير والاستقبال نعم، الطبيب لا افتراضيًا). */
  const canSeeMoney =
    (context.role || context.userRole) === "admin" ||
    (context.role || context.userRole) === "reception" ||
    context.permissions?.canViewPatientPayments === true;

  if (!context.isDbConnected) {
    return {
      success: true,
      textSummary: `👤 **ملف المريض #${patientId}:**\n⚠️ خدمة قاعدة البيانات غير متصلة في هذا الوضع.`,
      patientIdAccessed: patientId,
    };
  }

  try {
    const [file, ledger, plans] = await Promise.all([
      getPatientFile(patientId).catch(() => null),
      patientLedger(patientId).catch(() => ({ invoices: [], payments: [], opening: null })),
      listPatientPlans(patientId, context.todayISO || new Date().toISOString().slice(0, 10)).catch(() => []),
    ]);

    if (!file) {
      return { success: false, textSummary: `تعذر تحميل ملف المريض رقم #${patientId}.` };
    }

    const p = file.patient;
    const balance = patientBalance(
      ledger.invoices.map((i) => ({
        totalMinor: i.totalMinor,
        discountMinor: i.discountMinor,
        status: i.status,
      })),
      asPaymentLikes(ledger.payments),
      ledger.opening?.amountMinor ?? 0,
    );
    const balText = balanceText(balance, CLINIC_BASE_CURRENCY);

    // بطاقات الأداء السريعة للمريض
    const cards: KpiCard[] = [
      ...(canSeeMoney
        ? [{
            title: "الحساب الحالي",
            value: balText,
            tone: balance.dueMinor > 0 ? ("warn" as const) : ("good" as const),
          }]
        : []),
      {
        title: "رقم الملف السكني",
        value: p.patientNumber,
        tone: "info",
      },
      {
        title: "التنبيه الطبي",
        value: p.medicalAlert
          ? `⚠️ ${p.medicalAlert}`
          : "لا يوجد تنبيه مسجل — تحقق سريرياً",
        tone: p.medicalAlert ? ("bad" as const) : ("calm" as const),
      },
      {
        title: "خطط العلاج",
        value: plans.length > 0 ? `${plans.length} خطط مسجلة` : "لا توجد خطط نشطة",
        tone: "calm",
      },
    ];

    // أزرار التنقل السريعة
    const actions: ActionButton[] = [
      { label: "فتح ملف المريض الكامل", href: `/patients/${p.id}`, actionType: "navigate" },
      { label: "كشف الحساب المالي", href: `/print/statement/${p.id}`, actionType: "print" },
    ];

    if (p.phone) {
      const wa = toWhatsAppNumber(p.phone);
      if (wa) {
        actions.push({
          label: "مراسلة واتساب",
          href: `https://wa.me/${wa}`,
          actionType: "whatsapp",
        });
      }
    }

    const moneyLine = canSeeMoney
      ? `• **الحالة المالية:** **${balText}** (المفوتر: ${formatMoney(balance.billedMinor, CLINIC_BASE_CURRENCY)} | المسدد: ${formatMoney(balance.collectedMinor, CLINIC_BASE_CURRENCY)})`
      : `• **الحالة المالية:** محجوبة — عرض أرصدة المرضى يتطلب صلاحية مالية.`;
    const fullSummary = `👤 **بطاقة المريض: ${p.fullName}**
• **رقم الملف:** \`${p.patientNumber}\` | **الهاتف:** \`${p.phone || "غير مسجل"}\`
• **العنوان:** ${p.address || "غير مسجل"} | **الجنس:** ${p.gender === "female" ? "أنثى" : "ذكر"}
${moneyLine}
• **التنبيه الطبي:** ${p.medicalAlert ? `🚨 **${p.medicalAlert}**` : "لا يوجد تنبيه أو مانع مسجل في الملف — يجب التحقق سريرياً"}
• **الزيارات والمواعيد:** إجمالي الزيارات المسجلة: ${file.visits?.length || 0} زيارة.`;

    return {
      success: true,
      textSummary: fullSummary,
      cards,
      actions,
      patientIdAccessed: p.id,
      data: { patient: p, balance, plansCount: plans.length },
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `تعذر جلب ملف المريض: ${(err as Error).message}`,
      warnings: [(err as Error).message],
    };
  }
}
