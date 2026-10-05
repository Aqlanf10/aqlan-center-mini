import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLEARANCE_REQUIRED_MESSAGE, CLEARANCE_WARNING, EMERGENCY_BYPASS_WARNING, EMERGENCY_REASON_MESSAGE,
  balanceLines, chairStepper, clearanceGate, deriveReadiness, normalizeEmergencyReason,
  parseBalanceWarning, suggestSpecialtyTab, type ReadinessFacts,
} from "../lib/chair-readiness";
import { validateTypedSetting } from "../lib/settings-validate";
import { SETTING_DEFAULTS } from "../lib/settings";
import { settingDefinition } from "../lib/settings-definitions";
import { sendGatedMove } from "../components/today/useChairReadiness";

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
      items: [{ key: "file", state: "attention", label: "بلا ملف — اربطه بملفٍّ أو افتحه" }], attention: 1, alerts: [], historyAlerts: [],
    });
  });
});

describe("(CHAIR-1 Slice 3) ready-for-chair gate decision", () => {
  const base = { cleared: false, requireClearance: false, action: "call" as const, fromStatus: "waiting", emergency: false, emergencyReason: null };

  it("a cleared visit always passes without a warning, setting on or off", () => {
    expect(clearanceGate({ ...base, cleared: true })).toEqual({ allow: true, warning: null, bypass: false });
    expect(clearanceGate({ ...base, cleared: true, requireClearance: true })).toEqual({ allow: true, warning: null, bypass: false });
  });

  it("setting OFF (the default): not cleared ⇒ passes with a text warning — zero extra clicks", () => {
    expect(clearanceGate(base)).toEqual({ allow: true, warning: CLEARANCE_WARNING, bypass: false });
    expect(clearanceGate({ ...base, action: "seat" })).toEqual({ allow: true, warning: CLEARANCE_WARNING, bypass: false });
    expect(SETTING_DEFAULTS["ops.require_clearance_before_call"]).toBe("false");
  });

  it("setting ON: not cleared ⇒ refused with an Arabic message", () => {
    expect(clearanceGate({ ...base, requireClearance: true }))
      .toEqual({ allow: false, code: "clearance_required", message: CLEARANCE_REQUIRED_MESSAGE });
    expect(clearanceGate({ ...base, requireClearance: true, action: "seat" }).allow).toBe(false);
  });

  it("setting ON: an emergency with a written reason bypasses (audited); without a reason it is refused", () => {
    expect(clearanceGate({ ...base, requireClearance: true, emergency: true, emergencyReason: "نزيف بعد خلع" }))
      .toEqual({ allow: true, warning: EMERGENCY_BYPASS_WARNING, bypass: true });
    expect(clearanceGate({ ...base, requireClearance: true, emergency: true, emergencyReason: null }))
      .toEqual({ allow: false, code: "emergency_reason_required", message: EMERGENCY_REASON_MESSAGE });
  });

  it("seating a patient who was already called is not refused a second time (the call passed the gate)", () => {
    expect(clearanceGate({ ...base, requireClearance: true, action: "seat", fromStatus: "called" }))
      .toEqual({ allow: true, warning: CLEARANCE_WARNING, bypass: false });
  });

  it("an emergency reason is trimmed, capped and must be at least three characters", () => {
    expect(normalizeEmergencyReason("  ألم حاد  ")).toBe("ألم حاد");
    expect(normalizeEmergencyReason("ab")).toBeNull();
    expect(normalizeEmergencyReason(42)).toBeNull();
    expect(normalizeEmergencyReason("x".repeat(400))).toHaveLength(300);
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
    expect(validateTypedSetting("ops.require_clearance_before_call", "true")).toBeNull();
    expect(validateTypedSetting("ops.require_clearance_before_call", "maybe")).toMatch(/[؀-ۿ]/);
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

describe("(CHAIR-1 Slice 4) stepper and specialty router", () => {
  const visit = { status: "waiting", clearedAt: null, seatedAt: null, signedAt: null, invoiceNetMinor: null, dueInInvoiceCurrencyMinor: null, deferred: false };

  it("وصول → جاهز → على الكرسي → توقيع → دفع, each read from its own fact", () => {
    expect(chairStepper(visit).current).toBe("ready");
    expect(chairStepper(visit).steps.map((step) => step.label)).toEqual(["وصول", "جاهز", "على الكرسي", "توقيع", "دفع"]);
    expect(chairStepper({ ...visit, status: "in_chair", seatedAt: "x" }).steps.map((step) => step.done))
      .toEqual([true, false, true, false, false]);
    const signed = { ...visit, status: "done", clearedAt: "x", seatedAt: "x", signedAt: "x", invoiceNetMinor: 15000, dueInInvoiceCurrencyMinor: 15000 };
    expect(chairStepper(signed).current).toBe("paid");
    expect(chairStepper({ ...signed, dueInInvoiceCurrencyMinor: 0 }).current).toBeNull();
    expect(chairStepper({ ...signed, deferred: true }).current).toBeNull();
    expect(chairStepper({ ...signed, invoiceNetMinor: null }).current).toBeNull();
  });

  it("suggests (never switches): ortho first, then today's planned session, then the open visit", () => {
    expect(suggestSpecialtyTab({ orthoActive: true, plannedTodayTitle: "حشو", planSpecialty: null, hasOpenVisit: true })?.tab).toBe("ortho");
    expect(suggestSpecialtyTab({ orthoActive: false, plannedTodayTitle: "علاج عصب ٣٦", planSpecialty: "علاج الجذور", hasOpenVisit: true }))
      .toEqual({ tab: "plans", label: "خطط العلاج", reason: "جلسة مخطَّطة: علاج عصب ٣٦ (علاج الجذور)" });
    expect(suggestSpecialtyTab({ orthoActive: false, plannedTodayTitle: null, planSpecialty: null, hasOpenVisit: true })?.tab).toBe("today");
    expect(suggestSpecialtyTab({ orthoActive: false, plannedTodayTitle: null, planSpecialty: null, hasOpenVisit: false })).toBeNull();
  });
});

describe("(CHAIR-1 Slice 3) the board's gated move adds no request and no prompt when the setting is off", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("warn-only response: one request, no prompt", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 1, warning: CLEARANCE_WARNING }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ask = vi.fn(() => "x");
    const response = await sendGatedMove(1, { action: "call", chair: 2 }, ask);
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
  });

  it("a chair conflict (409 without a gate code) is returned as is — no prompt", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: "الكرسي شُغل" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    const ask = vi.fn(() => "x");
    expect((await sendGatedMove(1, { action: "seat", chair: 2 }, ask)).status).toBe(409);
    expect(ask).not.toHaveBeenCalled();
  });

  it("setting on: the refusal asks for an emergency reason and resends it; cancelling keeps the refusal", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return body.emergency
        ? new Response(JSON.stringify({ id: 1, warning: EMERGENCY_BYPASS_WARNING }), { status: 200 })
        : new Response(JSON.stringify({ message: CLEARANCE_REQUIRED_MESSAGE, code: "clearance_required" }), { status: 409 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ok = await sendGatedMove(1, { action: "call", chair: 1 }, () => "نزيف");
    expect(ok.status).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ action: "call", chair: 1, emergency: true, emergencyReason: "نزيف" });
    fetchMock.mockClear();
    expect((await sendGatedMove(1, { action: "call", chair: 1 }, () => null)).status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
