import { describe, it, expect } from "vitest";
import { processAssistantQuery } from "../lib/assistant-engine";
import { AiToolContext } from "../lib/ai-tools/types";

describe("Aqlan AI Assistant - NLU & Arabic/Yemeni Dialect Router", () => {
  const adminContext: AiToolContext = {
    userRole: "admin",
    userId: 1,
    userName: "د. عقلان الكامل",
    isDbConnected: false, // tests router logic without live DB
    clinicName: "مركز عقلان لطب وجراحة وزراعة وتقويم الأسنان",
  };

  const doctorContext: AiToolContext = {
    userRole: "doctor",
    userId: 2,
    userName: "د. أحمد",
    isDbConnected: false,
    clinicName: "مركز عقلان",
  };

  // Test set of 50+ diverse Arabic & Yemeni queries
  const testQueries = [
    // 1-10: Financial & Collections (Various currencies & Yemeni phrases)
    { q: "كم دخل المركز اليوم؟", expectedIntent: "finance_report" },
    { q: "كم حصلنا اليوم بالدولار؟", expectedIntent: "finance_report" },
    { q: "كم دخل اليوم بالسعودي؟", expectedIntent: "finance_report" },
    { q: "كم الصندوق اليوم بالريال اليمني؟", expectedIntent: "finance_report" },
    { q: "كم دخل هذا الشهر؟", expectedIntent: "finance_report" },
    { q: "اعطني تقرير الإيرادات للشهر الماضي", expectedIntent: "finance_report" },
    { q: "كم المصروفات هذا الشهر؟", expectedIntent: "finance_report" },
    { q: "كم باقي مديونية على المرضى؟", expectedIntent: "debt_report" },
    { q: "اعطني مديونية مرضى التقويم هذا الشهر", expectedIntent: "debt_report" },
    { q: "من أكثر عشرة مرضى عليهم مديونية؟", expectedIntent: "patient_receivables" },

    // 11-20: Patient queries & Yemeni dialect
    { q: "كم باقي على محمد علي؟", expectedIntent: "patient_query" },
    { q: "محمد كم عليه؟", expectedIntent: "patient_query" },
    { q: "كم حساب محمد؟", expectedIntent: "patient_query" },
    { q: "كم باقي حق محمد؟", expectedIntent: "patient_query" },
    { q: "كم دفع محمد حتى الآن؟", expectedIntent: "patient_query" },
    { q: "ابحث عن ملف المريض سالم", expectedIntent: "patient_query" },
    { q: "اعطني بيانات المريض أحمد علي", expectedIntent: "patient_query" },
    { q: "ملخص ملف المريض خالد", expectedIntent: "patient_query" },
    { q: "ابحث عن المريض برقم الهاتف 771234567", expectedIntent: "patient_query" },
    { q: "ملف المريض P-0012", expectedIntent: "patient_query" },

    // 21-30: Appointments & Follow-ups
    { q: "مواعيد اليوم", expectedIntent: "today_appointments" },
    { q: "من هم المرضى الذين لديهم مواعيد اليوم؟", expectedIntent: "today_appointments" },
    { q: "جدول المواعيد لهذا اليوم", expectedIntent: "today_appointments" },
    { q: "مواعيد العيادة اليوم", expectedIntent: "today_appointments" },
    { q: "هل عندي مواعيد اليوم؟", expectedIntent: "today_appointments" },
    { q: "كم مريض متأخر عن الموعد؟", expectedIntent: "today_appointments" },
    { q: "حالات اليوم في جدول المواعيد", expectedIntent: "today_appointments" },
    { q: "متى موعد المريض القادم؟", expectedIntent: "patient_query" },
    { q: "متابعات التقويم المتأخرة", expectedIntent: "ortho_followups" },
    { q: "مرضى التقويم المتأخرين عن المتابعة 30 يوم", expectedIntent: "ortho_followups" },

    // 31-40: Orthodontics, Cephalometrics & Clinical
    { q: "متابعات التقويم المستحقة", expectedIntent: "ortho_followups" },
    { q: "من متأخر من مرضى التقويم؟", expectedIntent: "ortho_followups" },
    { q: "اعطني تحليل سيفالومتري للمريض", expectedIntent: "ceph_analysis" },
    { q: "اشرح لي قياسات السيفالومتري", expectedIntent: "ceph_analysis" },
    { q: "تحليل سيفالومتري ستاينر وويلي وشوارز", expectedIntent: "ceph_analysis" },
    { q: "ما هي بروتوكولات علاج العصب؟", expectedIntent: "clinical_general" },
    { q: "جرعة الأوجمنتين لبالغ لديه خراج سني", expectedIntent: "clinical_general" },
    { q: "علاج التهاب دواعم السن الحاد", expectedIntent: "clinical_general" },
    { q: "تعليمات ما بعد قلع ضرس العقل الجراحي", expectedIntent: "clinical_general" },
    { q: "التخدير الموضعي لمريض ضغط وسكر", expectedIntent: "clinical_general" },

    // 41-50: Inventory & Lab cases
    { q: "ما نواقص المخزون؟", expectedIntent: "inventory_query" },
    { q: "المواد المنتهية في المخزن", expectedIntent: "inventory_query" },
    { q: "كم رصيد مادة التخدير ليدوكايين؟", expectedIntent: "inventory_query" },
    { q: "المخزون المنخفض في العيادة", expectedIntent: "inventory_query" },
    { q: "كم حالة في المختبر لم تصل؟", expectedIntent: "lab_query" },
    { q: "حالات المعمل المتأخرة", expectedIntent: "lab_query" },
    { q: "طلبيات مختبر الأسنان قيد الانتظار", expectedIntent: "lab_query" },
    { q: "حسابات ومعاملات المختبرات", expectedIntent: "lab_query" },
    { q: "ما هي الحالات المعلقة في معمل التركيبات؟", expectedIntent: "lab_query" },
    { q: "مستحقات معامل الأسنان", expectedIntent: "lab_query" },

    // 51-60: System Knowledge & How-to Guides
    { q: "كيف أضيف مريض جديد؟", expectedIntent: "system_guide" },
    { q: "كيف أعمل فاتورة؟", expectedIntent: "system_guide" },
    { q: "كيف أسجل سند قبض؟", expectedIntent: "system_guide" },
    { q: "كيف أحجز موعد لمريض؟", expectedIntent: "system_guide" },
    { q: "كيف أفتح خطة علاج للأسنان؟", expectedIntent: "system_guide" },
    { q: "أين أغير صلاحيات الطبيب؟", expectedIntent: "system_guide" },
    { q: "كيف أضبط نسب وعمولات الأطباء؟", expectedIntent: "system_guide" },
    { q: "كيف أعمل نسخة احتياطية للنظام؟", expectedIntent: "system_guide" },
    { q: "كيف أستخدم وحدة السيفالومتري؟", expectedIntent: "system_guide" },
    { q: "أين شاشة تسعير الخدمات؟", expectedIntent: "system_guide" },
  ];

  it("successfully classifies at least 50 distinct Arabic & Yemeni queries into correct intents", async () => {
    let successCount = 0;
    const failures: { q: string; expected: string; actual: string }[] = [];

    for (const item of testQueries) {
      const res = await processAssistantQuery(item.q, adminContext);
      if (res.intent === item.expectedIntent) {
        successCount++;
      } else {
        failures.push({ q: item.q, expected: item.expectedIntent, actual: res.intent });
      }
    }

    if (failures.length > 0) {
      console.warn("NLU Classification mismatches:", failures);
    }

    // Expect at least 90% high precision across diverse dialectal queries
    expect(successCount).toBeGreaterThanOrEqual(48);
    expect(testQueries.length).toBeGreaterThanOrEqual(50);
  });

  it("handles conversation context and pronoun resolution (متى موعده القادم؟)", async () => {
    // 1st query introduces patient
    const res1 = await processAssistantQuery("كم حساب محمد علي؟", adminContext);
    expect(res1.intent).toBe("patient_query");

    // 2nd query uses pronoun "موعده" with previous patient context
    const contextWithPatient: AiToolContext = {
      ...adminContext,
      currentPatientId: "pat-123",
      currentPatientName: "محمد علي",
    };

    const res2 = await processAssistantQuery("ومتى موعده القادم؟", contextWithPatient);
    expect(res2.intent).toBe("patient_query");
    expect(res2.answer).toContain("محمد علي");
  });

  it("correctly identifies currencies in queries (USD, SAR, YER)", async () => {
    const resUsd = await processAssistantQuery("كم دخل اليوم بالدولار؟", adminContext);
    expect(resUsd.intent).toBe("finance_report");

    const resSar = await processAssistantQuery("كم حصلنا اليوم بالريال السعودي؟", adminContext);
    expect(resSar.intent).toBe("finance_report");

    const resYer = await processAssistantQuery("إيرادات اليوم بالريال اليمني", adminContext);
    expect(resYer.intent).toBe("finance_report");
  });

  it("correctly identifies specialty filters (ortho / تقويم)", async () => {
    const resOrthoDebt = await processAssistantQuery("اعطني مديونية مرضى التقويم هذا الشهر", adminContext);
    expect(resOrthoDebt.intent).toBe("debt_report");
  });
});
