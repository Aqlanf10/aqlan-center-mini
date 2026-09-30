import { describe, expect, it } from "vitest";
import {
  FAMILY_ROLES, FAMILY_ROLE_LABEL, familyRoleLabel, familyTotals, isFamilyRole, normalizeGuarantorPhone,
  parseFamilyName, parseFamilyRole, parseGuarantor, validateFamilyDraft,
} from "../lib/patient-families";

describe("(PAT-4) family roles", () => {
  it("every role code has a short Arabic label", () => {
    for (const role of FAMILY_ROLES) expect(FAMILY_ROLE_LABEL[role]).toMatch(/^[؀-ۿ/ ]+$/);
    expect(FAMILY_ROLE_LABEL.father).toBe("أب");
    expect(FAMILY_ROLE_LABEL.daughter).toBe("ابنة");
  });

  it("codes match the database shape check (lowercase letters/underscore, ≤ 20)", () => {
    for (const role of FAMILY_ROLES) expect(role).toMatch(/^[a-z_]{1,20}$/);
  });

  it("unknown or empty roles: label never shows a raw English code", () => {
    expect(familyRoleLabel(null)).toBe("—");
    expect(familyRoleLabel("cousin")).toBe(FAMILY_ROLE_LABEL.other);
    expect(isFamilyRole("cousin")).toBe(false);
  });

  it("parseFamilyRole: empty = unspecified; unknown = Arabic 400 message", () => {
    expect(parseFamilyRole(undefined)).toEqual({ ok: true, value: null });
    expect(parseFamilyRole("")).toEqual({ ok: true, value: null });
    expect(parseFamilyRole("son")).toEqual({ ok: true, value: "son" });
    expect(parseFamilyRole("boss")).toMatchObject({ ok: false, message: "صلة القرابة غير معروفة." });
  });
});

describe("(PAT-4) family draft validation", () => {
  it("name is required, whitespace collapsed, at most 80 chars", () => {
    expect(parseFamilyName("  عائلة   الحكيمي ")).toEqual({ ok: true, value: "عائلة الحكيمي" });
    expect(parseFamilyName("   ")).toMatchObject({ ok: false, field: "name" });
    expect(parseFamilyName("ع".repeat(81))).toMatchObject({ ok: false, field: "name" });
  });

  it("guarantor: none, a patient, or an outside person — never an unknown kind", () => {
    expect(parseGuarantor(undefined)).toEqual({ ok: true, value: { kind: "none" } });
    expect(parseGuarantor({ kind: "patient", patientId: "12" })).toEqual({ ok: true, value: { kind: "patient", patientId: 12 } });
    expect(parseGuarantor({ kind: "patient", patientId: -1 })).toMatchObject({ ok: false, message: "اختر المريض الضامن." });
    expect(parseGuarantor({ kind: "external", name: " خالد ", phone: "0773 000 111" }))
      .toEqual({ ok: true, value: { kind: "external", name: "خالد", phone: "967773000111" } });
    expect(parseGuarantor({ kind: "external", name: "" })).toMatchObject({ ok: false, field: "guarantorName" });
    expect(parseGuarantor({ kind: "both" })).toMatchObject({ ok: false });
    expect(parseGuarantor("x")).toMatchObject({ ok: false });
  });

  it("guarantor phone: Arabic digits accepted, garbage refused, empty = none", () => {
    expect(normalizeGuarantorPhone("٧٧٣٠٠٠١١١")).toEqual({ ok: true, value: "967773000111" });
    expect(normalizeGuarantorPhone("")).toEqual({ ok: true, value: null });
    expect(normalizeGuarantorPhone("12")).toMatchObject({ ok: false, message: "جوال الضامن غير صالح." });
  });

  it("members: unique, valid ids, known roles, bounded", () => {
    const ok = validateFamilyDraft({ name: "عائلة", members: [{ patientId: 1, role: "father" }, { patientId: "2" }] });
    expect(ok).toEqual({
      ok: true,
      value: { name: "عائلة", note: null, guarantor: { kind: "none" }, members: [{ patientId: 1, role: "father" }, { patientId: 2, role: null }] },
    });
    expect(validateFamilyDraft({ name: "عائلة", members: [{ patientId: 1 }, { patientId: 1 }] }))
      .toMatchObject({ ok: false, message: "أحد الأفراد مكرر في القائمة." });
    expect(validateFamilyDraft({ name: "عائلة", members: [{ patientId: 0 }] })).toMatchObject({ ok: false, field: "members" });
    expect(validateFamilyDraft({ name: "عائلة", members: [{ patientId: 3, role: "boss" }] })).toMatchObject({ ok: false, field: "role" });
    expect(validateFamilyDraft({ name: "عائلة", members: "x" })).toMatchObject({ ok: false, field: "members" });
    expect(validateFamilyDraft({ name: "عائلة", members: Array.from({ length: 21 }, (_, i) => ({ patientId: i + 1 })) }))
      .toMatchObject({ ok: false, field: "members" });
    expect(validateFamilyDraft(null)).toMatchObject({ ok: false, field: "name" });
  });

  it("every validation message is Arabic", () => {
    const failures = [
      validateFamilyDraft({}), validateFamilyDraft({ name: "x", guarantor: { kind: "?" } }),
      validateFamilyDraft({ name: "x", note: 5 }), validateFamilyDraft({ name: "x", members: [{ patientId: 1, role: 9 }] }),
    ];
    for (const failure of failures) {
      expect(failure.ok).toBe(false);
      if (!failure.ok) expect(failure.message).toMatch(/[؀-ۿ]/);
    }
  });
});

describe("(PAT-4) family totals", () => {
  it("sums per currency only — never across currencies — in bucket order", () => {
    expect(familyTotals([
      { balances: [{ currency: "USD", balanceMinor: 500 }, { currency: "YER", balanceMinor: 30_000 }] },
      { balances: [{ currency: "YER", balanceMinor: -3_000 }] },
      { balances: [] },
    ])).toEqual([{ currency: "YER", balanceMinor: 27_000 }, { currency: "USD", balanceMinor: 500 }]);
  });

  it("a currency that nets to zero still shows (it had activity); no members = no totals", () => {
    expect(familyTotals([
      { balances: [{ currency: "SAR", balanceMinor: 100 }] }, { balances: [{ currency: "SAR", balanceMinor: -100 }] },
    ])).toEqual([{ currency: "SAR", balanceMinor: 0 }]);
    expect(familyTotals([])).toEqual([]);
  });
});
