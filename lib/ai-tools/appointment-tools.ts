/**
 * أدوات المواعيد والجدول والزيارات (Appointment AI Tools)
 */

import { listAppointmentsByDate } from "../db";
import { getAppointmentTypeLabel } from "../schedule";
import type { AiToolContext, ToolExecutionResult, KpiCard, StructuredTable, ActionButton } from "./types";

/**
 * أداة جلب جدول مواعيد اليوم أو تاريخ محدد
 */
export async function getTodayAppointments(
  params: { date?: string; doctorId?: number },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  const date = params.date || context.todayISO || new Date().toISOString().slice(0, 10);

  if (!context.isDbConnected) {
    return {
      success: true,
      textSummary: `📅 **جدول مواعيد (${date}):**\n⚠️ خدمة قاعدة البيانات غير متصلة في هذا الوضع التجريبي. عند التشغيل الحي، سيعرض النظام جدول الحضور والمواعيد مباشرة.`,
      cards: [{ title: "مواعيد اليوم", value: "وضع تجريبي", tone: "calm" }],
      actions: [{ label: "فتح جدول المواعيد", href: "/appointments", actionType: "navigate" }],
    };
  }

  try {
    const rawAppointments = await listAppointmentsByDate(date).catch(() => []);
    let appointments = rawAppointments;

    // عزل الطبيب: إذا كان الطبيب لا يملك رؤية جدول بقية الأطباء
    if (context.role === "doctor" && !context.permissions?.canViewAllAppointments && context.doctorPartyId) {
      appointments = appointments.filter((a) => a.doctorId === context.doctorPartyId);
    } else if (params.doctorId) {
      appointments = appointments.filter((a) => a.doctorId === params.doctorId);
    }

    if (appointments.length === 0) {
      return {
        success: true,
        textSummary: `📅 **جدول مواعيد (${date}):**\nلا توجد أي مواعيد مجدولة مسجلة لهذا اليوم${
          context.role === "doctor" ? " في عيادتك" : " في المركز"
        }.`,
        cards: [
          { title: "إجمالي مواعيد اليوم", value: "0", tone: "calm" },
        ],
        actions: [{ label: "حجز موعد جديد", href: "/appointments", actionType: "navigate" }],
      };
    }

    const statusMap: Record<string, string> = {
      booked: "مجدول ⏳",
      arrived: "حضر بالصالة 🚶",
      done: "تم الإجراء ✅",
      cancelled: "ملغي ❌",
      no_show: "لم يحضر ⚠️",
    };

    const bookedCount = appointments.filter((a) => a.status === "booked").length;
    const arrivedCount = appointments.filter((a) => a.status === "arrived").length;
    const doneCount = appointments.filter((a) => a.status === "done").length;

    const cards: KpiCard[] = [
      { title: "إجمالي المواعيد", value: String(appointments.length), tone: "info" },
      { title: "بالانتظار / حضور", value: String(arrivedCount), tone: arrivedCount > 0 ? "warn" : "calm" },
      { title: "تم الإجراء", value: String(doneCount), tone: "good" },
      { title: "قادمة اليوم", value: String(bookedCount), tone: "calm" },
    ];

    const headers = ["الوقت", "المريض", "نوع الموعد", "الطبيب", "الحالة"];
    const rows = appointments.map((a) => [
      a.scheduledTime,
      a.patientName,
      getAppointmentTypeLabel(a.appointmentType) || "كشف/علاج",
      a.doctorName ? `د. ${a.doctorName}` : "—",
      statusMap[a.status] || a.status,
    ]);

    const table: StructuredTable = {
      headers,
      rows,
      caption: `مواعيد تاريخ ${date} (${appointments.length} مريض)`,
    };

    const itemsText = appointments
      .slice(0, 8)
      .map(
        (a, idx) =>
          `${idx + 1}. **${a.scheduledTime}** — **${a.patientName}** (${getAppointmentTypeLabel(a.appointmentType) || "كشف"}) [${
            statusMap[a.status] || a.status
          }]`,
      )
      .join("\n");

    const textSummary = `📅 **جدول مواعيد المركز (${date}):**\nإجمالي المواعيد: **${appointments.length} مريض** (حضر: ${arrivedCount} | قادم: ${bookedCount} | منجز: ${doneCount})\n\n${itemsText}${
      appointments.length > 8 ? `\n... و (${appointments.length - 8}) مواعيد أخرى.` : ""
    }`;

    return {
      success: true,
      textSummary,
      cards,
      table,
      actions: [{ label: "شاشة المواعيد الكاملة", href: "/appointments", actionType: "navigate" }],
      data: appointments,
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `تعذر استعلام المواعيد: ${(err as Error).message}`,
      warnings: [(err as Error).message],
    };
  }
}
