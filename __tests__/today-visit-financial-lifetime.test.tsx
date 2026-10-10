import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TodayVisitTab } from "../components/patient/TodayVisitTab";
import { ClinicalVisit } from "../components/ClinicalVisit";
import { CollectPaymentModal } from "../components/CollectPaymentModal";
import type { WorkflowSummary } from "../components/patient/SummaryTab";
import { formatMoney } from "../lib/money";

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
  return { render, props, text: () => renderToStaticMarkup(render()),
    sign: () => { const e = elements(render()).find((e) => e.type === ClinicalVisit)!; (e.props.onSigned as (r: unknown) => void)({ duesMinor: 0, invoiceId: null, invoiceCurrency: "YER" }); },
    collect: () => { const e = elements(render()).find((e) => e.type === CollectPaymentModal)!; (e.props.onSuccess as () => void)(); },
    unmount: () => frame.slots.forEach((s) => s.cleanup?.()) };
}
afterEach(() => vi.unstubAllGlobals());
describe("TodayVisitTab canonical financial read lifetime", () => {
  it("keeps opening 180000 after sign and ignores a late pre-sign zero", async () => {
    let release!: (v: unknown) => void;
    const old = new Promise((done) => { release = done; });
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("/workflow") ? old : Promise.resolve(response(walkout()))));
    const f = mount(); f.sign(); await turns();
    expect(f.text()).toContain(formatMoney(180000, "YER"));
    release(response({ ...workflow(), financial: { byCurrency: { YER: { balanceMinor: 0 }, SAR: { balanceMinor: 0 }, USD: { balanceMinor: 0 } } } }));
    await turns();
    expect(f.text()).toContain(formatMoney(180000, "YER"));
    expect(f.text()).not.toContain("لا مبلغ مطلوب لهذه الزيارة"); f.unmount();
  });
  it.each(["http500", "json", "null", "empty", "missing", "amount"] as const)("does not retain a verified zero after %s", async (fault) => {
    let bad = false;
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/workflow")) return Promise.resolve(response(workflow()));
      if (!bad) return Promise.resolve(response(walkout(0)));
      if (fault === "http500") return Promise.resolve(response(null, false));
      if (fault === "json") return Promise.resolve({ ok: true, json: async () => { throw new SyntaxError("invalid JSON"); } });
      const value = walkout(0);
      if (fault === "null") return Promise.resolve(response(null));
      if (fault === "empty") value.checkout.current = {} as typeof value.checkout.current;
      if (fault === "missing") delete (value.checkout.current as Partial<typeof value.checkout.current>).USD;
      if (fault === "amount") (value.checkout.current as { YER: unknown }).YER = "0";
      return Promise.resolve(response(value));
    }));
    const f = mount(); f.sign(); await turns(); expect(f.text()).toContain("لا مبلغ مطلوب لهذه الزيارة");
    bad = true; f.collect(); await turns();
    expect(f.text()).toContain("تعذّر التحقق من الأرصدة");
    expect(f.text()).not.toContain("لا مبلغ مطلوب لهذه الزيارة");
    expect(f.text()).not.toContain("لا رصيد سابق"); f.unmount();
  });
  it("rejects a late pre-collection response after a newer collection refresh", async () => {
    const pending: ((v: unknown) => void)[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("/workflow") ? Promise.resolve(response(workflow()))
      : new Promise((done) => { pending.push(done); })));
    const f = mount(); f.sign(); f.collect();
    pending[1](response(walkout(120000))); await turns();
    pending[0](response(walkout(180000))); await turns();
    expect(f.text()).toContain(formatMoney(120000, "YER"));
    f.unmount();
  });
  it("contains completions after a patient owner unmounts", async () => {
    let release!: (v: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((done) => { release = done; })));
    const a = mount(); a.sign(); a.unmount(); release(response(walkout())); await turns();
    expect(a.props.onChanged).toHaveBeenCalledTimes(1);
    expect(a.text()).not.toContain(formatMoney(180000, "YER"));
    const first = TodayVisitTab(a.props) as ReactElement;
    const other = TodayVisitTab({ ...a.props, patientId: 2 }) as ReactElement;
    expect(other.key).not.toBe(first.key);
  });
});


const referenceCardCount = (node: ReactNode) => elements(node).filter((item) => item.props["aria-label"] === "آخر زيارة").length;
const referenceReporter = (node: ReactNode) => elements(node).find((item) => item.type === ClinicalVisit)!.props.onPreviousVisitReferenceChange as (id: number | null) => void;
describe("single visible previous-visit reference", () => {
  const previous = { id: 9, date: "2026-10-08", treatmentDone: "توثيق زيارة اصطناعية سابقة", proceduresSummary: null, nextPlan: null };
  it("retains the fallback until the authorized editor reports the exact visible reference, restoring it on absence", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response(workflow()))));
    const f = mount(); f.props.summary.lastVisit = previous;
    expect(referenceCardCount(f.render())).toBe(1);
    referenceReporter(f.render())(8);
    expect(referenceCardCount(f.render())).toBe(1);
    referenceReporter(f.render())(9);
    expect(referenceCardCount(f.render())).toBe(0);
    referenceReporter(f.render())(null);
    expect(referenceCardCount(f.render())).toBe(1);
    f.props.summary.openVisit = null;
    expect(referenceCardCount(f.render())).toBe(1);
    expect(elements(f.render()).some((item) => item.type === ClinicalVisit)).toBe(false);
    f.unmount();
  });
  it("rejects stale A→B→A visibility callbacks and keeps the fallback when read authority is unavailable", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response(workflow()))));
    const f = mount(); f.props.summary.lastVisit = previous;
    const a = f.props.summary.openVisit!;
    const lateA = referenceReporter(f.render());
    lateA(9); expect(referenceCardCount(f.render())).toBe(0);
    f.props.summary.openVisit = { ...a, id: 11 }; f.render();
    f.props.summary.openVisit = a; f.render();
    lateA(9); expect(referenceCardCount(f.render())).toBe(1);
    // Failure/restricted clinical reads never emit a verified reference ID.
    referenceReporter(f.render())(null); expect(referenceCardCount(f.render())).toBe(1);
    referenceReporter(f.render())(9); expect(referenceCardCount(f.render())).toBe(0);
    f.unmount();
  });
  it("commits a new presentation owner before a child passive report and rejects the retired report", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(response(workflow()))));
    const f = mount(); f.props.summary.lastVisit = previous;
    const oldReport = referenceReporter(f.render());
    const a = f.props.summary.openVisit!;
    f.props.summary.openVisit = { ...a, id: 11 };
    f.render((tree) => referenceReporter(tree)(previous.id));
    expect(referenceCardCount(f.render())).toBe(0);
    oldReport(null);
    expect(referenceCardCount(f.render())).toBe(0);
    // A→B→A is a fresh token even though the visit ID repeats.
    f.props.summary.openVisit = a;
    f.render((tree) => referenceReporter(tree)(previous.id));
    oldReport(null);
    expect(referenceCardCount(f.render())).toBe(0);
    f.unmount();
  });

});
