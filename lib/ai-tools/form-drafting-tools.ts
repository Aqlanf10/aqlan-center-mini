/**
 * محرك تعبئة وصياغة النماذج الطبية والتشغيلية والاتفاقيات السريرية
 * (Smart Clinical Form-Filling & Document Drafting Engine)
 * لمركز الدكتور عقلان الكامل لطب وجراحة وتقويم الأسنان.
 *
 * يوفر المساعدة الذكية الفورية في:
 * 1. إقرارات الموافقة الطبية المستنيرة (draft_consent_form)
 * 2. خطط العلاج واتفاقيات الأقساط (draft_treatment_plan_form)
 * 3. نماذج مواصفات وأوامر المعمل السني (draft_lab_order_form)
 * 4. استمارة السيرة المرضية والفحص الأولي (draft_patient_intake_form)
 * 5. التقارير والشهادات الطبية الرسمية (draft_medical_report_form)
 */

import { getPatient, searchPatients, getSettings } from "../db";
import { CONSENT_TEMPLATES, getConsentTemplate, type ConsentTemplate } from "../consent-templates";
import { buildInstallmentPlanAgreement, STANDARD_PLAN_TERMS, type Installment } from "../plans";
import { parseMedicalAlerts } from "../patient";
import { formatMoney, type Currency, isCurrency } from "../money";
import { toWhatsAppNumber } from "../reminders";
import type { AiToolContext, ToolExecutionResult, KpiCard, ActionButton, StructuredTable } from "./types";

// ─── 1. صياغة وتعبئة إقرار الموافقة الطبية المستنيرة ─────────────────────────


/** مجال بحث المرضى: الطبيب بلا منحٍ عامة يبحث في مرضاه فقط (P0.2). */
function doctorScopeIdFor(context: AiToolContext): number | null {
  if (context.role !== "doctor" && context.userRole !== "doctor") return null;
  if (context.canViewAllPatients || context.permissions?.canViewAllPatients) return null;
  return context.doctorPartyId ?? null;
}

export async function draftConsentFormAction(
  params: {
    patientName?: string;
    patientId?: number;
    procedureType?: string;
    toothNumber?: string | number;
    customRisks?: string[];
    notes?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  let patientName = params.patientName || context.currentPatientName || "المريض";
  let patientPhone: string | null = null;
  let patientId = params.patientId;
  let medicalAlert: string | null = null;

  if (context.isDbConnected && (patientId || params.patientName || context.currentPatientName)) {
    let p = null;
    if (patientId) {
      p = await getPatient(patientId);
    } else {
      const q = params.patientName || context.currentPatientName || "";
      const matches = await searchPatients(q.trim(), 1, doctorScopeIdFor(context));
      if (matches[0]) p = await getPatient(matches[0].id);
    }
    if (p) {
      patientName = p.fullName;
      patientPhone = p.phone;
      patientId = p.id;
      medicalAlert = p.medicalAlert;
    }
  }

  // كشف القالب الأنسب
  const proc = (params.procedureType || "").toLowerCase();
  let template: ConsentTemplate = CONSENT_TEMPLATES[0];

  if (proc.includes("زرع") || proc.includes("زراع") || proc.includes("غرس") || proc.includes("implant")) {
    template = getConsentTemplate("dental_implant") || template;
  } else if (proc.includes("عصب") || proc.includes("جذور") || proc.includes("endo") || proc.includes("لب")) {
    template = getConsentTemplate("root_canal") || template;
  } else if (proc.includes("تقويم") || proc.includes("ortho") || proc.includes("شد")) {
    template = getConsentTemplate("orthodontics") || template;
  } else if (proc.includes("تبييض") || proc.includes("bleach")) {
    template = getConsentTemplate("teeth_whitening") || template;
  } else if (proc.includes("خلع") || proc.includes("عقل") || proc.includes("جراح")) {
    template = getConsentTemplate("surgical_extraction") || template;
  }

  const toothStr = params.toothNumber ? ` (السن / المنطقة: ${params.toothNumber})` : "";
  const dateStr = context.todayISO || new Date().toISOString().slice(0, 10);

  const documentText =
    `📄 **${template.icon} ${template.title} — مركز د. عقلان الكامل**\n\n` +
    `👤 **بيانات المريض والإجراء المقترح:**\n` +
    `• **اسم المريض:** ${patientName}\n` +
    `• **الإجراء الطبي:** ${template.procedureName}${toothStr}\n` +
    `• **التاريخ:** ${dateStr}\n` +
    `• **الحالة والتنبيهات الصحية:** ${medicalAlert || "لا يوجد تنبيه أو مانع مسجل في الملف — يجب التحقق سريريًا قبل اعتماد الإجراء"}\n\n` +
    `📜 **صيغة الإقرار والموافقة المستنيرة:**\n` +
    `${template.summary}\n\n` +
    `⚖️ **البنود والتعهدات القانونية والطبية:**\n` +
    template.terms.map((t, idx) => `${idx + 1}. ${t}`).join("\n") +
    `\n\n⚠️ **المخاطر والمضاعفات المحتملة التي تم توضيحها للمريض:**\n` +
    template.risks.map((r) => `• ${r}`).join("\n") +
    (params.customRisks && params.customRisks.length > 0 ? "\n" + params.customRisks.map((cr) => `• [ملاحظة سريرية إضافية]: ${cr}`).join("\n") : "") +
    `\n\n🩺 **التزامات المريض بعد المعالجة:**\n` +
    template.postOpInstructions.map((i) => `✓ ${i}`).join("\n") +
    `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `✍️ **منطقة الاعتماد والتوقيع:**\n` +
    `• **توقيع المريض (أو ولي الأمر):** ......................................\n` +
    `• **اسم وتوقيع الطبيب المعالج:** د. عقلان الكامل (أو الطبيب المشرف)\n` +
    `• **خاتم المركز الرسمي:** مركز د. عقلان لطب وجراحة وتقويم الأسنان\n\n` +
    `💡 *أُعدّ هذا الإقرار آليًا كمسودة أولية للمراجعة — تحقّق الطبيب سريريًا من الحالة والتنبيهات وأكمل ما يلزم قبل التوقيع والاعتماد النهائي.*`;

  const cards: KpiCard[] = [
    { title: "نوع الإقرار", value: template.procedureName, tone: "info" },
    { title: "المريض", value: patientName, tone: "good" },
    { title: "جاهزية النموذج", value: "جاهز للطباعة والتوقيع ✍️", tone: "good" },
  ];

  const actions: ActionButton[] = [];
  actions.push({
    label: `🖨️ طباعة إقرار ${template.procedureName}`,
    href: `/print/consent/${patientId || 0}?template=${template.id}`,
    actionType: "print",
  });

  if (patientId) {
    actions.push({
      label: `فتح ملف ${patientName}`,
      href: `/patients/${patientId}`,
      actionType: "navigate",
    });
  }

  const cleanPhone = toWhatsAppNumber(patientPhone || "");
  if (cleanPhone) {
    const waText = `السلام عليكم يا ${patientName}،\n` +
      `مرفق لكم نموذج الإقرار الطبي المستنير لإجراء (${template.procedureName}) بمركز د. عقلان الكامل للاطلاع عليه قبل موعدكم:\n` +
      `📌 ${template.title}\n\n` +
      `نتمنى لكم دوام الصحة والعافية 🦷✨`;
    actions.push({
      label: `📲 إرسال إشعار الإقرار واتساب إلى ${patientName}`,
      href: `https://wa.me/${cleanPhone}?text=${encodeURIComponent(waText)}`,
      actionType: "whatsapp",
    });
  }

  return {
    success: true,
    textSummary: documentText,
    cards,
    actions,
    patientIdAccessed: patientId || undefined,
  };
}

// ─── 2. صياغة وتعبئة خطة العلاج واتفاقية الأقساط الشهرية ───────────────────────

export async function draftTreatmentPlanFormAction(
  params: {
    patientName?: string;
    patientId?: number;
    planTitle?: string;
    totalCost?: number;
    downPayment?: number;
    installmentsCount?: number;
    currency?: Currency;
    stages?: string[];
    note?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  let patientName = params.patientName || context.currentPatientName || "المريض";
  let patientPhone: string | null = null;
  let patientId = params.patientId;

  if (context.isDbConnected && (patientId || params.patientName || context.currentPatientName)) {
    let p = null;
    if (patientId) {
      p = await getPatient(patientId);
    } else {
      const q = params.patientName || context.currentPatientName || "";
      const matches = await searchPatients(q.trim(), 1, doctorScopeIdFor(context));
      if (matches[0]) p = await getPatient(matches[0].id);
    }
    if (p) {
      patientName = p.fullName;
      patientPhone = p.phone;
      patientId = p.id;
    }
  }

  /* مراجعة الجولة الثانية (Blocker C): وثيقةٌ مالية تخصّ مريضًا لا تُختلق
     أرقامها — لا «300000» افتراضية ولا دفعة مقدّمة «30%» إذا لم يدخلها
     المستخدم. المدخل المالي الناقص ⇒ Missing Financial Inputs: مسودة بلا
     أرقام مالية تطلب ما نقص، لا قيمة مخترقة مكان المجهول. */
  const hasTotalCost =
    typeof params.totalCost === "number" && !isNaN(params.totalCost) && params.totalCost > 0;
  const hasDownPayment =
    typeof params.downPayment === "number" && !isNaN(params.downPayment) && params.downPayment >= 0;
  const hasInstallmentsCount =
    typeof params.installmentsCount === "number" && !isNaN(params.installmentsCount) && params.installmentsCount >= 1;
  const rawCurr = params.currency as string | undefined;
  const currency: Currency = (rawCurr === "USD" || rawCurr === "SAR" || rawCurr === "YER") ? rawCurr : "YER";
  const planTitle = params.planTitle || "خطة علاج وتقويم متكاملة";

  const defaultStages = params.stages || [
    "المرحلة الأولى: الفحص الشامل، تنظيف وتجهيز الأسنان، أخذ الطبعات والصور التشخيصية",
    "المرحلة الثانية: تركيب الأجهزة / بدء المعالجة الأساسية والشد الأولي",
    "المرحلة الثالثة: جلسات المتابعة الدورية الشهرية وتعديل المحاذاة",
    "المرحلة الرابعة: إزالة الأجهزة وتثبيت النتيجة بتركيب المثبت النهائي (Retainer)",
  ];

  if (!(hasTotalCost && hasDownPayment && hasInstallmentsCount)) {
    /* القيم الناقصة تُطلب صراحة — والقيمة المجهولة تبقى مجهولة. */
    const missing: string[] = [];
    if (!hasTotalCost) missing.push("إجمالي تكلفة الخطة (totalCost) بالعملة");
    if (!hasDownPayment) missing.push("الدفعة المقدّمة (downPayment) — اكتب 0 إن لم توجد");
    if (!hasInstallmentsCount) missing.push("عدد الأقساط (installmentsCount)");

    const missingText =
      `📑 **مسودة خطة علاج — مفقودات مالية (Missing Financial Inputs)**\n\n` +
      `👤 **المريض:** ${patientName}\n` +
      `🦷 **عنوان الخطة:** ${planTitle}\n\n` +
      `⚠️ **لم تُحدّد القيم المالية بعد — لا تُستخدم قيم افتراضية في وثيقة مالية تخصّ مريضًا:**\n` +
      missing.map((m) => `• ${m}`).join("\n") +
      `\n\nأرسل القيم الناقصة لإكمال المسودة (مثال: «بمبلغ 400 ألف، دفعة أولى 100 ألف، على 4 أقساط»).\n\n` +
      `🛠️ **إطار مراحل المعالجة (يُراجع ويعتمد سريريًا):**\n` +
      defaultStages.map((st, i) => `${i + 1}. ${st}`).join("\n") +
      `\n\n💰 **الإجمالي والدفعة وجدول الأقساط:** غير محددة — بانتظار إدخال القيم المتفق عليها.\n\n` +
      `⚖️ **الشروط السريرية والمالية:**\n` +
      STANDARD_PLAN_TERMS.map((term) => `✓ ${term}`).join("\n") +
      `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `✍️ مسودة أولية لا تُطبَع كاتفاقية رسمية قبل اعتماد الأرقام وحفظ الخطة.`;

    return {
      success: true,
      textSummary: missingText,
      cards: [
        { title: "المريض", value: patientName, tone: "info" },
        { title: "عنوان الخطة", value: planTitle, tone: "info" },
        { title: "الحالة المالية", value: `مفقودات مالية (${missing.length}) — لا أرقام مخترقة`, tone: "bad" },
      ],
      actions: [
        /* Draft غير محفوظ بلا أرقام ⇒ لا Official Print: زرّ فتح شاشة
           الإنشاء/المراجعة فقط؛ الطباعة الرسمية لخطةٍ محفوظةٍ بمعرّفها من
           شاشة الخطط نفسها (مراجعة الجولة الثانية — Blocker C). */
        { label: "فتح شاشة إنشاء/مراجعة الخطة", href: patientId ? `/patients/${patientId}/plans` : "/finance/plans", actionType: "navigate" },
      ],
      warnings: [
        `قيم مالية ناقصة (${missing.join("، ")}) — لم تُستخدم أي قيمة افتراضية (لا 300000 ولا 30%)، ولم تُعرض أرقام مالية للمريض.`,
      ],
      patientIdAccessed: patientId || undefined,
    };
  }

  const totalCost = params.totalCost as number;
  const downPayment = params.downPayment as number;
  const numInstallments = params.installmentsCount as number;
  // حساب الأقساط وتواريخها
  const installments: Installment[] = [];
  const baseDate = new Date();
  
  if (downPayment > 0 && numInstallments > 1) {
    // القسط الأول: الدفعة المقدمة
    installments.push({
      number: 1,
      dueDate: baseDate.toISOString().slice(0, 10),
      amountMinor: downPayment,
    });

    // بقية الأقساط موزعة شهرياً
    const remaining = totalCost - downPayment;
    const monthlyAmount = Math.round(remaining / (numInstallments - 1));

    for (let i = 2; i <= numInstallments; i++) {
      const d = new Date(baseDate);
      d.setMonth(d.getMonth() + (i - 1));
      installments.push({
        number: i,
        dueDate: d.toISOString().slice(0, 10),
        amountMinor: i === numInstallments ? (remaining - (monthlyAmount * (numInstallments - 2))) : monthlyAmount,
      });
    }
  } else {
    // توزيع متساوٍ
    const singleAmount = Math.round(totalCost / numInstallments);
    for (let i = 1; i <= numInstallments; i++) {
      const d = new Date(baseDate);
      d.setMonth(d.getMonth() + (i - 1));
      installments.push({
        number: i,
        dueDate: d.toISOString().slice(0, 10),
        amountMinor: i === numInstallments ? (totalCost - (singleAmount * (numInstallments - 1))) : singleAmount,
      });
    }
  }

  // بناء اتفاقية الأقساط المعتمدة بالنظام
  const agreement = buildInstallmentPlanAgreement({
    planId: 0,
    patientName,
    patientPhone: patientPhone || "",
    planTitle,
    totalMinor: totalCost,
    baseCurrency: currency,
    startDate: baseDate.toISOString().slice(0, 10),
    note: params.note || "تم إعداد الخطة بناءً على الفحص السريري المبدئي والأشعة التشخيصية",
    installments,
    paidMinor: downPayment > 0 ? downPayment : 0,
  });

  const planText =
    `📑 **عقد واتفاقية خطة العلاج وجدول الأقساط — مركز د. عقلان الكامل**\n\n` +
    `👤 **المريض:** ${patientName}\n` +
    `🦷 **عنوان الخطة:** ${planTitle}\n` +
    `💰 **إجمالي التكلفة:** ${formatMoney(totalCost, currency)}\n` +
    `💵 **الدفعة الأولى المبدئية:** ${formatMoney(downPayment, currency)}\n` +
    `📅 **عدد الدفعات والأقساط:** ${numInstallments} دفعات موزعة شهرياً\n\n` +
    `🛠️ **مراحل المعالجة السريرية المبرمجة:**\n` +
    defaultStages.map((st, i) => `${i + 1}. ${st}`).join("\n") +
    `\n\n📅 **جدول الدفعات والأقساط الشهرية:**\n` +
    agreement.installments.map((inst) => `• **القسط #${inst.number}:** ${formatMoney(inst.amountMinor, currency)} — تاريخ الاستحقاق: ${inst.dueDate} (${inst.paid ? "✅ مسدد" : "⏳ مستحق"})`).join("\n") +
    `\n\n⚖️ **الشروط والأحكام السريرية والمالية:**\n` +
    STANDARD_PLAN_TERMS.map((term) => `✓ ${term}`).join("\n") +
    `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `✍️ **التوقيع والاعتماد:**\n` +
    `• توقيع المريض: .......................................   • توقيع المدير الطبي: د. عقلان الكامل`;

  const rows = agreement.installments.map((inst) => [
    `قسط #${inst.number}`,
    inst.dueDate,
    formatMoney(inst.amountMinor, currency),
    inst.paid ? "مسدد ✅" : "مستحق ⏳",
  ]);

  const table: StructuredTable = {
    headers: ["رقم الدفعة", "تاريخ الاستحقاق", "المبلغ المقدر", "حالة السداد"],
    rows,
  };

  const cards: KpiCard[] = [
    { title: "إجمالي الخطة", value: formatMoney(totalCost, currency), tone: "info" },
    { title: "الدفعة الأولى", value: formatMoney(downPayment, currency), tone: "good" },
    { title: "عدد الأقساط", value: `${numInstallments} أقساط`, tone: "info" },
  ];

  const actions: ActionButton[] = [
    /* مراجعة الجولة الثانية (Blocker C): لا طباعة اتفاقية رسمية من مسودة غير
     * محفوظة — كان الرابط يفتح /print/plan/${patientId} بينما الصفحة تتوقع
     * معرّف الخطة المحفوظة (planId) لا معرّف المريض. الرسمية تُطبع لخطةٍ
     * محفوظةٍ بمعرّفها من شاشة الخطط نفسها؛ هنا زرّ فتح الشاشة فقط. */
    { label: "فتح شاشة إنشاء/مراجعة الخطة", href: patientId ? `/patients/${patientId}/plans` : "/finance/plans", actionType: "navigate" },
  ];

  const cleanPhone = toWhatsAppNumber(patientPhone || "");
  if (cleanPhone) {
    const waText = `السلام عليكم يا ${patientName}،\n` +
      `تفاصيل خطة علاج (${planTitle}) قيد الإعداد لك في مركز د. عقلان الكامل:\n\n` +
      `💰 إجمالي الخطة: ${formatMoney(totalCost, currency)}\n` +
      `📅 عدد الأقساط: ${numInstallments} أقساط شهرية\n` +
      `💵 الدفعة المقدمة: ${formatMoney(downPayment, currency)}\n\n` +
      `تفاصيل الاتفاقية النهائية تُسلّم بعد اعتمادها وتوقيعها في المركز.\n\n` +
      `نتمنى لكم ابتسامة وصحة دائمة 🦷💐`;
    actions.push({
      label: `📲 إرسال جدول الأقساط واتساب إلى ${patientName}`,
      href: `https://wa.me/${cleanPhone}?text=${encodeURIComponent(waText)}`,
      actionType: "whatsapp",
    });
  }

  return {
    success: true,
    textSummary: planText,
    table,
    cards,
    actions,
    patientIdAccessed: patientId || undefined,
  };
}

// ─── 3. صياغة وتعبئة نموذج أمر ومواصفات المعمل السني ─────────────────────────

export async function draftLabOrderFormAction(
  params: {
    patientName?: string;
    patientId?: number;
    toothCode?: string;
    restorationType?: string;
    shade?: string;
    labName?: string;
    targetDate?: string;
    specialInstructions?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  let patientName = params.patientName || context.currentPatientName || "المريض";
  let patientId = params.patientId;

  if (context.isDbConnected && (patientId || params.patientName || context.currentPatientName)) {
    let p = null;
    if (patientId) {
      p = await getPatient(patientId);
    } else {
      const q = params.patientName || context.currentPatientName || "";
      const matches = await searchPatients(q.trim(), 1, doctorScopeIdFor(context));
      if (matches[0]) p = await getPatient(matches[0].id);
    }
    if (p) {
      patientName = p.fullName;
      patientId = p.id;
    }
  }

  const toothCode = params.toothCode || "السن المرفق بالطبعة";
  const restorationType = params.restorationType || "تاج زركونيا كامل التشريح (Full Contour Zirconia)";
  const shade = params.shade || "A2";
  const labName = params.labName || "مختبر النخبة السني الرقمي";
  const targetDate = params.targetDate || new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const instructions = params.specialInstructions || "إغلاق نقاط الاتصال المجاورة بدقة مع مراعاة الإطباق وعدم رفع العضة السنية.";

  const labText =
    `🔬 **نموذج أمر ومواصفات عمل المختبر السني — مركز د. عقلان الكامل**\n\n` +
    `👤 **المريض:** ${patientName}\n` +
    `🏢 **المختبر الموجه إليه:** ${labName}\n` +
    `🦷 **السن / المنطقة:** ${toothCode}\n` +
    `💎 **نوع التعويض والخامة:** ${restorationType}\n` +
    `🎨 **اللون المختار (VITA Shade):** ${shade}\n` +
    `📅 **تاريخ الاستلام المطلوب:** ${targetDate}\n` +
    `📝 **تعليمات فنية خاصة للطبي والمخبري:** ${instructions}\n\n` +
    `📋 **مواصفات الجودة والتشريح الفني المطلوبة:**\n` +
    `1. تفريغ الحواف اللثوية (Margins) بدقة لمنع تجمع البلاك والتهاب اللثة.\n` +
    `2. شفافية طبيعية في الثلث القاطع (Incisal Translucency) مطابقة للأسنان المجاورة.\n` +
    `3. صقل وتلميع نهائي عالي الجودة ومقاوم للتصبغات.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `✍️ **توقيع الطبيب الآمر:** د. عقلان الكامل`;

  const rows = [
    ["المريض", patientName],
    ["المختبر", labName],
    ["السن المستهدف", toothCode],
    ["نوع التركيبة", restorationType],
    ["درجة اللون", shade],
    ["موعد التسليم", targetDate],
  ];

  const table: StructuredTable = {
    headers: ["البند الفني", "المواصفة المعتمدة"],
    rows,
  };

  const cards: KpiCard[] = [
    { title: "نوع التركيبة", value: restorationType, tone: "info" },
    { title: "السن", value: toothCode, tone: "good" },
    { title: "اللون", value: shade, tone: "good" },
    { title: "المختبر", value: labName, tone: "info" },
  ];

  const actions: ActionButton[] = [
    { label: "🖨️ طباعة أمر عمل المعمل", href: `/print/lab/${patientId || 0}`, actionType: "print" },
    { label: "فتح شاشة المعمل", href: "/lab", actionType: "navigate" },
  ];

  return {
    success: true,
    textSummary: labText,
    table,
    cards,
    actions,
    patientIdAccessed: patientId || undefined,
  };
}

// ─── 4. صياغة وتعبئة استمارة السيرة المرضية والفحص الأولي ─────────────────────

export async function draftPatientIntakeFormAction(
  params: {
    fullName?: string;
    phone?: string;
    gender?: string;
    birthYear?: number;
    chiefComplaint?: string;
    medicalHistory?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const name = params.fullName || "مريض جديد";
  const phone = params.phone || "—";
  const gender = params.gender === "female" ? "أنثى" : "ذكر";
  const birthYear = params.birthYear ? `${params.birthYear}` : "غير محدد";
  const complaint = params.chiefComplaint || "فحص دوري ومعاينة عامة لآلام الأسنان";
  const historyText = params.medicalHistory || "لا توجد أمراض مزمنة مصرح بها";

  // استخراج شارات التنبيه الطبي
  const { badges } = parseMedicalAlerts(historyText);
  const isHighRisk = badges.some((b) => b.severity === "high");

  const intakeText =
    `📋 **استمارة الفحص الأولي والسيرة المرضية (Intake Form) — مركز د. عقلان الكامل**\n\n` +
    `👤 **البيانات الشخصية للمريض:**\n` +
    `• **الاسم الكامل:** ${name}\n` +
    `• **رقم الهاتف:** ${phone}\n` +
    `• **الجنس:** ${gender}\n` +
    `• **سنة الميلاد:** ${birthYear}\n\n` +
    `🦷 **الشكوى السريرية الرئيسية (Chief Complaint):**\n` +
    `«${complaint}»\n\n` +
    `🩺 **السيرة المرضية والمخاطر الطبية:**\n` +
    `• **المعلومات المصرح بها:** ${historyText}\n` +
    (badges.length > 0
      ? `• **المحددات والمخاطر السريرية المرصودة:**\n` +
        badges.map((b) => `  ⚠️ ${b.icon} **${b.label}** (${b.severity === "high" ? "درجة خطورة عالية" : "متوسط"})`).join("\n")
      : `• **التقييم الأولي:** لا توجد تنبيهات مصرّح بها — التحقق السريري قبل المعالجة لازم ولا يُستغنى عنه.\n`) +
    `\n💡 *تم تصنيف الاستمارة وتجهيزها للحفظ الفوري في قاعدة بيانات المركز السريرية.*`;

  const cards: KpiCard[] = [
    { title: "المريض", value: name, tone: "info" },
    { title: "درجة الخطورة الطبية", value: isHighRisk ? "تنبيه سريري حرج ⚠️" : "مستقرة وطبيعية ✅", tone: isHighRisk ? "bad" : "good" },
    { title: "التنبيهات المرصودة", value: `${badges.length} تنبيهات`, tone: badges.length > 0 ? "warn" : "calm" },
  ];

  const actions: ActionButton[] = [
    {
      label: `➕ تسجيل ${name} رسمياً بالمركز`,
      href: `/patients?action=create&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`,
      actionType: "navigate",
    },
  ];

  return {
    success: true,
    textSummary: intakeText,
    cards,
    actions,
  };
}

// ─── 5. صياغة وتعبئة نموذج التقرير الطبي والشهادة السريرية ────────────────────

export async function draftMedicalReportFormAction(
  params: {
    patientName?: string;
    patientId?: number;
    diagnosis?: string;
    treatmentProvided?: string;
    recommendations?: string;
    sickLeaveDays?: number;
    addressedTo?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  let patientName = params.patientName || context.currentPatientName || "المريض";
  let patientPhone: string | null = null;
  let patientId = params.patientId;

  if (context.isDbConnected && (patientId || params.patientName || context.currentPatientName)) {
    let p = null;
    if (patientId) {
      p = await getPatient(patientId);
    } else {
      const q = params.patientName || context.currentPatientName || "";
      const matches = await searchPatients(q.trim(), 1, doctorScopeIdFor(context));
      if (matches[0]) p = await getPatient(matches[0].id);
    }
    if (p) {
      patientName = p.fullName;
      patientPhone = p.phone;
      patientId = p.id;
    }
  }

  const addressedTo = params.addressedTo || "إلى من يهمه الأمر / الجهة المختصة";
  const diagnosis = params.diagnosis || "التهاب لبي حاد وتسوس عميق مع خراج سني موضعي";
  const treatment = params.treatmentProvided || "إجراء معالجة لبية كاملة مع استئصال العصب وتطهير القنوات وحشوها نهائياً مع حشوة بناء تجميلية";
  const sickLeave = params.sickLeaveDays ? `يُمنح المريض راحة مرضية لمدة (${params.sickLeaveDays}) أيام ابتداءً من تاريخه للتعافي والراحة.` : "";
  const recommendations = params.recommendations || "المواظبة على العناية الفموية، تجنب الإجهاد والضغوط على السن المعالج، وتناول الأدوية الموصوفة بانتظام.";
  const reportDate = context.todayISO || new Date().toISOString().slice(0, 10);

  const reportText =
    `🏥 **تقرير طبي سني رسمي (Official Dental Medical Report)**\n` +
    `**مركز الدكتور عقلان الكامل لطب وجراحة وتقويم الأسنان**\n\n` +
    `📌 **الموجه إليه:** ${addressedTo}\n` +
    `📅 **التاريخ:** ${reportDate}\n\n` +
    `يفيد مركز الدكتور عقلان الكامل بأن الأخ/الأخت: **«${patientName}»** قد راجع/ت المركز وخضع/ت للفحص السريري والشعاعي الدقيق، وتبين الآتي:\n\n` +
    `🩺 **التشخيص السريري (Clinical Diagnosis):**\n` +
    `• ${diagnosis}\n\n` +
    `🦷 **الإجراءات والعلاجات السنية المنفذة (Procedures Performed):**\n` +
    `• ${treatment}\n\n` +
    `💡 **التوصيات الطبية والتعليمات السريرية (Recommendations):**\n` +
    `• ${recommendations}\n` +
    (sickLeave ? `• 🛌 **الإجازة المرضية المقررة:** ${sickLeave}\n` : "") +
    `\nأُعطي هذا التقرير بناءً على طلب المريض لتقديمه للجهة المعنية دون أي مسؤولية على المركز تجاه الغير.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `👨‍⚕️ **الطبيب المعالج:** د. عقلان الكامل\n` +
    `ختم المركز والاعتماد: مركز د. عقلان لطب وتقويم الأسنان 🦷✨`;

  const cards: KpiCard[] = [
    { title: "المريض", value: patientName, tone: "info" },
    { title: "التشخيص", value: diagnosis.slice(0, 30) + "...", tone: "good" },
    { title: "حالة التقرير", value: "جاهز للطباعة والختم 🖨️", tone: "good" },
  ];

  const actions: ActionButton[] = [
    { label: "🖨️ طباعة التقرير الطبي", href: `/print/report?patientId=${patientId || 0}`, actionType: "print" },
  ];

  if (patientId) {
    actions.push({ label: `فتح ملف ${patientName}`, href: `/patients/${patientId}`, actionType: "navigate" });
  }

  const cleanPhone = toWhatsAppNumber(patientPhone || "");
  if (cleanPhone) {
    const waText = `السلام عليكم يا ${patientName}،\n` +
      `نسخة من التقرير الطبي الصادر لكم من مركز د. عقلان الكامل:\n\n` +
      `🩺 التشخيص: ${diagnosis}\n` +
      `🦷 العلاج: ${treatment}\n\n` +
      `مع تمنياتنا لكم بالسلامة التامة 🌹`;
    actions.push({
      label: `📲 إرسال التقرير واتساب إلى ${patientName}`,
      href: `https://wa.me/${cleanPhone}?text=${encodeURIComponent(waText)}`,
      actionType: "whatsapp",
    });
  }

  return {
    success: true,
    textSummary: reportText,
    cards,
    actions,
    patientIdAccessed: patientId || undefined,
  };
}
