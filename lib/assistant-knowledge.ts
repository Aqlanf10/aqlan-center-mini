/**
 * بنك المعرفة السريري والإداري الذكي لمركز د. عقلان لطب وتقويم الأسنان
 * (Aqlan Center Assistant Knowledge & Live Database Engine)
 *
 * يوفر الوصول الفوري لـ:
 * 1. بيانات أي مريض: الهوية، المديونية والرصيد المالي، المواعيد، الزيارات، التنبيهات الطبية، خطط العلاج.
 * 2. عمليات وإحصائيات المركز الحية: مواعيد اليوم، نواقص المخزون، قائمة الأطباء، أسعار الخدمات، إيرادات اليوم.
 * 3. الدليل الإرشادي التفاعلي لاستخدام جميع شاشات وخصائص البرنامج.
 *
 * يحقق المادة 214 دستوريًا: الذكاء الاصطناعي يقترح ولا يعتمد — القرار النهائي بيد الطبيب والإدارة.
 * ويحقق المادة 202: خصوصية البيانات وعزل صلاحيات الطبيب (Doctor Isolation).
 */

import {
  getPool,
  ensureSchema,
  searchPatients,
  getPatientFile,
  patientLedger,
  asPaymentLikes,
  listAppointmentsByDate,
  listServices,
  listInventoryItems,
  listPatientPlans,
  CLINIC_TIME_ZONE,
  type PatientSummary,
} from "./db";
import {
  patientBalance,
  balanceText,
  formatMoney,
  CLINIC_BASE_CURRENCY,
  type Currency,
} from "./money";
import { clinicDateString, getAppointmentTypeLabel } from "./schedule";
import { CATEGORY_LABEL, DEFAULT_SERVICES } from "./services-catalog";

function isDbAvailable(): boolean {
  return Boolean(
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.USE_LOCAL_DB === "true"
  );
}

export interface AssistantUserContext {
  userRole?: string;
  username?: string;
  doctorPartyId?: number | null;
  canViewAllPatients?: boolean;
  canViewFinancials?: boolean;
}

export interface AssistantQueryResult {
  found: boolean;
  type: "patient" | "clinic_ops" | "system_guide";
  reply: string;
  rawContext?: string; // سياق مهيأ للحقن في النماذج السحابية (RAG)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. استخراج والتعرف على اسم/رقم المريض من نص المستخدم
// ─────────────────────────────────────────────────────────────────────────────

const GENERIC_PATIENT_WORDS = new Set([
  "لديه", "عنده", "عندها", "يعاني", "بعد", "قبل", "القلب", "الضغط", "السكري", "السكر",
  "حامل", "ينزف", "نزف", "طفل", "في", "مع", "بدون", "الخلع", "الجراحة", "العصب",
  "التقويم", "كبير", "صغير", "جديد", "سابق", "طوارئ", "حاد", "مزمن", "خضع", "يخضع",
  "ألم", "وجع", "ورم", "خراج", "نزيف",
]);

/**
 * يستخرج معرف المريض (اسم أو رقم ملف أو هاتف) من نص السؤال
 */
export function extractPatientIdentifier(text: string): string | null {
  const normalized = text.trim();
  const lower = normalized.toLowerCase();

  // استبعاد الاستفسارات السريرية أو شروحات البرنامج العامة التي تستخدم كلمة «مريض» كموضوع عام
  if (
    lower.includes("كيف") ||
    lower.includes("طريقة") ||
    lower.includes("خطوات") ||
    lower.includes("تعليمات") ||
    lower.includes("إرشادات") ||
    lower.includes("رسالة واتساب") ||
    lower.includes("الحد الأقصى") ||
    lower.includes("جرعات") ||
    lower.includes("الجرعة") ||
    lower.includes("المضاد الحيوي") ||
    lower.includes("البديل") ||
    lower.includes("pulpectomy") ||
    lower.includes("dry socket") ||
    lower.includes("avulsion") ||
    lower.includes("بروتوكول")
  ) {
    return null;
  }

  // فحص رقم الملف بنمط P-001 أو P-123
  const fileCodeMatch = normalized.match(/\b[Pp]-?\d+\b/);
  if (fileCodeMatch) return fileCodeMatch[0].toUpperCase();

  // فحص رقم الهاتف اليمني (9 أرقام تبدأ بـ 7 أو مع رمز الدولة 967)
  const phoneMatch = normalized.match(/\b(?:967)?(7\d{8})\b/);
  if (phoneMatch) return phoneMatch[1];

  // أنماط الاستعلام الصريحة: "المريض فلان" / "المريضة فلانة"
  const patientMatch = normalized.match(
    /(?:المريض|المريضة|مريض|مريضة)\s+(?:رقم\s+)?([^\s؟?,،.:!]+(?:\s+[^\s؟?,،.:!]+){0,3})/,
  );
  if (patientMatch && patientMatch[1]) {
    const candidate = cleanStopWords(patientMatch[1]);
    if (candidate.length >= 2) return candidate;
  }

  // أنماط الاستعلام المالي: "حساب فلان" / "كم باقي على فلان" / "رصيد فلان"
  const balanceMatch = normalized.match(
    /(?:كم\s+باقي\s+على|كم\s+رصيد|حساب|رصيد|مديونية|ديون|مستحقات)\s+(?:المريض\s+|المريضة\s+)?([^\s؟?,،.:!]+(?:\s+[^\s؟?,،.:!]+){0,3})/,
  );
  if (balanceMatch && balanceMatch[1]) {
    const candidate = cleanStopWords(balanceMatch[1]);
    if (candidate.length >= 2) return candidate;
  }

  // أنماط الاستعلام عن المواعيد: "موعد فلان" / "متى موعد فلان"
  const aptMatch = normalized.match(
    /(?:متى\s+موعد|موعد|مواعيد|زيارة|زيارات)\s+(?:المريض\s+|المريضة\s+)?([^\s؟?,،.:!]+(?:\s+[^\s؟?,،.:!]+){0,3})/,
  );
  if (aptMatch && aptMatch[1]) {
    const candidate = cleanStopWords(aptMatch[1]);
    if (candidate.length >= 2) return candidate;
  }

  // أنماط استعلام الملف والمعلومات: "ملف فلان" / "معلومات فلان" / "بيانات فلان"
  const infoMatch = normalized.match(
    /(?:ملف|معلومات|بيانات|تفاصيل|سجل|خطة\s+علاج|حساسية|تلفون|هاتف|رقم)\s+(?:المريض\s+|المريضة\s+)?([^\s؟?,،.:!]+(?:\s+[^\s؟?,،.:!]+){0,3})/,
  );
  if (infoMatch && infoMatch[1]) {
    const candidate = cleanStopWords(infoMatch[1]);
    if (candidate.length >= 2) return candidate;
  }

  return null;
}

function cleanStopWords(term: string): string {
  const stopWords = new Set([
    "هو", "هي", "كم", "ما", "هل", "عن", "في", "من", "إلى", "على", "له", "لها",
    "اليوم", "غداً", "أمس", "الآن", "حق", "بتاع", "عنده", "عندها", "جديد", "سابق",
  ]);
  const parts = term.trim().split(/\s+/).filter((p) => !stopWords.has(p));
  if (parts.length > 0 && GENERIC_PATIENT_WORDS.has(parts[0])) {
    return ""; // سياق طبي عام وليس اسم شخص محدد
  }
  return parts.join(" ").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. الاستعلام الذكي الشامل عن أي مريض (Patient Inquiry Engine)
// ─────────────────────────────────────────────────────────────────────────────

export async function resolvePatientInquiry(
  query: string,
  context?: AssistantUserContext,
): Promise<AssistantQueryResult | null> {
  const identifier = extractPatientIdentifier(query);
  if (!identifier) return null;

  if (!isDbAvailable()) {
    return {
      found: true,
      type: "patient",
      reply: `🔍 **استعلام عن المريض «${identifier}»:**
⚠️ خدمة قاعدة البيانات غير متصلة في هذا الوضع. عند التشغيل المباشر للعيادة، سيعرض النظام كامل الملف المالي (الرصيد والمديونية) والمواعيد والتنبيهات الطبية فوراً.`,
    };
  }

  await ensureSchema();
  const doctorPartyId =
    context?.userRole === "doctor" && !context.canViewAllPatients
      ? (context.doctorPartyId ?? -1)
      : null;

  // 1. البحث عن المريض بالاسم أو الهاتف أو رقم الملف
  let matches: PatientSummary[] = [];

  // إذا كان المدخل رقمي صرف
  if (/^\d+$/.test(identifier) && Number(identifier) > 0 && Number(identifier) < 100000) {
    const file = await getPatientFile(Number(identifier)).catch(() => null);
    if (file) {
      matches = [
        {
          id: file.patient.id,
          patientNumber: file.patient.patientNumber,
          fullName: file.patient.fullName,
          phone: file.patient.phone,
          medicalAlert: file.patient.medicalAlert,
        },
      ];
    }
  }

  if (matches.length === 0) {
    matches = await searchPatients(identifier, 6, doctorPartyId).catch(() => []);
  }

  // لم نجد أي مريض
  if (matches.length === 0) {
    return {
      found: false,
      type: "patient",
      reply: `🔍 **استعلام عن مريض:** لم أجد في النظام أي مريض مسجل باسم أو رقم «${identifier}».
- يمكنك تجربة كتابة الاسم الثلاثي أو جزء منه.
- أو البحث برقم الهاتف أو رقم الملف السكني (مثل P-10).`,
    };
  }

  // إذا وجدنا أكثر من مريض ولم يحدد المستخدم واحداً بالضبط
  if (matches.length > 1 && !matches.some((m) => m.fullName.trim() === identifier.trim())) {
    const listText = matches
      .map(
        (m, idx) =>
          `${idx + 1}. **${m.fullName}** — رقم الملف: \`${m.patientNumber}\` — هاتف: \`${m.phone || "غير مسجل"}\`${
            m.medicalAlert ? ` (⚠️ ${m.medicalAlert})` : ""
          }`,
      )
      .join("\n");

    return {
      found: true,
      type: "patient",
      reply: `🔍 **عثرت على (${matches.length}) نتائج تطابق «${identifier}»:**

${listText}

💡 *للإجابة الدقيقة، يرجى كتابة اسم المريض كاملاً أو كتابة رقم ملفه السكني.*`,
    };
  }

  // مطابقة لمريض واحد محدد
  const targetPatient = matches[0];
  const patientId = targetPatient.id;

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);

  const [file, ledger, plans] = await Promise.all([
    getPatientFile(patientId).catch(() => null),
    patientLedger(patientId).catch(() => ({ invoices: [], payments: [], opening: null })),
    listPatientPlans(patientId, today).catch(() => []),
  ]);

  if (!file) {
    return {
      found: false,
      type: "patient",
      reply: `تعذر تحميل ملف المريض «${targetPatient.fullName}».`,
    };
  }

  const p = file.patient;
  const balance = patientBalance(
    ledger.invoices,
    asPaymentLikes(ledger.payments),
    ledger.opening?.amountMinor ?? 0,
  );
  const balText = balanceText(balance, CLINIC_BASE_CURRENCY);

  // تصنيف نية السؤال: هل سأل عن الحساب والمالية؟ أم عن المواعيد؟ أم عن التنبيه الطبي؟
  const isFinanceQuery =
    query.includes("حساب") ||
    query.includes("باقي") ||
    query.includes("رصيد") ||
    query.includes("مديونية") ||
    query.includes("دفع") ||
    query.includes("فلوس");

  const isAppointmentQuery =
    query.includes("موعد") ||
    query.includes("مواعيد") ||
    query.includes("زيارة") ||
    query.includes("متى");

  const isMedicalQuery =
    query.includes("حساسية") ||
    query.includes("ضغط") ||
    query.includes("سكر") ||
    query.includes("طبي") ||
    query.includes("تحذير") ||
    query.includes("مرض");

  // تجهيز ملخص المواعيد
  const upcomingApt = file.appointments.find(
    (a) => a.scheduledDate >= today && a.status !== "cancelled",
  );
  const lastApt = file.appointments.find((a) => a.scheduledDate < today);
  const lastVisit = file.visits[0];

  let aptSummary = "";
  if (upcomingApt) {
    const aptType = getAppointmentTypeLabel(upcomingApt.appointmentType) || "جلسة علاج";
    aptSummary = `📅 **الموعد القادم:** يوم ${upcomingApt.scheduledDate} الساعة ${upcomingApt.scheduledTime} (${aptType})${
      upcomingApt.doctorName ? ` — د. ${upcomingApt.doctorName}` : ""
    }`;
  } else if (lastApt) {
    aptSummary = `📅 **لا يوجد موعد قادم مجدول.** آخر موعد كان بتاريخ ${lastApt.scheduledDate}`;
  } else {
    aptSummary = `📅 **لا توجد مواعيد مجدولة مسجلة للمريض.**`;
  }

  if (lastVisit) {
    aptSummary += `\n🕒 **آخر زيارة حضورية:** ${lastVisit.arrivedAt.slice(0, 10)}${
      lastVisit.note ? ` — (${lastVisit.note})` : ""
    }`;
  }

  // تجهيز ملخص الخطط العلاجية
  const activePlans = plans.filter((pl) => pl.status === "active");
  let planSummary = "";
  if (activePlans.length > 0) {
    planSummary = activePlans
      .map(
        (pl) =>
          `• **${pl.title}**: التكلفة الإجمالية ${formatMoney(
            pl.totalMinor,
            CLINIC_BASE_CURRENCY,
          )} — طريقة السداد: ${pl.installments.length > 0 ? "أقساط مجدولة" : "حسب الجلسات"}`,
      )
      .join("\n");
  } else {
    planSummary = "لا توجد خطة علاج نشطة مسجلة حالياً.";
  }

  // إنشاء الرد الموجه بذكاء
  let headerFocus = "";
  if (isFinanceQuery) {
    headerFocus = `💰 **الوضع المالي والحساب:**
> ### 💳 **${balText}**
• **إجمالي المفوتر:** ${formatMoney(balance.billedMinor, CLINIC_BASE_CURRENCY)}
• **إجمالي المسدد:** ${formatMoney(balance.collectedMinor, CLINIC_BASE_CURRENCY)}
${balance.openingMinor ? `• **رصيد سابق:** ${formatMoney(balance.openingMinor, CLINIC_BASE_CURRENCY)}\n` : ""}• **عدد الفواتير:** ${ledger.invoices.length} فاتورة | **عدد سندات القبض:** ${ledger.payments.length} سند

---`;
  } else if (isAppointmentQuery) {
    headerFocus = `📅 **حالة المواعيد والزيارات:**
> ### ${aptSummary}

---`;
  } else if (isMedicalQuery) {
    headerFocus = `🚨 **الملف الطبي والتنبيهات السريرية:**
> ${p.medicalAlert ? `⚠️ **تنبيه سريري هام:** ${p.medicalAlert}` : "✅ لا توجد تنبيهات طبية أو حساسية مسجلة في ملف المريض."}

---`;
  }

  const fullReply = `👤 **بطاقة المريض: ${p.fullName}**

${headerFocus}
📋 **البيانات الشخصية والاتصال:**
• **رقم الملف السكني:** \`${p.patientNumber}\`
• **رقم الهاتف:** \`${p.phone || "غير مسجل"}\`${p.altPhone ? ` | هاتف بديل: \`${p.altPhone}\`` : ""}
• **الجنس والعمر:** ${p.gender === "female" ? "أنثى" : p.gender === "male" ? "ذكر" : "غير محدد"}${
    p.birthYear ? ` (مواليد ${p.birthYear} — العمر تقريباً ${new Date().getFullYear() - p.birthYear} سنة)` : ""
  }
• **العنوان:** ${p.address || "غير مسجل"}
• **التنبيه الطبي:** ${p.medicalAlert ? `⚠️ **${p.medicalAlert}**` : "سليم (لا توجد موانع مسجلة)"}

💵 **الملخص المالي السريع:**
• **الحساب الحالي:** **${balText}** (المفوتر: ${formatMoney(balance.billedMinor, CLINIC_BASE_CURRENCY)} | المسدد: ${formatMoney(balance.collectedMinor, CLINIC_BASE_CURRENCY)})

🗓️ **المواعيد والزيارات:**
${aptSummary}

🦷 **خطط العلاج والأقساط:**
${planSummary}
${p.note ? `\n📝 **ملاحظة إدارية:** ${p.note}` : ""}`;

  const rawContext = `بيانات المريض من قاعدة بيانات المركز:
الاسم: ${p.fullName} | رقم الملف: ${p.patientNumber} | الهاتف: ${p.phone || "لا يوجد"}
التنبيه الطبي: ${p.medicalAlert || "لا يوجد"}
الرصيد المالي: ${balText} (مفوتر: ${balance.billedMinor} ر.ي، مسدد: ${balance.collectedMinor} ر.ي، متبقي: ${balance.dueMinor} ر.ي)
المواعيد: ${upcomingApt ? `موعد قادم في ${upcomingApt.scheduledDate} ${upcomingApt.scheduledTime}` : "لا يوجد موعد قادم"}
آخر زيارة: ${lastVisit ? lastVisit.arrivedAt : "لا توجد"}`;

  return {
    found: true,
    type: "patient",
    reply: fullReply,
    rawContext,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. الاستعلام عن عمليات وإحصائيات المركز الحية (Live Clinic Operations)
// ─────────────────────────────────────────────────────────────────────────────

export async function resolveClinicOperationsInquiry(
  query: string,
  context?: AssistantUserContext,
): Promise<AssistantQueryResult | null> {
  const norm = query.toLowerCase().trim();

  if (!isDbAvailable()) {
    if (
      norm.includes("سعر") ||
      norm.includes("أسعار") ||
      norm.includes("بكم") ||
      norm.includes("تكلفة") ||
      norm.includes("قائمة الأسعار") ||
      norm.includes("دليل الخدمات")
    ) {
      const items = DEFAULT_SERVICES.slice(0, 15).map((s) => {
        const cat = s.category ? CATEGORY_LABEL[s.category] || s.category : "خدمة عامة";
        return `• **${s.name}** (${cat}): **${formatMoney(s.priceMinor, CLINIC_BASE_CURRENCY)}**`;
      });
      return {
        found: true,
        type: "clinic_ops",
        reply: `🦷 **دليل أسعار الخدمات المعتمدة في مركز د. عقلان:**\n\n${items.join("\n")}\n\n*(الأسعار خاضعة لاعتماد الطبيب المعالج وإدارة المركز).*`,
      };
    }
    return null;
  }

  await ensureSchema();
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const pool = getPool();

  // أ. مواعيد اليوم
  if (
    norm.includes("مواعيد اليوم") ||
    norm.includes("موعد اليوم") ||
    norm.includes("من عنده موعد") ||
    norm.includes("جدول اليوم") ||
    norm.includes("كم موعد اليوم")
  ) {
    const appointments = await listAppointmentsByDate(today).catch(() => []);

    if (appointments.length === 0) {
      return {
        found: true,
        type: "clinic_ops",
        reply: `📅 **جدول مواعيد اليوم (${today}):**
لا توجد أي مواعيد مجدولة مسجلة لهذا اليوم حتى الآن في المركز.`,
        rawContext: `مواعيد اليوم (${today}): لا توجد مواعيد مجدولة.`,
      };
    }

    const items = appointments.map((a, idx) => {
      const typeLabel = getAppointmentTypeLabel(a.appointmentType) || "كشف/علاج";
      const statusMap: Record<string, string> = {
        booked: "مجدول ⏳",
        arrived: "حضر بالصالة 🚶",
        done: "تم الإجراء ✅",
        cancelled: "ملغي ❌",
        no_show: "لم يحضر ⚠️",
      };
      const st = statusMap[a.status] || a.status;
      return `${idx + 1}. **${a.scheduledTime}** — **${a.patientName}** (${typeLabel})${
        a.doctorName ? ` — د. ${a.doctorName}` : ""
      } [${st}]`;
    });

    const reply = `📅 **جدول مواعيد اليوم في المركز (${today}):**
إجمالي المواعيد المجدولة اليوم: **${appointments.length} مريض**

${items.join("\n")}

💡 *يمكنك الاستفسار عن أي مريض باسمه لمعرفة حسابه أو تفاصيل خطة علاجه.*`;

    const rawContext = `مواعيد اليوم (${today}) بإجمالي ${appointments.length} مريض:\n${appointments
      .map((a) => `${a.scheduledTime}: ${a.patientName} (${a.appointmentType || "عام"}) - ${a.status}`)
      .join("\n")}`;

    return { found: true, type: "clinic_ops", reply, rawContext };
  }

  // ب. إحصائيات المركز العامة (عدد المرضى، الزيارات، الأطباء)
  if (
    norm.includes("كم مريض بالمركز") ||
    norm.includes("عدد المرضى") ||
    norm.includes("إحصائيات المركز") ||
    norm.includes("إحصائيات المرضى")
  ) {
    const [patientCountRes, aptCountRes, visitCountRes] = await Promise.all([
      pool.query<{ count: string }>("SELECT COUNT(*)::int as count FROM patients"),
      pool.query<{ count: string }>("SELECT COUNT(*)::int as count FROM appointments"),
      pool.query<{ count: string }>("SELECT COUNT(*)::int as count FROM visits"),
    ]);

    const totalPatients = Number(patientCountRes.rows[0]?.count || 0);
    const totalAppointments = Number(aptCountRes.rows[0]?.count || 0);
    const totalVisits = Number(visitCountRes.rows[0]?.count || 0);

    const reply = `📊 **إحصائيات مركز د. عقلان لطب وجراحة وتقويم الأسنان:**
• **إجمالي المرضى المسجلين في النظام:** **${totalPatients.toLocaleString()} مريض**
• **إجمالي الزيارات السريرية المنفذة:** **${totalVisits.toLocaleString()} زيارة**
• **إجمالي المواعيد المحجوزة تاريخياً:** **${totalAppointments.toLocaleString()} موعد**
• **المنطقة الزمنية المعتمدة للعيادة:** \`${CLINIC_TIME_ZONE}\`
• **العملة الأساسية للنظام المحاسبي:** \`${CLINIC_BASE_CURRENCY}\` (ريال يمني)`;

    return {
      found: true,
      type: "clinic_ops",
      reply,
      rawContext: `إحصائيات المركز: إجمالي المرضى: ${totalPatients}، إجمالي الزيارات: ${totalVisits}، إجمالي المواعيد: ${totalAppointments}.`,
    };
  }

  // ج. نواقص المخزون والمواد التي أوشكت على النفاد
  if (
    norm.includes("المخزون") ||
    norm.includes("نواقص") ||
    norm.includes("حد الطلب") ||
    norm.includes("المواد الناقصة") ||
    norm.includes("نفاد")
  ) {
    const items = await listInventoryItems().catch(() => []);
    const lowStock = items.filter((item) => item.isActive && item.balance <= item.minLevel);

    if (lowStock.length === 0) {
      return {
        found: true,
        type: "clinic_ops",
        reply: `📦 **تقرير نواقص المخزون:**
✅ **جميع المواد والمستهلكات السنية بحالة آمنة وكافية!**
لا توجد أي مادة وصلت إلى حد الطلب الأدنى حالياً من بين (${items.length}) مادة مسجلة في المخزون.`,
      };
    }

    const listText = lowStock
      .map(
        (it, idx) =>
          `${idx + 1}. **${it.name}**: الرصيد الحالي **${it.balance} ${it.unit}** (حد الطلب الأدنى: ${it.minLevel} ${it.unit}) [${
            it.balance <= 0 ? "🚨 نافد بالكامل" : "⚠️ قارب على النفاد"
          }]`,
      )
      .join("\n");

    const reply = `📦 **تنبيه نواقص المخزون والمستلزمات السنية:**
يوجد حالياً **(${lowStock.length}) مواد** بحاجة لإعادة طلب وتوريد عاجل:

${listText}

💡 *يمكن لمدير المركز تسجيل حركة توريد جديدة من شاشة «المخزون» مباشرة.*`;

    return { found: true, type: "clinic_ops", reply };
  }

  // د. أطباء المركز
  if (
    norm.includes("أطباء المركز") ||
    norm.includes("من هم الأطباء") ||
    norm.includes("دكاترة المركز") ||
    norm.includes("طبيب التقويم")
  ) {
    const { rows: doctors } = await pool.query<{
      id: number;
      name: string;
      phone: string | null;
      commission_percent: string;
    }>(
      `SELECT id, name, phone, commission_percent FROM parties WHERE kind = 'doctor' AND is_active = TRUE ORDER BY name`,
    );

    if (doctors.length === 0) {
      return {
        found: true,
        type: "clinic_ops",
        reply: `👨‍⚕️ لا يوجد أطباء مسجلون حالياً في جدول الجهات السريرية بالمركز.`,
      };
    }

    const docList = doctors
      .map(
        (d, idx) =>
          `${idx + 1}. **د. ${d.name}**${d.phone ? ` — هاتف: \`${d.phone}\`` : ""}`,
      )
      .join("\n");

    const reply = `👨‍⚕️ **الكادر الطبي في مركز د. عقلان لطب وتقويم الأسنان:**
إجمالي الأطباء المعتمدين بالمركز: **${doctors.length} أطباء**

${docList}

*(المركز مجهز بأحدث تجهيزات طب وجراحة الفم والأسنان وتقويم الأسنان والفكين).*`;

    return { found: true, type: "clinic_ops", reply };
  }

  // هـ. أسعار الخدمات وقائمة الأسعار
  if (
    norm.includes("سعر") ||
    norm.includes("أسعار") ||
    norm.includes("بكم") ||
    norm.includes("تكلفة") ||
    norm.includes("قائمة الأسعار") ||
    norm.includes("دليل الخدمات")
  ) {
    const services = await listServices(false).catch(() => []);

    // إذا سأل عن إجراء بعينه (تقويم، عصب، حشوة، زراعة، خلع)
    let keyword = "";
    if (norm.includes("تقويم")) keyword = "تقويم";
    else if (norm.includes("عصب") || norm.includes("جذور")) keyword = "عصب";
    else if (norm.includes("حشوة") || norm.includes("حشوات")) keyword = "حشو";
    else if (norm.includes("زراع")) keyword = "زراع";
    else if (norm.includes("خلع") || norm.includes("قلع")) keyword = "خلع";
    else if (norm.includes("تنظيف") || norm.includes("تبييض")) keyword = "تنظيف";
    else if (norm.includes("تركيب") || norm.includes("زيركون") || norm.includes("بورسلان") || norm.includes("تاج"))
      keyword = "تاج";

    let filtered = services;
    if (keyword) {
      filtered = services.filter((s) => s.name.includes(keyword) || (s.category && s.category.includes(keyword)));
    }

    if (filtered.length === 0) filtered = services.slice(0, 15);

    const items = filtered.slice(0, 20).map((s) => {
      const cat = s.category ? CATEGORY_LABEL[s.category] || s.category : "خدمة عامة";
      return `• **${s.name}** (${cat}): **${formatMoney(s.priceMinor, CLINIC_BASE_CURRENCY)}**`;
    });

    const reply = `🦷 **دليل أسعار الخدمات في مركز د. عقلان:**
${keyword ? `نتائج البحث عن «${keyword}»:` : "أبرز الخدمات المعتمدة في دليل المركز:"}

${items.join("\n")}

*(ملاحظة: الأسعار قابلة للتعديل وتطبيق الخصومات وفق موافقة الطبيب المعالج وإدارة المركز).*`;

    return { found: true, type: "clinic_ops", reply };
  }

  // و. الدخل والإيرادات اليومية (لأصحاب الصلاحيات المالية فقط)
  if (
    norm.includes("دخل اليوم") ||
    norm.includes("إيرادات اليوم") ||
    norm.includes("تحصيل اليوم") ||
    norm.includes("صندوق اليوم")
  ) {
    const canViewFinance =
      context?.userRole === "admin" ||
      context?.userRole === "accountant" ||
      Boolean(context?.canViewFinancials);

    if (!canViewFinance) {
      return {
        found: true,
        type: "clinic_ops",
        reply: `🔒 **تنبيه أمني:** الاطلاع على إجمالي الدخل وصندوق المركز يتطلب صلاحية مالية مخصصة (المدير أو المحاسب).`,
      };
    }

    const { rows: payRows } = await pool.query<{
      currency: Currency;
      total_amount: string;
      base_total: string;
      count: string;
    }>(
      `SELECT currency, SUM(amount_minor)::bigint as total_amount,
              SUM(base_amount_minor)::bigint as base_total,
              COUNT(*)::int as count
       FROM payments
       WHERE created_at >= CURRENT_DATE
       GROUP BY currency`,
    );

    const shiftRes = await pool.query<{ id: number; opened_by: string; opened_at: string }>(
      `SELECT id, opened_by, opened_at FROM cashier_shifts WHERE status = 'open' LIMIT 1`,
    );

    let totalBase = 0;
    let totalCount = 0;
    const byCur = payRows.map((r) => {
      totalBase += Number(r.base_total || 0);
      totalCount += Number(r.count || 0);
      return `• ${formatMoney(Number(r.total_amount), r.currency)} (${r.count} سند قبض)`;
    });

    const shiftStatus = shiftRes.rows[0]
      ? `✅ **الوردية الحالية مفتوحة** بواسطة «${shiftRes.rows[0].opened_by}» منذ ${shiftRes.rows[0].opened_at.slice(11, 16)}`
      : `⚠️ لا توجد وردية كاشير مفتوحة حالياً.`;

    const reply = `💵 **تقرير إيرادات وتحصيل اليوم (${today}):**
${shiftStatus}

• **إجمالي التحصيل بما يعادله بالعملة الأساسية:** **${formatMoney(totalBase, CLINIC_BASE_CURRENCY)}**
• **إجمالي السندات المحصلة اليوم:** **${totalCount} عملية دفع**
${byCur.length > 0 ? `\nتفصيل المقبوضات حسب العملة المدفوعة:\n${byCur.join("\n")}` : "\n(لم يتم تحصيل أي دفعات نقدية اليوم حتى الآن)."}`;

    return { found: true, type: "clinic_ops", reply };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. الدليل الإرشادي التفاعلي للبرنامج (System How-To Guide Engine)
// ─────────────────────────────────────────────────────────────────────────────

export function resolveSystemGuideInquiry(query: string): AssistantQueryResult | null {
  const norm = query.toLowerCase().trim();

  // كيف أضيف مريض
  if (norm.includes("كيف أضيف مريض") || norm.includes("إضافة مريض") || norm.includes("تسجيل مريض جديد")) {
    return {
      found: true,
      type: "system_guide",
      reply: `📋 **كيفية إضافة مريض جديد في النظام:**
1. توجه إلى شاشة **«المرضى»** من القائمة الرئيسية.
2. اضغط على زر **«مريض جديد»** (أعلى الصفحة).
3. أدخل البيانات الأساسية:
   - **الاسم الرباعي الكامل**: لضمان عدم تكرار الأسماء وتطابق السجلات.
   - **رقم الهاتف**: (يقبل الصيغة المحلية 7xxxxxxxx أو الدولية).
   - **الجنس وسنة الميلاد**: لحساب الجرعات ومتابعة نمو الفكين والأسنان.
   - **التنبيه الطبي (هام جداً)**: حساسية البنسلين، السكري، الضغط، أمراض القلب، أو الحمل (سيظهر باللون الأحمر في كل شاشات المريض).
4. اضغط **«حفظ المريض»**. سيقوم النظام تلقائياً بتوليد رقم ملف سكني فريد (مثل P-001).`,
    };
  }

  // كيف أعمل فاتورة أو سند قبض
  if (
    norm.includes("كيف أعمل فاتورة") ||
    norm.includes("إنشاء فاتورة") ||
    norm.includes("سند قبض") ||
    norm.includes("تسجيل دفعة")
  ) {
    return {
      found: true,
      type: "system_guide",
      reply: `💳 **كيفية إنشاء فاتورة وسند قبض للمريض:**
### 1. إنشاء الفاتورة:
1. افتح **ملف المريض** ثم انتقل إلى تبويب **«المالية / الفواتير»**.
2. اضغط على **«فاتورة جديدة»**.
3. اختر الإجراءات أو الخدمات المنفذة من **دليل الخدمات** (مثلاً: حشوة ضوئية، علاج عصب، خلع).
4. حدد الطبيب المعالج الذي نفذ البند لحساب عمولته بدقة.
5. أدخل أي خصم معتمد (إن وجد) ثم اضغط **«حفظ واعتماد الفاتورة»**.

### 2. تسجيل سند القبض (الدفعة النقدية):
1. من نفس صفحة الفاتورة أو حساب المريض، اضغط **«سند قبض جديد»**.
2. حدد **المبلغ والعملة** (ريال يمني YER، ريال سعودي SAR، دولار USD).
3. يحفظ النظام سعر الصرف الفعلي لحظة السداد لمنع تغير الحسابات لاحقاً.
4. اضغط **«تسجيل السند»** واطبع إيصال القبض المعتمد للمريض.`,
    };
  }

  // كيف أحجز موعد
  if (norm.includes("كيف أحجز موعد") || norm.includes("حجز موعد") || norm.includes("إضافة موعد")) {
    return {
      found: true,
      type: "system_guide",
      reply: `🗓️ **كيفية حجز موعد جديد في المركز:**
1. انتقل إلى شاشة **«المواعيد»** من الشريط الرئيسي.
2. اختر التاريخ المطلوب من التقويم.
3. اضغط على خانة الوقت المناسبة أو زر **«حجز موعد جديد»**.
4. ابحث عن المريض بالاسم أو رقم الهاتف.
5. حدد:
   - **الطبيب المعالج**.
   - **نوع الإجراء** (كشف، شد تقويم، علاج عصب، جراحة، تنظيف).
   - **المدة المقدرة بالدقائق** (لمنع تداخل المواعيد وتكدس الصالة).
6. اضغط **«تأكيد الحجز»**. يمكنك فوراً إرسال رسالة تذكير للمريض عبر الواتساب.`,
    };
  }

  // المخطط السني الرقمي
  if (norm.includes("مخطط") || norm.includes("chart") || norm.includes("fdi") || norm.includes("رسم الأسنان")) {
    return {
      found: true,
      type: "system_guide",
      reply: `🦷 **المخطط السني الرقمي التفاعلي (FDI Tooth Chart):**
1. ادخل ملف المريض وافتح تبويب **«المخطط السني السريري»**.
2. يمثل المخطط ترقيم الأسنان الدولي للبالغين (11-48) والأسنان اللبنية للأطفال (51-85).
3. اضغط على أي سن لاختيار أسطحه الخمسة (Mesial, Distal, Occlusal, Buccal, Lingual).
4. حدد الحالة السريرية أو الإجراء (حشوة منفذة، نخر نشط، معالجة لبية، تاج مفقود، زراعة).
5. يتم تلوين وتوثيق السن فوراً ويتحول تلقائياً إلى بنود خطة العلاج والفاتورة.`,
    };
  }

  // النسخ الاحتياطي
  if (norm.includes("نسخ احتياطي") || norm.includes("backup") || norm.includes("استعادة")) {
    return {
      found: true,
      type: "system_guide",
      reply: `💾 **النسخ الاحتياطي وحفظ بيانات المركز:**
1. من القائمة الرئيسية، ادخل إلى **«الإعدادات»** ثم تبويب **«النسخ الاحتياطي (Backup)»**.
2. اضغط على **«تنزيل نسخة احتياطية كاملة الآن»**.
3. سيتم تنزيل ملف مضغوط آمن يحوي كافة سجلات المرضى، الفواتير، الصور، والأشعة.
4. يُنصح بحفظ نسخة أسبوعية على قرص خارجي أو سحابة آمنة لحماية بيانات العيادة.`,
    };
  }

  // التقويم والتحليل السيفالومتري في البرنامج
  if (
    norm.includes("سيفالومتري") ||
    norm.includes("cephalometric") ||
    norm.includes("شاشة التقويم") ||
    norm.includes("برنامج التقويم") ||
    norm.includes("رفع صور التقويم") ||
    (norm.includes("كيف") && norm.includes("تقويم"))
  ) {
    return {
      found: true,
      type: "system_guide",
      reply: `📐 **وحدة التحليل السيفالومتري والتقويم (Cephalometric AI):**
1. افتح ملف مريض التقويم وانتقل إلى **«صور وأشعة التقويم»**.
2. ارفع صورة الأشعة الجانبية (Lateral Ceph).
3. يمكنك استخدام المعايرة وتحديد المعالم السيفالومترية القياسية (Sella, Nasion, A-Point, B-Point, Pogonion).
4. يقوم النظام آلياً بحساب:
   - زوايا **SNA, SNB, ANB** لتحديد تصنيف الهيكل العظمي (Class I, II, III).
   - ميل القواطع العلوية والسفلية (U1-SN, IMPA).
   - خط الجمال والنسيج الرخو (Ricketts E-Line).`,
    };
  }

  // ما هي أقسام النظام والصلاحيات
  if (norm.includes("صلاحيات") || norm.includes("أقسام البرنامج") || norm.includes("دليل النظام")) {
    return {
      found: true,
      type: "system_guide",
      reply: `🏢 **دليل أقسام وصلاحيات نظام مركز د. عقلان:**
• **مدير المركز (Admin):** صلاحيات كاملة تشمل إدارة الأطباء، الأرباح، الأسعار، النسخ الاحتياطي، وإعدادات الذكاء الاصطناعي.
• **طبيب الأسنان (Doctor):** يرى مرضاه وحالاته السريرية ومواعيده ومخططه السني، مع عزل تلقائي للمالية العامة ما لم يُمنح صلاحية صريحة.
• **المحاسب (Accountant):** إدارة الفواتير وسندات القبض والصرف، إغلاق ورديات الكاشير، وتقارير الإيرادات.
• **موظف الاستقبال (Receptionist):** تسجيل المرضى، جدولة المواعيد، تنظيم غرفة الانتظار وشاشة الصالة.`,
    };
  }

  return null;
}
