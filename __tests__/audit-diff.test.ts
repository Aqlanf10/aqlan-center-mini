import { describe, expect, it } from "vitest";
import { PATIENT_AUDIT_FIELDS, SERVICE_AUDIT_FIELDS, auditChanges, auditSnapshot } from "../lib/audit-diff";

describe("audit diff (P1-4)", () => {
  it("records only the fields that changed, with before and after, under Arabic names", () => {
    const changes = auditChanges(
      { fullName: "أحمد", phone: "771111111", note: "" },
      { fullName: "أحمد", phone: "772222222", note: null },
      PATIENT_AUDIT_FIELDS,
    );
    expect(changes).toEqual({ الهاتف: { قبل: "771111111", بعد: "772222222" } });
  });

  it("a price change is visible in minor units", () => {
    expect(auditChanges({ priceMinor: 15000, isActive: true }, { priceMinor: 18000, isActive: true }, SERVICE_AUDIT_FIELDS))
      .toEqual({ السعر: { قبل: 15000, بعد: 18000 } });
  });

  it("no change → empty, so no noise row is written", () => {
    expect(auditChanges({ name: "x" }, { name: "x" }, SERVICE_AUDIT_FIELDS)).toEqual({});
  });

  it("snapshot names every configured field", () => {
    expect(auditSnapshot({ name: "حشوة", priceMinor: 5000 }, SERVICE_AUDIT_FIELDS))
      .toEqual({ الاسم: "حشوة", التخصص: null, السعر: 5000, نشطة: null });
  });
});
