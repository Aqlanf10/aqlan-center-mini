import { describe, expect, it } from "vitest";
import { generateDentalExpertReply } from "../lib/dental-ai-engine";

describe("محرك الذكاء الاصطناعي السريري المتخصص لطب الأسنان (Dental AI Engine)", () => {
  it("يجيب عن جرعات المضادات السنية (أوجمنتين وفلاجيل) بدقة للكبار والأطفال", async () => {
    const result = await generateDentalExpertReply([
      { role: "user", content: "ما هي الجرعات المعتمدة لأوجمنتين وفلاجيل للبالغين والأطفال؟" },
    ]);

    expect(result.category).toBe("pharmacology");
    expect(result.model).toContain("aqlan-dental-expert");
    expect(result.reply).toContain("أوجمنتين");
    expect(result.reply).toContain("1000 مجم");
    expect(result.reply).toContain("فلاجيل");
    expect(result.reply).toContain("المادة 214");
  });

  it("يقدم بدائل آمنة لحساسية البنسلين (كليندامايسين وأزيثرومايسين)", async () => {
    const result = await generateDentalExpertReply([
      { role: "user", content: "مريض لديه حساسية بنسلين ما هو المضاد الحيوي البديل والجرعة؟" },
    ]);

    expect(result.category).toBe("pharmacology");
    expect(result.reply).toContain("كليندامايسين");
    expect(result.reply).toContain("أزيثرومايسين");
  });

  it("يوضح قواعد التخدير الموضعي لمرضى القلب والضغط والحد الأقصى للأدرينالين", async () => {
    const result = await generateDentalExpertReply([
      { role: "user", content: "كم الحد الأقصى لأمبولات البنج مع أدرينالين لمريض القلب والضغط؟" },
    ]);

    expect(result.category).toBe("anesthesia");
    expect(result.reply).toContain("0.04 مجم");
    expect(result.reply).toContain("أمبولتان");
    expect(result.reply).toContain("ميبفاكائين");
  });

  it("يوثق بروتوكول فتح السن الطارئ (Pulpectomy) والتهاب العصب الحاد", async () => {
    const result = await generateDentalExpertReply([
      { role: "user", content: "ما هي خطوات فتح السن الطارئ Pulpectomy لالتهاب العصب الحاد؟" },
    ]);

    expect(result.category).toBe("endo_emergency");
    expect(result.reply).toContain("الحاجز المطاطي");
    expect(result.reply).toContain("هيدروكسيد الكالسيوم");
    expect(result.reply).toContain("تخفيض الإطباق");
  });

  it("يؤكد على منع تجريف العظم في علاج السنخ الجاف (Dry Socket)", async () => {
    const result = await generateDentalExpertReply([
      { role: "user", content: "كيف نعالج السنخ الجاف dry socket بعد خلع ضرس العقل؟" },
    ]);

    expect(result.category).toBe("endo_emergency");
    expect(result.reply).toContain("ممنوع تماماً كحت أو تجريف العظم");
    expect(result.reply).toContain("Alveogyl");
  });

  it("يشرح الفارق بين Class II div 1 و div 2 ومعايير القلع في التقويم", async () => {
    const result = await generateDentalExpertReply([
      { role: "user", content: "ما الفرق في التقويم بين Class II div 1 و Class II div 2؟" },
    ]);

    expect(result.category).toBe("orthodontics");
    expect(result.reply).toContain("Class II Div 1");
    expect(result.reply).toContain("Class II Div 2");
    expect(result.reply).toContain("Overjet");
  });

  it("يولد تعليمات ما بعد العلاج ورسالة واتساب جاهزة للإرسال", async () => {
    const result = await generateDentalExpertReply([
      { role: "user", content: "أريد تعليمات ورسالة واتساب لمريض بعد الخلع الجراحي" },
    ]);

    expect(result.category).toBe("post_op");
    expect(result.reply).toContain("العضّ المستمر");
    expect(result.reply).toContain("نص رسالة الواتساب الجاهزة");
  });

  it("يقدم سلم أولويات فرز الحالات في الاستقبال", async () => {
    const result = await generateDentalExpertReply([
      { role: "user", content: "كيف يرتب موظف الاستقبال أولوية الحالات الطارئة؟" },
    ]);

    expect(result.category).toBe("triage");
    expect(result.reply).toContain("طوارئ قصوى");
    expect(result.reply).toContain("المستوى الأول");
  });

  it("يجيب عن كيفية إضافة مريض جديد في النظام (System Guide)", async () => {
    const result = await generateDentalExpertReply([
      { role: "user", content: "كيف أضيف مريض جديد في النظام؟" },
    ]);

    expect(result.category).toBe("system_guide");
    expect(result.reply).toContain("«المرضى»");
    expect(result.reply).toContain("مريض جديد");
    expect(result.reply).toContain("التنبيه الطبي");
  });

  it("يجيب عن كيفية إنشاء فاتورة وسند قبض للمريض (System Guide)", async () => {
    const result = await generateDentalExpertReply([
      { role: "user", content: "كيف أعمل فاتورة وسند قبض للمريض؟" },
    ]);

    expect(result.category).toBe("system_guide");
    expect(result.reply).toContain("فاتورة جديدة");
    expect(result.reply).toContain("سند قبض");
    expect(result.reply).toContain("دليل الخدمات");
  });

  it("يجيب عن كيفية حجز موعد جديد في جدول العيادة (System Guide)", async () => {
    const result = await generateDentalExpertReply([
      { role: "user", content: "كيف أحجز موعد جديد لمريض؟" },
    ]);

    expect(result.category).toBe("system_guide");
    expect(result.reply).toContain("المواعيد");
    expect(result.reply).toContain("تأكيد الحجز");
  });

  it("يجيب عن كيفية أخذ نسخة احتياطية Backup للبيانات (System Guide)", async () => {
    const result = await generateDentalExpertReply([
      { role: "user", content: "كيف أعمل نسخ احتياطي backup للبيانات؟" },
    ]);

    expect(result.category).toBe("system_guide");
    expect(result.reply).toContain("النسخ الاحتياطي");
    expect(result.reply).toContain("تنزيل نسخة احتياطية");
  });

  it("يجيب عن دليل أسعار الخدمات عند السؤال عنها (Clinic Operations)", async () => {
    const result = await generateDentalExpertReply([
      { role: "user", content: "ما هي أسعار خدمات المركز وقائمة الأسعار؟" },
    ]);

    expect(result.category).toBe("clinic_ops");
    expect(result.reply).toContain("دليل أسعار الخدمات");
  });

  it("يتعرف على الاستعلام عن رصيد وحساب مريض محدد (Patient Query)", async () => {
    const result = await generateDentalExpertReply([
      { role: "user", content: "كم باقي على المريض سالم أحمد؟" },
    ]);

    expect(result.category).toBe("patient_query");
    expect(result.reply).toContain("سالم أحمد");
  });

  it("يتعرف على الاستعلام عن ملف وبيانات مريض محدد (Patient Query)", async () => {
    const result = await generateDentalExpertReply([
      { role: "user", content: "معلومات المريض محمد علي" },
    ]);

    expect(result.category).toBe("patient_query");
    expect(result.reply).toContain("محمد علي");
  });
});

