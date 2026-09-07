/**
 * أدوات المعامل والتركيبات السنية (Lab AI Tools)
 */

import { listLabOrders } from "../db";
import type { LabOrder } from "../lab";
import type { AiToolContext, ToolExecutionResult, KpiCard, StructuredTable, ActionButton } from "./types";

/**
 * أداة جلب أوامر وحالات معمل الأسنان المعلقة وقيد الإنجاز
 */
export async function getLabCases(
  params: { status?: string; doctorId?: number },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  if (!context.isDbConnected) {
    return {
      success: true,
      textSummary: `🦷 **أوامر المعمل:**\n⚠️ خدمة قاعدة البيانات غير متصلة في هذا الوضع التجريبي. عند التشغيل الحي، سيعرض النظام حالات التركيبات وقيد الإنجاز بالمعمل.`,
      cards: [{ title: "أعمال المعمل", value: "وضع تجريبي", tone: "calm" }],
      actions: [{ label: "فتح شاشة المعمل", href: "/lab", actionType: "navigate" }],
    };
  }

  try {
    let doctorId = params.doctorId;
    if (context.role === "doctor" && !context.canViewAllPatients && context.doctorPartyId) {
      doctorId = context.doctorPartyId;
    }

    const orders: LabOrder[] = await listLabOrders({
      status: params.status || "active",
      doctorId,
      limit: 30,
    }).catch(() => []);

    const statusMap: Record<string, string> = {
      needed: "مطلوبة 📝",
      sent: "أُرسلت للمعمل 🚚",
      in_progress: "قيد التصنيع ⚙️",
      received: "وصلت العيادة 📦",
      delivered: "رُكِّبت للمريض ✅",
      remake: "إعادة تصنيع 🔄",
      cancelled: "ملغية ❌",
    };

    const inProgressCount = orders.filter((o) => o.status === "in_progress" || o.status === "sent").length;
    const receivedCount = orders.filter((o) => o.status === "received").length;
    const neededCount = orders.filter((o) => o.status === "needed").length;

    const cards: KpiCard[] = [
      { title: "إجمالي أوامر المعمل", value: String(orders.length), tone: "info" },
      { title: "قيد التصنيع بالمعمل", value: String(inProgressCount), tone: inProgressCount > 0 ? "warn" : "calm" },
      { title: "وصلت وجاهزة للتركيب", value: String(receivedCount), tone: receivedCount > 0 ? "good" : "calm" },
      { title: "بانتظار الإرسال", value: String(neededCount), tone: neededCount > 0 ? "warn" : "calm" },
    ];

    if (orders.length === 0) {
      return {
        success: true,
        textSummary: `🦷 **أعمال وطلبات المعمل:**\nلا توجد أي طلبات معملية مفتوحة أو معلقة حالياً${
          context.role === "doctor" ? " في عيادتك" : " في المركز"
        }.`,
        cards,
        actions: [{ label: "طلب معمل جديد", href: "/lab", actionType: "navigate" }],
      };
    }

    const headers = ["المريض", "العمل / التركيبة", "المعمل", "اللون (Shade)", "تاريخ التسليم", "الحالة"];
    const rows = orders.slice(0, 10).map((o) => [
      o.patientName,
      o.serviceName || o.workType,
      o.labName || "معمل المركز",
      o.shade || "غير محدد",
      o.dueDate || "—",
      statusMap[o.status] || o.status,
    ]);

    const table: StructuredTable = {
      headers,
      rows,
      caption: `أوامر المعمل المفتوحة (${orders.length} طلب)`,
    };

    const itemsText = orders.slice(0, 6).map(
      (o, idx) => `${idx + 1}. **${o.patientName}** — ${o.serviceName || o.workType} (معمل: ${o.labName || "عام"})${
        o.shade ? ` [لون: ${o.shade}]` : ""
      } — تسليم: ${o.dueDate || "غير محدد"} [${statusMap[o.status] || o.status}]`,
    ).join("\n");

    const textSummary = `🦷 **تقرير أوامر معمل الأسنان والتركيبات:**
• إجمالي الطلبات المفتوحة: **${orders.length} طلب**
• قيد التصنيع والمتابعة: **${inProgressCount} حالة**
• وصلت للعيادة وجاهزة للتركيب: **${receivedCount} حالة**

${itemsText}${orders.length > 6 ? `\n... و (${orders.length - 6}) طلبات أخرى.` : ""}`;

    return {
      success: true,
      textSummary,
      cards,
      table,
      actions: [{ label: "شاشة المعمل الكاملة", href: "/lab", actionType: "navigate" }],
      data: orders,
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `تعذر جلب أوامر المعمل: ${(err as Error).message}`,
      warnings: [(err as Error).message],
    };
  }
}
