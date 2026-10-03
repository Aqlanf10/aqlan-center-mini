import { describe, expect, it } from "vitest";
import { canRecordPlanReminder, hasPlanReminderAuthority, MAX_PLAN_REMINDER_BATCH, parsePlanReminderTarget } from "../lib/plan-reminders";

describe("strict plan reminder target validation", () => {
  it("normalizes unique sorted bulk IDs and preserves an exact installment", () => {
    expect(parsePlanReminderTarget({ planIds: [9, 2, 9] })).toEqual({ ok: true, target: { kind: "bulk", planIds: [2, 9] } });
    expect(parsePlanReminderTarget({ planId: 2, installmentNumber: 4 })).toEqual({ ok: true,
      target: { kind: "single", planId: 2, installmentNumber: 4 } });
    expect(parsePlanReminderTarget({ planId: 2 })).toEqual({ ok: true, target: { kind: "single", planId: 2 } });
  });
  it.each([null, [], 1, "1", {}, { planId: "1" }, { planId: 0 }, { planId: -1 }, { planId: 1.5 },
    { planId: 2147483648 }, { planId: Number.MAX_SAFE_INTEGER }, { planId: Infinity },
    { planIds: [] }, { planIds: [1, "2"] }, { planIds: [1, null] }, { planIds: [1, 0] },
    { planIds: null }, { planId: 1, planIds: [1] }, { planIds: [1], installmentNumber: 1 },
    { planId: 1, installmentNumber: null }, { planId: 1, installmentNumber: "1" },
    { planId: 1, installmentNumber: undefined }, { planId: 1, installmentNumber: 0 },
    { planId: 1, installmentNumber: -1 }, { planId: 1, installmentNumber: 2147483648 },
    { kind: "single", planIds: [1] }, { kind: "bulk", planId: 1 }, { kind: "unknown", planId: 1 },
  ])("rejects malformed or ambiguous targets without widening: %j", (raw) => {
    expect(parsePlanReminderTarget(raw)).toMatchObject({ ok: false, status: 400 });
  });
  it("rejects sparse targets and explicit oversized input instead of truncating", () => {
    expect(parsePlanReminderTarget({ planIds: new Array(2) })).toMatchObject({ ok: false });
    expect(parsePlanReminderTarget({ planIds: Array(MAX_PLAN_REMINDER_BATCH + 1).fill(1) })).toMatchObject({ ok: false });
    expect(parsePlanReminderTarget({ planIds: Array.from({ length: MAX_PLAN_REMINDER_BATCH }, (_, i) => i + 1) })).toMatchObject({ ok: true });
  });
});

describe("reminder authority preserves legacy defaults without corruption grants", () => {
  it.each([null, undefined, "", "null", "{}", {}, { canViewAllPatients: true }])("keeps legacy defaults: %j", (raw) => {
    expect(hasPlanReminderAuthority(raw, "doctor")).toBe(true);
  });
  it.each(["{", "[]", "true", "1", [], true, 1, { canEditPlans: "true" }, { canEditPlans: null },
    { canEditPlans: 1 }, { canEditPlans: undefined }, { schemaVersion: 1 },
    { schemaVersion: 1, revision: 1, patientScope: "all", appointmentScope: "all", grants: {} },
  ])("fails closed before permissive defaults: %j", (raw) => {
    expect(hasPlanReminderAuthority(raw, "doctor")).toBe(false);
  });
  it("uses canEditPlans but no money-view prerequisite or broader read-scope grant", () => {
    expect(hasPlanReminderAuthority({ canEditPlans: false, canViewAllPatients: true }, "doctor")).toBe(false);
    expect(hasPlanReminderAuthority({ canEditPlans: true, canViewMoney: false, canViewAllPatients: false }, "doctor")).toBe(true);
    expect(hasPlanReminderAuthority({ canEditPlans: false }, "admin")).toBe(true);
    expect(hasPlanReminderAuthority({ canEditPlans: false }, "reception")).toBe(true);
  });
  it.each([null, "", "{}", "{", "[]", '{"canEditPlans":"true"}',
    { canEditPlans: false }, { schemaVersion: 1, revision: 1, patientScope: "none", appointmentScope: "none", grants: {} },
  ])("keeps admin/reception role authority independent of unrelated storage: %j", (raw) => {
    expect(hasPlanReminderAuthority(raw, "admin")).toBe(true);
    expect(hasPlanReminderAuthority(raw, "reception")).toBe(true);
  });
  it("never interprets valid future grants as live doctor permission", () => {
    const future = { schemaVersion: 1, revision: 1, patientScope: "all", appointmentScope: "all",
      grants: { "clinical.plans.view": true, "clinical.plans.edit": true } };
    expect(hasPlanReminderAuthority(future, "doctor")).toBe(false);
    expect(hasPlanReminderAuthority(future, "cashier")).toBe(false);
  });
  it.each(["cashier", "accountant", "assistant", "staff", "unknown"])("does not expand effective role %s", (role) => {
    expect(canRecordPlanReminder(role)).toBe(false);
    expect(hasPlanReminderAuthority({ canEditPlans: true }, role)).toBe(false);
  });
});
