import { describe, expect, it } from "vitest";
import { lapseLabelForWeeks, parseConfiguredLapseWeeks, recallText, resolveRecallWeeks, sinceText, weeksSince } from "../lib/recall";

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

describe("استهلاك إعداد العيادة recall.lapse_weeks (S23 / R35)", () => {
  it("يستهلك الإعداد المحفوظ عند غياب معامل الطلب ويرفض الأرقام المتطرفة", () => {
    expect(parseConfiguredLapseWeeks("8")).toBe(8);
    expect(parseConfiguredLapseWeeks(16)).toBe(16);
    expect(parseConfiguredLapseWeeks("0")).toBe(6);
    expect(parseConfiguredLapseWeeks("999")).toBe(6);
    expect(parseConfiguredLapseWeeks("invalid")).toBe(6);

    expect(resolveRecallWeeks(null, "8")).toBe(8);
    expect(resolveRecallWeeks("", "8")).toBe(8);
    expect(resolveRecallWeeks("8", "8")).toBe(8);
    expect(resolveRecallWeeks("12", "8")).toBe(12);
    expect(resolveRecallWeeks("100000", "8")).toBe(8);
    expect(resolveRecallWeeks("100000")).toBe(6);

    expect(lapseLabelForWeeks(6)).toBe("أكثر من ٦ أسابيع");
    expect(lapseLabelForWeeks(8)).toBe("أكثر من 8 أسابيع");
    expect(lapseLabelForWeeks(16)).toBe("أكثر من 16 أسبوعًا");
  });
});
