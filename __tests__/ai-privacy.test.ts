import { describe, expect, it } from "vitest";
import { deIdentifyClinicalContext } from "../lib/ai-tools/privacy";

describe("طبقة الخصوصية وإلغاء تحديد الهوية السريرية (Clinical Privacy & De-Identification)", () => {
  it("تقنّع أرقام الهواتف اليمنية والدولية والأرقام الطويلة بدقة", () => {
    const text = "تواصل مع المريض على 777123456 أو 967712345678 أو +967-733445566";
    const cleaned = deIdentifyClinicalContext(text);

    expect(cleaned).not.toContain("777123456");
    expect(cleaned).not.toContain("712345678");
    expect(cleaned).not.toContain("733445566");
    expect(cleaned).toContain("[هاتف محمي]");
  });

  it("تقنّع أرقام الملفات السكنية P-001 و P-123", () => {
    const text = "رقم ملف المريض هو P-001 وملف آخر p-142";
    const cleaned = deIdentifyClinicalContext(text);

    expect(cleaned).not.toContain("P-001");
    expect(cleaned).not.toContain("p-142");
    expect(cleaned).toContain("[ملف محمي]");
  });

  it("تقنّع عناوين البريد الإلكتروني", () => {
    const text = "بريد المريض info@example.com ومراسلات aqlan.clinic@test.ye";
    const cleaned = deIdentifyClinicalContext(text);

    expect(cleaned).not.toContain("info@example.com");
    expect(cleaned).not.toContain("aqlan.clinic@test.ye");
    expect(cleaned).toContain("[بريد محمي]");
  });

  it("تقنّع الأسماء الصريحة الممررة لقائمة الحماية", () => {
    const text = "المريض سالم أحمد علي حضر اليوم ودفع حسابه كاملاً";
    const cleaned = deIdentifyClinicalContext(text, ["سالم أحمد علي", "سالم أحمد"]);

    expect(cleaned).not.toContain("سالم أحمد علي");
    expect(cleaned).toContain("[المريض]");
  });

  it("تقنّع صيغ الأسماء المسبوقة بالمريض فلان دون المساس بالمصطلحات السريرية", () => {
    const textWithPatient = "المريض عبدالله عثمان يحتاج قلع جراحي";
    const cleanedPatient = deIdentifyClinicalContext(textWithPatient);
    expect(cleanedPatient).not.toContain("عبدالله عثمان");
    expect(cleanedPatient).toContain("[المريض]");

    // المصطلحات السريرية لا تُمس
    const clinicalText = "مريض سكري ومريض ضغط ومريض لديه حساسية بنسلين";
    const cleanedClinical = deIdentifyClinicalContext(clinicalText);
    expect(cleanedClinical).toContain("سكري");
    expect(cleanedClinical).toContain("ضغط");
    expect(cleanedClinical).toContain("حساسية بنسلين");
  });

  it("تحافظ على القيم الرقمية والجرعات السريرية والزوايا السيفالومترية", () => {
    const text = "جرعة الأدرينالين 0.04 مجم وأمبولتان، وزاوية SNA 82 درجة وزاوية ANB 4 درجات";
    const cleaned = deIdentifyClinicalContext(text);

    expect(cleaned).toContain("0.04 مجم");
    expect(cleaned).toContain("82");
    expect(cleaned).toContain("ANB");
  });
});
