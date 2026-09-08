/**
 * أدوات المساعد الذكي السريرية والتوجيهية المتقدمة (Clinical & Educational AI Action Tools)
 * لمركز الدكتور عقلان الكامل لطب وجراحة وتقويم الأسنان.
 *
 * تشمل:
 * 1. فحص وتوليد الروشتات مع الأمان الدوائي (recommend_prescription)
 * 2. إرشادات وتعليمات ما بعد العمليات السنية والواتساب (generate_post_op_care)
 * 3. الاستعلام الشامل عن أسعار وخدمات المركز الرسمية (get_service_pricing)
 */

import { getPatient, searchPatients, getSettings } from "../db";
import { canAccessPatient } from "../patient-access";
import { evaluatePrescriptionSafety, type DrugInput } from "../medication-safety";
import { POST_OP_TEMPLATES, type PostOpTemplate, detectPostOpTemplateFromText } from "../post-op-care";
import { DEFAULT_SERVICES, CATEGORY_LABEL } from "../services-catalog";
import { formatMoney, isCurrency, type Currency } from "../money";
import { rateFromSettings } from "../settings";
import { toWhatsAppNumber } from "../reminders";
import type { AiToolContext, ToolExecutionResult, KpiCard, ActionButton, StructuredTable } from "./types";


/** مجال بحث المرضى: الطبيب بلا منحٍ عامة يبحث في مرضاه فقط (P0.2). */
function doctorScopeIdFor(context: AiToolContext): number | null {
  if (context.role !== "doctor" && context.userRole !== "doctor") return null;
  if (context.canViewAllPatients || context.permissions?.canViewAllPatients) return null;
  return context.doctorPartyId ?? null;
}

// ─── 1. مساعد السلامة الدوائية — فحصٌ لا اختيار (Medication Safety Assistant) ────
//
// الدستور الحاكم (مراجعة P0 المستقلة): هذا **AI Medication Safety Assistant**
// لا **Autonomous Drug Selector**. الوضع الأساسي: الطبيب يحدد الدواء أو
// الأدوية التي يفكر بها والتشخيص/الاستطباب، ثم المساعد:
//   • يراجع التعارضات مع ملف المريض.
//   • ينبه لنقص البيانات السريرية.
//   • يعرض الاعتبارات السريرية.
//   • لا يعتمد الوصفة ولا يختار نظامًا دوائيًا.
//
// كلمة مثل «خراج/تورم/عدوى» لا تولّد تلقائيًا Amoxicillin+Metronidazole+Ibuprofen
// أو أي regimen ثابت آخر: عند نقص السياق يُعاد «Missing Clinical Context»
// بالبيانات المطلوبة، وعند اكتشاف تعارض لا يُقترح نظامٌ بديل كامل بجرعات —
// يُذكر «صنف بديل محتمل بعد تقييم الطبيب» فقط.
//
// وقاعدة: **«لا تنبيه مسجل ≠ مريض سليم»** — الملف الفارغ ليس إثبات سلامة.

/** البيانات السريرية التي يتطلبها أي فحص دوائي قبل أن يكون له معنى. */
export interface MedicationContextAssessment {
  /** بيانات ناقصة يجهلها المساعد ويطلبها من الطبيب. */
  missing: string[];
  /** اعتبارات خاصة بالحالة المذكورة (لا جرعات). */
  notes: string[];
}

interface PatientLike {
  gender?: string | null;
  birthYear?: number | null;
  medicalAlert?: string | null;
}

const CHILDING_AGE_RANGE = [12, 55];

/** هل المريضة أنثى في سن الإنجاب؟ (بلا سنة ميلاد لا يُعرف — يُطلب). */
function isFemaleOfChildbearingAge(patient: PatientLike | null): boolean | null {
  if (!patient) return null;
  const gender = String(patient.gender ?? "").toLowerCase();
  if (gender !== "female" && gender !== "أنثى" && gender !== "f") return false;
  const year = Number(patient.birthYear);
  if (!Number.isInteger(year) || year <= 1900) return null; /* السن مجهول */
  const age = new Date().getFullYear() - year;
  if (age < CHILDING_AGE_RANGE[0] || age > CHILDING_AGE_RANGE[1]) return false;
  return true;
}

function isPediatric(patient: PatientLike | null): boolean | null {
  if (!patient) return null;
  const year = Number(patient.birthYear);
  if (!Number.isInteger(year) || year <= 1900) return null;
  return new Date().getFullYear() - year <= 14;
}

/** أدوية شائعة تُحسب جرعتها بالوزن (أطفال غالبًا) — تُطلب مع الوزن لا بجرعة ثابتة. */
const WEIGHT_BASED_HINTS = ["amoxicillin", "augmentin", "أوغمنتين", "اموكسيسيلين", "paracetamol", "بنادول", "azithromycin", "زيثروماكس", "suspension", "شراب"];

/**
 * يقيّم اكتمال السياق السريري المطلوب لفحصٍ دوائي سليم.
 * دالة نقية: تُصدَّر للاختبار المباشر (اختبارات Medication CDS / Stewardship).
 */
export function assessMedicationContext(
  params: { condition?: string; requestedDrugs?: string[]; medicalAlert?: string | null },
  patient: PatientLike | null,
): MedicationContextAssessment {
  const missing: string[] = [];
  const notes: string[] = [];

  const condition = (params.condition || "").trim();
  const drugs = params.requestedDrugs ?? [];

  /* العمر/الطفولة */
  const pediatric = isPediatric(patient);
  if (pediatric === null) missing.push("العمر (طفل أم بالغ) — لا يُقيم أي فحص دوائي بدونه");
  else if (pediatric) notes.push("مريض طفل: الجرعات الوزنية هي الأصل — لا جرعة بالغة قبل معرفة الوزن");

  /* الحساسية */
  const alertText = String(params.medicalAlert ?? patient?.medicalAlert ?? "").trim();
  if (!alertText) {
    missing.push("حالة الحساسية الدوائية (لا تنبيه مسجل ≠ لا حساسية — اسأل المريض)");
  }

  /* الحمل/الرضاعة */
  const childbearing = isFemaleOfChildbearingAge(patient);
  if (childbearing === true) {
    const norm = condition.toLowerCase();
    if (!norm.includes("حامل") && !norm.includes("حمل") && !norm.includes("pregnan") && !norm.includes("رضاع") && !norm.includes("lactat")) {
      missing.push("حالة الحمل/الرضاعة (أنثى في سن الإنجاب)");
    }
  } else if (childbearing === null) {
    missing.push("الجنس والعمر (لتقييم الحمل/الرضاعة عند الإناث)");
  }

  /* الكلى/الكبد */
  if (!/كلوي|كلى|كبد|كلوي|كلوية|renal|hepatic|فشل/.test(alertText)) {
    missing.push("مرض/وظيفة الكلى والكبد إن وُجد");
  }

  /* المميعات/النزف */
  if (!/مميع|أسبرين|aspirin|وارفارين|warfarin|نزف|bleeding/.test(alertText)) {
    missing.push("مميعات الدم أو اضطرابات النزف أو تناول الأسبرين/الوارفارين");
  }

  /* الأدوية الحالية والأمراض المزمنة — الملف وحده لا يكفي */
  missing.push("الأدوية الحالية والأمراض المزمنة المهمة (ما لم يكن الملف مكتملًا ومحدّثًا)");

  /* التشخيص/الاستطباب */
  if (!condition) {
    missing.push("التشخيص/الاستطباب المُعتبر لصرف الدواء");
  } else {
    /* علامات تُغير وزن القرار لا تُذكر ضمن regimen جاهز */
    const norm = condition.toLowerCase();
    const infectionSigns = ["خراج", "تورم", "صديد", "انتفاخ", "عدوى", "إنتان", "حمى", "حرارة", "abscess", "infection", "swelling", "pus", "cellulitis"];
    const hasInfection = infectionSigns.some((k) => norm.includes(k));
    if (hasInfection) {
      notes.push("وردت علامات عدوى في الوصف: يلزم بيان الاستطباب المضاداتي (indication) ومدى الانتشار والاشتراك الجهازي والحمى والتوعك وحالة ضبط المصدر (source control) قبل أي قرار مضاد حيوي");
    }
  }

  /* جرعات وزنية بلا وزن */
  if (drugs.length > 0 && pediatric) {
    const lowerJoined = drugs.join(" ").toLowerCase();
    if (WEIGHT_BASED_HINTS.some((h) => lowerJoined.includes(h))) {
      missing.push("الوزن بالكيلوغرام — دواء موصوف جرعته وزنية لمريض طفل بلا وزن مسجل");
    }
  }

  return { missing, notes };
}

export async function recommendPrescriptionAction(
  params: {
    patientName?: string;
    patientId?: number;
    condition?: string;
    requestedDrugs?: string[];
    medicalAlert?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  let patientName = params.patientName || context.currentPatientName || "المريض";
  let medicalAlert: string | null = params.medicalAlert || null;
  let patientId = params.patientId;
  let patient: PatientLike | null = null;

  /* تنبيهٌ يصرّح به الطبيب في نص الحالة (حساسية/حمل/نزف...) هو بياناتٌ مصرّح بها
   * تُدخل الفحص — لا افتراض سلامة من صمت النص. */
  const normCondition = (params.condition || "").toLowerCase();
  if (!medicalAlert && (normCondition.includes("حساسية") || normCondition.includes("ضغط") || normCondition.includes("سكر") || normCondition.includes("حامل") || normCondition.includes("نزف") || normCondition.includes("مميع") || normCondition.includes("كلوي") || normCondition.includes("كبد"))) {
    medicalAlert = params.condition || null;
  }

  if (context.isDbConnected && (patientId || params.patientName || context.currentPatientName)) {
    let p = null;
    if (patientId) {
      p = await getPatient(patientId);
    } else {
      const queryName = params.patientName || context.currentPatientName || "";
      const matches = await searchPatients(queryName.trim(), 1, doctorScopeIdFor(context));
      if (matches[0]) p = await getPatient(matches[0].id);
    }
    /* عزل الطبيب: ملف مريض زملته لا يُقرأ لتوليد اقتراح دوائي باسمه (P0.2). */
    if (p) {
      const session = {
        userId: context.userId ?? 1,
        username: context.username || "anonymous",
        role: (context.role || context.userRole || "doctor") as string,
        expiresAt: Date.now() + 3600_000,
        partyId: context.doctorPartyId ?? undefined,
      };
      const allowed = await canAccessPatient(session, p.id).catch(() => false);
      if (!allowed) {
        return {
          success: false,
          textSummary: "🔒 **تنبيه أمني:** ليس لديك صلاحية للوصول إلى ملف هذا المريض (عزل الكادر السريري).",
          warnings: ["عزل الأطباء: محاولة قراءة ملف مريض غير مسند"],
        };
      }
      patientName = p.fullName;
      if (p.medicalAlert) medicalAlert = p.medicalAlert;
      patientId = p.id;
      patient = { gender: p.gender, birthYear: p.birthYear, medicalAlert: p.medicalAlert };
    }
  }

  /* ── الوضع الأساسي (Stewardship): فحص أدويةٍ اختارها الطبيب ── */
  if (params.requestedDrugs && params.requestedDrugs.length > 0) {
    const drugs: DrugInput[] = params.requestedDrugs
      .filter((d) => typeof d === "string" && d.trim())
      .slice(0, 12)
      .map((d) => ({ name: d.trim(), instructions: "حسب الوصفة التي يكتبها الطبيب" }));

    const assessment = assessMedicationContext(params, patient);

    /* فحص التعارضات مع ملف المريض — تنبيهٌ لا استبدال آلي */
    const safetyAlerts = evaluatePrescriptionSafety(drugs, medicalAlert);
    const safetyCards: KpiCard[] = [];
    let warningMessage = "";

    for (const drug of drugs) {
      const alert = safetyAlerts.find((a) => a.medicationName.toLowerCase() === drug.name.toLowerCase());
      if (alert) {
        safetyCards.push({
          title: `⚠️ تعارض دوائي: ${drug.name}`,
          value: alert.title,
          tone: alert.severity === "critical" ? "bad" : "warn",
        });
        warningMessage += `\n🚨 **${alert.title}**: ${alert.message}`;
        /* صنفٌ بديل بعد تقييم الطبيب — لا نظامٌ بديل كامل بجرعات جاهزة. */
        warningMessage += `\n💡 فكّر في صنف دوائي بديل بعد تقييمك السريري (consider an alternative class after clinician assessment).`;
      }
    }

    const cards: KpiCard[] = [
      { title: "المريض", value: patientName, tone: "info" },
      {
        title: "التنبيهات السريرية",
        value: medicalAlert
          ? medicalAlert
          : "لا تنبيه مسجل — غيابُ التنبيه لا يعني خلوّ المريض من المخاطر: تحقق سريريًا",
        tone: medicalAlert ? "warn" : "calm",
      },
      ...safetyCards,
      ...(assessment.missing.length > 0
        ? [{ title: "بيانات ناقصة", value: `${assessment.missing.length} عناصر`, tone: "warn" as const }]
        : []),
    ];

    let rxText =
      `🧪 **فحص السلامة الدوائية لأدويةٍ حددتَها لـ «${patientName}»**${params.condition ? ` (حالة: ${params.condition})` : ""}:\n\n`;
    rxText += drugs.map((d, idx) => `${idx + 1}. **${d.name}** — يُفحص ضد ملف المريض ولا يُعتمد هنا`).join("\n");

    if (assessment.missing.length > 0) {
      rxText += `\n\n📋 **بيانات سريرية ناقصة يُطلب استكمالها قبل الاعتماد (Missing Clinical Context):**\n`;
      rxText += assessment.missing.map((m) => `• ${m}`).join("\n");
    }
    if (assessment.notes.length > 0) {
      rxText += `\n\n🧭 **اعتبارات سريرية:**\n${assessment.notes.map((n) => `• ${n}`).join("\n")}`;
    }
    if (warningMessage) {
      rxText += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n🛡️ **تحذيرات وتعارضات دوائية (Medication Safety Guard):**${warningMessage}\n`;
    }

    rxText +=
      `\n\n⚖️ **تنبيه دستوري (المادة 214):** المساعد يفحص ولا يعتمد — الوصفة الرسمية تُصدر من نافذة الوصفة في ملف المريض حيث تُحفظ وتُوقّع باسم مُصدرها، ولا تُطبع ولا تُرسل إلا من الوثيقة المحفوظة.`;

    const actions: ActionButton[] = [];
    if (patientId) {
      actions.push({
        label: `فتح ملف ${patientName} لإصدار الوصفة الرسمية`,
        href: `/patients/${patientId}`,
        actionType: "navigate",
      });
    }

    return {
      success: true,
      textSummary: rxText,
      cards,
      actions,
      patientIdAccessed: patientId || undefined,
    };
  }

  /* ── لم يحدد الطبيب أدوية: لا اقتراح نظام دوائي تلقائي أبدًا —
   * لا لكلمة «خراج» ولا «تورم» ولا «عدوى» ولا لأي regimen ثابت آخر.
   * الإجابة: البيانات السريرية المطلوبة (Missing Clinical Context) + كيف
   * يطلب الفحص (يكتب الأدوية التي يفكر فيها). */
  const assessment = assessMedicationContext(params, patient);

  const contextLines = [
    "• العمر (طفل أم بالغ)، والوزن إذا كانت الجرعة وزنية.",
    "• حالة الحساسية الدوائية — لا يُفترض خلوّ المريض منها لمجرد خلوّ ملفه.",
    "• الحمل/الرضاعة عند الإناث في سن الإنجاب.",
    "• مرض ووظيفة الكلى والكبد.",
    "• مميعات الدم واضطرابات النزف.",
    "• الأدوية الحالية والأمراض المزمنة المهمة.",
    "• التشخيص والاستطباب — وللمضادات الحيوية: علامات العدوى ومدى انتشارها والاشتراك الجهازي والحمى وحالة ضبط المصدر.",
  ];

  const textSummary =
    `🧪 **بيانات سريرية ناقصة (Missing Clinical Context) — لا يُقترح نظام دوائي قبلها**\n\n` +
    `المساعد **مساعد سلامة دوائية** لا مُختار أدوية: لا يولّد أسماءً وجرعات علاجية جاهزة لمجرد وصف الحالة (${params.condition ? `«${params.condition}»` : "بلا حالة موصوفة"}).\n\n` +
    `**البيانات المطلوبة:**\n${contextLines.join("\n")}\n\n` +
    (assessment.notes.length > 0
      ? `**اعتبارات خاصة بوصفك:**\n${assessment.notes.map((n) => `• ${n}`).join("\n")}\n\n`
      : "") +
    `**كيف يعمل الفحص:** اكتب الأدوية التي تفكر فيها (مثال: «افحص أمان Augmentin وBrufen لمريض…») فيراجع المساعد تعارضاتها مع ملف المريض وينبه للناقص — ثم تُصدر الوصفة الرسمية من ملف المريض وتبقى الموافقة بيدك.\n\n` +
    `⚖️ المساعد لا يعتمد وصفةً ولا يختار بديلًا بجرعات تلقائيًا؛ وعند تعارضٍ يُذكر «صنف بديل محتمل بعد تقييم الطبيب» لا نظامٌ علاجي جاهز.`;

  const cards: KpiCard[] = [
    { title: "فحص السلامة الدوائية", value: "بانتظار أدوية الطبيب + السياق", tone: "info" },
    ...(medicalAlert
      ? [{ title: "تنبيه مسجل في الملف", value: medicalAlert, tone: "warn" as const }]
      : []),
    { title: "قاعدة السلامة", value: "لا تنبيه مسجل ≠ مريض سليم", tone: "calm" },
  ];

  const actions: ActionButton[] = [];
  if (patientId) {
    actions.push({ label: `فتح ملف ${patientName}`, href: `/patients/${patientId}`, actionType: "navigate" });
  } else if (patientName && patientName !== "المريض") {
    actions.push({ label: `بحث عن ملف ${patientName}`, href: `/patients?q=${encodeURIComponent(patientName)}`, actionType: "navigate" });
  }

  return {
    success: true,
    textSummary,
    cards,
    actions,
    patientIdAccessed: patientId || undefined,
  };
}

// ─── 2. محرك إرشادات وتعليمات ما بعد العمليات السنية ─────────────────────────────

export async function generatePostOpCareAction(
  params: {
    patientName?: string;
    patientId?: number;
    procedureType?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  let patientName = params.patientName || context.currentPatientName || "المريض الكريم";
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

  const template: PostOpTemplate = detectPostOpTemplateFromText(params.procedureType || "");

  const instructionsText =
    `🦷 **${template.icon} ${template.title} ${patientName ? `— المريض: ${patientName} ` : ""}— مركز د. عقلان الكامل**\n\n` +
    `📌 **ملخص العناية:** ${template.summary}\n\n` +
    `⏰ **أول 24 ساعة:**\n` +
    template.first24Hours.map((step) => `• ${step}`).join("\n") +
    `\n\n🥗 **النظام الغذائي:**\n` +
    `• المسموح: ${template.diet.allowed.join("، ")}\n` +
    `• الممنوع: ${template.diet.avoid.join("، ")}\n\n` +
    `🚨 **متى تتواصل فوراً مع المركز؟**\n` +
    template.emergencyWarnings.map((w) => `⚠️ ${w}`).join("\n");

  const cleanPhone = toWhatsAppNumber(patientPhone || "");
  const actions: ActionButton[] = [];

  if (cleanPhone) {
    const waText = `السلام عليكم يا ${patientName}،\n` +
      `إرشادات العناية بعد الإجراء من د. عقلان الكامل:\n\n` +
      `📌 ${template.title}\n\n` +
      template.first24Hours.slice(0, 3).map((s) => `• ${s}`).join("\n") +
      `\n\nنتمنى لكم الشفاء العاجل والسلامة الدائمة. 🌹✨`;
    actions.push({
      label: `📲 إرسال الإرشادات واتساب إلى ${patientName}`,
      href: `https://wa.me/${cleanPhone}?text=${encodeURIComponent(waText)}`,
      actionType: "whatsapp",
    });
  }

  if (patientId) {
    actions.push({ label: `فتح ملف ${patientName}`, href: `/patients/${patientId}`, actionType: "navigate" });
  }

  const cards: KpiCard[] = [
    { title: "نوع الإجراء", value: template.procedureName, tone: "info" },
    { title: "المريض", value: patientName, tone: "good" },
    { title: "حالة الإرسال", value: cleanPhone ? "جاهز للإرسال 📲" : "بلا هاتف مسجل", tone: cleanPhone ? "good" : "warn" },
  ];

  return {
    success: true,
    textSummary: instructionsText,
    cards,
    actions,
    patientIdAccessed: patientId || undefined,
  };
}

// ─── 3. محرك الاستعلام عن دليل الخدمات والأسعار الرسمية ────────────────────────

export async function getServicePricingAction(
  params: {
    query?: string;
    serviceQuery?: string;
    category?: string;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const settings = context.isDbConnected ? await getSettings().catch(() => ({} as any)) : ({} as any);
  const baseCurrency: Currency = isCurrency(settings["finance.base_currency"]) ? settings["finance.base_currency"] : "YER";
  const sarRate = rateFromSettings(settings, "SAR", baseCurrency) ?? 0.0038;
  const usdRate = rateFromSettings(settings, "USD", baseCurrency) ?? 0.0019;

  const rawQ = (params.query || params.serviceQuery || "").trim().toLowerCase();
  let filtered = DEFAULT_SERVICES;

  // استخراج الكلمات المفتاحية الذكية إذا كان الاستعلام يحتوي على جملة استفسارية طويلة
  let searchKeyword = rawQ;
  if (rawQ.includes("زراع") || rawQ.includes("غرس") || rawQ.includes("implant")) searchKeyword = "زراع";
  else if (rawQ.includes("تقويم") || rawQ.includes("ortho") || rawQ.includes("شد")) searchKeyword = "تقويم";
  else if (rawQ.includes("تبييض") || rawQ.includes("bleach") || rawQ.includes("white")) searchKeyword = "تبييض";
  else if (rawQ.includes("عصب") || rawQ.includes("جذور") || rawQ.includes("endo")) searchKeyword = "عصب";
  else if (rawQ.includes("تنظيف") || rawQ.includes("لثة") || rawQ.includes("جير") || rawQ.includes("perio")) searchKeyword = "تنظيف";
  else if (rawQ.includes("حشو") || rawQ.includes("كومبوزيت") || rawQ.includes("كمبوزيت") || rawQ.includes("أمالغم")) searchKeyword = "حشو";
  else if (rawQ.includes("خلع") || rawQ.includes("قلع") || rawQ.includes("جراح")) searchKeyword = "خلع";
  else if (rawQ.includes("تاج") || rawQ.includes("زيركون") || rawQ.includes("زركون") || rawQ.includes("تركيب") || rawQ.includes("crown") || rawQ.includes("جسور") || rawQ.includes("جسر")) searchKeyword = "تاج";
  else if (rawQ.includes("أشعة") || rawQ.includes("اشعة") || rawQ.includes("بانوراما")) searchKeyword = "أشعة";
  else if (rawQ.includes("كشف") || rawQ.includes("استشارة") || rawQ.includes("معاينة")) searchKeyword = "كشف";

  if (params.category) {
    filtered = filtered.filter((s) => s.category?.toLowerCase() === params.category!.toLowerCase());
  }

  if (searchKeyword && !rawQ.includes("كل الخدمات") && !rawQ.includes("قائمة الأسعار كلها") && !rawQ.includes("دليل الأسعار")) {
    const matched = filtered.filter(
      (s) => s.name.toLowerCase().includes(searchKeyword) || (s.category && s.category.toLowerCase().includes(searchKeyword)),
    );
    if (matched.length > 0) {
      filtered = matched;
    }
  }

  if (filtered.length === 0) {
    return {
      success: true,
      textSummary: `لم يتم العثور على خدمات مطابقة للبحث «${params.query || params.category}». تتوفر في المركز خدمات: الكشف، الحشوات، علاج الجذور، التيجان والزيركون، الزراعة، التقويم، والتبييض.`,
      cards: [{ title: "نتائج البحث", value: "0 خدمات", tone: "info" }],
    };
  }

  const rows = filtered.slice(0, 12).map((s) => {
    const yerPrice = formatMoney(s.priceMinor, "YER");
    const sarEst = sarRate ? Math.round(s.priceMinor * sarRate) : null;
    const sarFormatted = sarEst ? `${sarEst.toLocaleString()} ر.س` : "—";
    return [
      s.name,
      CATEGORY_LABEL[s.category || ""] || s.category || "عام",
      yerPrice,
      sarFormatted,
    ];
  });

  const table: StructuredTable = {
    headers: ["الخدمة السنية", "التصنيف", "السعر بالريال اليمني", "تقديري سعودي"],
    rows,
  };

  const cards: KpiCard[] = [
    { title: "الخدمات المطابقة", value: `${filtered.length} خدمات`, tone: "good" },
    { title: "العملة الأساسية", value: baseCurrency, tone: "info" },
  ];

  const actions: ActionButton[] = [
    { label: "فتح شاشة المالية والخدمات", href: "/finance/services", actionType: "navigate" },
    { label: "حجز موعد كشف واستشارة", href: "/appointments", actionType: "navigate" },
  ];

  const textSummary =
    `🦷 **دليل أسعار وخدمات مركز د. عقلان الكامل لطب وجراحة الأسنان:**\n\n` +
    filtered.slice(0, 8).map((s) => `• **${s.name}**: ${formatMoney(s.priceMinor, "YER")} (${CATEGORY_LABEL[s.category || ""] || "خدمة"})`).join("\n") +
    (filtered.length > 8 ? `\n\n... ويوجد ${filtered.length - 8} خدمات إضافية موضحة في الجدول أدناه.` : "") +
    `\n\n💡 الأسعار خاضعة للتقييم السريري الدقيق للطبيب بعد الفحص المباشر والأشعة التشخيصية.`;

  return {
    success: true,
    textSummary,
    table,
    cards,
    actions,
  };
}
