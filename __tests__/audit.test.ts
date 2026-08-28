import { describe, expect, it } from "vitest";
import {
  AUDIT_LABEL,
  SENSITIVE_ACTIONS,
  describeAudit,
  isSensitive,
  sanitizeDetails,
  type AuditAction,
} from "../lib/audit";

describe("سجل التدقيق", () => {
  it("لكل فعل مسجَّل وصفٌ عربي — سجلٌّ برموز إنجليزية لا يُقرأ", () => {
    for (const action of Object.keys(AUDIT_LABEL) as AuditAction[]) {
      expect(AUDIT_LABEL[action]).toMatch(/[؀-ۿ]/);
    }
  });

  it("الحركات الحسّاسة كلها معرّفة في القائمة", () => {
    for (const action of SENSITIVE_ACTIONS) {
      expect(AUDIT_LABEL[action]).toBeTruthy();
      expect(isSensitive(action)).toBe(true);
    }
    expect(isSensitive("payment.create")).toBe(false);
  });

  it("إلغاء الفاتورة والاسترداد والقيد اليدوي حسّاسة — وهي ما يُسأل عنه أولًا", () => {
    expect(isSensitive("invoice.cancel")).toBe(true);
    expect(isSensitive("payment.refund")).toBe(true);
    expect(isSensitive("journal.manual")).toBe(true);
    expect(isSensitive("backup.download")).toBe(true);
  });

  it("لا يُدخل الأسرار في سجلٍّ لا يُحذف منه شيء", () => {
    const clean = sanitizeDetails({
      المبلغ: 5000, password: "س", passwordHash: "س", token: "س",
      كلمة_السر: "س", رمز_الجلسة: "س",
    });
    expect(clean).toEqual({ المبلغ: 5000 });
  });

  it("يقصّ النصوص الطويلة بدل أن تُثقل السجل", () => {
    const clean = sanitizeDetails({ ملاحظة: "ط".repeat(500) });
    expect(String(clean?.ملاحظة)).toHaveLength(301);
  });

  it("يعيد لا شيء حين لا يبقى ما يُسجَّل", () => {
    expect(sanitizeDetails({ token: "س" })).toBeNull();
    expect(sanitizeDetails(null)).toBeNull();
  });

  it("يبني وصفًا يذكر المستند بعينه", () => {
    expect(describeAudit("invoice.cancel", "INV-00012")).toBe("إلغاء فاتورة — INV-00012");
    expect(describeAudit("shift.open")).toBe("فتح وردية");
  });
});
