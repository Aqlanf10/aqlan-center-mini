import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientLedger } from "../components/PatientLedger";
import { formatMoney } from "../lib/money";
import { ServiceSelect } from "../components/ServiceSelect";
import { ToothSelectionDialog } from "../components/dental/ToothSelectionDialog";
import { LegacyTreatmentForm } from "../components/LegacyTreatmentForm";
import { TreatmentEntryChoice } from "../components/TreatmentEntryChoice";

// Execute the real wrapper/content and write callbacks. Child forms are left as
// elements: this test owns feedback lifetime, not native form/chart acceptance.
const hooks = vi.hoisted(() => {
  type Store = { values: unknown[]; cursor: number; changed: boolean;
    effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>;
    memos: Map<number, { deps?: readonly unknown[]; value: unknown }>; pending: Array<() => void> };
  const make = (): Store => ({ values: [], cursor: 0, changed: false, effects: new Map(), memos: new Map(), pending: [] });
  return { make, current: make(), outer: make(), inner: make(), form: make() };
});
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
      return [h.values[index], (value: unknown) => { const next = typeof value === "function" ? value(h.values[index]) : value;
        if (!Object.is(next, h.values[index])) h.changed = true; h.values[index] = next; }]; },
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
beforeEach(() => {
  hooks.outer = hooks.make(); hooks.inner = hooks.make(); hooks.form = hooks.make(); hooks.current = hooks.outer; entryRequestKey = 0; fetchMock.mockReset();
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm: vi.fn(() => true) });
  write = async () => json({ id: 701, invoiceNumber: "INV-SYNTHETIC-701", patientId: 901, patientName: "Synthetic patient",
    status: "open", totalMinor: 180000, discountMinor: 0, baseCurrency: "YER", note: null, createdAt: "2026-10-11T00:00:00.000Z",
    items: [{ id: 711, serviceId: 31, doctorId: null, description: "Synthetic feedback seed", quantity: 1, unitPriceMinor: 180000, totalMinor: 180000,
      planItemId: 811, caseId: 601, toothCode: 36, surfaces: null, originInvoiceId: 701, billingStatus: "needs_financial_review", financialReviewRequired: true }],
    clinical: { planId: 801, links: [{ line: 0, kind: "clinical", specialty: "endodontics", planItemId: 811, planItemCreated: true, caseCreated: true, caseId: 601 }] }, replayed: false }, 201);
  fetchMock.mockImplementation((url: string, init?: RequestInit) => init?.method === "POST" ? write()
    : url === "/api/patients/901/ledger" ? Promise.resolve(json(ledger))
    : url === "/api/services" ? Promise.resolve(json([{ id: 31, name: "Synthetic root canal", category: "rct", priceMinor: 180000 }])) : Promise.reject(new Error("Unexpected synthetic route")));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { for (const h of [hooks.outer, hooks.inner, hooks.form]) h.effects.forEach(effect => effect.cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });

function renderLegacy(): ReactNode {
  const form = find(node => node.type === LegacyTreatmentForm); expect(form).toBeDefined();
  for (let round = 0; round < 30; round++) {
    hooks.current = hooks.form; hooks.form.cursor = 0; hooks.form.changed = false;
    const wrapper = (form!.type as (props: Record<string, unknown>) => ReactNode)(form!.props) as Element;
    const tree = (wrapper.type as (props: Record<string, unknown>) => ReactNode)(wrapper.props);
    hooks.form.pending.splice(0).forEach(run => run());
    if (!hooks.form.changed) return tree;
  }
  throw new Error("Legacy preview fixture did not settle");
}

describe("PatientLedger operation-scoped success feedback", () => {
  it.each(["toolbar", "request"] as const)("a new %s draft retires old success before refused preview, without a write", async entry => {
    render(); await settle(); open("invoice");
    const invoice = find(node => typeof node.type === "function" && node.type.name === "InvoiceForm")!;
    await (invoice.props.onSubmit as (body: Record<string, unknown>) => Promise<unknown>)({ currency: "YER", items: [{ serviceId: 31, toothCode: 36, price: "180000", quantity: "1" }], idempotencyKey: "synthetic-before-preview" });
    await settle(); expect(find(node => node.props["data-testid"] === "invoice-clinical-notice")).toBeDefined();
    if (entry === "toolbar") click(find(node => node.props["data-testid"] === "treatment-entry-open"));
    else { entryRequestKey = 1; render(); }
    expect(find(node => node.props["data-testid"] === "invoice-clinical-notice")).toBeUndefined();
    const choice = find(node => node.type === TreatmentEntryChoice)!;
    (choice.props.onSelect as (kind: "legacy") => void)("legacy"); render();
    vi.useFakeTimers();
    const realRead = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => url === "/api/patients/901/legacy-treatments/preview"
      ? Promise.resolve(json({ refusal: "open_item_exists", refusalMessage: "Synthetic preview refusal" })) : realRead(url, init));
    const pickService = elements(renderLegacy()).find(node => node.type === ServiceSelect)!;
    (pickService.props.onChange as (id: number) => void)(31); renderLegacy();
    const toothButton = elements(renderLegacy()).find(node => node.props["data-testid"] === "legacy-tooth-button")!;
    (toothButton.props.onClick as () => void)();
    const dialog = elements(renderLegacy()).find(node => node.type === ToothSelectionDialog)!;
    (dialog.props.onConfirm as (selection: { teeth: number[]; surfaces: string; scope: null }) => void)({ teeth: [36], surfaces: "", scope: null });
    for (const [label, value] of [["المبلغ المتفق عليه أصلًا", "300000"], ["المدفوع قبل النظام", "120000"], ["تاريخ المعلومات التاريخية", "2026-01-01"]]) {
      const input = elements(renderLegacy()).find(node => node.type === "input" && node.props["aria-label"] === label)!;
      (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
    }
    renderLegacy(); await vi.advanceTimersByTimeAsync(301);
    const refused = renderLegacy(); expect(text(refused)).toContain("Synthetic preview refusal");
    const save = elements(refused).find(node => node.type === "button" && text(node).trim() === "احفظ العلاج السابق")!;
    expect(save.props.disabled).toBe(true); await (save.props.onClick as () => Promise<void>)();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/patients/901/legacy-treatments/preview")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/patients/901/legacy-treatments")).toHaveLength(0);
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/invoices")).toHaveLength(1);
    expect(find(node => node.props["data-testid"] === "invoice-clinical-notice")).toBeUndefined();
    expect(text(find(node => node.props["data-testid"] === "account-canonical-balance"))).toContain(formatMoney(180000, "YER"));
  });
  it.each([400, 409])("a new legacy write with refusal %i cannot retain the prior invoice success", async status => {
    render(); await settle(); open("invoice");
    const invoice = find(node => typeof node.type === "function" && node.type.name === "InvoiceForm"); expect(invoice).toBeDefined();
    await (invoice!.props.onSubmit as (body: Record<string, unknown>) => Promise<unknown>)({ currency: "YER", items: [{ serviceId: 31, toothCode: 36, description: "Synthetic feedback seed", price: "180000", quantity: "1" }], idempotencyKey: "synthetic-first" });
    await settle(); expect(find(node => node.props["data-testid"] === "invoice-clinical-notice")).toBeDefined();
    open("legacy"); const form = find(node => node.type === LegacyTreatmentForm)!; expect(form).toBeDefined();
    let release!: (value: Response) => void; write = () => new Promise(resolve => { release = resolve; });
    const body = { serviceId: 31, currency: "YER", agreedAmount: "300000", previouslyPaidAmount: "120000", idempotencyKey: "synthetic-legacy-same-key" };
    const pending = (form.props.onSubmit as (body: Record<string, unknown>) => Promise<void>)(body);
    // The old success is retired synchronously, before even the new headers arrive.
    expect(find(node => node.props["data-testid"] === "invoice-clinical-notice")).toBeUndefined();
    release(json({ message: "Synthetic explicit refusal" }, status)); await pending; await settle();
    expect(find(node => node.props["aria-label"] === "تعذّر حفظ إجراء الحساب")).toBeDefined();
    expect(text(render())).toContain("Synthetic explicit refusal");
    expect(find(node => node.props["data-testid"] === "invoice-clinical-notice")).toBeUndefined();
    expect(find(node => node.type === LegacyTreatmentForm)?.type).toBe(form.type);
    expect(text(find(node => node.props["data-testid"] === "account-canonical-balance"))).toContain(formatMoney(180000, "YER"));
    expect(find(node => node.props["data-testid"] === "account-balance-unavailable")).toBeUndefined();
    // The current successful retry gets its own notice; neither the key nor command is replaced here.
    write = async () => json({ agreement: { remainingMinor: 180000, caseId: 601 } }, 201);
    const retry = find(node => node.type === LegacyTreatmentForm)!;
    await (retry.props.onSubmit as (body: Record<string, unknown>) => Promise<void>)(body); await settle();
    expect(find(node => node.props["aria-label"] === "تعذّر حفظ إجراء الحساب")).toBeUndefined();
    expect(text(find(node => node.props["data-testid"] === "invoice-clinical-notice"))).toContain("سُجّل العلاج السابق للنظام");
    const legacyWrites = fetchMock.mock.calls.filter(([url]) => url === "/api/patients/901/legacy-treatments");
    expect(legacyWrites).toHaveLength(2); expect(legacyWrites[0][1].body).toBe(legacyWrites[1][1].body);
  });
});
