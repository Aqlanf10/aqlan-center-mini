import { describe, expect, it } from "vitest";
import {
  POST_OP_TEMPLATES,
  getPostOpTemplate,
  detectPostOpTemplateFromText,
  formatPostOpWhatsAppMessage,
} from "../lib/post-op-care";

describe("Post-Operative Care Engine (إرشادات ما بعد الإجراء السني)", () => {
  it("يحتوي على كافة القوالب السريرية الـ 8 الأساسية لطب الأسنان", () => {
    expect(POST_OP_TEMPLATES.length).toBe(8);

    const expectedIds = [
      "surgical_extraction",
      "simple_extraction",
      "endodontics",
      "dental_implants",
      "teeth_whitening",
      "periodontal_scaling",
      "pediatric_care",
      "crowns_bridges",
    ];

    for (const id of expectedIds) {
      const tmpl = getPostOpTemplate(id);
      expect(tmpl).toBeDefined();
      expect(tmpl?.title).toBeTruthy();
      expect(tmpl?.first24Hours.length).toBeGreaterThan(0);
      expect(tmpl?.diet.allowed.length).toBeGreaterThan(0);
      expect(tmpl?.diet.avoid.length).toBeGreaterThan(0);
      expect(tmpl?.hygiene.length).toBeGreaterThan(0);
      expect(tmpl?.medications.length).toBeGreaterThan(0);
      expect(tmpl?.emergencyWarnings.length).toBeGreaterThan(0);
    }
  });

  it("يكتشف القالب السريري المناسب تلقائياً من اسم الإجراء أو الملاحظة", () => {
    expect(detectPostOpTemplateFromText("قلع جراحي لضرس العقل").id).toBe("surgical_extraction");
    expect(detectPostOpTemplateFromText("جلسة حشو عصب وقنوات الجذر").id).toBe("endodontics");
    expect(detectPostOpTemplateFromText("زراعة سنية فورية مع طعم عظمي").id).toBe("dental_implants");
    expect(detectPostOpTemplateFromText("تبييض الأسنان بالليزر").id).toBe("teeth_whitening");
    expect(detectPostOpTemplateFromText("تنظيف وتجريف لثة عميق").id).toBe("periodontal_scaling");
    expect(detectPostOpTemplateFromText("حشوة لبنية لطفل مع تخدير موضعي").id).toBe("pediatric_care");
    expect(detectPostOpTemplateFromText("تركيب تاج زيركون دائم").id).toBe("crowns_bridges");
  });

  it("يقوم بتوليد رسالة واتساب منسقة واحترافية بكامل التفاصيل للمريض", () => {
    const tmpl = getPostOpTemplate("surgical_extraction")!;
    const msg = formatPostOpWhatsAppMessage(
      tmpl,
      "أحمد محمد",
      "مركز الدكتور عقلان لطب الأسنان",
      "+967770000000",
      "يرجى الالتزام بتناول المسكن كل 8 ساعات.",
    );

    expect(msg).toContain("مركز الدكتور عقلان لطب الأسنان");
    expect(msg).toContain("أحمد محمد");
    expect(msg).toContain("خلع جراحي / ضرس عقل منطمر");
    expect(msg).toContain("الساعات الـ 24 الأولى");
    expect(msg).toContain("المأكولات والمشروبات");
    expect(msg).toContain("ملاحظة خاصة من الطبيب المعالج");
    expect(msg).toContain("متى تتصل بالمركز فوراً؟");
    expect(msg).toContain("+967770000000");
  });
});
