/**
 * سيناريو التحقق الشامل من الأوامر التنفيذية للمساعد الذكي
 * لاختبار قدرة البوت على فهم الأوامر المباشرة باللغة الطبيعية وتنفيذها.
 */

process.env.USE_LOCAL_DB = "true";

import { processAssistantQuery } from "../lib/assistant-engine";
import { executeAiTool, findToolByNameOrAlias } from "../lib/ai-tools/registry";
import type { AiToolContext } from "../lib/ai-tools/types";

const context: AiToolContext = {
  role: "admin",
  userRole: "admin",
  username: "admin",
  isDbConnected: true,
  todayISO: "2026-09-07",
  canViewAllPatients: true,
  canViewClinicFinance: true,
  permissions: {
    canUseAiChat: true,
    canViewAllPatients: true,
  },
};

async function runLiveVerification() {
  console.log("==================================================");
  console.log("  بدء فحص العمليات التنفيذية المباشرة للمساعد الذكي");
  console.log("==================================================\n");

  const testCases = [
    {
      title: "1. إضافة مريض جديد بالاسم والهاتف والتنبيه الطبي",
      query: "أضف مريض جديد باسم أدهم فؤاد الكامل هاتف 779911223 تنبيه طبي حساسية بنسلين",
      expectedWords: ["أدهم فؤاد الكامل", "779911223"],
    },
    {
      title: "2. حجز موعد مباشر للمريض بالوقت والتاريخ",
      query: "احجز موعد للمريض أدهم غداً الساعة 4:30 عصراً كشف عام",
      expectedWords: ["موعد", "أدهم"],
    },
    {
      title: "3. إضافة وتثبيت تنبيه طبي معتمد في ملف المريض",
      query: "سجل تنبيه طبي للمريض أدهم: مريض ضغط وسكر",
      expectedWords: ["التنبيه الطبي", "ضغط وسكر"],
    },
    {
      title: "4. تجهيز رسالة تذكير واتساب رسمية برابط مباشر",
      query: "جهز رسالة تذكير واتساب للمريض أدهم بالموعد",
      expectedWords: ["واتساب", "أدهم"],
    },
    {
      title: "5. إنشاء أمر معمل تركيبات وتحديد اللون والتاريخ",
      query: "أرسل للمعمل طلب تاج زيركون للمريض أدهم لون A2",
      expectedWords: ["معمل", "أدهم", "A2"],
    },
    {
      title: "6. صرف مادة من المخزون الطبي",
      query: "اصرف من المخزون كمية 2 من مادة كمبوزيت",
      expectedWords: ["مخزون"],
    },
  ];

  let passed = 0;
  for (const tc of testCases) {
    console.log(`🔹 [فحص]: ${tc.title}`);
    console.log(`   الطلب: «${tc.query}»`);

    try {
      const response = await processAssistantQuery(tc.query, context);
      console.log(`   الأداة المنفذة: [${response.toolsUsed.join(", ") || response.intent}]`);
      console.log(`   البطاقات: ${response.cards?.map((c) => `${c.title}: ${c.value}`).join(" | ") || "لا يوجد"}`);
      console.log(`   الأزرار التفاعلية: ${response.actions?.map((a) => a.label).join(" | ") || "لا يوجد"}`);

      const hasAllWords = tc.expectedWords.every((w) => response.answer.includes(w));
      if (hasAllWords && response.answer.length > 20) {
        console.log(`   ✅ نجح التنفيذ بنجاح!\n`);
        passed++;
      } else {
        console.log(`   ⚠️ تحقق غير مكتمل في الرد:\n   ${response.answer.slice(0, 150)}...\n`);
      }
    } catch (err) {
      console.error(`   ❌ خطأ أثناء التنفيذ:`, (err as Error).message);
    }
  }

  console.log("==================================================");
  console.log(`  النتيجة النهائية: نجح ${passed} من أصل ${testCases.length} عمليات`);
  console.log("==================================================");

  if (passed < testCases.length) {
    process.exit(1);
  }
}

runLiveVerification().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
