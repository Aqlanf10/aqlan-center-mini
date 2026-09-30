import { describe, expect, it } from "vitest";
import {
  balanceLines, deriveReadiness, 
  parseBalanceWarning, type ReadinessFacts,
} from "../lib/chair-readiness";
import { validateTypedSetting } from "../lib/settings-validate";
import { SETTING_DEFAULTS } from "../lib/settings";
import { settingDefinition } from "../lib/settings-definitions";

const TODAY = "2026-09-30";
const facts = (over: Partial<ReadinessFacts> = {}): ReadinessFacts => ({
  patientId: 7,
  medicalAlert: null,
  flags: [],
  history: { recordedAt: "2026-08-01T08:00:00.000Z", answers: {}, allergies: [], asaClass: null },
  intakeAt: null,
  ...over,
});

describe("(CHAIR-1 Slice 1) derived readiness checklist", () => {
  it("a recent history, no alerts and no intake: nothing needs attention; intake is information only", () => {
    const checklist = deriveReadiness(facts(), 6, TODAY);
    expect(checklist.attention).toBe(0);
    expect(checklist.items.map((item) => [item.key, item.state])).toEqual([
      ["medical_history", "ok"], ["alerts", "ok"], ["intake", "info"],
    ]);
  });

  it("no history at all, or one older than the review period, needs attention", () => {
    expect(deriveReadiness(facts({ history: null }), 6, TODAY).items[0])
      .toEqual({ key: "medical_history", state: "attention", label: "لا تاريخ طبي مسجَّل" });
    const stale = facts({ history: { recordedAt: "2026-01-01T08:00:00.000Z", answers: {}, allergies: [], asaClass: null } });
    expect(deriveReadiness(stale, 6, TODAY).items[0].state).toBe("attention");
    expect(deriveReadiness(stale, 12, TODAY).items[0].state).toBe("ok");
  });

  it("the legacy alert text and alerts derived from the latest history both need acknowledgement", () => {
    const checklist = deriveReadiness(facts({
      medicalAlert: "حساسية بنسلين",
      history: {
        recordedAt: "2026-09-01T08:00:00.000Z",
        answers: { anticoagulants: "yes" },
        allergies: [{ substance: "لاتكس", reaction: null, severity: "severe" }],
        asaClass: "III",
      },
    }), 6, TODAY);
    expect(checklist.alerts).toEqual(["حساسية بنسلين", "حساسية لاتكس (شديدة)", "على مميّعات دم", "ASA III"]);
    expect(checklist.items.find((item) => item.key === "alerts")?.state).toBe("attention");
    expect(checklist.attention).toBe(1);
  });

  it("patient flags are shown as information and never counted; today's intake is ✓", () => {
    const checklist = deriveReadiness(facts({ flags: ["VIP", " يحتاج مرافقًا "], intakeAt: "2026-09-30T06:00:00.000Z" }), 6, TODAY);
    expect(checklist.items.find((item) => item.key === "flags")).toEqual({ key: "flags", state: "info", label: "أعلام: VIP · يحتاج مرافقًا" });
    expect(checklist.items.find((item) => item.key === "intake")?.state).toBe("ok");
    expect(checklist.attention).toBe(0);
  });

  it("a walk-in without a file has one item: link or open the file", () => {
    expect(deriveReadiness(facts({ patientId: null }), 6, TODAY)).toEqual({
      items: [{ key: "file", state: "attention", label: "بلا ملف — اربطه بملفٍّ أو افتحه" }], attention: 1, alerts: [],
    });
  });
});

describe("(CHAIR-1 Slice 2) balance at arrival — information, never a block", () => {
  it("the warning setting is off by default and is per currency (no single cross-currency threshold)", () => {
    expect(SETTING_DEFAULTS["reception.balance_warning_minor"]).toBe("");
    expect(parseBalanceWarning("")).toEqual({ ok: true, thresholds: {} });
    expect(parseBalanceWarning("{}")).toEqual({ ok: true, thresholds: {} });
    expect(parseBalanceWarning('{"YER":50000,"USD":0}')).toEqual({ ok: true, thresholds: { YER: 50000 } });
    expect(parseBalanceWarning("50000").ok).toBe(false);
    expect(parseBalanceWarning('{"EUR":1}').ok).toBe(false);
    expect(parseBalanceWarning('{"YER":-1}').ok).toBe(false);
    expect(parseBalanceWarning('{"YER":1.5}').ok).toBe(false);
  });

  it("the settings validator accepts empty/off and valid JSON, and rejects the rest in Arabic", () => {
    expect(settingDefinition("reception.balance_warning_minor")?.category).toBe("reception");
    expect(validateTypedSetting("reception.balance_warning_minor", "")).toBeNull();
    expect(validateTypedSetting("reception.balance_warning_minor", '{"SAR":10000}')).toBeNull();
    expect(validateTypedSetting("reception.balance_warning_minor", "abc")).toMatch(/[؀-ۿ]/);
  });

  it("lines are per currency, due only, flagged at the threshold — credit and zero are not dues", () => {
    expect(balanceLines([
      { currency: "USD", dueMinor: 20000 },
      { currency: "YER", dueMinor: 49999 },
      { currency: "SAR", dueMinor: 0 },
    ], { YER: 50000, USD: 20000 })).toEqual([
      { currency: "YER", dueMinor: 49999, warn: false },
      { currency: "USD", dueMinor: 20000, warn: true },
    ]);
    expect(balanceLines([{ currency: "YER", dueMinor: 90000 }], {})).toEqual([{ currency: "YER", dueMinor: 90000, warn: false }]);
  });
});

