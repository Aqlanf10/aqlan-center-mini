import { describe, expect, it, vi } from "vitest";
import type { AuditInput, Service, createPlan, createPlanV2 } from "../lib/db";
import type { Role } from "../lib/roles";
import type { SettingsMap } from "../lib/settings";
import type { SpecialtyTemplate } from "../lib/specialty-templates";
import { resolvePlanCreatePreparation } from "../lib/plan-create-preparation";

// Pure preparation contract: no DB runtime import, writer, route, or transaction
// harness. These cases assert the data handed to the existing writers, not a
// database commit/rollback guarantee. Expected prices and schedules are literals.
type LegacyInput = Parameters<typeof createPlan>[0];
type V2Input = Parameters<typeof createPlanV2>[0];
type Actor = { username: string; role: Role };
const actor: Actor = { username: "synthetic-reception", role: "reception" };
const failureMessage = "تعذّر إنشاء الخطة. تأكد من المريض.";
const templateFailure = "تعذّر إنشاء الخطة من القالب.";
const unsupportedMessage = "لا يمكن حفظ هذا الاتفاق حاليًا دون تغيير مبلغه. المبلغ المتفق عليه يختلف عن طريقة حساب الإجمالي المحفوظ؛ لم تُحفظ الخطة ولم تتغير بنود المسودة.";
const invalidAgreementMessage = "اكتب مبلغ الاتفاق الصحيح الأكبر من صفر بعملة الخطة.";

function service(overrides: Partial<Service> = {}): Service {
  return {
    id: 8, name: "Synthetic treatment", category: "general", priceMinor: 30000,
    priceSarMinor: 30000, priceUsdMinor: 30000, priceConfigured: true,
    priceProvisional: false, isActive: true, sortOrder: 1, ...overrides,
  };
}

function settings(overrides: Partial<SettingsMap> = {}): SettingsMap {
  // Only these settings are consumed by preparation; no DB settings load occurs.
  return {
    "billing.max_discount_percent": "10", "plans.specialty_templates": "",
    "finance.rate.SAR": "140", "finance.rate.USD": "530", ...overrides,
  } as SettingsMap;
}

function harness() {
  const state = { catalog: [service()], settings: settings(), today: "2026-11-01" };
  const dependencies = {
    getSettings: vi.fn(async (): Promise<SettingsMap> => state.settings),
    listServices: vi.fn(async (): Promise<Service[]> => state.catalog),
    clinicDate: vi.fn(() => state.today),
  };
  return {
    state, dependencies,
    prepare: (source: Record<string, unknown>, who: Actor = actor, patientId = 91) =>
      resolvePlanCreatePreparation(source, patientId, who, dependencies),
  };
}

const source = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  patientId: 91, title: "Synthetic agreement", currency: "SAR", startDate: "2026-11-01", ...overrides,
});
const item = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  serviceId: 8, quantity: 1, unitPriceMinor: 30000, toothCode: 36,
  billingRule: "on_completion", sessionCount: 2, ...overrides,
});
const v2Source = (overrides: Record<string, unknown> = {}): Record<string, unknown> => source({
  mode: "v2", billingMode: "per_procedure", items: [item()], ...overrides,
});
const normalizedItem: V2Input["items"][number] = {
  serviceId: 8, serviceName: "Synthetic treatment", category: "general", toothCode: 36,
  surfaces: null, quantity: 1, unitPriceMinor: 30000, billingRule: "on_completion", sessionCount: 2, note: null,
};
const v2Input = (overrides: Partial<V2Input> = {}): V2Input => ({
  patientId: 91, title: "Synthetic agreement", specialty: null, primaryDoctorId: null,
  billingMode: "per_procedure", baseCurrency: "SAR", startDate: "2026-11-01", note: null,
  items: [{ ...normalizedItem }], installments: [], createdBy: actor.username, ...overrides,
});
const v2Audit = (overrides: Partial<Omit<AuditInput, "entityId">> = {}): Omit<AuditInput, "entityId"> => ({
  action: "plan.create_v2", entity: "treatment_plan", entityLabel: "Synthetic agreement",
  details: { البنود: 1, الجلسات: 2, طريقة_الدفع: "per_procedure", الأقساط: 0 },
  actor: actor.username, actorRole: actor.role, ...overrides,
});
const invalid = (message: string, code?: string) => ({
  ok: false, status: 400, body: code ? { message, code } : { message },
});

describe("plan preparation common validation and legacy writers", () => {
  it.each([0, -1, 1.5, NaN, Infinity])("rejects patient id %s before title/currency/default work", async (patientId) => {
    const h = harness();
    expect(await h.prepare(source({ patientId: 91, title: "", currency: "invalid", mode: "template" }), actor, patientId))
      .toEqual(invalid("اختر المريض أولًا."));
    expect(h.dependencies.clinicDate).not.toHaveBeenCalled();
    expect(h.dependencies.getSettings).not.toHaveBeenCalled();
    expect(h.dependencies.listServices).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "", "   ", 5, "x".repeat(121)])("rejects title %s before currency or dependency reads", async (title) => {
    const h = harness();
    expect(await h.prepare(source({ title, currency: "invalid", mode: "template" })))
      .toEqual(invalid("اكتب اسم الخطة — مثل: تقويم ثابت فكّين."));
    expect(h.dependencies.clinicDate).not.toHaveBeenCalled();
    expect(h.dependencies.getSettings).not.toHaveBeenCalled();
    expect(h.dependencies.listServices).not.toHaveBeenCalled();
  });

  it.each(["EUR", "sar", " SAR ", 1, false, {}])("rejects nonblank unknown currency %s before date/default work", async (currency) => {
    const h = harness();
    expect(await h.prepare(source({ currency, total: "invalid" })))
      .toEqual(invalid("عملة الخطة يجب أن تكون YER أو SAR أو USD."));
    expect(h.dependencies.clinicDate).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "", "   "])("defaults blank currency %s to YER", async (currency) => {
    const h = harness();
    const result = await h.prepare(source({ currency, total: "25", count: 1 }));
    expect(result).toEqual({ ok: true, plan: {
      writer: "legacy", audit: null, failureMessage,
      input: { patientId: 91, title: "Synthetic agreement", totalMinor: 25, baseCurrency: "YER",
        startDate: "2026-11-01", note: null, createdBy: actor.username,
        installments: [{ number: 1, dueDate: "2026-11-01", amountMinor: 25 }] },
    } });
  });

  it("prepares exact financial input, including numbered remainder-first installments and trusted identity", async () => {
    const h = harness();
    const input: LegacyInput = {
      patientId: 91, title: "Trimmed title", totalMinor: 10001, baseCurrency: "SAR", startDate: "2026-11-01",
      note: "n".repeat(300), createdBy: actor.username,
      installments: [
        { number: 1, dueDate: "2026-11-01", amountMinor: 3335 },
        { number: 2, dueDate: "2026-11-08", amountMinor: 3333 },
        { number: 3, dueDate: "2026-11-15", amountMinor: 3333 },
      ],
    };
    expect(await h.prepare(source({
      patientId: 999, title: "  Trimmed title  ", mode: "financial", total: "١٠٠٫٠١",
      count: "3.4", everyDays: "7.4", note: `  ${"n".repeat(305)}  `,
      createdBy: "forged-user", installments: [{ amountMinor: 1 }],
    }))).toEqual({ ok: true, plan: { writer: "legacy", input, audit: null, failureMessage } });
    expect(h.dependencies.clinicDate).toHaveBeenCalledOnce();
    expect(h.dependencies.listServices).not.toHaveBeenCalled();
    expect(h.dependencies.getSettings).not.toHaveBeenCalled();
  });

  it("keeps clinical input empty and ignores otherwise invalid financial controls", async () => {
    const h = harness();
    expect(await h.prepare(source({ mode: "clinical", total: "invalid", count: Infinity, everyDays: "invalid",
      currency: "USD", note: "  ", title: ` ${"t".repeat(120)} `, startDate: "2026-99-99" })))
      .toEqual({ ok: true, plan: { writer: "legacy", audit: null, failureMessage, input: {
        patientId: 91, title: "t".repeat(120), totalMinor: 0, baseCurrency: "USD",
        startDate: "2026-99-99", note: null, createdBy: actor.username, installments: [],
      } } });
    expect(h.dependencies.listServices).not.toHaveBeenCalled();
    expect(h.dependencies.getSettings).not.toHaveBeenCalled();
  });

  it("reads the current clinic date on every call, without caching defaults", async () => {
    const h = harness();
    const body = source({ mode: "clinical", startDate: "not-a-date", currency: undefined });
    const first = await h.prepare(body);
    h.state.today = "2026-11-02";
    const second = await h.prepare(body);
    expect(first.ok && first.plan.input.startDate).toBe("2026-11-01");
    expect(second.ok && second.plan.input.startDate).toBe("2026-11-02");
    expect(h.dependencies.clinicDate).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "unknown", "Clinical", null])("retains financial fallback for mode %s", async (mode) => {
    expect(await harness().prepare(source({ mode, total: "0" })))
      .toEqual(invalid("اكتب المبلغ الإجمالي المتفق عليه."));
  });

  it.each<[Record<string, unknown>, string]>([
    [{ total: "invalid", count: 0, everyDays: 0 }, "اكتب المبلغ الإجمالي المتفق عليه."],
    [{ total: "10", count: 0, everyDays: 0 }, "عدد الأقساط بين 1 و60."],
    [{ total: "10", count: 61, everyDays: 0 }, "عدد الأقساط بين 1 و60."],
    [{ total: "10", count: NaN, everyDays: 0 }, "عدد الأقساط بين 1 و60."],
    [{ total: "10", count: 1, everyDays: 0 }, "المدة بين الأقساط بين 1 و365 يومًا."],
    [{ total: "10", count: 1, everyDays: 366 }, "المدة بين الأقساط بين 1 و365 يومًا."],
    [{ total: "10", count: 1, everyDays: Infinity }, "المدة بين الأقساط بين 1 و365 يومًا."],
  ])("preserves legacy validation order for %j", async (body, message) => {
    expect(await harness().prepare(source(body))).toEqual(invalid(message));
  });
});

describe("V2 normalized writer input and audit preparation", () => {
  it("uses catalog identity, normalizes values, and preserves a partial custom schedule", async () => {
    const h = harness();
    const installments = [{ dueDate: "2026-11-15", amountMinor: 10000 }];
    const input = v2Input({ specialty: "s".repeat(80), primaryDoctorId: 7, note: "n".repeat(300),
      billingMode: "custom_schedule", installments,
      items: [{ ...normalizedItem, surfaces: " MO ", sessionCount: 12, note: "i".repeat(300) }],
    });
    expect(await h.prepare(v2Source({
      patientId: 999, createdBy: "forged", title: " Synthetic agreement ",
      specialty: ` ${"s".repeat(90)} `, primaryDoctorId: "7", note: ` ${"n".repeat(305)} `,
      billingMode: "custom_schedule", total: "300.004", pricingMode: "agreed",
      items: [item({ serviceId: "8", serviceName: "Forged name", category: "forged-category",
        quantity: "1.4", unitPriceMinor: 30000.4, toothCode: "36", surfaces: " MO ",
        billingRule: "package", sessionCount: 99, note: ` ${"i".repeat(305)} ` })],
      installments: [{ dueDate: "2026-11-15", amountMinor: "10000.4" },
        { dueDate: "invalid", amountMinor: 20000 }, { dueDate: "2026-11-20", amountMinor: -1 },
        { dueDate: "2026-11-21", amountMinor: "nonsense" }],
    }))).toEqual({ ok: true, plan: { writer: "v2", input, failureMessage,
      audit: v2Audit({ details: { البنود: 1, الجلسات: 12, طريقة_الدفع: "custom_schedule", الأقساط: 1 } }),
    } });
    expect(h.dependencies.listServices).toHaveBeenCalledOnce();
    expect(h.dependencies.getSettings).toHaveBeenCalledOnce();
  });

  it.each<[Record<string, unknown>, Partial<V2Input["items"][number]>]>([
    [{ quantity: 0, sessionCount: 0 }, { quantity: 1, sessionCount: 1 }],
    [{ quantity: -5, sessionCount: "invalid" }, { quantity: 1, sessionCount: 1 }],
    [{ quantity: 1.5, sessionCount: 2.5 }, { quantity: 2, sessionCount: 3 }],
  ])("preserves quantity/session rounding for %j", async (raw, normalized) => {
    const h = harness();
    const result = await h.prepare(v2Source({ items: [item(raw)] }));
    expect(result.ok && result.plan.writer === "v2" && result.plan.input.items)
      .toEqual([{ ...normalizedItem, ...normalized }]);
  });

  it("normalizes optional V2 fields and retains current positive numeric tooth/doctor coercion", async () => {
    const result = await harness().prepare(v2Source({ specialty: " ", primaryDoctorId: "7.5",
      items: [item({ toothCode: "99.5", surfaces: " ", note: 6, sessionCount: Infinity })] }));
    expect(result).toEqual({ ok: true, plan: { writer: "v2", failureMessage,
      input: v2Input({ primaryDoctorId: 7.5, items: [{ ...normalizedItem, toothCode: 99.5, sessionCount: 1 }] }),
      audit: v2Audit({ details: { البنود: 1, الجلسات: 1, طريقة_الدفع: "per_procedure", الأقساط: 0 } }),
    } });
  });

  it("keeps the 100-item slice before validation and agreement calculation", async () => {
    const h = harness();
    const result = await h.prepare(v2Source({ items: [...Array.from({ length: 100 }, () => item()),
      item({ serviceId: 999, unitPriceMinor: 1 })], total: "30000" }));
    expect(result).toEqual({ ok: true, plan: { writer: "v2", failureMessage,
      input: v2Input({ items: Array.from({ length: 100 }, () => ({ ...normalizedItem })) }),
      audit: v2Audit({ details: { البنود: 100, الجلسات: 200, طريقة_الدفع: "per_procedure", الأقساط: 0 } }),
    } });
  });

  it.each([null, {}, { serviceId: 999 }, { serviceId: "bad", serviceName: "Synthetic treatment" }])("requires catalog membership before agreement validation for item %j", async (raw) => {
      expect(await harness().prepare(v2Source({ items: [raw], pricingMode: "unknown" })))
        .toEqual(invalid("اختر خدمة كل بند من الدليل."));
    });

  it("uses fresh discount settings and catalog authority on repeated calls", async () => {
    const h = harness();
    const body = v2Source({ items: [item({ unitPriceMinor: 24000, priceReason: " Approved discount " })], total: "240" });
    expect(await h.prepare(body)).toEqual(invalid("الخصم على «Synthetic treatment» 20٪ يتجاوز الحد المسموح (10٪) — يحتاج موافقة المدير."));
    h.state.settings = settings({ "billing.max_discount_percent": "30" });
    expect(await h.prepare(body)).toEqual({ ok: true, plan: { writer: "v2", failureMessage,
      input: v2Input({ items: [{ ...normalizedItem, unitPriceMinor: 24000 }] }),
      audit: v2Audit({ details: { البنود: 1, الجلسات: 2, طريقة_الدفع: "per_procedure", الأقساط: 0,
        أسعار_معدلة: "Synthetic treatment: 30000 ← 24000 (Approved discount)" } }),
    } });
    h.state.catalog = [service({ name: "Updated catalog name", category: "updated", priceSarMinor: 40000 })];
    expect(await h.prepare(body)).toEqual(invalid("الخصم على «Updated catalog name» 40٪ يتجاوز الحد المسموح (30٪) — يحتاج موافقة المدير."));
    h.state.settings = settings({ "billing.max_discount_percent": "50" });
    const final = await h.prepare(body);
    expect(final.ok && final.plan.writer === "v2" && final.plan.input.items)
      .toEqual([{ ...normalizedItem, serviceName: "Updated catalog name", category: "updated", unitPriceMinor: 24000 }]);
    expect(final.ok && final.plan.audit).toEqual(v2Audit({ details: {
      البنود: 1, الجلسات: 2, طريقة_الدفع: "per_procedure", الأقساط: 0,
      أسعار_معدلة: "Updated catalog name: 40000 ← 24000 (Approved discount)",
    } }));
    expect(h.dependencies.listServices).toHaveBeenCalledTimes(4);
    expect(h.dependencies.getSettings).toHaveBeenCalledTimes(4);
  });

  it.each<Role>(["admin", "reception", "doctor"])("requires a discount reason before agreement validation for %s", async (role) => {
    expect(await harness().prepare(v2Source({ pricingMode: "unknown", items: [item({ unitPriceMinor: 20000 })] }),
      { username: `synthetic-${role}`, role }))
      .toEqual(invalid("اكتب سبب الخصم على «Synthetic treatment» (33.3٪ عن سعر الدليل)."));
  });

  it("restricts price increases before the assembled agreement check", async () => {
    expect(await harness().prepare(v2Source({ total: "400", items: [item({ unitPriceMinor: 40000, priceReason: "Synthetic uplift" })] })))
      .toEqual(invalid("سعر «Synthetic treatment» أعلى من سعر الدليل — رفع السعر للمدير وحده."));
  });

  it("prepares exact admin override audit without an entity id", async () => {
    const who: Actor = { username: "synthetic-admin", role: "admin" };
    expect(await harness().prepare(v2Source({ total: "200", pricingMode: "agreed",
      items: [item({ unitPriceMinor: 20000, priceReason: " Approved synthetic discount " })] }), who))
      .toEqual({ ok: true, plan: { writer: "v2", failureMessage,
        input: v2Input({ createdBy: who.username, items: [{ ...normalizedItem, unitPriceMinor: 20000 }] }),
        audit: v2Audit({ actor: who.username, actorRole: "admin", details: {
          البنود: 1, الجلسات: 2, طريقة_الدفع: "per_procedure", الأقساط: 0,
          أسعار_معدلة: "Synthetic treatment: 30000 ← 20000 (Approved synthetic discount)",
        } }),
      } });
  });

  it("retains unpriced foreign agreement authority instead of imposing a converted catalog price", async () => {
    const h = harness();
    h.state.catalog = [service({ priceSarMinor: null })];
    h.state.settings = settings({ "finance.rate.SAR": "200", "billing.max_discount_percent": "0" });
    expect(await h.prepare(v2Source({ items: [item({ unitPriceMinor: 12345 })], total: "123.45" })))
      .toEqual({ ok: true, plan: { writer: "v2", failureMessage,
        input: v2Input({ items: [{ ...normalizedItem, unitPriceMinor: 12345 }] }),
        audit: v2Audit({ details: { البنود: 1, الجلسات: 2, طريقة_الدفع: "per_procedure", الأقساط: 0,
          أسعار_معدلة: "Synthetic treatment: 15000 ← 12345" } }),
      } });
  });
});

describe("V2 installment assembly and agreement guard", () => {
  it("prepares fallback installments with exact minor rounding and no catalog/settings read", async () => {
    const h = harness();
    const installments = [
      { dueDate: "2026-11-01", amountMinor: 6668 },
      { dueDate: "2026-12-01", amountMinor: 6666 },
      { dueDate: "2026-12-31", amountMinor: 6666 },
    ];
    expect(await h.prepare(v2Source({ billingMode: "unknown", items: [], total: "200", count: 3.4, everyDays: 30.4 })))
      .toEqual({ ok: true, plan: { writer: "v2", failureMessage,
        input: v2Input({ billingMode: "installments", items: [], installments }),
        audit: v2Audit({ details: { البنود: 0, الجلسات: 0, طريقة_الدفع: "installments", الأقساط: 3 } }),
      } });
    expect(h.dependencies.getSettings).not.toHaveBeenCalled();
    expect(h.dependencies.listServices).not.toHaveBeenCalled();
  });

  it("defaults an unknown billing mode with items to per_procedure", async () => {
    expect(await harness().prepare(v2Source({ billingMode: "unknown" })))
      .toEqual({ ok: true, plan: { writer: "v2", input: v2Input(), audit: v2Audit(), failureMessage } });
  });

  it("retains an explicit partial schedule even in per_procedure mode and ignores fallback controls", async () => {
    const installments = [{ dueDate: "2026-12-01", amountMinor: 10000 }];
    expect(await harness().prepare(v2Source({ total: "300", count: 3, everyDays: 30, installments })))
      .toEqual({ ok: true, plan: { writer: "v2", input: v2Input({ installments }), failureMessage,
        audit: v2Audit({ details: { البنود: 1, الجلسات: 2, طريقة_الدفع: "per_procedure", الأقساط: 1 } }),
      } });
  });

  it("falls back only when all explicit schedule rows were discarded", async () => {
    const result = await harness().prepare(v2Source({ items: [], billingMode: "installments", total: "200.01", count: 3,
      installments: [{ dueDate: "bad", amountMinor: 100 }, { dueDate: "2026-11-01", amountMinor: 0 }] }));
    expect(result.ok && result.plan.writer === "v2" && result.plan.input.installments).toEqual([
      { dueDate: "2026-11-01", amountMinor: 6667 }, { dueDate: "2026-12-01", amountMinor: 6667 },
      { dueDate: "2026-12-31", amountMinor: 6667 },
    ]);
  });

  it.each([
    { count: 0 }, { count: 61 }, { count: Infinity }, { count: 1, everyDays: 0 },
    { count: 1, everyDays: 366 }, { count: 1, everyDays: Infinity },
  ])("does not synthesize a schedule from invalid fallback controls %j", async (controls) => {
    const result = await harness().prepare(v2Source({ billingMode: "installments", total: "300", ...controls }));
    expect(result).toEqual({ ok: true, plan: { writer: "v2", failureMessage,
      input: v2Input({ billingMode: "installments" }),
      audit: v2Audit({ details: { البنود: 1, الجلسات: 2, طريقة_الدفع: "installments", الأقساط: 0 } }),
    } });
  });

  it("does not synthesize custom_schedule installments when the array is absent", async () => {
    expect(await harness().prepare(v2Source({ billingMode: "custom_schedule", items: [], total: "200", count: 2 })))
      .toEqual(invalid(unsupportedMessage, "agreement_pricing_unsupported"));
  });

  it("keeps the empty-item schedule principal with no separate agreement and no schedule row cap", async () => {
    const installments = Array.from({ length: 61 }, () => ({ dueDate: "2026-11-01", amountMinor: 100 }));
    const result = await harness().prepare(v2Source({ items: [], billingMode: "custom_schedule", installments }));
    expect(result).toEqual({ ok: true, plan: { writer: "v2", failureMessage,
      input: v2Input({ items: [], billingMode: "custom_schedule", installments }),
      audit: v2Audit({ details: { البنود: 0, الجلسات: 0, طريقة_الدفع: "custom_schedule", الأقساط: 61 } }),
    } });
  });

  it.each([undefined, "items", "agreed"])("allows normalized matching agreement and partial schedule for pricingMode %s", async (pricingMode) => {
    const installments = [{ dueDate: "2026-12-01", amountMinor: 10000 }];
    const result = await harness().prepare(v2Source({ total: "300.004", pricingMode, billingMode: "custom_schedule", installments,
      items: [item({ quantity: 1.4, unitPriceMinor: 30000.4 })] }));
    expect(result.ok && result.plan.writer === "v2" && result.plan.input)
      .toEqual(v2Input({ billingMode: "custom_schedule", installments }));
  });

  it.each([undefined, "items", "agreed"])("rejects an explicit 300/200 mismatch for pricingMode %s", async (pricingMode) => {
    expect(await harness().prepare(v2Source({ total: "200", pricingMode })))
      .toEqual(invalid(unsupportedMessage, "agreement_pricing_unsupported"));
  });

  it.each<Role>(["admin", "reception", "doctor"])("does not bypass agreement principal validation for %s", async (role) => {
    expect(await harness().prepare(v2Source({ total: "400", pricingMode: "agreed" }), { username: `synthetic-${role}`, role }))
      .toEqual(invalid(unsupportedMessage, "agreement_pricing_unsupported"));
  });

  it("compares an empty-item agreement against the assembled rounded schedule", async () => {
    expect(await harness().prepare(v2Source({ items: [], billingMode: "custom_schedule", total: "300",
      installments: [{ dueDate: "2026-11-01", amountMinor: 10000.4 }] })))
      .toEqual(invalid(unsupportedMessage, "agreement_pricing_unsupported"));
  });

  it.each([undefined, null, ""])("preserves legacy item-only blank total %s", async (total) => {
    expect(await harness().prepare(v2Source({ total })))
      .toEqual({ ok: true, plan: { writer: "v2", input: v2Input(), audit: v2Audit(), failureMessage } });
  });

  it.each(["fixed", "", null])("rejects unsupported pricingMode %s before the empty-plan check", async (pricingMode) => {
    expect(await harness().prepare(v2Source({ items: [], pricingMode })))
      .toEqual(invalid(unsupportedMessage, "agreement_pricing_unsupported"));
  });

  it("rejects items pricing without items before considering an invalid explicit total", async () => {
    expect(await harness().prepare(v2Source({ items: [], pricingMode: "items", total: "bogus" })))
      .toEqual(invalid(unsupportedMessage, "agreement_pricing_unsupported"));
  });

  it.each([undefined, null, "", "0", "bogus"])("rejects invalid declared agreement %s before the empty-plan check", async (total) => {
    expect(await harness().prepare(v2Source({ items: [], pricingMode: "agreed", total })))
      .toEqual(invalid(invalidAgreementMessage, "invalid_agreement_total"));
  });

  it("returns the existing empty-plan message when no agreement validation fails", async () => {
    expect(await harness().prepare(v2Source({ items: [] })))
      .toEqual(invalid("أضف بنود الخطة أو المبلغ المتفق عليه مع جدول أقساطه."));
  });
});

const templateSource = (overrides: Record<string, unknown> = {}): Record<string, unknown> => source({
  mode: "template", templateId: "endo", currency: "YER", teeth: [16], ...overrides,
});
const templateCatalog = (): Service[] => [
  service({ id: 8, name: "نزع عصب — طاحونة", category: "rct", priceMinor: 40000 }),
  service({ id: 9, name: "تاج زركونيا", category: "crown", priceMinor: 100000, priceSarMinor: 90000 }),
];
const customTemplate = (name = "Saved template"): SpecialtyTemplate => ({
  id: "saved", name, specialty: "Saved specialty", description: "",
  steps: [{ key: "treatment", title: "Saved treatment", category: "general", preferredService: null,
    perTooth: false, optional: false, billingRule: "on_start", labWork: false,
    sessions: [{ title: "Saved session", minutes: 30, afterDays: 2 }],
  }],
});

describe("template preparation server authority and grouping", () => {
  it("prepares exact server-priced items, grouped sessions, and template audit", async () => {
    const h = harness();
    h.state.catalog = templateCatalog();
    const rctSessions = [
      { title: "فتح السن وتنظيف القنوات", minutes: 45, afterDays: 0, visitKey: "rct:0", visitTitle: "فتح السن وتنظيف القنوات — سن 16، 26" },
      { title: "تشكيل وتعقيم القنوات", minutes: 45, afterDays: 7, visitKey: "rct:1", visitTitle: "تشكيل وتعقيم القنوات — سن 16، 26" },
      { title: "حشو القنوات النهائي", minutes: 45, afterDays: 7, visitKey: "rct:2", visitTitle: "حشو القنوات النهائي — سن 16، 26" },
    ];
    const crownSessions = [
      { title: "تحضير السن وأخذ الطبعة", minutes: 45, afterDays: 3, visitKey: "crown:0", visitTitle: "تحضير السن وأخذ الطبعة — سن 16، 26" },
      { title: "تركيب التاج", minutes: 30, afterDays: 10, visitKey: "crown:1", visitTitle: "تركيب التاج — سن 16، 26" },
    ];
    const items: V2Input["items"] = [
      ...[16, 26].map((toothCode): V2Input["items"][number] => ({ serviceId: 8, serviceName: "نزع عصب — طاحونة", category: "rct",
        toothCode, surfaces: null, quantity: 1, unitPriceMinor: 40000, billingRule: "per_session", sessionCount: 3,
        note: null, sessionPlan: rctSessions })),
      ...[16, 26].map((toothCode): V2Input["items"][number] => ({ serviceId: 9, serviceName: "تاج زركونيا", category: "crown",
        toothCode, surfaces: null, quantity: 1, unitPriceMinor: 100000, billingRule: "on_start", sessionCount: 2,
        note: null, sessionPlan: crownSessions })),
    ];
    expect(await h.prepare(templateSource({ teeth: [16, "26", 16], primaryDoctorId: "7", note: " plan note ",
      specialty: "Forged specialty", billingMode: "installments", pricingMode: "agreed", total: "1",
      installments: [{ dueDate: "2026-11-01", amountMinor: 1 }], items: [item({ unitPriceMinor: 1 })],
      steps: [{ key: "rct", include: false, serviceId: "8", unitPriceMinor: 1, serviceName: "Forged" },
        { key: "crown", include: true, serviceId: null }],
    }))).toEqual({ ok: true, plan: { writer: "v2", failureMessage: templateFailure,
      input: v2Input({ specialty: "علاج عصب", primaryDoctorId: 7, baseCurrency: "YER", note: "plan note", items }),
      audit: v2Audit({ details: { القالب: "علاج عصب + تاج", الأسنان: "16، 26", البنود: 4, الجلسات: 10 } }),
    } });
    expect(h.dependencies.getSettings).toHaveBeenCalledTimes(2);
    expect(h.dependencies.listServices).toHaveBeenCalledOnce();
  });

  it("selects from the first settings read and prices from the second, in the existing order", async () => {
    const h = harness();
    h.state.catalog = [service({ priceMinor: 60000, priceSarMinor: null })];
    const order: string[] = [];
    h.dependencies.getSettings.mockImplementationOnce(async () => {
      order.push("select-template");
      return settings({ "plans.specialty_templates": JSON.stringify([customTemplate()]), "finance.rate.SAR": "100" });
    }).mockImplementationOnce(async () => {
      order.push("price-settings");
      return settings({ "plans.specialty_templates": JSON.stringify([customTemplate("Must not replace selected name")]), "finance.rate.SAR": "200" });
    });
    h.dependencies.listServices.mockImplementationOnce(async () => { order.push("catalog"); return h.state.catalog; });
    expect(await h.prepare(templateSource({ templateId: "saved", currency: "SAR", teeth: [], specialty: "forged" })))
      .toEqual({ ok: true, plan: { writer: "v2", failureMessage: templateFailure,
        input: v2Input({ specialty: "Saved specialty", items: [{ ...normalizedItem, toothCode: null,
          unitPriceMinor: 30000, billingRule: "on_start", sessionCount: 1,
          sessionPlan: [{ title: "Saved session", minutes: 30, afterDays: 2, visitKey: "treatment:0", visitTitle: "Saved session" }],
        }] }),
        audit: v2Audit({ details: { القالب: "Saved template", الأسنان: null, البنود: 1, الجلسات: 1 } }),
      } });
    expect(order).toEqual(["select-template", "catalog", "price-settings"]);
  });

  it("does not cache template settings, catalog prices/names, or clinic-date defaults between calls", async () => {
    const h = harness();
    h.state.settings = settings({ "plans.specialty_templates": JSON.stringify([customTemplate("First template")]), "finance.rate.SAR": "200" });
    h.state.catalog = [service({ priceMinor: 60000, priceSarMinor: null })];
    const body = templateSource({ templateId: "saved", currency: "SAR", startDate: undefined, teeth: [] });
    const first = await h.prepare(body);
    expect(first.ok && first.plan.input.startDate).toBe("2026-11-01");
    expect(first.ok && first.plan.writer === "v2" && first.plan.input.items[0].unitPriceMinor).toBe(30000);
    h.state.today = "2026-11-02";
    h.state.settings = settings({ "plans.specialty_templates": JSON.stringify([customTemplate("Second template")]), "finance.rate.SAR": "150" });
    h.state.catalog = [service({ name: "Fresh treatment", priceMinor: 75000, priceSarMinor: null })];
    const second = await h.prepare(body);
    expect(second.ok && second.plan.input.startDate).toBe("2026-11-02");
    expect(second.ok && second.plan.writer === "v2" && second.plan.input.items[0])
      .toEqual({ ...normalizedItem, serviceName: "Fresh treatment", toothCode: null, unitPriceMinor: 50000,
        billingRule: "on_start", sessionCount: 1,
        sessionPlan: [{ title: "Saved session", minutes: 30, afterDays: 2, visitKey: "treatment:0", visitTitle: "Saved session" }],
      });
    expect(second.ok && second.plan.audit).toEqual(v2Audit({ details: { القالب: "Second template", الأسنان: null, البنود: 1, الجلسات: 1 } }));
    expect(h.dependencies.getSettings).toHaveBeenCalledTimes(4);
    expect(h.dependencies.listServices).toHaveBeenCalledTimes(2);
    expect(h.dependencies.clinicDate).toHaveBeenCalledTimes(2);
  });

  it("prefers an explicit foreign catalog price over the current conversion rate", async () => {
    const h = harness();
    h.state.catalog = templateCatalog();
    const result = await h.prepare(templateSource({ templateId: "crowns", currency: "SAR", teeth: [11] }));
    expect(result.ok && result.plan.writer === "v2" && result.plan.input.items[0].unitPriceMinor).toBe(90000);
  });

  it("retains invalid saved-template fallback to the built-in templates", async () => {
    const h = harness();
    h.state.settings = settings({ "plans.specialty_templates": "{" });
    h.state.catalog = templateCatalog();
    const result = await h.prepare(templateSource());
    expect(result.ok && result.plan.audit).toEqual(v2Audit({ details: { القالب: "علاج عصب + تاج", الأسنان: "16", البنود: 1, الجلسات: 3 } }));
  });

  it("limits selected steps to 20 and requires literal true for optional inclusion", async () => {
    const h = harness();
    h.state.catalog = templateCatalog();
    const bodies = [
      templateSource({ steps: [...Array.from({ length: 20 }, (_, index) => ({ key: `unused-${index}`, include: true })), { key: "crown", include: true }] }),
      templateSource({ steps: [{ key: "crown", include: "true" }, { key: "rct", include: false, serviceId: -1 }] }),
    ];
    for (const body of bodies) {
      const result = await h.prepare(body);
      expect(result.ok && result.plan.writer === "v2" && result.plan.input.items.map((row) => [row.serviceId, row.toothCode, row.sessionCount]))
        .toEqual([[8, 16, 3]]);
    }
  });
});

describe("template validation order and dependency failure boundaries", () => {
  const permanentTeeth = [11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28,
    31, 32, 33, 34, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48];

  it("rejects missing templates before validating teeth or loading the catalog", async () => {
    const h = harness();
    expect(await h.prepare(templateSource({ templateId: "missing", teeth: [99] })))
      .toEqual(invalid("قالب التخصص غير موجود."));
    expect(h.dependencies.getSettings).toHaveBeenCalledOnce();
    expect(h.dependencies.listServices).not.toHaveBeenCalled();
  });

  it.each<[unknown[], string]>([
    [[99], "«99» ليس رقم سنٍّ صالحًا بترقيم FDI."],
    [["bad"], "«NaN» ليس رقم سنٍّ صالحًا بترقيم FDI."],
    [[...permanentTeeth, 51, 99], "«99» ليس رقم سنٍّ صالحًا بترقيم FDI."],
    [[...permanentTeeth, 51], "اختر 32 سنًّا بحدٍّ أقصى."],
  ])("validates teeth before the second settings/catalog reads: %j", async (teeth, message) => {
    const h = harness();
    expect(await h.prepare(templateSource({ teeth }))).toEqual(invalid(message));
    expect(h.dependencies.getSettings).toHaveBeenCalledOnce();
    expect(h.dependencies.listServices).not.toHaveBeenCalled();
  });

  it("accepts exactly 32 unique teeth and deduplicates before applying the limit", async () => {
    const h = harness();
    h.state.catalog = templateCatalog();
    const result = await h.prepare(templateSource({ teeth: [...permanentTeeth, 11, 11] }));
    expect(result.ok && result.plan.writer === "v2" && result.plan.input.items.map((row) => row.toothCode)).toEqual(permanentTeeth);
    expect(result.ok && result.plan.audit).toEqual(v2Audit({ details: {
      القالب: "علاج عصب + تاج", الأسنان: permanentTeeth.join("، "), البنود: 32, الجلسات: 96,
    } }));
  });

  it.each<[Record<string, unknown>, string]>([
    [{ teeth: [] }, "اختر السن أو الأسنان لخطوة «علاج الجذور»."],
    [{ steps: [{ key: "rct", include: true, serviceId: 9 }] }, "الخدمة المختارة لخطوة «علاج الجذور» ليست من فئتها أو غير فعّالة."],
    [{ templateId: "filling" }, "لا خدمة فعّالة في الدليل لخطوة «حشوة» — أضفها إلى الدليل أولًا."],
  ])("preserves template builder refusal %j", async (body, message) => {
    const h = harness();
    h.state.catalog = templateCatalog();
    expect(await h.prepare(templateSource(body))).toEqual(invalid(message));
    expect(h.dependencies.getSettings).toHaveBeenCalledTimes(2);
    expect(h.dependencies.listServices).toHaveBeenCalledOnce();
  });

  it("refuses missing foreign prices before missing-teeth validation", async () => {
    const h = harness();
    h.state.catalog = [service({ name: "نزع عصب — طاحونة", category: "rct", priceUsdMinor: null })];
    h.state.settings = settings({ "finance.rate.USD": "" });
    expect(await h.prepare(templateSource({ currency: "USD", teeth: [] })))
      .toEqual(invalid("لا سعر لخدمة «نزع عصب — طاحونة» بعملة الخطة (دولار) — اضبط سعرها أو سعر الصرف أولًا."));
  });

  it("leaves the initial template settings read rejection thrown", async () => {
    const h = harness();
    const error = new Error("initial settings unavailable");
    h.dependencies.getSettings.mockRejectedValueOnce(error);
    await expect(h.prepare(templateSource())).rejects.toBe(error);
    expect(h.dependencies.listServices).not.toHaveBeenCalled();
  });

  it.each(["settings", "catalog"])("maps the second-stage template %s rejection to its existing 500", async (boundary) => {
    const h = harness();
    const error = new Error("template dependencies unavailable");
    if (boundary === "settings") {
      h.dependencies.getSettings.mockResolvedValueOnce(settings()).mockRejectedValueOnce(error);
    } else {
      h.dependencies.listServices.mockRejectedValueOnce(error);
    }
    expect(await h.prepare(templateSource())).toEqual({ ok: false, status: 500, body: { message: templateFailure } });
    expect(h.dependencies.getSettings).toHaveBeenCalledTimes(2);
    expect(h.dependencies.listServices).toHaveBeenCalledOnce();
  });

  it("maps a thrown template build failure to the same 500 without a runtime DB mock", async () => {
    const h = harness();
    const broken = service({ category: "rct" });
    Object.defineProperty(broken, "priceMinor", { get() { throw new Error("synthetic catalog price failure"); } });
    h.state.catalog = [broken];
    expect(await h.prepare(templateSource())).toEqual({ ok: false, status: 500, body: { message: templateFailure } });
  });

  it.each(["settings", "catalog"])("leaves V2 %s rejection thrown rather than widening the template catch", async (boundary) => {
    const h = harness();
    const error = new Error("v2 dependencies unavailable");
    if (boundary === "settings") h.dependencies.getSettings.mockRejectedValueOnce(error);
    else h.dependencies.listServices.mockRejectedValueOnce(error);
    await expect(h.prepare(v2Source())).rejects.toBe(error);
    expect(h.dependencies.getSettings).toHaveBeenCalledOnce();
    expect(h.dependencies.listServices).toHaveBeenCalledOnce();
  });
});
