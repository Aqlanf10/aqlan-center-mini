import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TodayVisitTab } from "../components/patient/TodayVisitTab";
import { ClinicalVisit } from "../components/ClinicalVisit";
import { CheckoutExtras } from "../components/patient/CheckoutExtras";
import { CollectPaymentModal } from "../components/CollectPaymentModal";
import type { WorkflowSummary } from "../components/patient/SummaryTab";
import { buildCheckoutDueRecommendation, type CheckoutDueSource } from "../lib/checkout-due-recommendation";

type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
type Frame = { slots: Slot[]; cursor: number; pending: (() => void)[]; layout: (() => void)[] };
const runtime = vi.hoisted(() => ({ frame: null as Frame | null }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = () => { const f = runtime.frame!; const i = f.cursor++; return f.slots[i] ?? (f.slots[i] = {}); };
  const changed = (s: Slot, deps?: unknown[]) => !deps || !s.deps || deps.some((v, i) => !Object.is(v, s.deps![i]));
  return { ...react,
    useState: (initial: unknown) => { const s = slot(); if (!("value" in s)) s.value = typeof initial === "function" ? initial() : initial;
      return [s.value, (next: unknown) => { s.value = typeof next === "function" ? next(s.value) : next; }]; },
    useRef: (initial: unknown) => { const s = slot(); if (!s.value) s.value = { current: initial }; return s.value; },
    useCallback: (fn: unknown, deps: unknown[]) => { const s = slot(); if (changed(s, deps)) { s.value = fn; s.deps = deps; } return s.value; },
    useMemo: (fn: () => unknown, deps: unknown[]) => { const s = slot(); if (changed(s, deps)) { s.value = fn(); s.deps = deps; } return s.value; },
    useLayoutEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const s = slot(); if (changed(s, deps)) { s.deps = deps; runtime.frame!.layout.push(() => { s.cleanup?.(); s.cleanup = fn() || undefined; }); }
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const s = slot(); if (changed(s, deps)) { s.deps = deps; runtime.frame!.pending.push(() => { s.cleanup?.(); s.cleanup = fn() || undefined; }); }
    },
  };
});
vi.mock("../components/ClinicalVisit", () => ({ ClinicalVisit: () => null }));
vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));
vi.mock("../components/patient/CheckoutExtras", async (original) => {
  const actual = await original<typeof import("../components/patient/CheckoutExtras")>();
  return { ...actual, CheckoutExtras: () => null };
});
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const e = node as Element; return [e, ...elements(e.props.children as ReactNode)];
}
const workflow = () => ({ patient: { id: 1 }, canSeeFinancial: true,
  financial: { byCurrency: { YER: { balanceMinor: 180000 }, SAR: { balanceMinor: 0 }, USD: { balanceMinor: 0 } } } });
const walkout = (balance = 180000) => ({ visitId: 10, patientId: 1, patientName: "Synthetic",
  signedAt: "2026-10-09T10:00:00Z", arrivedAt: "2026-10-09T09:00:00Z", signedToday: true,
  deferred: false, lines: [], orthoAdjustment: { id: 30, billingClass: "LEGACY_INCLUDED", pendingDecision: false, decision: null },
  nextAppointment: null, invoice: null, balances: balance ? [{ currency: "YER", balanceMinor: balance }] : [],
  checkout: { previous: { YER: 180000, SAR: 0, USD: 0 }, current: { YER: balance, SAR: 0, USD: 0 }, invoicePaidMinor: 0 } });
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
const turns = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
function mount(patientId = 1) {
  const frame: Frame = { slots: [], cursor: 0, pending: [], layout: [] };
  let tree: ReactElement;
  const props = { patientId, patientName: "Synthetic", base: "YER" as const, canCollect: true, visits: [],
    summary: { openVisit: { id: 10, arrivedAt: "2026-10-09T09:00:00Z", status: "in_chair", chair: 1 }, lastVisit: null, plannedVisits: [] } as unknown as WorkflowSummary,
    onVisitStarted: vi.fn(), onChanged: vi.fn() };
  const render = (afterLayout?: (tree: ReactElement) => void) => { runtime.frame = frame; frame.cursor = 0;
    const owner = TodayVisitTab(props) as ReactElement;
    tree = (owner.type as (p: unknown) => ReactElement)(owner.props);
    frame.layout.splice(0).forEach((fn) => fn());
    // React commits every layout effect before any child passive visibility report.
    afterLayout?.(tree);
    const pending = frame.pending.splice(0); pending.forEach((fn) => fn()); return tree; };
  render();
  return { render, props, modal: () => elements(render()).find(e => e.type === CollectPaymentModal)!, text: () => renderToStaticMarkup(render()),
    sign: () => { const e = elements(render()).find((e) => e.type === ClinicalVisit)!; (e.props.onSigned as (r: unknown) => void)({ duesMinor: 0, invoiceId: null, invoiceCurrency: "YER" }); },
    collect: () => { const e = elements(render()).find((e) => e.type === CollectPaymentModal)!; (e.props.onSuccess as () => void)(); },
    unmount: () => frame.slots.forEach((s) => s.cleanup?.()) };
}
afterEach(() => vi.unstubAllGlobals());
const invoiceSource = (changes: Partial<CheckoutDueSource> = {}): CheckoutDueSource => ({ kind: "visit_invoice", authorityId: 20,
  currency: "YER", invoiceId: 20, openingCurrency: null, remainingMinor: 750, dueNowMinor: 750, available: true, ...changes });
const paidSummary = [{ currency: "YER" as const, previousBalanceMinor: 0, newBillableMinor: 1000, paymentsTodayMinor: 250,
  currentBalanceMinor: 750, todayRemainingMinor: 750, legacySuggestedMinor: 0, legacyRemainingMinor: 0, dueNowMinor: 750 }];
const withDue = (sources: CheckoutDueSource[] = [invoiceSource()]) => ({ ...walkout(750),
  invoice: { id: 20, netMinor: 1000, currency: "YER" }, summary: paidSummary,
  checkout: { previous: { YER: 0, SAR: 0, USD: 0 }, current: { YER: 750, SAR: 0, USD: 0 }, invoicePaidMinor: 250 },
  dueRecommendation: buildCheckoutDueRecommendation({ patientId: 1, visitInvoiceId: 20, current: { YER: 750 }, sources }) });
async function load(value: unknown) {
  vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(response(url.includes("/workflow") ? workflow() : value))));
  const f = mount(); f.sign(); await turns(); return f;
}
describe("checkout collection targets match the source-qualified recommendation", () => {
  it.each([0, 150])("routes a scheduled source with due %i to account, never the full invoice modal", async (dueNowMinor) => {
    const f = await load(withDue([invoiceSource({ kind: "repayment_schedule", authorityId: 40, dueNowMinor })]));
    expect(f.text()).not.toContain("تحصيل وطباعة السند");
    expect(f.text()).not.toContain("استحقاق اليوم</dt>");
    expect(f.text()).toContain("اختيار مصدر التحصيل من الحساب");
    expect(f.modal().props.isOpen).toBe(false);
    expect(f.modal().props.presetInvoice).toBeNull();
    expect(f.modal().props.suggestedMinor).toBeNull();
    const link = elements(f.render()).find(e => e.type === "a" && e.props.children === "اختيار مصدر التحصيل من الحساب")!;
    expect(link.props.href).toBe("/patients/1?tab=account");
    expect(link.props.target).toBe("_blank"); // Existing editor/payment drafts stay in their current tab.
    f.unmount();
  });
  it("keeps the ordinary invoice's exact target, amount and currency", async () => {
    const f = await load(withDue());
    const button = elements(f.render()).find(e => e.type === "button" && e.props.children === "تحصيل وطباعة السند")!;
    expect(button).toBeTruthy(); (button.props.onClick as () => void)();
    expect(f.modal().props).toMatchObject({ patientId: 1, isOpen: true, suggestedMinor: 750, suggestedCurrency: "YER", presetInvoice: { id: 20, baseCurrency: "YER" } });
    f.props.canCollect = false;
    expect(f.modal().props.isOpen).toBe(false);
    f.unmount();
  });
  it("requires source selection when another plan coexists with the visit invoice", async () => {
    const value = withDue();
    value.balances = [{ currency: "YER", balanceMinor: 1750 }]; value.checkout.current.YER = 1750;
    value.dueRecommendation = buildCheckoutDueRecommendation({ patientId: 1, visitInvoiceId: 20, current: { YER: 1750 }, sources: [invoiceSource(),
      invoiceSource({ kind: "approved_agreement", authorityId: 42, invoiceId: 21, remainingMinor: 1000, dueNowMinor: 300 })] });
    const f = await load(value);
    expect(f.text()).toContain("اختيار مصدر التحصيل من الحساب"); expect(f.text()).not.toContain("تحصيل وطباعة السند");
    expect(f.modal().props).toMatchObject({ isOpen: false, presetInvoice: null, suggestedMinor: null });
    f.unmount();
  });
  it.each(["missing", "foreign", "balance", "review", "source_remaining"] as const)("never permits inline collection when recommendation is %s", async fault => {
    const value = withDue();
    if (fault === "missing") delete (value as { dueRecommendation?: unknown }).dueRecommendation;
    if (fault === "foreign") value.dueRecommendation.patientId = 9;
    if (fault === "source_remaining") value.dueRecommendation = buildCheckoutDueRecommendation({ patientId: 1, visitInvoiceId: 20, current: { YER: 750 }, sources: [invoiceSource({ remainingMinor: 700, dueNowMinor: 700 })] });
    if (fault === "balance") value.dueRecommendation = buildCheckoutDueRecommendation({ patientId: 1, visitInvoiceId: 20, current: { YER: 751 }, sources: [invoiceSource()] });
    if (fault === "review") value.dueRecommendation = buildCheckoutDueRecommendation({ patientId: 1, visitInvoiceId: 20, current: { YER: 750 }, sources: [invoiceSource({ kind: "repayment_schedule", authorityId: 40, dueNowMinor: null, available: false })] });
    const f = await load(value);
    expect(f.text()).not.toContain("تحصيل وطباعة السند");
    expect(f.text()).not.toContain("لا مبلغ مطلوب لهذه الزيارة");
    expect(f.text()).toContain("اختيار مصدر التحصيل من الحساب");
    expect(f.modal().props.isOpen).toBe(false);
    expect(f.modal().props.suggestedMinor).toBeNull();
    f.unmount();
  });
  it("does not open untargeted YER payment for included work with account debt", async () => {
    const value = { ...walkout(750), dueRecommendation: buildCheckoutDueRecommendation({ patientId: 1, visitInvoiceId: null, current: { YER: 750 }, sources: [] }) };
    const f = await load(value); expect(f.text()).not.toContain("تحصيل وطباعة السند"); expect(f.text()).toContain("اختيار مصدر التحصيل من الحساب"); f.unmount();
  });
  it("retires all child money props immediately during parent refresh and on a failed/foreign response", async () => {
    let resolve!: (value: unknown) => void;
    let fresh = true;
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("/workflow") ? Promise.resolve(response(workflow()))
      : fresh ? Promise.resolve(response(withDue())) : new Promise(done => { resolve = done; })));
    const f = mount(); f.sign(); await turns();
    const extras = () => elements(f.render()).find(e => e.type === CheckoutExtras)!;
    expect(extras().props).toMatchObject({ financialVerified: true, financialSummary: paidSummary });
    expect(extras().props.dueRecommendation).not.toBeNull();
    fresh = false; f.collect();
    expect(extras().props).toMatchObject({ financialVerified: false, financialSummary: null, dueRecommendation: null });
    resolve(response({ ...withDue(), patientId: 9 })); await turns();
    expect(extras().props).toMatchObject({ financialVerified: false, financialSummary: null, dueRecommendation: null });
    f.unmount();
  });

});
