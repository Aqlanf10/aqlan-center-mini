/**
 * أدوات التقارير والمالية والحسابات (Finance & Report AI Tools)
 *
 * القاعدة المعمارية الحاكمة:
 * لا نعيد بناء التقارير إطلاقاً. ترتبط هذه الأدوات مباشرة بمحرك التقارير المعتمد `buildReport()`
 * في `lib/reports.ts` وتستخدم نفس الفلاتر والقواعد المحاسبية الدقيقة.
 */

import { buildReport, parseFilters, dbTodayISO } from "../reports";
import type { ReportFilters, ReportResult, PeriodPreset, DebtMode, CurrencyFilter } from "../reports-types";
import { formatMoney, CLINIC_BASE_CURRENCY, type Currency } from "../money";
import type { AiToolContext, ToolExecutionResult, KpiCard, StructuredTable, ActionButton } from "./types";
import { getPool, ensureSchema } from "../db";

/**
 * الأداة الموحدة الشاملة لتوليد أي تقرير من النظام باللغة الطبيعية
 */
export async function generateInternalReport(
  params: {
    reportType: "daily" | "monthly" | "annual" | "debt" | "aging" | "specialty" | "doctor" | "collections" | "services" | "patients";
    preset?: PeriodPreset;
    from?: string;
    to?: string;
    specialty?: string;
    doctorId?: number;
    currency?: CurrencyFilter;
    debtMode?: DebtMode;
    compare?: "none" | "prev_period" | "prev_year";
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const role = context.role || context.userRole;

  // فحص الصلاحية
  if (!context.canViewClinicFinance && role !== "admin") {
    // إذا كان طبيباً ويريد تقرير عمولته الشخصية فقط
    if (role === "doctor" && params.reportType === "doctor") {
      params.doctorId = context.doctorPartyId ?? context.userId;
    } else {
      return {
        success: false,
        textSummary: "🔒 **تنبيه أمني:** غير مصرح بالاطلاع على التقارير المالية والإدارية (يتطلب صلاحية الإدارة أو المحاسبة).",
        message: "🔒 **تنبيه أمني:** غير مصرح بالاطلاع على التقارير المالية والإدارية.",
        warnings: ["غير مصرح: محاولة وصول لبيانات مالية بدون صلاحية"],
      };
    }
  }

  if (!context.isDbConnected) {
    const text = `📊 **تقرير ${params.reportType}:**\n⚠️ خدمة قاعدة البيانات غير متصلة حالياً في وضع الاختبار/الاستعراض. عند التشغيل الحي، سيعرض النظام المؤشرات المحاسبية الدقيقة من محرك التقارير.`;
    return {
      success: true,
      textSummary: text,
      message: text,
      cards: [
        { title: "حالة المحرك المحاسبي", value: "جاهز (وضع غير متصل)", tone: "calm" },
      ],
      actions: [
        { label: "فتح مركز التقارير", href: "/reports", actionType: "navigate" },
      ],
      data: { title: `تقرير ${params.reportType}`, kpis: [], rows: [] },
    };
  }

  try {
    const today = await dbTodayISO().catch(() => context.todayISO);
    const searchParams = new URLSearchParams();
    if (params.preset) searchParams.set("preset", params.preset);
    if (params.from) searchParams.set("from", params.from);
    if (params.to) searchParams.set("to", params.to);
    if (params.specialty) searchParams.set("specialty", params.specialty);
    if (params.doctorId) searchParams.set("doctorId", String(params.doctorId));
    if (params.currency) searchParams.set("currency", params.currency);
    if (params.debtMode) searchParams.set("debtMode", params.debtMode);
    if (params.compare) searchParams.set("compare", params.compare);

    const filters: ReportFilters = parseFilters(searchParams, today);
    const result: ReportResult = await buildReport(params.reportType, filters);

    // تحويل مؤشرات التقرير (KPIs) إلى بطاقات جاهزة للعرض
    const cards: KpiCard[] = result.kpis.slice(0, 6).map((kpi) => {
      let val = "";
      if (typeof kpi.minor === "number") {
        val = formatMoney(kpi.minor, kpi.currency || result.baseCurrency);
      } else if (typeof kpi.count === "number") {
        val = kpi.count.toLocaleString();
      } else {
        val = kpi.text || "—";
      }

      return {
        title: kpi.label,
        value: val,
        tone: kpi.tone === "good" ? "good" : kpi.tone === "warn" ? "warn" : kpi.tone === "bad" ? "bad" : "info",
        hint: kpi.hint,
      };
    });

    // تحويل الصفوف إلى جدول مهيكل (أول 10 صفوف)
    let table: StructuredTable | null = null;
    if (result.columns && result.columns.length > 0 && result.rows && result.rows.length > 0) {
      const headers = result.columns.map((c) => c.label);
      const rows = result.rows.slice(0, 10).map((row) =>
        result.columns!.map((col) => {
          const v = row[col.key];
          if (col.type === "money" && typeof v === "number") {
            return formatMoney(v, result.baseCurrency);
          }
          return v !== null && v !== undefined ? String(v) : "—";
        }),
      );

      table = {
        headers,
        rows,
        caption: `نتائج التقرير (${result.rows.length} حركة مسجلة)`,
      };
    }

    const actions: ActionButton[] = [
      { label: "فتح التقرير الكامل", href: `/reports?report=${params.reportType}`, actionType: "navigate" },
      { label: "طباعة التقرير", href: `/print/report/${params.reportType}`, actionType: "print" },
    ];

    const kpiSummary = result.kpis.map((k) => {
      const v = typeof k.minor === "number" ? formatMoney(k.minor, k.currency || result.baseCurrency) : k.count ?? k.text;
      return `• **${k.label}**: **${v}**`;
    }).join("\n");

    const textSummary = `📊 **${result.title}** (${result.periodLabel}):\n\n${kpiSummary}\n\n*المرجع: محرك التقارير المحاسبي لمركز د. عقلان (عملة الأساس: ${result.baseCurrency})*.`;

    return {
      success: true,
      textSummary,
      cards,
      table,
      actions,
      data: result,
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `تعذر إعداد التقرير المطلوب: ${(err as Error).message}`,
      warnings: [(err as Error).message],
    };
  }
}

/**
 * أداة استعلام متحصلات اليوم وصندوق الكاشير
 */
export async function getTodayCollections(
  params: { currency?: CurrencyFilter },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  return generateInternalReport(
    {
      reportType: "collections",
      preset: "today",
      currency: params.currency || "all",
    },
    context,
  );
}

/**
 * أداة استعلام مديونيات المرضى وأعمار الديون
 */
export async function getPatientReceivables(
  params: {
    debtMode?: DebtMode;
    specialty?: string;
    doctorId?: number;
  },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  return generateInternalReport(
    {
      reportType: "debt",
      preset: "this_month",
      debtMode: params.debtMode || "outstanding",
      specialty: params.specialty,
      doctorId: params.doctorId,
    },
    context,
  );
}

/**
 * أداة أعمار الديون (30، 60، 90، 90+ يوم)
 */
export async function getDebtAging(
  params: { specialty?: string; doctorId?: number },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  return generateInternalReport(
    {
      reportType: "aging",
      preset: "this_month",
      specialty: params.specialty,
      doctorId: params.doctorId,
    },
    context,
  );
}

/**
 * أداة استعلام عمولات ومستحقات الأطباء
 */
export async function getDoctorCommissionReport(
  params: { doctorId?: number; preset?: PeriodPreset },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const role = context.role || context.userRole;
  const myPartyId = context.doctorPartyId ?? context.userId;

  // عزل الطبيب: إذا حاول الطبيب استعلام عمولة طبيب آخر يُرفض فوراً
  if (role === "doctor" && params.doctorId && myPartyId && params.doctorId !== myPartyId) {
    return {
      success: false,
      textSummary: "🔒 **تنبيه أمني:** غير مصرح للطبيب بالاطلاع على عمولات أو مستحقات أطباء آخرين.",
      message: "🔒 **تنبيه أمني:** غير مصرح بالاطلاع على عمولة طبيب آخر.",
      warnings: ["غير مصرح: استعلام عمولة طبيب آخر"],
    };
  }

  let targetDocId = params.doctorId;
  if (role === "doctor") {
    targetDocId = myPartyId;
  }

  return generateInternalReport(
    {
      reportType: "doctor",
      preset: params.preset || "this_month",
      doctorId: targetDocId,
    },
    context,
  );
}
