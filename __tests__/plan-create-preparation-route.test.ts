import { beforeEach, describe, expect, it, vi } from "vitest";
import { withDefaults } from "../lib/settings";
import type { Service } from "../lib/db";

// Real POST + real preparation/pricing/template functions; synthetic session and
// catalog/writer/audit boundaries. This proves HTTP parity, not DB atomicity.
const boundary = vi.hoisted(() => ({
  createPlan: vi.fn(), createPlanV2: vi.fn(), recordAudit: vi.fn(),
  getSettings: vi.fn(), listServices: vi.fn(), requireSession: vi.fn(),
  findUserByUsername: vi.fn(), doctorOwnsPatient: vi.fn(), clinicDate: vi.fn(),
  events: [] as string[],
}));
vi.mock("@/lib/db", () => ({ ...boundary, CLINIC_TIME_ZONE: "Asia/Aden" }));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/schedule", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/schedule")>(),
  clinicDateString: boundary.clinicDate,
}));
import { POST } from "../app/api/plans/route";

// Same agreement values as plan-agreement-pricing-route.test.ts; templates use
// the existing ready-made endodontic scenario from specialty-templates.test.ts.
const service: Service = {
  id: 8, name: "Synthetic treatment", category: "rct", priceMinor: 30000,
  priceSarMinor: 30000, priceUsdMinor: 30000, priceConfigured: true,
  priceProvisional: false, isActive: true, sortOrder: 0,
};
const item = { serviceId: 8, quantity: 1, unitPriceMinor: 30000, sessionCount: 2, billingRule: "on_completion" };
const base = { patientId: "91", title: "  Synthetic agreement  ", currency: "SAR" };
const legacy = { ...base, total: "200.01", count: 3 };
const v2 = { ...base, mode: "v2", items: [item] };
const template = { ...base, mode: "template", templateId: "endo", teeth: [16, 26, 16] };
const post = (body: unknown) => POST(new Request("http://localhost/api/plans", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}));
const noWrite = () => {
  expect(boundary.createPlan).not.toHaveBeenCalled();
  expect(boundary.createPlanV2).not.toHaveBeenCalled();
  expect(boundary.recordAudit).not.toHaveBeenCalled();
};
const noPreparation = () => {
  expect(boundary.clinicDate).not.toHaveBeenCalled();
  expect(boundary.getSettings).not.toHaveBeenCalled();
  expect(boundary.listServices).not.toHaveBeenCalled();
  noWrite();
};
beforeEach(() => {
  vi.resetAllMocks(); boundary.events.length = 0;
  boundary.requireSession.mockImplementation(async () => {
    boundary.events.push("session"); return { username: "synthetic-reception", role: "reception" };
  });
  boundary.clinicDate.mockImplementation(() => { boundary.events.push("date"); return "2026-11-01"; });
  boundary.getSettings.mockImplementation(async () => { boundary.events.push("settings"); return withDefaults({ "billing.max_discount_percent": "10" }); });
  boundary.listServices.mockImplementation(async () => { boundary.events.push("services"); return [service]; });
  boundary.createPlan.mockImplementation(async () => { boundary.events.push("legacy-write"); return 42; });
  boundary.createPlanV2.mockImplementation(async () => { boundary.events.push("v2-write"); return { ok: true, planId: 41 }; });
  boundary.recordAudit.mockImplementation(async () => { boundary.events.push("audit"); });
});

describe("plan create preparation route parity", () => {
  it("keeps legacy writer input, split rounding, 201 body and absence of route audit", async () => {
    const response = await post(legacy);
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ id: 42 });
    expect(boundary.createPlan).toHaveBeenCalledExactlyOnceWith({
      patientId: 91, title: "Synthetic agreement", totalMinor: 20001,
      baseCurrency: "SAR", startDate: "2026-11-01", note: null, createdBy: "synthetic-reception",
      installments: [
        { number: 1, dueDate: "2026-11-01", amountMinor: 6667 },
        { number: 2, dueDate: "2026-12-01", amountMinor: 6667 },
        { number: 3, dueDate: "2026-12-31", amountMinor: 6667 },
      ],
    });
    expect(boundary.events).toEqual(["session", "date", "legacy-write"]);
    expect(boundary.createPlanV2).not.toHaveBeenCalled(); expect(boundary.recordAudit).not.toHaveBeenCalled();
    expect(boundary.clinicDate).toHaveBeenCalledWith(expect.any(Date), "Asia/Aden");
  });
  it("keeps legacy clinical empty plans, including the existing null-ID success shape", async () => {
    boundary.createPlan.mockResolvedValue(null);
    const response = await post({ ...base, mode: "clinical" });
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ id: null });
    expect(boundary.createPlan).toHaveBeenCalledWith(expect.objectContaining({ totalMinor: 0, installments: [] }));
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
  it("passes authoritative V2 inputs and adds the created ID only when auditing", async () => {
    const response = await post({ ...v2, items: [{ ...item, serviceName: "forged", category: "forged" }] });
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ id: 41 });
    expect(boundary.createPlanV2).toHaveBeenCalledExactlyOnceWith({
      patientId: 91, title: "Synthetic agreement", specialty: null, primaryDoctorId: null,
      billingMode: "per_procedure", baseCurrency: "SAR", startDate: "2026-11-01", note: null,
      createdBy: "synthetic-reception", installments: [], items: [{
        serviceId: 8, serviceName: service.name, category: "rct", toothCode: null, surfaces: null,
        quantity: 1, unitPriceMinor: 30000, billingRule: "on_completion", sessionCount: 2, note: null,
      }],
    });
    expect(boundary.recordAudit).toHaveBeenCalledExactlyOnceWith({
      action: "plan.create_v2", entity: "treatment_plan", entityId: 41, entityLabel: "Synthetic agreement",
      details: { البنود: 1, الجلسات: 2, طريقة_الدفع: "per_procedure", الأقساط: 0 },
      actor: "synthetic-reception", actorRole: "reception",
    });
    expect(boundary.events).toEqual(["session", "date", "services", "settings", "v2-write", "audit"]);
    expect(boundary.createPlan).not.toHaveBeenCalled();
  });
  it("keeps template selection/read order, grouped sessions and its detailed audit", async () => {
    const response = await post({ ...template, items: [{ ...item, unitPriceMinor: 1 }] });
    expect(response.status).toBe(201); expect(await response.json()).toEqual({ id: 41 });
    expect(boundary.events).toEqual(["session", "date", "settings", "services", "settings", "v2-write", "audit"]);
    const saved = boundary.createPlanV2.mock.calls[0][0];
    expect(saved).toMatchObject({ specialty: "علاج عصب", billingMode: "per_procedure", installments: [] });
    expect(saved.items).toHaveLength(2);
    expect(saved.items.map((row: { toothCode: number; unitPriceMinor: number; sessionCount: number }) =>
      [row.toothCode, row.unitPriceMinor, row.sessionCount])).toEqual([[16, 30000, 3], [26, 30000, 3]]);
    expect(saved.items[0].sessionPlan).toEqual(saved.items[1].sessionPlan);
    expect(saved.items[0].sessionPlan[2]).toEqual({
      title: "حشو القنوات النهائي", minutes: 45, afterDays: 7,
      visitKey: "rct:2", visitTitle: "حشو القنوات النهائي — سن 16، 26",
    });
    expect(boundary.recordAudit).toHaveBeenCalledExactlyOnceWith({
      action: "plan.create_v2", entity: "treatment_plan", entityId: 41, entityLabel: "Synthetic agreement",
      details: { القالب: "علاج عصب + تاج", الأسنان: "16، 26", البنود: 2, الجلسات: 6 },
      actor: "synthetic-reception", actorRole: "reception",
    });
  });
  it.each([v2, template])("retains the public V2 writer refusal without audit", async (body) => {
    boundary.createPlanV2.mockResolvedValue({ ok: false, message: "Synthetic writer refusal" });
    const response = await post(body);
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ message: "Synthetic writer refusal" });
    expect(boundary.createPlanV2).toHaveBeenCalledOnce(); expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
  it.each([
    [legacy, "تعذّر إنشاء الخطة. تأكد من المريض."],
    [v2, "تعذّر إنشاء الخطة. تأكد من المريض."],
    [template, "تعذّر إنشاء الخطة من القالب."],
  ])("keeps each writer error's existing 500 body", async (body, message) => {
    boundary.createPlan.mockRejectedValue(new Error("synthetic"));
    boundary.createPlanV2.mockRejectedValue(new Error("synthetic"));
    const response = await post(body);
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ message });
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
  it.each([[v2, "تعذّر إنشاء الخطة. تأكد من المريض."], [template, "تعذّر إنشاء الخطة من القالب."]])(
    "still catches a rejected public audit after its successful writer", async (body, message) => {
      boundary.recordAudit.mockRejectedValue(new Error("synthetic"));
      const response = await post(body);
      expect(response.status).toBe(500); expect(await response.json()).toEqual({ message });
      expect(boundary.createPlanV2).toHaveBeenCalledOnce(); expect(boundary.recordAudit).toHaveBeenCalledOnce();
    },
  );
  it("keeps the assembled agreement-price code and exact message without a write", async () => {
    const response = await post({ ...v2, total: "200", pricingMode: "agreed" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "agreement_pricing_unsupported",
      message: "لا يمكن حفظ هذا الاتفاق حاليًا دون تغيير مبلغه. المبلغ المتفق عليه يختلف عن طريقة حساب الإجمالي المحفوظ؛ لم تُحفظ الخطة ولم تتغير بنود المسودة.",
    });
    noWrite();
  });
  it("does not read mutable dependencies before session denial", async () => {
    boundary.requireSession.mockResolvedValue(null);
    const response = await post(template);
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ message: "انتهت الجلسة. سجّل الدخول من جديد." });
    noPreparation();
  });
  it("retains bounded body rejection before preparation", async () => {
    const response = await POST(new Request("http://localhost/api/plans", { method: "POST", body: "{" }));
    expect(response.status).toBe(400); noPreparation();
  });
  it("does not read mutable dependencies before role denial", async () => {
    boundary.requireSession.mockResolvedValue({ role: "assistant", username: "synthetic-assistant" });
    const response = await post(template);
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ message: "خطط العلاج للإدارة والاستقبال." });
    noPreparation();
  });
  it("retains doctor permission denial before patient/title validation", async () => {
    boundary.requireSession.mockResolvedValue({ role: "doctor", username: "synthetic-doctor", partyId: 7 });
    boundary.findUserByUsername.mockResolvedValue({ partyId: 7, permissions: { canEditPlans: false } });
    const response = await post({ ...template, patientId: 0, title: "" });
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ message: "غير مصرّح لك بإنشاء أو تعديل خطط العلاج." });
    expect(boundary.doctorOwnsPatient).not.toHaveBeenCalled(); noPreparation();
  });
  it("retains doctor ownership denial before preparation", async () => {
    boundary.requireSession.mockResolvedValue({ role: "doctor", username: "synthetic-doctor", partyId: 7 });
    boundary.findUserByUsername.mockResolvedValue({ partyId: 7, permissions: { canEditPlans: true } });
    boundary.doctorOwnsPatient.mockResolvedValue(false);
    const response = await post(template);
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ message: "غير مصرّح لك بإنشاء خطة لهذا المريض." });
    expect(boundary.doctorOwnsPatient).toHaveBeenCalledWith(7, 91); noPreparation();
  });
  it("preserves doctor session party fallback and authorized actor through creation", async () => {
    boundary.requireSession.mockResolvedValue({ role: "doctor", username: "synthetic-doctor", partyId: 7 });
    boundary.findUserByUsername.mockResolvedValue(null); boundary.doctorOwnsPatient.mockResolvedValue(true);
    expect((await post(v2)).status).toBe(201);
    expect(boundary.doctorOwnsPatient).toHaveBeenCalledWith(7, 91);
    expect(boundary.createPlanV2).toHaveBeenCalledWith(expect.objectContaining({ createdBy: "synthetic-doctor" }));
    expect(boundary.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ actor: "synthetic-doctor", actorRole: "doctor" }));
  });
  it("keeps patient validation before title/currency/date resolution for finance roles", async () => {
    const response = await post({ ...template, patientId: 0, title: "", currency: "EUR" });
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ message: "اختر المريض أولًا." }); noPreparation();
  });
  it("retains unhandled first-template and V2 catalog-read rejections", async () => {
    const failure = new Error("synthetic read failure");
    boundary.getSettings.mockRejectedValue(failure);
    await expect(post(template)).rejects.toBe(failure); noWrite();
    await expect(post(v2)).rejects.toBe(failure); noWrite();
  });
  it("retains the second template-read failure's template-specific 500", async () => {
    boundary.getSettings.mockResolvedValueOnce(withDefaults({})).mockRejectedValueOnce(new Error("synthetic read failure"));
    const response = await post(template);
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ message: "تعذّر إنشاء الخطة من القالب." }); noWrite();
  });
  it("resolves the date again per new request and does not create a replay contract", async () => {
    boundary.clinicDate.mockReturnValueOnce("2026-11-01").mockReturnValueOnce("2026-11-02");
    await post(legacy); await post(legacy);
    expect(boundary.createPlan.mock.calls.map(([input]) => input.startDate)).toEqual(["2026-11-01", "2026-11-02"]);
    expect(boundary.createPlan).toHaveBeenCalledTimes(2);
  });
});
