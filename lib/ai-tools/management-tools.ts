/**
 * أدوات الإدارة والخدمات والعيادة (Management AI Tools)
 */

import { listParties, listServices, getPool, CLINIC_TIME_ZONE } from "../db";
import { formatMoney, CLINIC_BASE_CURRENCY } from "../money";
import { CATEGORY_LABEL, DEFAULT_SERVICES } from "../services-catalog";
import type { AiToolContext, ToolExecutionResult, KpiCard, StructuredTable, ActionButton } from "./types";

/**
 * أداة جلب قائمة الأطباء في المركز
 */
export async function getDoctors(context: AiToolContext): Promise<ToolExecutionResult> {
  if (!context.isDbConnected) {
    return {
      success: true,
      textSummary: `👨‍⚕️ **كادر أطباء مركز د. عقلان:**\n• **د. عقلان** (استشاري طب وجراحة وتقويم الأسنان)\n*(المركز مجهز بأحدث تجهيزات طب الأسنان الرقمية).*`,
      cards: [{ title: "الكادر الطبي", value: "جاهز", tone: "good" }],
    };
  }

  try {
    const doctors = await listParties("doctor").catch(() => []);
    const cards: KpiCard[] = [
      { title: "إجمالي الأطباء المعتمدين", value: String(doctors.length), tone: "info" },
    ];

    const listText = doctors.map(
      (d, idx) => `${idx + 1}. **د. ${d.name}**${d.phone ? ` (هاتف: \`${d.phone}\`)` : ""}`,
    ).join("\n");

    const textSummary = `👨‍⚕️ **الكادر الطبي المعتمد في مركز د. عقلان لطب وتقويم الأسنان:**
إجمالي الأطباء: **${doctors.length} أطباء**

${listText}`;

    return {
      success: true,
      textSummary,
      cards,
      data: doctors,
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `تعذر جلب قائمة الأطباء: ${(err as Error).message}`,
    };
  }
}

/**
 * أداة جلب دليل وأسعار الخدمات السنية
 */
export async function getServicePrices(
  params: { keyword?: string; category?: string },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  let services = DEFAULT_SERVICES;

  if (context.isDbConnected) {
    try {
      const dbServices = await listServices(false).catch(() => []);
      if (dbServices.length > 0) {
        services = dbServices;
      }
    } catch {
      // fallback to DEFAULT_SERVICES
    }
  }

  let filtered = services;
  const kw = params.keyword?.toLowerCase().trim();
  if (kw) {
    filtered = filtered.filter(
      (s) => s.name.toLowerCase().includes(kw) || (s.category && s.category.toLowerCase().includes(kw)),
    );
  }
  if (params.category) {
    filtered = filtered.filter((s) => s.category === params.category);
  }

  if (filtered.length === 0) {
    filtered = services.slice(0, 15);
  }

  const items = filtered.slice(0, 15).map((s) => {
    const cat = s.category ? CATEGORY_LABEL[s.category] || s.category : "عام";
    return `• **${s.name}** (${cat}): **${formatMoney(s.priceMinor, CLINIC_BASE_CURRENCY)}**`;
  });

  const cards: KpiCard[] = [
    { title: "العملة المعتمدة", value: CLINIC_BASE_CURRENCY, tone: "info" },
    { title: "الخدمات المعروضة", value: String(filtered.length), tone: "calm" },
  ];

  const headers = ["الخدمة", "التصنيف", "السعر المعتمد"];
  const rows = filtered.slice(0, 10).map((s) => [
    s.name,
    s.category ? CATEGORY_LABEL[s.category] || s.category : "عام",
    formatMoney(s.priceMinor, CLINIC_BASE_CURRENCY),
  ]);

  const table: StructuredTable = {
    headers,
    rows,
    caption: kw ? `نتائج البحث عن «${kw}»` : "أبرز خدمات المركز",
  };

  const textSummary = `🦷 **دليل أسعار الخدمات في مركز د. عقلان:**
${kw ? `نتائج البحث عن «${kw}»:` : "أبرز الخدمات المعتمدة في دليل المركز:"}

${items.join("\n")}

*(ملاحظة: الأسعار قابلة للتعديل وتطبيق الخصومات وفق اعتماد الطبيب وإدارة المركز).*`;

  return {
    success: true,
    textSummary,
    cards,
    table,
    actions: [{ label: "شاشة دليل الخدمات", href: "/settings/services", actionType: "navigate" }],
    data: filtered,
  };
}

/**
 * أداة إحصائيات المركز العامة (المرضى، الزيارات، المواعيد)
 */
export async function getClinicStatistics(context: AiToolContext): Promise<ToolExecutionResult> {
  if (!context.isDbConnected) {
    return {
      success: true,
      textSummary: `📊 **إحصائيات مركز د. عقلان:**
• المنطقة الزمنية: \`${CLINIC_TIME_ZONE}\`
• العملة الأساسية: \`${CLINIC_BASE_CURRENCY}\` (ريال يمني)
⚠️ خدمة قاعدة البيانات غير متصلة في هذا الوضع لعرض الأرقام التراكمية الحية.`,
      cards: [
        { title: "المنطقة الزمنية", value: CLINIC_TIME_ZONE, tone: "info" },
        { title: "العملة الأساسية", value: CLINIC_BASE_CURRENCY, tone: "info" },
      ],
    };
  }

  try {
    const pool = getPool();
    /* عزل الطبيب (P0.14): الإحصاءات التجميعية تُحسب بعد تطبيق مجال الطبيب —
       لا يتسرب عدد مرضى المركز كله لطبيبٍ بلا منحٍ عامة. */
    const doctorScope =
      context.role === "doctor" && !context.canViewAllPatients && !context.permissions?.canViewAllPatients && context.doctorPartyId
        ? context.doctorPartyId
        : null;

    const scopedFrom = doctorScope
      ? `FROM patients WHERE EXISTS (
           SELECT 1 FROM treatment_plans t WHERE t.patient_id = patients.id AND t.primary_doctor_id = $1 AND t.status = 'active'
           UNION ALL
           SELECT 1 FROM visits v WHERE v.patient_id = patients.id AND v.doctor_id = $1
           UNION ALL
           SELECT 1 FROM planned_visits pv WHERE pv.patient_id = patients.id AND pv.doctor_id = $1
           UNION ALL
           SELECT 1 FROM patients pd WHERE pd.id = patients.id AND pd.primary_doctor_id = $1
           UNION ALL
           SELECT 1 FROM appointments a WHERE a.patient_id = patients.id AND a.doctor_id = $1
         )`
      : "FROM patients";
    const params = doctorScope ? [doctorScope] : [];
    const [patientCountRes, aptCountRes, visitCountRes] = await Promise.all([
      pool.query<{ count: string }>(`SELECT COUNT(*)::int as count ${scopedFrom}`, params),
      pool.query<{ count: string }>(
        doctorScope
          ? `SELECT COUNT(*)::int as count FROM appointments WHERE patient_id IN (SELECT id ${scopedFrom})`
          : "SELECT COUNT(*)::int as count FROM appointments",
        params,
      ),
      pool.query<{ count: string }>(
        doctorScope
          ? `SELECT COUNT(*)::int as count FROM visits WHERE patient_id IN (SELECT id ${scopedFrom})`
          : "SELECT COUNT(*)::int as count FROM visits",
        params,
      ),
    ]);

    const totalPatients = Number(patientCountRes.rows[0]?.count || 0);
    const totalAppointments = Number(aptCountRes.rows[0]?.count || 0);
    const totalVisits = Number(visitCountRes.rows[0]?.count || 0);

    const cards: KpiCard[] = [
      { title: "إجمالي المرضى", value: totalPatients.toLocaleString(), tone: "good" },
      { title: "إجمالي الزيارات", value: totalVisits.toLocaleString(), tone: "info" },
      { title: "إجمالي المواعيد", value: totalAppointments.toLocaleString(), tone: "calm" },
      { title: "العملة الأساسية", value: CLINIC_BASE_CURRENCY, tone: "info" },
    ];

    const textSummary = `📊 **إحصائيات مركز د. عقلان لطب وتقويم الأسنان:**
• **إجمالي المرضى المسجلين:** **${totalPatients.toLocaleString()} مريض**
• **إجمالي الزيارات المنفذة:** **${totalVisits.toLocaleString()} زيارة سريرية**
• **إجمالي المواعيد المحجوزة:** **${totalAppointments.toLocaleString()} موعد**
• **المنطقة الزمنية المعتمدة:** \`${CLINIC_TIME_ZONE}\`
• **العملة الأساسية:** \`${CLINIC_BASE_CURRENCY}\` (ريال يمني)`;

    return {
      success: true,
      textSummary,
      cards,
      data: { totalPatients, totalAppointments, totalVisits },
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `تعذر جلب إحصائيات المركز: ${(err as Error).message}`,
    };
  }
}
