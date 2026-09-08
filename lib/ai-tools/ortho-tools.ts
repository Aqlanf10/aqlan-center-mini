/**
 * أدوات التقويم والمتابعات والتحليل السيفالومتري (Orthodontics AI Tools)
 */

import { orthoFollowupBoard, listPatientCephAnalyses, doctorOwnedPatientIds } from "../db";
import { classifyFollowups, BUCKET_LABEL, type FollowupBucket } from "../ortho-followup";
import { canAccessPatient } from "../patient-access";
import type { SessionPayload } from "../auth";
import type { AiToolContext, ToolExecutionResult, KpiCard, StructuredTable } from "./types";

/**
 * أداة جلب مرضى التقويم المتأخرين عن المتابعة أو بدون موعد قادم
 */
export async function getOrthoFollowupsDue(
  params: { bucket?: string },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  if (!context.isDbConnected) {
    return {
      success: true,
      textSummary: `📐 **متابعات التقويم:**\n⚠️ خدمة قاعدة البيانات غير متصلة في هذا الوضع التجريبي. عند التشغيل الحي، يعرض النظام تصنيف حالات التقويم المتأخرة والشدات المجدولة.`,
      cards: [{ title: "متابعات التقويم", value: "وضع تجريبي", tone: "calm" }],
      actions: [{ label: "فتح لوحة متابعة التقويم", href: "/orthodontics", actionType: "navigate" }],
    };
  }

  try {
    const today = context.todayISO || new Date().toISOString().slice(0, 10);
    let board = await orthoFollowupBoard(today).catch(() => []);

    /* عزل الطبيب (P0.14): اللوحة والتجميعات والأعداد كلها تُحسب بعد التصفية —
       فلا يتسرب للطبيب حتى «عدد» مرضى تقويم زملائه. والمنح العامة وحدها
       (canViewAllPatients) تفتح اللوحة كاملة. */
    if (context.role === "doctor" && !context.canViewAllPatients && !context.permissions?.canViewAllPatients && context.doctorPartyId) {
      const candidateIds = Array.from(new Set(board.map((row) => row.patientId)));
      const owned = await doctorOwnedPatientIds(context.doctorPartyId, candidateIds).catch(() => new Set<number>());
      board = board.filter((row) => owned.has(row.patientId));
    }
    const classified = classifyFollowups({ cases: board, today });
    const userRows = classified;

    const overdueCount = userRows.filter((r) =>
      r.buckets.includes("lapsed_6") || r.buckets.includes("lapsed_8") || r.buckets.includes("overdue"),
    ).length;
    const noAppointmentCount = userRows.filter((r) =>
      r.buckets.includes("no_appointment") || r.buckets.includes("no_show"),
    ).length;
    const todayCount = userRows.filter((r) =>
      r.buckets.includes("this_week") || r.buckets.includes("today"),
    ).length;

    const cards: KpiCard[] = [
      { title: "إجمالي حالات التقويم", value: String(userRows.length), tone: "info" },
      { title: "انقطاع شدّة (>6 أسابيع)", value: String(overdueCount), tone: overdueCount > 0 ? "warn" : "good" },
      { title: "بدون موعد قادم", value: String(noAppointmentCount), tone: noAppointmentCount > 0 ? "warn" : "calm" },
      { title: "مستحقة هذا الأسبوع", value: String(todayCount), tone: "calm" },
    ];

    const targetBucket = params.bucket as FollowupBucket | undefined;
    let filtered = userRows;
    if (targetBucket && targetBucket !== ("all" as any)) {
      filtered = userRows.filter((r) => r.buckets.includes(targetBucket));
    }

    const headers = ["المريض", "الحالة / القائمة", "آخر شدّة", "الموعد القادم"];
    const rows = filtered.slice(0, 10).map((r) => [
      r.patientName,
      r.buckets.map((b) => BUCKET_LABEL[b] || b).join("، ") || "مستقرة",
      r.lastAdjustmentDate || "—",
      r.nextAppointment ? `${r.nextAppointment.date} ${r.nextAppointment.time}` : "بدون موعد",
    ]);

    const table: StructuredTable = {
      headers,
      rows,
      caption: `مرضى التقويم (${filtered.length} حالة مسجلة)`,
    };

    const textSummary = `📐 **تقرير متابعة مرضى التقويم:**
• إجمالي الحالات المسجلة باللوحة: **${userRows.length} مريض تقويم**
• متأخرون عن جلسة الشدة والمتابعة (>6 أسابيع): **${overdueCount} حالة** بحاجة للتواصل والمتابعة
• حالات بدون موعد قادم محجوز: **${noAppointmentCount} حالة**
• مستحقات الشدة هذا الأسبوع: **${todayCount} مريض**`;

    return {
      success: true,
      textSummary,
      cards,
      table,
      actions: [{ label: "فتح لوحة متابعة التقويم", href: "/orthodontics", actionType: "navigate" }],
      data: userRows,
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `تعذر جلب تقرير متابعة التقويم: ${(err as Error).message}`,
      warnings: [(err as Error).message],
    };
  }
}

/**
 * أداة استعلام التحليل السيفالومتري لمريض محدد
 */
export async function getCephalometricSummary(
  params: { patientId: number },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const patientId = Number(params.patientId);
  if (!patientId || patientId <= 0) {
    return { success: false, textSummary: "رقم المريض غير صالح." };
  }

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
      textSummary: "🔒 **تنبيه أمني:** ليس لديك صلاحية للوصول إلى تحليلات هذا المريض.",
    };
  }

  if (!context.isDbConnected) {
    return {
      success: true,
      textSummary: `📐 **تحليل سيفالومتري للمريض #${patientId}:**\n⚠️ خدمة قاعدة البيانات غير متصلة في هذا الوضع.`,
    };
  }

  try {
    const analyses = await listPatientCephAnalyses(patientId).catch(() => []);
    if (analyses.length === 0) {
      return {
        success: true,
        textSummary: `📐 لم يتم تسجيل أي تحليل سيفالومتري رقمي سابق في ملف هذا المريض حتى الآن.`,
        actions: [
          { label: "إجراء تحليل سيفالومتري جديد", href: `/patients/${patientId}/ceph`, actionType: "navigate" },
        ],
      };
    }

    const latest = analyses[0];
    const cards: KpiCard[] = [
      { title: "حالة التحليل", value: latest.status === "completed" ? "معتمد" : "مسودة", tone: latest.status === "completed" ? "good" : "info" },
      { title: "المرحلة السريرية", value: latest.phase || "تشخيص أولي", tone: "calm" },
    ];

    const findings = (latest as any).findings || {};
    const textSummary = `📐 **آخر تحليل سيفالومتري مسجل للمريض #${patientId}:**
• **الحالة:** ${latest.status === "completed" ? "معتمد ومختوم" : "مسودة عمل"} (المرحلة: ${latest.phase || "تشخيص أولي"})
${findings.anb != null ? `• **زاوية ANB:** ${findings.anb}° (العلاقة الهيكلية بين الفكين)` : ""}
${findings.fma != null ? `• **زاوية FMA:** ${findings.fma}° (النمط العمودي)` : ""}
${findings.wits != null ? `• **قياس WITS:** ${findings.wits} مم` : ""}`;

    return {
      success: true,
      textSummary,
      cards,
      actions: [
        { label: "عرض التحليل السيفالومتري الكامل", href: `/patients/${patientId}/ceph`, actionType: "navigate" },
      ],
      patientIdAccessed: patientId,
      data: latest,
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `تعذر جلب التحليل السيفالومتري: ${(err as Error).message}`,
    };
  }
}
