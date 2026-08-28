import { describe, expect, it } from "vitest";
import { recallText, sinceText, weeksSince } from "../lib/recall";

const TODAY = "2026-08-27";

describe("حساب الانقطاع", () => {
  it("يقرّب لأسفل: أربعة أسابيع وستة أيام هي أربعة لا خمسة", () => {
    expect(weeksSince("2026-07-27", TODAY)).toBe(4);
    expect(weeksSince("2026-08-20", TODAY)).toBe(1);
    expect(weeksSince("2026-08-27", TODAY)).toBe(0);
  });

  it("لا يعطي رقمًا سالبًا لتاريخ مستقبلي", () => {
    expect(weeksSince("2026-09-27", TODAY)).toBe(0);
  });

  it("ينطق المدة كما ينطقها الناس", () => {
    expect(sinceText("2026-08-25", TODAY)).toBe("هذا الأسبوع");
    expect(sinceText("2026-08-19", TODAY)).toBe("منذ أسبوع");
    expect(sinceText("2026-08-12", TODAY)).toBe("منذ أسبوعين");
    expect(sinceText("2026-07-20", TODAY)).toBe("منذ 5 أسابيع");
    // بعد شهرين يصير الحساب بالأشهر: «منذ 10 أسابيع» لا يقولها أحد.
    expect(sinceText("2026-06-01", TODAY)).toBe("منذ 3 أشهر");
    // العربية تقول «منذ شهر» لا «منذ 1 شهر» — والرسالة تُقرأ على المريض نفسه.
    expect(sinceText("2026-06-25", TODAY)).toBe("منذ شهرين");
    expect(sinceText("2024-08-27", TODAY)).toBe("منذ 26 شهرًا");
  });
});

describe("رسالة الاستدعاء", () => {
  it("تلاحظ الغياب ولا تلوم عليه", () => {
    const text = recallText({
      patientName: "عبدالله",
      sinceText: "منذ 3 أشهر",
      clinicName: "مركز الدكتور عقلان الكامل",
      clinicPhone: "04-253028",
    });
    expect(text).toContain("عبدالله");
    expect(text).toContain("منذ 3 أشهر");
    // اللوم يفقدك المريض نهائيًا، وهو يعرف أنه تأخّر.
    expect(text).not.toContain("لماذا");
    expect(text).not.toContain("تأخرتم");
  });
});
