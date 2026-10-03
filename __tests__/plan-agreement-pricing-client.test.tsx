import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientPlans } from "../components/PatientPlans";

// Exercise the actual advanced-form controls/submit closure in separate hook
// scopes. This is synthetic component coverage, not a browser or database gate.
type Driver = { values: unknown[]; cursor: number; effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>; layoutEffects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>; memos: Map<number, { deps?: readonly unknown[]; value: unknown }>; pending: Array<() => void>; layoutPending: Array<() => void> };
const hooks = vi.hoisted(() => ({ current: null as unknown as Driver }));
const newDriver = (): Driver => ({ values: [], cursor: 0, effects: new Map(), layoutEffects: new Map(), memos: new Map(), pending: [], layoutPending: [] });
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (state: Driver, initial: unknown) => { const index = state.cursor++; if (!(index in state.values)) state.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const state = hooks.current; const index = slot(state, undefined); const previous = state.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); state.memos.set(index, { deps, value }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => { const state = hooks.current; const index = slot(state, typeof initial === "function" ? initial() : initial); return [state.values[index], (value: unknown) => { state.values[index] = typeof value === "function" ? value(state.values[index]) : value; }]; },
    useRef: (initial: unknown) => { const state = hooks.current; return state.values[slot(state, { current: initial })]; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const state = hooks.current; const index = slot(state, undefined); const previous = state.effects.get(index); if (previous && same(previous.deps, deps)) return;
      state.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); state.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
    },
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const state = hooks.current; const index = slot(state, undefined); const previous = state.layoutEffects.get(index); if (previous && same(previous.deps, deps)) return;
      state.layoutPending.push(() => { previous?.cleanup?.(); const cleanup = effect(); state.layoutEffects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
    },
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic-reception", role: "reception" }) }));
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  const found: Element[] = [];
  Children.forEach(node, (child) => { if (isValidElement<Record<string, unknown>>(child)) { found.push(child); found.push(...elements(child.props.children as ReactNode)); } });
  return found;
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  const parts: string[] = [];
  Children.forEach(node, (child) => { if (typeof child === "string" || typeof child === "number") parts.push(String(child)); else if (isValidElement<{ children?: ReactNode }>(child)) parts.push(text(child.props.children)); });
  return parts.join(" ");
}
let parent: Driver; let child: Driver;
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
const fetchMock = vi.fn();
let writeResponse: ReturnType<typeof response>;
function view(state: Driver, component: () => ReactNode) {
  hooks.current = state; state.cursor = 0; const tree = component(); state.layoutPending.splice(0).forEach((effect) => effect()); state.pending.splice(0).forEach((effect) => effect());
  return { tree, nodes: elements(tree), text: text(tree) };
}
const parentView = () => view(parent, () => PatientPlans({ patientId: 91 }));
function childView() {
  const node = parentView().nodes.find((element) => typeof element.type === "function" && element.type.name === "NewPlanFormV2");
  expect(node).toBeDefined();
  return view(child, () => (node!.type as (input: Record<string, unknown>) => ReactNode)(node!.props));
}
const cleanup = (state: Driver) => { state.layoutEffects.forEach((effect) => effect.cleanup?.()); state.effects.forEach((effect) => effect.cleanup?.()); };
async function settle() { for (let index = 0; index < 40; index += 1) await Promise.resolve(); }
function click(label: string, current = childView()) {
  const node = current.nodes.find((element) => element.type === "button" && text(element).includes(label));
  expect(node, label).toBeDefined(); (node!.props.onClick as () => void)();
}
function field(label: string) { const node = childView().nodes.find((element) => element.props["aria-label"] === label); expect(node, label).toBeDefined(); return node!; }
function change(label: string, value: string) { (field(label).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); }
async function submit() {
  const form = childView().nodes.find((element) => element.type === "form")!;
  await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: vi.fn() });
}
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
async function open() {
  parentView(); await settle(); click("خطة متقدمة", parentView()); childView(); await settle(); childView();
}
async function selectItem() {
  await open();
  change("عملة الاتفاق", "SAR"); click("بند علاجي");
  const selector = childView().nodes.find((element) => element.props.ariaLabel === "الإجراء")!;
  (selector.props.onChange as (id: number, service: unknown) => void)(8, { id: 8, name: "Synthetic treatment", priceMinor: 30000 });
  change("السعر", "300");
  const tooth = childView().nodes.find((element) => typeof element.type === "function" && element.type.name === "ToothField")!;
  (tooth.props.onChange as (value: string) => void)("36");
}
beforeEach(() => {
  parent = newDriver(); child = newDriver();
  writeResponse = response({ message: "Synthetic server rejection" }, 400);
  fetchMock.mockReset().mockImplementation(async (target: string, init?: RequestInit) => init?.method ? writeResponse
    : target === "/api/services" ? response({ services: [{ id: 8, name: "Synthetic treatment", priceMinor: 30000 }] })
      : target.endsWith("/plans") ? response({ plans: [], plannedVisits: [], canSeeFinancial: true, baseCurrency: "YER", capabilities: { canEditPlans: true, canViewCatalogPrices: true, canCollectPayments: true, canRecordConsent: true, canCompletePlan: true, canPrintContract: true } }) : response([]));
  vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("window", { confirm: vi.fn() });
});
afterEach(() => { cleanup(child); cleanup(parent); vi.unstubAllGlobals(); });

describe("advanced plan creation preserves unsupported agreement drafts", () => {
  it("blocks the published-baseline 300 SAR -> 200 SAR mode switch before any POST and retains all controls", async () => {
    await selectItem(); click("مبلغ إجمالي متفق عليه"); change("المبلغ المتفق عليه", "200");
    click("دفعة أولى + أقساط"); change("عدد الأقساط", "2");
    expect(childView().text).toContain("200.00");
    await submit(); await submit();
    expect(writes()).toHaveLength(0); expect(parentView().text).toContain("لم تُحفظ الخطة");
    expect(field("المبلغ المتفق عليه").props.value).toBe("200"); expect(field("السعر").props.value).toBe("300");
    expect(field("عدد الأقساط").props.value).toBe("2");
    const selector = childView().nodes.find((element) => element.props.ariaLabel === "الإجراء")!;
    expect(selector.props.value).toBe(8);
    const tooth = childView().nodes.find((element) => typeof element.type === "function" && element.type.name === "ToothField")!;
    expect(tooth.props.value).toBe("36");
    // A deliberate edit can make the existing item-derived contract representable.
    change("المبلغ المتفق عليه", "300"); await submit();
    expect(writes()).toHaveLength(1);
    const body = JSON.parse(String(writes()[0][1]?.body));
    expect(body).toMatchObject({ pricingMode: "agreed", total: "300", currency: "SAR", items: [{ serviceId: 8, toothCode: 36, unitPriceMinor: 30000 }] });
    expect(body.installments.map((part: { amountMinor: number }) => part.amountMinor)).toEqual([15000, 15000]);
  });
  it("blocks a partial empty-item custom schedule without changing either amount", async () => {
    await open(); change("عملة الاتفاق", "SAR"); click("مبلغ إجمالي متفق عليه"); change("المبلغ المتفق عليه", "300");
    click("جدول دفعات مخصص"); click("+ دفعة"); change("مبلغ الدفعة", "100"); await submit();
    expect(writes()).toHaveLength(0); expect(field("المبلغ المتفق عليه").props.value).toBe("300");
    expect(field("مبلغ الدفعة").props.value).toBe("100"); expect(parentView().text).toContain("لم تُحفظ الخطة");
  });
  it("keeps item-priced partial custom schedules available and explicit", async () => {
    await selectItem(); click("جدول دفعات مخصص"); click("+ دفعة"); change("مبلغ الدفعة", "100"); await submit();
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0][1]?.body))).toMatchObject({ pricingMode: "items", billingMode: "custom_schedule", items: [{ unitPriceMinor: 30000 }], installments: [{ amountMinor: 10000 }] });
  });
  it("retains the full draft after a typed server rejection, without marking an uncertain write", async () => {
    writeResponse = response({ code: "agreement_pricing_unsupported", message: "Synthetic agreement rejection" }, 400);
    await selectItem(); click("مبلغ إجمالي متفق عليه"); change("المبلغ المتفق عليه", "300"); await submit();
    expect(writes()).toHaveLength(1); expect(parentView().text).toContain("Synthetic agreement rejection");
    expect(field("المبلغ المتفق عليه").props.value).toBe("300"); expect(field("السعر").props.value).toBe("300");
    expect(parentView().text).not.toContain("نتيجة طلب سابق غير مؤكدة");
  });
});
