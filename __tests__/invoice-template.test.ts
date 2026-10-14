import { describe, expect, it } from "vitest";
import type { Service } from "../lib/db";
import { invoiceCommandFingerprint, invoiceTemplateRequestFingerprint, parseInvoiceCommand, type InvoiceTemplateSelection } from "../lib/invoice-template";
import { parseInvoiceInput } from "../lib/invoice-input";
import { invoiceRequestFingerprint } from "../lib/invoice-clinical-linkage";
import { withDefaults } from "../lib/settings";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../lib/specialty-templates";

const service = (id: number, category: string, priceMinor: number): Service => ({
  id, name: `Synthetic ${category}`, category, priceMinor, priceConfigured: true, priceProvisional: false,
  priceSarMinor: 12500, priceUsdMinor: 3300, isActive: true, sortOrder: id,
});
const services = new Map([service(1, "rct", 60000), service(2, "crown", 40000), service(3, "consultation", 5000),
  service(4, "ortho", 240000), service(5, "cleaning", 12000), service(6, "filling", 15000)].map((one) => [one.id, one]));
const doctors = new Set([7]);
const defaults = withDefaults({});
const selection = (): InvoiceTemplateSelection => ({ templateId: "endo", teeth: [36, 11, 36], doctorId: 7,
  steps: [{ key: "rct", include: true, serviceId: 1 }, { key: "crown", include: true, serviceId: 2 }],
  sites: [11, 36].map((toothCode) => ({ stepKey: "crown", toothCode, episodeTeeth: [11, 36] })),
});
const command = (templateSelection: unknown = selection()): Record<string, unknown> => ({ patientId: 91, currency: "YER", items: [], templateSelection, idempotencyKey: "synthetic-template-key" });
function preview(input = command(), catalog = services, settings: Record<string, string> = {}) {
  const result = parseInvoiceCommand(input, catalog, doctors, withDefaults(settings), false);
  expect(result.ok).toBe(true);
  if (!result.ok || result.template === null) throw new Error("Expected a template preview");
  return { ...result, template: result.template };
}
function invalid(input: Record<string, unknown>) {
  const result = parseInvoiceCommand(input, services, doctors, defaults, false);
  expect(result).toMatchObject({ ok: false, status: 400, code: "INVOICE_TEMPLATE_INVALID" });
}

describe("canonical invoice template reference", () => {
  it("expands exact catalogue work with names, durations, intervals and shared step visits", () => {
    const parsed = preview();
    expect(parsed.template.version).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.items.map((item) => [item.serviceId, item.toothCode, item.unitPriceMinor, item.sessions]))
      .toEqual([[1, 11, 60000, 3], [1, 36, 60000, 3], [2, 11, 40000, 2], [2, 36, 40000, 2]]);
    const rct = parsed.items[0].templatePlan!;
    expect(rct.billingRule).toBe("per_session");
    expect(rct.sessionPlan.map((one) => [one.title, one.minutes, one.afterDays, one.visitKey])).toEqual([
      ["فتح السن وتنظيف القنوات", 45, 0, "rct:0"], ["تشكيل وتعقيم القنوات", 45, 7, "rct:1"], ["حشو القنوات النهائي", 45, 7, "rct:2"],
    ]);
    expect(parsed.items[1].templatePlan!.sessionPlan).toEqual(rct.sessionPlan);
    expect(parsed.items[2].templatePlan!.billingRule).toBe("on_start");
    expect(parsed.template.lines.map((line) => line.line)).toEqual([0, 1, 2, 3]);
    expect(parsed.authorityLines.every((line) => line.explicit === false)).toBe(true);
  });

  it("keeps mixed manual offsets and fingerprints ordinary commands byte-compatibly", () => {
    const manual = { patientId: 91, currency: "YER", items: [{ description: "Synthetic manual", price: "99", quantity: 1 }] };
    const original = parseInvoiceInput(manual, services, doctors);
    const ordinary = parseInvoiceCommand(manual, services, doctors, defaults, true);
    if (!original.ok || !ordinary.ok) throw new Error("Expected manual input");
    expect(ordinary.template).toBeNull();
    expect(invoiceCommandFingerprint(ordinary)).toBe(invoiceRequestFingerprint({ ...original, currency: original.baseCurrency }));
    const mixed = preview({ ...command(), items: manual.items });
    expect(mixed.items[0].templatePlan).toBeUndefined();
    expect(mixed.template.lines.map((line) => line.line)).toEqual([1, 2, 3, 4]);
    expect(mixed.items).toHaveLength(5);
    expect(invoiceCommandFingerprint(mixed)).not.toBe(invoiceCommandFingerprint(preview()));
  });

  it("requires a reviewed version on save and accepts only the exact reviewed template", () => {
    expect(parseInvoiceCommand(command(), services, doctors, defaults, true)).toMatchObject({ ok: false, status: 409, code: "INVOICE_TEMPLATE_REVIEW_REQUIRED" });
    const first = preview();
    const save = parseInvoiceCommand(command({ ...selection(), version: first.template.version }), services, doctors, defaults, true);
    expect(save.ok).toBe(true);
    if (!save.ok) throw new Error("Expected exact save");
    expect(invoiceCommandFingerprint(save)).toBe(invoiceCommandFingerprint(first));
  });

  it("requires a valid key for template saves while preview and ordinary invoices remain compatible", () => {
    const selected = { ...selection(), version: preview().template.version };
    for (const idempotencyKey of [undefined, null, "", "   ", "short", 123]) {
      expect(parseInvoiceCommand({ ...command(selected), idempotencyKey }, services, doctors, defaults, true))
        .toMatchObject({ ok: false, code: "INVOICE_TEMPLATE_INVALID" });
    }
    expect(parseInvoiceCommand({ ...command(), idempotencyKey: undefined }, services, doctors, defaults, false).ok).toBe(true);
    expect(parseInvoiceCommand({ patientId: 91, items: [{ description: "Synthetic", price: "99" }] }, services, doctors, defaults, true).ok).toBe(true);
  });

  it("binds recovery to exact raw intent and actor without storing raw private values", () => {
    const body = { ...command(), note: "Synthetic private note", templateSelection: { ...selection(), version: preview().template.version } };
    const actor = { username: "reception", role: "reception" };
    const hash = invoiceTemplateRequestFingerprint(body, actor);
    expect(hash).toMatch(/^invoice-template-intent-v1:[a-f0-9]{64}$/);
    expect(hash).not.toContain(body.note);
    expect(invoiceTemplateRequestFingerprint(Object.fromEntries(Object.entries(body).reverse()), actor)).toBe(hash);
    expect(invoiceTemplateRequestFingerprint({ ...body, idempotencyKey: "another-key" }, actor)).toBe(hash);
    expect(invoiceTemplateRequestFingerprint({ ...body, patientId: 92 }, actor)).not.toBe(hash);
    expect(invoiceTemplateRequestFingerprint({ ...body, note: "Changed" }, actor)).not.toBe(hash);
    expect(invoiceTemplateRequestFingerprint(body, { ...actor, username: "other" })).not.toBe(hash);
    expect(invoiceTemplateRequestFingerprint(body, { ...actor, role: "admin" })).not.toBe(hash);
    expect(invoiceTemplateRequestFingerprint(body, { ...actor, userId: 11 })).not.toBe(invoiceTemplateRequestFingerprint(body, { ...actor, userId: 12 }));
  });

  it("type-tags objects and arrays so entries-array substitutions never recover an object intent", () => {
    const actor = { username: "reception", role: "reception", userId: 7 };
    const item = { description: "Synthetic", price: "99", nested: { chosen: true } };
    const body = { ...command(), items: [item], templateSelection: { ...selection(), version: preview().template.version } };
    const hash = invoiceTemplateRequestFingerprint(body, actor);
    expect(invoiceTemplateRequestFingerprint({ ...body, items: [Object.entries(item)] }, actor)).not.toBe(hash);
    expect(invoiceTemplateRequestFingerprint({ ...body, items: [{ ...item, nested: Object.entries(item.nested) }] }, actor)).not.toBe(hash);
    expect(invoiceTemplateRequestFingerprint({ ...body, templateSelection: { ...body.templateSelection,
      steps: body.templateSelection.steps.map((step) => Object.entries(step)),
    } }, actor)).not.toBe(hash);
    expect(invoiceTemplateRequestFingerprint({ ...body, templateSelection: { ...body.templateSelection,
      sites: body.templateSelection.sites!.map((site) => Object.entries(site)),
    } }, actor)).not.toBe(hash);
    expect(invoiceTemplateRequestFingerprint({ ...body, items: [Object.fromEntries(Object.entries(item).reverse())] }, actor)).toBe(hash);
  });

  it("rejects changed catalogue price, template schedule, selection and authority scope after preview", () => {
    const first = preview();
    const body = command({ ...selection(), version: first.template.version });
    const changedCatalog = new Map(services);
    changedCatalog.set(1, { ...services.get(1)!, priceMinor: 60001 });
    expect(parseInvoiceCommand(body, changedCatalog, doctors, defaults, true)).toMatchObject({ ok: false, code: "INVOICE_TEMPLATE_STALE" });
    const templates = structuredClone(DEFAULT_SPECIALTY_TEMPLATES);
    templates.find((one) => one.id === "endo")!.steps[0].sessions[0].minutes = 50;
    const settings = { "plans.specialty_templates": JSON.stringify(templates) };
    expect(parseInvoiceCommand(body, services, doctors, withDefaults(settings), true)).toMatchObject({ ok: false, code: "INVOICE_TEMPLATE_STALE" });
    expect(parseInvoiceCommand(command({ ...selection(), version: first.template.version, doctorId: null }), services, doctors, defaults, true))
      .toMatchObject({ ok: false, code: "INVOICE_TEMPLATE_STALE" });
    expect(parseInvoiceCommand(body, services, new Set(), defaults, true)).toMatchObject({ ok: false, code: "INVOICE_TEMPLATE_INVALID" });
  });

  it("refuses client price, session and billing-rule injections rather than using them", () => {
    for (const extra of [{ price: 1 }, { billingRule: "on_start" }, { sessionPlan: [] }, { role: "admin" }, { installments: [] }]) {
      invalid(command({ ...selection(), ...extra }));
      invalid(command({ ...selection(), steps: [{ key: "rct", include: true, serviceId: 1, ...extra }] }));
    }
    const manual = parseInvoiceCommand({ patientId: 91, items: [{ serviceId: 1, price: "60000", toothCode: 36,
      templatePlan: { billingRule: "per_session", sessionPlan: [] } }] }, services, doctors, defaults, true);
    expect(manual.ok).toBe(true);
    if (manual.ok) expect(manual.items[0].templatePlan).toBeUndefined();
  });

  it("rejects duplicate/unknown/prototype step keys and inherited objects", () => {
    for (const key of ["missing", "constructor", "__proto__", "prototype", "toString", "hasOwnProperty"]) {
      invalid(command({ ...selection(), steps: [{ key, include: true, serviceId: 1 }] }));
    }
    invalid(command({ ...selection(), steps: [{ key: "rct", include: true, serviceId: 1 }, { key: "rct", include: true, serviceId: 1 }] }));
    invalid(command({ ...selection(), steps: [{ key: "rct", include: false, serviceId: 1 }] }));
    invalid(command({ ...selection(), steps: [{ key: "rct", include: true, serviceId: null }] }));
    invalid(command({ ...selection(), steps: [] }));
    invalid(command(Object.assign(Object.create({ hidden: true }), selection())));
    invalid(Object.assign(Object.create({ templateSelection: selection() }), { patientId: 91, items: [] }));
    invalid(command(JSON.parse(JSON.stringify(selection()).replace('"templateId":', '"__proto__":{},"templateId":'))));
  });

  it("requires appropriate explicit clinical sites and rejects duplicate/unselected sites", () => {
    invalid(command({ ...selection(), sites: [] }));
    invalid(command({ ...selection(), sites: [...selection().sites!, selection().sites![0]] }));
    invalid(command({ ...selection(), sites: [...selection().sites!, { stepKey: "post", toothCode: 11 }] }));
    invalid(command({ ...selection(), teeth: [99] }));
    invalid(command({ ...selection(), teeth: ["11"] }));
    invalid(command({ ...selection(), teeth: Array.from({ length: 33 }, () => 11) }));
  });

  it("keeps optional records as authoritative scheduled lines and requires ortho arches", () => {
    const ortho = { templateId: "ortho", doctorId: 7, teeth: [], steps: [
      { key: "records", include: true, serviceId: 3 }, { key: "ortho", include: true, serviceId: 4 },
    ], sites: [{ stepKey: "ortho", toothCode: null, scope: "both" }] };
    const parsed = preview(command(ortho));
    expect(parsed.items.map((item) => [item.category, item.sessions, item.caseId])).toEqual([["consultation", 1, null], ["ortho", 12, null]]);
    expect(parsed.template.lines[0].sessionPlan[0]).toMatchObject({ title: "فحص وتشخيص وصور وأشعة", minutes: 45, afterDays: 0 });
    expect(parsed.items[0].templatePlan).toBeDefined();
    invalid(command({ ...ortho, sites: [] }));
    invalid(command({ ...ortho, sites: [...ortho.sites, { stepKey: "records", toothCode: null, caseId: 123 }] }));
  });

  it("uses configured foreign-currency catalogue prices and refuses inactive/category-mismatched service choices", () => {
    const foreign = preview({ ...command(), currency: "SAR" });
    expect(foreign.items.every((item) => item.unitPriceMinor === 12500)).toBe(true);
    invalid(command({ ...selection(), steps: [{ key: "rct", include: true, serviceId: 2 }] }));
    const inactive = new Map(services);
    inactive.set(1, { ...services.get(1)!, isActive: false });
    expect(parseInvoiceCommand(command(), inactive, doctors, defaults, false)).toMatchObject({ ok: false, code: "INVOICE_TEMPLATE_INVALID" });
    invalid(command({ ...selection(), doctorId: true }));
    invalid(command({ ...selection(), doctorId: 999 }));
  });

  it("bounds combined manual and template expansion without truncation", () => {
    invalid({ ...command(), items: Array.from({ length: 37 }, () => ({ description: "Synthetic", price: "1" })) });
  });
});
