import { describe, expect, it } from "vitest";
import {
  extractPatientIdentifier,
  resolveSystemGuideInquiry,
  resolveClinicOperationsInquiry,
} from "../lib/assistant-knowledge";

describe("بنك المعرفة ومحرك استعلامات المساعد الذكي (Assistant Knowledge Engine)", () => {
  describe("استخراج معرف المريض بدقة (extractPatientIdentifier)", () => {
    it("يستخرج أسماء المرضى بدقة من مختلف صيغ الاستعلام", () => {
      expect(extractPatientIdentifier("معلومات المريض أحمد علي")).toBe("أحمد علي");
      expect(extractPatientIdentifier("كم باقي على المريض سالم أحمد؟")).toBe("سالم أحمد");
      expect(extractPatientIdentifier("كم رصيد المريض محمد؟")).toBe("محمد");
      expect(extractPatientIdentifier("حساب المريض خالد")).toBe("خالد");
      expect(extractPatientIdentifier("متى موعد المريضة فاطمة؟")).toBe("فاطمة");
      expect(extractPatientIdentifier("ملف المريض عمر")).toBe("عمر");
      expect(extractPatientIdentifier("بيانات المريض زيد")).toBe("زيد");
    });

    it("يستخرج أرقام الملفات السكنية وأرقام الهواتف بدقة", () => {
      expect(extractPatientIdentifier("ملف المريض P-001")).toBe("P-001");
      expect(extractPatientIdentifier("ابحث عن P-124")).toBe("P-124");
      expect(extractPatientIdentifier("المريض صاحب الرقم 777123456")).toBe("777123456");
      expect(extractPatientIdentifier("مريض 967771234567")).toBe("771234567");
    });

    it("يستبعد الأسئلة الإرشادية وكيفية استخدام البرنامج من استعلام المرضى", () => {
      expect(extractPatientIdentifier("كيف أضيف مريض جديد في النظام؟")).toBeNull();
      expect(extractPatientIdentifier("كيف أحجز موعد جديد لمريض؟")).toBeNull();
      expect(extractPatientIdentifier("طريقة تسجيل مريض جديد")).toBeNull();
      expect(extractPatientIdentifier("خطوات إضافة مريض")).toBeNull();
    });

    it("يستبعد الاستفسارات السريرية العامة التي تذكر كلمة مريض كسياق طبي", () => {
      expect(extractPatientIdentifier("مريض لديه حساسية بنسلين ما هو البديل؟")).toBeNull();
      expect(extractPatientIdentifier("كم جرعة أمبولات البنج لمريض القلب والضغط؟")).toBeNull();
      expect(extractPatientIdentifier("تعليمات ورسالة واتساب لمريض بعد الخلع")).toBeNull();
      expect(extractPatientIdentifier("علاج مريض يعاني من سنخ جاف")).toBeNull();
      expect(extractPatientIdentifier("مريض حامل في الشهر الرابع")).toBeNull();
    });
  });

  describe("الدليل الإرشادي التفاعلي للبرنامج (resolveSystemGuideInquiry)", () => {
    it("يشرح خطوات إضافة مريض جديد", () => {
      const res = resolveSystemGuideInquiry("كيف أضيف مريض جديد في النظام؟");
      expect(res).not.toBeNull();
      expect(res?.found).toBe(true);
      expect(res?.type).toBe("system_guide");
      expect(res?.reply).toContain("شاشة **«المرضى»**");
      expect(res?.reply).toContain("التنبيه الطبي");
    });

    it("يشرح خطوات إنشاء فاتورة وسند قبض", () => {
      const res = resolveSystemGuideInquiry("كيف أعمل فاتورة وسند قبض؟");
      expect(res).not.toBeNull();
      expect(res?.found).toBe(true);
      expect(res?.reply).toContain("فاتورة جديدة");
      expect(res?.reply).toContain("سند قبض");
    });

    it("يشرح خطوات حجز موعد جديد", () => {
      const res = resolveSystemGuideInquiry("كيف أحجز موعد لمريض؟");
      expect(res).not.toBeNull();
      expect(res?.found).toBe(true);
      expect(res?.reply).toContain("شاشة **«المواعيد»**");
      expect(res?.reply).toContain("تأكيد الحجز");
    });

    it("يشرح وحدة المخطط السني FDI", () => {
      const res = resolveSystemGuideInquiry("كيف أستخدم المخطط السني للمريض؟");
      expect(res).not.toBeNull();
      expect(res?.found).toBe(true);
      expect(res?.reply).toContain("FDI Tooth Chart");
      expect(res?.reply).toContain("11-48");
    });

    it("يشرح خطوات النسخ الاحتياطي Backup", () => {
      const res = resolveSystemGuideInquiry("كيف أعمل نسخ احتياطي backup؟");
      expect(res).not.toBeNull();
      expect(res?.found).toBe(true);
      expect(res?.reply).toContain("النسخ الاحتياطي (Backup)");
      expect(res?.reply).toContain("تنزيل نسخة احتياطية");
    });

    it("يشرح وحدة التحليل السيفالومتري لمرضى التقويم", () => {
      const res = resolveSystemGuideInquiry("كيف أعمل تحليل سيفالومتري في برنامج التقويم؟");
      expect(res).not.toBeNull();
      expect(res?.found).toBe(true);
      expect(res?.reply).toContain("Cephalometric AI");
      expect(res?.reply).toContain("SNA, SNB, ANB");
    });

    it("يشرح أدوار وصلاحيات النظام", () => {
      const res = resolveSystemGuideInquiry("ما هي صلاحيات وأقسام البرنامج؟");
      expect(res).not.toBeNull();
      expect(res?.found).toBe(true);
      expect(res?.reply).toContain("مدير المركز (Admin)");
      expect(res?.reply).toContain("طبيب الأسنان (Doctor)");
    });
  });

  describe("استعلامات عمليات المركز (resolveClinicOperationsInquiry)", () => {
    it("يقدم دليل أسعار الخدمات عند الاستعلام عنها", async () => {
      const res = await resolveClinicOperationsInquiry("ما هي أسعار الخدمات في المركز؟");
      expect(res).not.toBeNull();
      expect(res?.found).toBe(true);
      expect(res?.type).toBe("clinic_ops");
      expect(res?.reply).toContain("دليل أسعار الخدمات");
    });
  });
});
