/**
 * أدوات المخزون والمستلزمات الطبية (Inventory AI Tools)
 */

import { listInventoryItems, type InventoryItem } from "../db";
import type { AiToolContext, ToolExecutionResult, KpiCard, StructuredTable, ActionButton } from "./types";

/**
 * أداة جلب حالة المخزون ونواقص المواد السنية
 */
export async function getInventorySummary(
  params: { onlyLowStock?: boolean },
  context: AiToolContext,
): Promise<ToolExecutionResult> {
  if (!context.isDbConnected) {
    return {
      success: true,
      textSummary: `📦 **تقرير المخزون:**\n⚠️ خدمة قاعدة البيانات غير متصلة في هذا الوضع التجريبي. عند التشغيل الحي، سيعرض النظام رصيد المواد ونواقص حد الطلب.`,
      cards: [{ title: "المخزون", value: "وضع تجريبي", tone: "calm" }],
      actions: [{ label: "فتح شاشة المخزون", href: "/inventory", actionType: "navigate" }],
    };
  }

  try {
    const items: InventoryItem[] = await listInventoryItems().catch(() => []);
    const activeItems = items.filter((it) => it.isActive);
    const lowStock = activeItems.filter((it) => it.balance <= it.minLevel);
    const outOfStock = activeItems.filter((it) => it.balance <= 0);

    const cards: KpiCard[] = [
      { title: "إجمالي المواد المسجلة", value: String(activeItems.length), tone: "info" },
      { title: "مواد وصلت حد الطلب", value: String(lowStock.length), tone: lowStock.length > 0 ? "warn" : "good" },
      { title: "مواد نافدة تماماً", value: String(outOfStock.length), tone: outOfStock.length > 0 ? "bad" : "good" },
    ];

    if (params.onlyLowStock || lowStock.length > 0) {
      const headers = ["المادة", "الرصيد الحالي", "حد الطلب الأدنى", "الوحدة", "الحالة"];
      const rows = lowStock.map((it) => [
        it.name,
        it.balance,
        it.minLevel,
        it.unit,
        it.balance <= 0 ? "🚨 نافد" : "⚠️ قارب على النفاد",
      ]);

      const table: StructuredTable = {
        headers,
        rows,
        caption: `المواد السنية التي وصلت لحد الطلب الأدنى (${lowStock.length} مادة)`,
      };

      const itemsList = lowStock.slice(0, 8).map(
        (it, idx) => `${idx + 1}. **${it.name}**: الرصيد **${it.balance} ${it.unit}** (حد الطلب: ${it.minLevel} ${it.unit}) [${
          it.balance <= 0 ? "🚨 نافد بالكامل" : "⚠️ قارب على النفاد"
        }]`,
      ).join("\n");

      const textSummary = `📦 **تنبيه نواقص المخزون والمستلزمات الطبية:**
يوجد حالياً **(${lowStock.length}) مادة** بحاجة لتوريد وإعادة طلب عاجل:

${itemsList}${lowStock.length > 8 ? `\n... و (${lowStock.length - 8}) مواد أخرى.` : ""}`;

      return {
        success: true,
        textSummary,
        cards,
        table,
        actions: [{ label: "تسجيل حركة توريد", href: "/inventory", actionType: "navigate" }],
        data: { activeCount: activeItems.length, lowStock },
      };
    }

    return {
      success: true,
      textSummary: `📦 **تقرير المخزون والمستهلكات السنية:**
✅ **جميع المواد والمستهلكات بحالة آمنة وكافية!**
لا توجد أي مادة وصلت لحد الطلب الأدنى حالياً من بين (${activeItems.length}) مادة مسجلة في النظام.`,
      cards,
      actions: [{ label: "شاشة المخزون", href: "/inventory", actionType: "navigate" }],
      data: { activeCount: activeItems.length, lowStockCount: 0 },
    };
  } catch (err) {
    return {
      success: false,
      textSummary: `تعذر جلب تقرير المخزون: ${(err as Error).message}`,
      warnings: [(err as Error).message],
    };
  }
}
