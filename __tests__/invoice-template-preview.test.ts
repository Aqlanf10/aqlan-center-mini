import { describe, expect, it } from "vitest";
import { invoicePriceQuote } from "../lib/invoice-price-quote";
import type { InvoiceTemplatePreview, InvoiceTemplateSelection } from "../lib/invoice-template";
import type { SpecialtyTemplate } from "../lib/specialty-templates";
import type { LinePreview, PreviewState } from "../components/dental/invoice-preview-state";
import { previewForRow } from "../components/dental/invoice-preview-state";
import { readInvoiceSelectionPreview, type InvoicePreviewRequestRow } from "../components/dental/invoice-selection-state";
import {
  invoiceTemplateRowKey, readInvoiceTemplateCatalog, readInvoiceTemplatePreview,
  type InvoiceTemplatePreviewContext,
} from "../components/dental/invoice-template-preview";

type Evidence = LinePreview & {
  specialty: string | null;
  itemCandidates?: { id: number; planId: number; clinicalCaseId: number | null }[];
};
type Payload = {
  template: InvoiceTemplatePreview;
  existingPlanId: number | null;
  planChoices: { id: number; compatible: boolean }[];
  lines: Evidence[];
};
const corrupt = (object: object, key: string, value: unknown) => Object.assign(object, { [key]: value });
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fixture(withManual = true) {
  const template: SpecialtyTemplate = {
    id: "endo", name: "علاج عصب", specialty: "علاج عصب", description: "جلسات مسماة مع متابعة اختيارية",
    steps: [
      { key: "root", title: "علاج الجذور", category: "rct", preferredService: null, perTooth: true,
        optional: false, billingRule: "per_session", labWork: false,
        sessions: [{ title: "تنظيف القنوات", minutes: 45, afterDays: 0 }, { title: "حشو القنوات", minutes: 30, afterDays: 7 }] },
      { key: "records", title: "متابعة", category: "consultation", preferredService: "كشف واستشارة", perTooth: false,
        optional: true, billingRule: "on_completion", labWork: false,
        sessions: [{ title: "فحص ومتابعة", minutes: 15, afterDays: 10 }] },
    ],
  };
  const selection: InvoiceTemplateSelection = {
    templateId: "endo", teeth: [26, 16], doctorId: 7,
    steps: [{ key: "records", include: true, serviceId: 12 }, { key: "root", include: true, serviceId: 11 }],
    sites: [{ stepKey: "root", toothCode: 26 }, { stepKey: "root", toothCode: 16 }, { stepKey: "records", toothCode: null }],
  };
  const context: InvoiceTemplatePreviewContext = { template, selection,
    catalogServices: [{ id: 11, name: "علاج جذور", category: "rct" }, { id: 12, name: "كشف واستشارة", category: "consultation" }] };
  const manualRows: InvoicePreviewRequestRow[] = withManual ? [{ key: "manual-a", clinical: false }] : [];
  const lines: InvoiceTemplatePreview["lines"] = template.steps.flatMap((step) => (step.perTooth ? [16, 26] : [null]).map((toothCode) => ({
    line: 0, stepKey: step.key, serviceId: step.key === "root" ? 11 : 12,
    description: step.key === "root" ? "علاج جذور" : "كشف واستشارة", quantity: 1,
    unitPriceMinor: step.key === "root" ? 50000 : 10000, toothCode, scope: null, episodeTeeth: null, surfaces: null,
    caseId: null, doctorId: 7, sessions: step.sessions.length,
    sessionPlan: step.sessions.map((session, index) => ({ ...session, visitKey: `${step.key}:${index}`,
      visitTitle: `${session.title}${step.perTooth ? " — سن 16، 26" : ""}` })),
  })));
  lines.forEach((line, index) => { line.line = manualRows.length + index; });
  const manualEvidence: Evidence[] = withManual ? [{ line: 0, kind: "financial", specialty: null, specialtyLabel: null,
    item: null, case: null, refusal: null, refusalMessage: null }] : [];
  const payload: Payload = { template: { templateId: "endo", version: "a".repeat(64), lines }, existingPlanId: null, planChoices: [],
    lines: [...manualEvidence, ...lines.map((line): Evidence => ({ line: line.line,
      kind: line.stepKey === "root" ? "clinical" : "financial", scheduled: true,
      specialty: line.stepKey === "root" ? "endodontics" : null, specialtyLabel: line.stepKey === "root" ? "علاج جذور" : null,
      item: { mode: "new", id: null }, case: { mode: line.stepKey === "root" ? "new" : "none", id: null, title: null, options: [] },
      refusal: null, refusalMessage: null, itemCandidates: [], financialReviewRequired: false,
    }))] };
  const read = () => readInvoiceTemplatePreview(payload, manualRows, payload.existingPlanId, context);
  return { template, selection, context, manualRows, payload, read };
}

describe("canonical invoice template catalog", () => {
  it("requires exact displayed source/rate evidence for quoted template services", () => {
    const value=fixture(); value.context.currency="SAR";
    for(const service of value.context.catalogServices){
      const amount=value.payload.template.lines.find(line=>line.serviceId===service.id)!.unitPriceMinor;
      const quote=invoicePriceQuote({priceMinor:amount*440/100,priceSarMinor:null,priceUsdMinor:null,priceConfigured:true},"SAR",{SAR:440});
      service.invoiceQuotes={SAR:quote};
      for(const line of value.payload.template.lines.filter(line=>line.serviceId===service.id))line.priceQuote=quote;
    }
    expect(value.read()?.template.lines[0].priceQuote).toMatchObject({source:"converted",rate:440});
    const original=value.payload.template.lines[0].priceQuote!;
    value.payload.template.lines[0].priceQuote={...original,rate:441};expect(value.read()).toBeNull();
    delete value.payload.template.lines[0].priceQuote;expect(value.read()).toBeNull();
    value.payload.template.lines[0].priceQuote=original;
    for(const line of value.payload.template.lines.filter(line=>line.serviceId===11))line.unitPriceMinor++;
    expect(value.read()).toBeNull();
  });
  it("reads exact template and named-session settings without prices or fallback defaults", () => {
    const { template } = fixture();
    expect(readInvoiceTemplateCatalog({ templates: [template], services: [{ priceMinor: "untrusted" }] })).toEqual([template]);
    for (const payload of [null, {}, { templates: [] }, { templates: {} }, { templates: [null] }]) {
      expect(readInvoiceTemplateCatalog(payload)).toBeNull();
    }
  });
  it("rejects duplicate template/step IDs, absent required steps, coercion and unknown fields", () => {
    const { template } = fixture();
    expect(readInvoiceTemplateCatalog({ templates: [template, template] })).toBeNull();
    for (const change of [
      (value: SpecialtyTemplate) => { value.steps.push(copy(value.steps[0])); },
      (value: SpecialtyTemplate) => { value.steps.forEach((step) => { step.optional = true; }); },
      (value: SpecialtyTemplate) => { corrupt(value.steps[0], "perTooth", "true"); },
      (value: SpecialtyTemplate) => { corrupt(value.steps[0], "billingRule", "invented"); },
      (value: SpecialtyTemplate) => { corrupt(value, "priceMinor", 0); },
      (value: SpecialtyTemplate) => { value.steps[0].key = ""; },
      (value: SpecialtyTemplate) => { value.steps[0].key = "x".repeat(41); },
      (value: SpecialtyTemplate) => { value.steps[0].key = "__proto__"; },
      (value: SpecialtyTemplate) => { value.id = "constructor"; },
    ]) {
      const altered = copy(template); change(altered);
      expect(readInvoiceTemplateCatalog({ templates: [altered] })).toBeNull();
    }
  });
  it.each([
    ["title", ""], ["title", "x".repeat(81)], ["minutes", "45"], ["minutes", 4], ["minutes", 481],
    ["minutes", 5.5], ["afterDays", -1], ["afterDays", 366], ["afterDays", "7"],
  ])("rejects invalid session %s %j", (key, value) => {
    const { template } = fixture(); corrupt(template.steps[0].sessions[0], key as string, value);
    expect(readInvoiceTemplateCatalog({ templates: [template] })).toBeNull();
  });
  it("honors the exact 1..12 session boundary", () => {
    for (const count of [0, 13]) {
      const { template } = fixture();
      template.steps[0].sessions = Array.from({ length: count }, () => ({ title: "جلسة", minutes: 5, afterDays: 365 }));
      expect(readInvoiceTemplateCatalog({ templates: [template] })).toBeNull();
    }
    const { template } = fixture();
    template.steps[0].sessions = Array.from({ length: 12 }, () => ({ title: "جلسة", minutes: 480, afterDays: 365 }));
    expect(readInvoiceTemplateCatalog({ templates: [template] })).toEqual([template]);
  });
});

describe("canonical invoice template preview", () => {
  it("appends to manual rows in template order and ascending explicit teeth with shared named visits", () => {
    const { read, selection, payload } = fixture();
    const before = copy(selection);
    const result = read();
    expect(result).not.toBeNull();
    expect(result?.rows.map((row) => row.key)).toEqual(["manual-a", invoiceTemplateRowKey("root", 16),
      invoiceTemplateRowKey("root", 26), invoiceTemplateRowKey("records", null)]);
    expect([...result!.byRow.keys()]).toEqual(result?.rows.map((row) => row.key));
    expect(result?.template).toEqual(payload.template);
    expect(result?.template.lines[0].sessionPlan).toEqual(result?.template.lines[1].sessionPlan);
    expect(selection).toEqual(before);
  });
  it("allows a template-only invoice and preserves selection evidence from manual adopted work", () => {
    expect(fixture(false).read()?.template.lines[0].line).toBe(0);
    const value = fixture();
    value.manualRows[0] = { key: "manual-existing", clinical: true, planItemId: 91 };
    value.payload.existingPlanId = 20;
    value.payload.planChoices = [{ id: 20, compatible: true }];
    value.payload.lines[0] = { line: 0, kind: "clinical", specialty: "restorative", specialtyLabel: "ترميمي",
      item: { mode: "existing", id: 91 }, case: { mode: "none", id: null, title: null, options: [] },
      refusal: null, refusalMessage: null, itemCandidates: [{ id: 91, planId: 20, clinicalCaseId: null }] };
    expect(value.read()?.selections.itemChoices.get("manual-existing")).toEqual([{ id: 91, planId: 20, clinicalCaseId: null }]);
    value.payload.lines[0].item = { mode: "existing", id: 92 };
    expect(value.read()).toBeNull();
  });
  it.each(["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), 0, null])("rejects invalid version %j", (version) => {
    const { payload, read } = fixture(); corrupt(payload.template, "version", version); expect(read()).toBeNull();
  });
  it("rejects stale or foreign receipt identity without manufacturing a version", () => {
    const value = fixture();
    value.selection.version = "b".repeat(64); expect(value.read()).toBeNull();
    value.selection.version = "a".repeat(64); expect(value.read()).not.toBeNull();
    value.payload.template.templateId = "ortho"; expect(value.read()).toBeNull();
  });
  it("rejects fragments, duplicate indices, reordered expansion and wrong manual offsets", () => {
    const mutations: ((value: ReturnType<typeof fixture>) => void)[] = [
      ({ payload }) => { payload.template.lines.pop(); },
      ({ payload }) => { payload.template.lines.push(copy(payload.template.lines[0])); },
      ({ payload }) => { payload.template.lines.reverse(); },
      ({ payload }) => { payload.template.lines[0].line = 0; },
      ({ payload }) => { payload.lines.pop(); },
      ({ payload }) => { payload.lines[2].line = 1; },
      ({ payload }) => { payload.lines.reverse(); },
      ({ manualRows }) => { manualRows.push(copy(manualRows[0])); },
      ({ manualRows }) => { manualRows[0].key = invoiceTemplateRowKey("root", 16); },
    ];
    for (const change of mutations) { const value = fixture(); change(value); expect(value.read()).toBeNull(); }
  });
  it.each([
    ["serviceId", 999], ["serviceId", "11"], ["stepKey", "foreign"], ["description", "different service"],
    ["toothCode", 36], ["toothCode", "16"], ["quantity", 2], ["unitPriceMinor", 0], ["unitPriceMinor", -1],
    ["unitPriceMinor", "50000"], ["unitPriceMinor", Number.NaN], ["unitPriceMinor", Number.MAX_SAFE_INTEGER + 1],
    ["scope", "upper"], ["episodeTeeth", [16, 26]], ["surfaces", "M"], ["caseId", 9], ["doctorId", 8],
    ["doctorId", "7"], ["sessions", 60], ["sessions", "2"],
  ])("rejects a changed or coerced generated %s %j", (key, value) => {
    const { payload, read } = fixture(); corrupt(payload.template.lines[0], key as string, value); expect(read()).toBeNull();
  });
  it("rejects inconsistent catalogue prices for the same service and unsafe totals", () => {
    const value = fixture(); value.payload.template.lines[1].unitPriceMinor += 1; expect(value.read()).toBeNull();
    value.payload.template.lines.forEach((line) => { line.unitPriceMinor = Number.MAX_SAFE_INTEGER; });
    expect(value.read()).toBeNull();
  });
  it.each([
    ["title", "renamed"], ["minutes", 60], ["afterDays", 1], ["visitKey", "root:1"], ["visitTitle", "renamed visit"],
    ["minutes", "45"], ["afterDays", "0"],
  ])("rejects changed named-session %s %j", (key, value) => {
    const { payload, read } = fixture(); corrupt(payload.template.lines[0].sessionPlan[0], key as string, value); expect(read()).toBeNull();
  });
  it("rejects missing, repeated, extra and reordered schedule entries", () => {
    for (const change of [
      (plan: InvoiceTemplatePreview["lines"][number]["sessionPlan"]) => { plan.pop(); },
      (plan: InvoiceTemplatePreview["lines"][number]["sessionPlan"]) => { plan.push(copy(plan[0])); },
      (plan: InvoiceTemplatePreview["lines"][number]["sessionPlan"]) => { plan[1] = copy(plan[0]); },
      (plan: InvoiceTemplatePreview["lines"][number]["sessionPlan"]) => { plan.reverse(); },
    ]) {
      const value = fixture(); change(value.payload.template.lines[0].sessionPlan); expect(value.read()).toBeNull();
    }
  });
  it("matches the persisted 200-character shared-visit title without dropping teeth", () => {
    const value = fixture();
    const selectedTeeth = [1, 2, 3, 4].flatMap((quadrant) => Array.from({ length: 8 }, (_, index) => quadrant * 10 + index + 1));
    value.selection.teeth = selectedTeeth;
    value.selection.sites = [...selectedTeeth.map((toothCode) => ({ stepKey: "root", toothCode })), { stepKey: "records", toothCode: null }];
    value.template.steps[0].sessions[0].title = "ش".repeat(80);
    const root = copy(value.payload.template.lines[0]);
    root.sessionPlan = value.template.steps[0].sessions.map((session, index) => ({ ...session, visitKey: `root:${index}`,
      visitTitle: `${session.title} — سن ${selectedTeeth.join("، ")}`.slice(0, 200) }));
    const records = value.payload.template.lines[2];
    value.payload.template.lines = [...selectedTeeth.map((toothCode, index) => ({ ...copy(root), toothCode, line: index + 1 })),
      { ...records, line: selectedTeeth.length + 1 }];
    const rootEvidence = value.payload.lines[1]; const recordsEvidence = value.payload.lines[3];
    value.payload.lines = [value.payload.lines[0], ...selectedTeeth.map((_, index) => ({ ...copy(rootEvidence), line: index + 1 })),
      { ...recordsEvidence, line: selectedTeeth.length + 1 }];
    expect(value.read()?.template.lines[0].sessionPlan[0].visitTitle).toHaveLength(200);
    value.payload.template.lines[0].sessionPlan[0].visitTitle += "ش";
    expect(value.read()).toBeNull();
  });
  it("requires explicit included services and rejects unknown/repeated choice or site identities", () => {
    const mutations: ((value: ReturnType<typeof fixture>) => void)[] = [
      ({ selection }) => { selection.steps[1].serviceId = null; },
      ({ selection }) => { selection.steps[1].include = false; },
      ({ selection }) => { selection.steps[0].include = false; },
      ({ selection }) => { selection.steps.push(copy(selection.steps[0])); },
      ({ selection }) => { selection.steps[0].key = "foreign"; },
      ({ selection }) => { selection.teeth.push(16); },
      ({ selection }) => { selection.teeth = [19, 26]; },
      ({ selection }) => { selection.sites!.push(copy(selection.sites![0])); },
      ({ selection }) => { selection.sites![0].stepKey = "foreign"; },
      ({ selection }) => { selection.sites![0].toothCode = 36; },
      ({ context }) => { context.catalogServices = [...context.catalogServices, context.catalogServices[0]]; },
      ({ context }) => { context.catalogServices = [{ id: 11, name: "علاج جذور", category: "ortho" }, context.catalogServices[1]]; },
    ];
    for (const change of mutations) { const value = fixture(); change(value); expect(value.read()).toBeNull(); }
  });
  it("validates explicit prosthetic episode membership and does not infer a bridge", () => {
    const value = fixture();
    value.template.steps[0].category = "bridge";
    value.context.catalogServices = [{ id: 11, name: "علاج جذور", category: "bridge" }, value.context.catalogServices[1]];
    for (const line of value.payload.lines.slice(1, 3)) { line.specialty = "prosthodontics"; line.specialtyLabel = "تركيبات"; }
    expect(value.read()).toBeNull();
    value.selection.sites![0].episodeTeeth = [26, 16]; value.selection.sites![1].episodeTeeth = [26, 16];
    value.payload.template.lines[0].episodeTeeth = [16, 26]; value.payload.template.lines[1].episodeTeeth = [16, 26];
    expect(value.read()).not.toBeNull();
    value.payload.template.lines[1].episodeTeeth = [26, 16]; expect(value.read()).toBeNull();
    value.payload.template.lines[1].episodeTeeth = [16, 26, 36]; expect(value.read()).toBeNull();
  });
  it("accepts only the selected explicit case and exact canonical specialty", () => {
    const value = fixture(); value.selection.sites![1].caseId = 19; value.payload.template.lines[0].caseId = 19;
    value.payload.lines[1].case = { mode: "existing", id: 19, title: "الحالة", options: [] };
    expect(value.read()).not.toBeNull();
    value.payload.lines[1].case!.id = 20; expect(value.read()).toBeNull();
    value.payload.lines[1].case!.id = 19; value.payload.lines[1].specialty = "orthodontics"; expect(value.read()).toBeNull();
  });
  it("requires explicit arch/whole-mouth scope and refuses another scope in the receipt", () => {
    for (const [category, scope, specialty, label] of [
      ["ortho", "upper", "orthodontics", "تقويم"], ["cleaning", "full_mouth", "periodontics", "لثة"],
    ]) {
      const value = fixture();
      value.template.steps[0].category = category; value.template.steps[0].perTooth = false;
      value.context.catalogServices = [{ id: 11, name: "علاج جذور", category }, value.context.catalogServices[1]];
      value.selection.teeth = [];
      value.selection.sites = [{ stepKey: "root", toothCode: null, scope }, { stepKey: "records", toothCode: null }];
      value.payload.template.lines.splice(1, 1);
      value.payload.template.lines.forEach((line, index) => { line.line = index + 1; });
      const generated = value.payload.template.lines[0]; generated.toothCode = null; generated.scope = scope;
      generated.sessionPlan.forEach((session) => { session.visitTitle = session.title; });
      value.payload.lines.splice(2, 1); value.payload.lines.forEach((line, index) => { line.line = index; });
      value.payload.lines[1].specialty = specialty; value.payload.lines[1].specialtyLabel = label;
      expect(value.read()).not.toBeNull();
      generated.scope = "lower"; expect(value.read()).toBeNull();
      generated.scope = scope; delete value.selection.sites[0].scope; expect(value.read()).toBeNull();
    }
  });
  it("normalizes only explicit surface selection, then requires its exact canonical response", () => {
    const value = fixture(); value.template.steps[0].category = "filling";
    value.context.catalogServices = [{ id: 11, name: "علاج جذور", category: "filling" }, value.context.catalogServices[1]];
    value.selection.sites![1].surfaces = "m"; value.payload.template.lines[0].surfaces = "M";
    value.payload.lines.slice(1, 3).forEach((line) => {
      line.specialty = "restorative"; line.specialtyLabel = "ترميمي";
      line.case = { mode: "none", id: null, title: null, options: [] };
    });
    expect(value.read()).not.toBeNull();
    value.payload.template.lines[0].surfaces = "m"; expect(value.read()).toBeNull();
  });
  it("checks the selected plan independently of any IDs supplied in the response", () => {
    const value = fixture();
    value.payload.existingPlanId = 9; value.payload.planChoices = [{ id: 9, compatible: true }];
    expect(readInvoiceTemplatePreview(value.payload, value.manualRows, 8, value.context)).toBeNull();
    expect(value.read()).not.toBeNull();
  });
  it("requires complete successful candidate/provider evidence and a new plan item", () => {
    for (const field of ["itemCandidates", "financialReviewRequired"] as const) {
      const value = fixture(); delete value.payload.lines[1][field]; expect(value.read()).toBeNull();
    }
    const value = fixture(); value.selection.doctorId = null;
    value.payload.template.lines.forEach((line) => { line.doctorId = null; });
    expect(value.read()).toBeNull();
    value.payload.lines.slice(1).forEach((line) => { line.financialReviewRequired = true; });
    expect(value.read()).not.toBeNull();
  });
  it("rejects expansion beyond the combined forty-line invoice boundary", () => {
    const value = fixture();
    const rows: InvoicePreviewRequestRow[] = Array.from({ length: 38 }, (_, index) => ({ key: `manual-${index}`, clinical: false }));
    expect(readInvoiceTemplatePreview(value.payload, rows, null, value.context)).toBeNull();
  });
  it("rejects invented, duplicated, coerced or adopted generated linkage", () => {
    const mutations: ((value: ReturnType<typeof fixture>) => void)[] = [
      ({ payload }) => { payload.lines[1].item = { mode: "existing", id: 1 }; },
      ({ payload }) => { corrupt(payload.lines[1].item!, "mode", { toString: () => "new" }); },
      ({ payload }) => { payload.lines[1].case!.options = [{ id: 8, title: "حالة" }, { id: 8, title: "حالة" }]; },
      ({ payload }) => { payload.lines[1].case!.mode = "none"; },
      ({ payload }) => { payload.lines[1].case = null; },
      ({ payload }) => { delete payload.lines[1].scheduled; },
      ({ payload }) => { corrupt(payload.lines[1], "scheduled", "true"); },
      ({ payload }) => { payload.lines[1].itemCandidates = [{ id: 1, planId: 2, clinicalCaseId: null }, { id: 1, planId: 2, clinicalCaseId: null }]; },
    ];
    for (const change of mutations) { const value = fixture(); change(value); expect(value.read()).toBeNull(); }
  });
  it("preserves a current explicit refusal without allowing its evidence to cross request owners", () => {
    const value = fixture(); value.payload.lines[1].refusal = "shape_mismatch"; value.payload.lines[1].refusalMessage = "راجع العمل الموجود";
    const result = value.read()!;
    const key = invoiceTemplateRowKey("root", 16);
    const state: PreviewState = { requestKey: "patient-1:exact-selection", status: "ready", byRow: result.byRow };
    expect(previewForRow(state, state.requestKey, key).status).toBe("refused");
    expect(previewForRow(state, "patient-2:changed-selection", key)).toEqual({ status: "pending", line: null });
  });
});

describe("explicit scheduled financial template evidence", () => {
  it("keeps consultation financial with a new plan item and no specialty case", () => {
    const value = fixture(); const result = value.read()!;
    expect(result.byRow.get(invoiceTemplateRowKey("records", null))).toMatchObject({ kind: "financial", scheduled: true,
      item: { mode: "new", id: null }, case: { mode: "none", id: null, title: null, options: [] } });
    expect(readInvoiceSelectionPreview(value.payload, result.rows.map(({ key, clinical }) => ({ key, clinical })), null)).toBeNull();
    const ordinary = { existingPlanId: null, planChoices: [], lines: [value.payload.lines[0]] };
    expect(readInvoiceSelectionPreview(ordinary, value.manualRows, null)).not.toBeNull();
    ordinary.lines[0] = { ...value.payload.lines[3], line: 0 };
    expect(readInvoiceSelectionPreview(ordinary, value.manualRows, null)).toBeNull();
  });
  it("rejects forged response markers and scheduled clinical work leaking onto manual financial rows", () => {
    const value = fixture();
    corrupt(value.payload.lines[0], "expectedScheduled", true);
    value.payload.lines[0].scheduled = true;
    expect(value.read()).toBeNull();
    const next = fixture(); corrupt(next.manualRows[0], "expectedScheduled", "invoice-template-scheduled-row");
    expect(next.read()).toBeNull();
  });
  it("requires exact financial case-none, new item, empty successful candidates and compatible selected plan", () => {
    const mutations: ((value: ReturnType<typeof fixture>) => void)[] = [
      ({ payload }) => { payload.lines[3].case = null; },
      ({ payload }) => { payload.lines[3].case!.mode = "new"; },
      ({ payload }) => { payload.lines[3].case!.title = "invented case"; },
      ({ payload }) => { payload.lines[3].case!.options = [{ id: 5, title: "case" }]; },
      ({ payload }) => { payload.lines[3].item = null; },
      ({ payload }) => { payload.lines[3].item = { mode: "existing", id: 5 }; },
      ({ payload }) => { payload.lines[3].itemCandidates = [{ id: 5, planId: 8, clinicalCaseId: null }]; },
      ({ payload }) => { delete payload.lines[3].itemCandidates; },
      ({ payload }) => { payload.lines[3].specialtyLabel = "تقويم"; },
      ({ payload }) => { payload.existingPlanId = 8; payload.planChoices = [{ id: 8, compatible: false }]; },
    ];
    for (const change of mutations) { const value = fixture(); change(value); expect(value.read()).toBeNull(); }
  });
});
