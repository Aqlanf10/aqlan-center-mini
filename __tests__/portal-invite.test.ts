import { describe, expect, it } from "vitest";
import { portalInvite, portalUrl, portalUrlFromHeaders } from "../lib/portalInvite";

describe("دعوة بوّابة المريض", () => {
  it("العنوان الناقص لا يُبنى منه رابط — «https://undefined/portal» يُرسل لصفحة خطأ", () => {
    expect(portalUrl("https://undefined")).toBeNull();
    expect(portalUrl("")).toBeNull();
    expect(portalUrl(null)).toBeNull();
    expect(portalUrl("ليس عنوانًا")).toBeNull();
  });

  it("العنوان السليم يُضاف إليه مسار البوابة بلا شرطةٍ مكررة", () => {
    expect(portalUrl("https://center.example.com")).toBe("https://center.example.com/portal");
    expect(portalUrl("https://center.example.com/")).toBe("https://center.example.com/portal");
    expect(portalUrl("http://localhost:3000")).toBe("http://localhost:3000/portal");
  });

  it("من ترويسات الطلب: بروتوكول الوسيط يُقرأ قبل افتراض https", () => {
    expect(portalUrlFromHeaders((name) =>
      name === "x-forwarded-host" ? "center.example.com" : null,
    )).toBe("https://center.example.com/portal");
    expect(portalUrlFromHeaders((name) =>
      name === "host" ? "localhost:3000" : null,
    )).toBe("http://localhost:3000/portal");
    expect(portalUrlFromHeaders(() => null)).toBeNull();
  });

  it("نصّ الدعوة يذكر رقم الملف ولا يذكر كلمة سرّ — لأنه لا كلمة سرّ", () => {
    const invite = portalInvite({
      origin: "https://center.example.com",
      clinicName: "مركز الاختبار",
      patientNumber: "P-00042",
    });
    expect(invite).not.toBeNull();
    expect(invite?.url).toBe("https://center.example.com/portal");
    expect(invite?.text).toContain("P-00042");
    expect(invite?.text).not.toContain("كلمة");
  });

  it("بلا رقم ملفٍ أو عنوانٍ لا دعوة — نصف المفتاح لا يُرسل", () => {
    expect(portalInvite({ origin: "https://c.example.com", clinicName: "م", patientNumber: " " })).toBeNull();
    expect(portalInvite({ origin: null, clinicName: "م", patientNumber: "P-1" })).toBeNull();
  });
});
