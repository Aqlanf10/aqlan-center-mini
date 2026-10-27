import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoFollowupCoveragePanel } from "../components/OrthoFollowupCoveragePanel";
import { followupCoverageJournal } from "../lib/ortho-followup-coverage-recovery";
import { PatientLedger } from "../components/PatientLedger";
import { formatMoney } from "../lib/money";
import { ServiceSelect } from "../components/ServiceSelect";
import { ToothSelectionDialog } from "../components/dental/ToothSelectionDialog";
import { TreatmentEntryChoice } from "../components/TreatmentEntryChoice";
import {readInvoiceCommandReceipt,type InvoiceTemplateReceiptExpectation} from "../lib/invoice-template-receipt";

// Execute the real wrapper/content and write callbacks. Child forms are left as
// elements: this test owns feedback lifetime, not native form/chart acceptance.
const hooks = vi.hoisted(() => {
  type Store = { values: unknown[]; cursor: number; changed: boolean;
    effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>;
    memos: Map<number, { deps?: readonly unknown[]; value: unknown }>; pending: Array<() => void> };
  const make = (): Store => ({ values: [], cursor: 0, changed: false, effects: new Map(), memos: new Map(), pending: [] });
  return { make, current: make(), outer: make(), inner: make(), form: make() };
});
const journalFixture = vi.hoisted(() => ({ command: null as import("../lib/financial-command-journal").FinancialCommand | null }));
// Browser-storage behaviour has separate real Chromium coverage. These hook
// fixtures isolate ledger reads/feedback and provide an empty durable journal.
vi.mock("../lib/financial-command-journal", async original => ({
  ...await original<typeof import("../lib/financial-command-journal")>(),
  readFinancialJournal: async () => ({ revision: 0, command: journalFixture.command }),
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic-feedback-owner", role: "admin" }) }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const h = hooks.current, index = h.cursor++; if (!(index in h.values)) h.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const h = hooks.current, index = slot(undefined), previous = h.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); h.memos.set(index, { deps, value }); return value;
  };
  const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const h = hooks.current, index = slot(undefined), previous = h.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    h.pending.push(() => { previous?.cleanup?.(); const cleanup = run(); h.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => { const h = hooks.current, index = slot(typeof initial === "function" ? initial() : initial);
      if (!h.memos.has(index)) h.memos.set(index, { value: (value: unknown) => { const next = typeof value === "function" ? value(h.values[index]) : value;
        if (!Object.is(next, h.values[index])) h.changed = true; h.values[index] = next; } });
      return [h.values[index], h.memos.get(index)!.value]; },
    useId: () => `synthetic-form-${slot("id")}`,
    useRef: (initial: unknown) => hooks.current.values[slot({ current: initial })],
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: effect, useLayoutEffect: effect,
  };
});
type Element = ReactElement<Record<string, unknown>>;
let entryRequestKey = 0;
const elements = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(elements)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...elements((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
function render(): ReactNode {
  for (let round = 0; round < 30; round++) {
    for (const h of [hooks.outer, hooks.inner]) { h.cursor = 0; h.changed = false; }
    hooks.current = hooks.outer;
    const wrapper = PatientLedger({ patientId: 901, entryRequestKey }) as Element;
    hooks.outer.pending.splice(0).forEach(run => run());
    if (typeof wrapper.type !== "function") return wrapper;
    hooks.current = hooks.inner;
    const tree = (wrapper.type as (props: Record<string, unknown>) => ReactNode)(wrapper.props);
    hooks.inner.pending.splice(0).forEach(run => run());
    if (!hooks.outer.changed && !hooks.inner.changed) return tree;
  }
  throw new Error("Ledger feedback fixture did not settle");
}
async function settle() { for (let pass = 0; pass < 5; pass++) { for (let i = 0; i < 15; i++) await Promise.resolve(); render(); } }
const find = (predicate: (element: Element) => boolean) => elements(render()).find(predicate);
const click = (element: Element | undefined) => { expect(element).toBeDefined(); (element!.props.onClick as () => void)(); render(); };
function open(kind: "invoice" | "legacy") {
  click(find(node => node.props["data-testid"] === "treatment-entry-open"));
  const choice = find(node => node.type === TreatmentEntryChoice); expect(choice).toBeDefined();
  (choice!.props.onSelect as (kind: "invoice" | "legacy") => void)(kind); render();
}
const bucket = { billedMinor: 180000, collectedMinor: 0, openingMinor: 0, dueMinor: 180000 };
const ledger = { invoices: [], payments: [], plans: [], opening: null, openingAccess: { add: true, edit: true }, baseCurrency: "YER", balance: bucket,
  balances: { YER: bucket, SAR: { billedMinor: 0, collectedMinor: 0, openingMinor: 0, dueMinor: 0 }, USD: { billedMinor: 0, collectedMinor: 0, openingMinor: 0, dueMinor: 0 } } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn();
let write: () => Promise<Response>;
const invoiceOwner={};
const invoiceExpectation:InvoiceTemplateReceiptExpectation={owner:invoiceOwner,patientId:901,currency:"YER",discountMinor:0,note:null,expectedPlanId:null,
  lines:[{source:"manual",serviceId:31,doctorId:null,description:"Synthetic feedback seed",quantity:1,unitPriceMinor:180000,toothCode:36,surfaces:null,
    kind:"clinical",specialty:"endodontics",scheduled:true,planItem:{mode:"new"},case:{mode:"new"}}]};
const validateInvoice=(value:unknown)=>readInvoiceCommandReceipt(value,invoiceExpectation,invoiceOwner)!==null;
beforeEach(() => {
  journalFixture.command = null;
  hooks.outer = hooks.make(); hooks.inner = hooks.make(); hooks.form = hooks.make(); hooks.current = hooks.outer; entryRequestKey = 0; fetchMock.mockReset();
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm: vi.fn(() => true) });
  write = async () => json({ id: 701, invoiceNumber: "INV-SYNTHETIC-701", patientId: 901, patientName: "Synthetic patient",
    status: "open", totalMinor: 180000, discountMinor: 0, baseCurrency: "YER", note: null, createdAt: "2026-10-11T00:00:00.000Z",
    items: [{ id: 711, serviceId: 31, doctorId: null, description: "Synthetic feedback seed", quantity: 1, unitPriceMinor: 180000, totalMinor: 180000,
      planItemId: 811, caseId: 601, toothCode: 36, surfaces: null, originInvoiceId: 701, billingStatus: "needs_financial_review", financialReviewRequired: true }],
    clinical: { planId: 801, links: [{ line: 0, kind: "clinical", specialty: "endodontics", planItemId: 811, planItemCreated: true, caseCreated: true, caseId: 601, scheduled: true }] }, replayed: false }, 201);
  fetchMock.mockImplementation((url: string, init?: RequestInit) => init?.method === "POST" ? write()
    : url === "/api/patients/901/ledger" ? Promise.resolve(json(ledger))
    : url === "/api/services" ? Promise.resolve(json([{ id: 31, name: "Synthetic root canal", category: "rct", priceMinor: 180000, priceConfigured: true, isActive: true }])) : url === "/api/parties?kind=doctor" ? Promise.resolve(json([])) : Promise.reject(new Error("Unexpected synthetic route")));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { for (const h of [hooks.outer, hooks.inner, hooks.form]) h.effects.forEach(effect => effect.cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });

function renderInvoiceForm(historical = true): ReactNode {
  const form = find(node => typeof node.type === "function" && node.type.name === "InvoiceForm" && !!node.props.historical === historical); expect(form).toBeDefined();
  for (let round = 0; round < 30; round++) {
    hooks.current = hooks.form; hooks.form.cursor = 0; hooks.form.changed = false;
    const tree = (form!.type as (props: Record<string, unknown>) => ReactNode)(form!.props);
    hooks.form.pending.splice(0).forEach(run => run());
    if (!hooks.form.changed) return tree;
  }
  throw new Error("Invoice form fixture did not settle");
}

describe("PatientLedger operation-scoped success feedback", () => {
  it("recognizes pending coverage and opens exact-case recovery without clearing or starting other money work", async () => {
    const pending = followupCoverageJournal({ actor: "synthetic-feedback-owner", patientId: 901, orthoCaseId: 73, command: {
      schemaVersion: 1, commandId: "11111111-1111-4111-8111-111111111111", expectedRevisionId: null,
      source: { patientId: 901, orthoCaseId: 73, clinicalCaseId: 74, planId: 75, planItemId: 76, invoiceId: 77 },
      expectedSourceFingerprint: "a".repeat(64), scope: "routine_adjustments", decision: "included", reason: "Synthetic explicit coverage",
    } });
    journalFixture.command = pending;
    render(); await settle();
    expect(find(node => node.props["data-testid"] === "ortho-coverage-account-recovery")).toBeDefined();
    const recovery = find(node => node.type === OrthoFollowupCoveragePanel);
    expect(recovery?.props).toMatchObject({ patientId: 901, orthoCaseId: 73 });
    expect(find(node => node.props["data-testid"] === "treatment-entry-open")?.props.disabled).toBe(true);
    expect(text(render())).not.toContain("تعذّر حفظ أو قراءة طلب العملية");
    expect(journalFixture.command).toBe(pending);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
  it.each(["toolbar", "request"] as const)("a new %s draft retires old success before refused preview, without a write", async entry => {
    render(); await settle(); open("invoice");
    const invoice = find(node => typeof node.type === "function" && node.type.name === "InvoiceForm")!;
    await (invoice.props.onSubmit as (body: Record<string, unknown>,validate:(value:unknown)=>boolean) => Promise<unknown>)({ currency: "YER", items: [{ serviceId: 31, toothCode: 36, price: "180000", quantity: "1" }], idempotencyKey: "synthetic-before-preview" },validateInvoice);
    await settle(); expect(find(node => node.props["data-testid"] === "invoice-clinical-notice")).toBeDefined();
    if (entry === "toolbar") click(find(node => node.props["data-testid"] === "treatment-entry-open"));
    else { entryRequestKey = 1; render(); }
    expect(find(node => node.props["data-testid"] === "invoice-clinical-notice")).toBeUndefined();
    const choice = find(node => node.type === TreatmentEntryChoice)!;
    (choice.props.onSelect as (kind: "legacy") => void)("legacy"); render();
    vi.useFakeTimers();
    const realRead = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/patients/901/historical-documents/preview"
      ? Promise.resolve(json({ message: "Synthetic preview refusal" }, 409)) : realRead(url, init));
    const pickService = elements(renderInvoiceForm()).find(node => node.type === ServiceSelect)!;
    (pickService.props.onChange as (id: number, service: unknown) => void)(31, { id: 31, name: "Synthetic root canal", category: "rct", priceMinor: 180000, priceConfigured: true, isActive: true }); renderInvoiceForm();
    const toothButton = elements(renderInvoiceForm()).find(node => node.props["data-testid"] === "invoice-tooth-button-0")!;
    (toothButton.props.onClick as () => void)();
    const dialog = elements(renderInvoiceForm()).find(node => node.type === ToothSelectionDialog)!;
    (dialog.props.onConfirm as (selection: { teeth: number[]; surfaces: string; scope: null }) => void)({ teeth: [36], surfaces: "", scope: null });
    for (const [label, value] of [["السعر", "300000"], ["سبب تغيير السعر", "Synthetic historical agreed price"], ["المدفوع قبل النظام", "120000"], ["تاريخ المعلومات التاريخية", "2026-01-01"]]) {
      const input = elements(renderInvoiceForm()).find(node => node.type === "input" && node.props["aria-label"] === label)!;
      (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
    }
    renderInvoiceForm(); await vi.advanceTimersByTimeAsync(351);
    const refused = renderInvoiceForm(); expect(text(refused)).toContain("Synthetic preview refusal");
    const save = elements(refused).find(node => node.type === "button" && text(node).trim() === "احفظ الاتفاق التاريخي")!;
    expect(save.props.disabled).toBe(true); await (save.props.onClick as () => Promise<void>)();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/patients/901/historical-documents/preview")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/patients/901/historical-documents")).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/invoices")).toHaveLength(1);
    expect(find(node => node.props["data-testid"] === "invoice-clinical-notice")).toBeUndefined();
    expect(text(find(node => node.props["data-testid"] === "account-canonical-balance"))).toContain(formatMoney(180000, "YER"));
  });
  it.each([400, 409])("a new legacy write with refusal %i cannot retain the prior invoice success", async status => {
    render(); await settle(); open("invoice");
    const invoice = find(node => typeof node.type === "function" && node.type.name === "InvoiceForm"); expect(invoice).toBeDefined();
    await (invoice!.props.onSubmit as (body: Record<string, unknown>,validate:(value:unknown)=>boolean) => Promise<unknown>)({ currency: "YER", items: [{ serviceId: 31, toothCode: 36, description: "Synthetic feedback seed", price: "180000", quantity: "1" }], idempotencyKey: "synthetic-first" },validateInvoice);
    await settle(); expect(find(node => node.props["data-testid"] === "invoice-clinical-notice")).toBeDefined();
    open("legacy"); const form = find(node => typeof node.type === "function" && node.type.name === "InvoiceForm" && node.props.historical === true)!; expect(form).toBeDefined();
    let release!: (value: Response) => void; write = () => new Promise(resolve => { release = resolve; });
    const body = { serviceId: 31, currency: "YER", agreedAmount: "300000", previouslyPaidAmount: "120000", idempotencyKey: "synthetic-legacy-same-key" };
    const pending = (form.props.onSubmit as (body: Record<string, unknown>, validate: (value: unknown) => boolean) => Promise<unknown>)(body, () => false);
    // The old success is retired synchronously, before even the new headers arrive.
    expect(find(node => node.props["data-testid"] === "invoice-clinical-notice")).toBeUndefined();
    // The bounded transport schedules fetch on a microtask; the notice retired before it.
    await Promise.resolve();
    release(json({ message: "Synthetic explicit refusal" }, status)); await pending; await settle();
    expect(find(node => node.props["aria-label"] === "تعذّر حفظ إجراء الحساب")).toBeDefined();
    expect(text(render())).toContain("Synthetic explicit refusal");
    expect(find(node => node.props["data-testid"] === "invoice-clinical-notice")).toBeUndefined();
    expect(find(node => typeof node.type === "function" && node.type.name === "InvoiceForm" && node.props.historical === true)?.type).toBe(form.type);
    expect(text(find(node => node.props["data-testid"] === "account-canonical-balance"))).toContain(formatMoney(180000, "YER"));
    expect(find(node => node.props["data-testid"] === "account-balance-unavailable")).toBeUndefined();
    // The current successful retry gets its own notice; neither the key nor command is replaced here.
    const accepted = { document: { remainingMinor: 180000, id: 71 }, replayed: true };
    write = async () => json(accepted, 201);
    const retry = find(node => typeof node.type === "function" && node.type.name === "InvoiceForm" && node.props.historical === true)!;
    await (retry.props.onSubmit as (body: Record<string, unknown>, validate: (value: unknown) => boolean) => Promise<unknown>)(body, value => JSON.stringify(value) === JSON.stringify(accepted)); await settle();
    expect(find(node => node.props["aria-label"] === "تعذّر حفظ إجراء الحساب")).toBeUndefined();
    expect(text(find(node => node.props["data-testid"] === "invoice-clinical-notice"))).toContain("حُفظ الاتفاق التاريخي");
    const legacyWrites = fetchMock.mock.calls.filter(([url]) => url === "/api/patients/901/historical-documents");
    expect(legacyWrites).toHaveLength(2); expect(legacyWrites[0][1].body).toBe(legacyWrites[1][1].body);
  });
});

describe("PatientLedger manual row provenance", () => {
  const picker = () => elements(renderInvoiceForm(false)).find(node => node.type === ServiceSelect)!;
  const input = (label: string) => elements(renderInvoiceForm(false)).find(node => node.type === "input" && node.props["aria-label"] === label)!;
  const type = (label: string, value: string) => (input(label).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
  const select = (id: number, service: unknown) => (picker().props.onChange as (id: number, service: unknown) => void)(id, service);
  const manual = () => (picker().props.onManualSelect as () => void)();
  const catalogue = { id: 31, name: "Synthetic root canal", category: "rct", priceMinor: 180000, priceConfigured: true, isActive: true };

  it("catalogue → placeholder → manual drops catalogue identity in the real form handler", async () => {
    render(); await settle(); open("invoice"); vi.useFakeTimers();
    select(31, catalogue);
    type("السعر", "180001");
    type("سبب تغيير السعر", "Synthetic catalogue override");
    select(0, null);
    manual();
    expect(picker().props).toMatchObject({ value: null, manualSelected: true });
    expect(input("وصف البند").props.value).toBe("");
    expect(input("السعر").props.value).toBe("");
    expect(elements(renderInvoiceForm(false)).some(node => node.props["data-testid"] === "invoice-tooth-control-0")).toBe(false);
    type("وصف البند", "Synthetic manual work");
    type("السعر", "900");
    renderInvoiceForm(false); await vi.advanceTimersByTimeAsync(351);
    const preview = fetchMock.mock.calls.find(([url]) => url === "/api/invoices/clinical-preview");
    expect(preview).toBeDefined();
    const item = JSON.parse(preview![1].body).items[0];
    expect(item).toMatchObject({ description: "Synthetic manual work", price: "900", priceReason: "" });
    expect(item).not.toHaveProperty("serviceId");
    expect(item).not.toHaveProperty("doctorId");
    expect(item).not.toHaveProperty("caseId");
  });

  it("keeps text typed after clearing a catalogue choice, but clears amounts on a real currency change", async () => {
    render(); await settle(); open("invoice");
    select(31, catalogue);
    select(0, null);
    // Even text equal to a catalogue name is manual when the user typed it after clearing the choice.
    type("وصف البند", catalogue.name);
    type("السعر", "12345");
    manual(); manual();
    expect(picker().props).toMatchObject({ value: null, manualSelected: true });
    expect(input("وصف البند").props.value).toBe(catalogue.name);
    expect(input("السعر").props.value).toBe("12345");
    for (const currency of ["SAR", "USD", "YER"]) {
      const choice = elements(renderInvoiceForm(false)).find(node => node.type === "select" && node.props["aria-label"] === "عملة الفاتورة")!;
      expect(choice.props.value).not.toBe(currency);
      (choice.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: currency } });
      expect(picker().props).toMatchObject({ value: null, manualSelected: true });
      expect(input("وصف البند").props.value).toBe(catalogue.name);
      expect(input("السعر").props.value).toBe("");
      type("السعر", "99");
    }
  });
});
