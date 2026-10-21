import { type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceCorrection } from "../components/InvoiceCorrection";
import type { SessionInfo } from "../components/SessionProvider";
import type { InvoiceRevisionCommand, InvoiceRevisionView } from "../lib/invoice-revision-view";
import type { FinancialRecoveryControl } from "../lib/financial-command-journal";
import { CURRENCIES, type Currency } from "../lib/money";

// Actual editor callbacks and request/receipt contracts; only React lifecycle,
// session delivery, transport and browser journal are synthetic boundaries.
// This is not a real-browser/IndexedDB or server authorization acceptance test.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  layout: [] as Array<() => void>, pending: [] as Array<() => void>,
  session: { username: "synthetic-readiness-admin", role: "admin" } as SessionInfo | null,
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined), previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  const effect = (phase: "layout" | "pending", run: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined), previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    hooks[phase].push(() => { previous?.cleanup?.(); const cleanup = run(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      if (!hooks.memos.has(index)) hooks.memos.set(index, { value: (value: unknown) => {
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      } });
      return [hooks.values[index], hooks.memos.get(index)!.value];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useMemo: memo, useCallback: (fn: unknown, deps?: readonly unknown[]) => memo(() => fn, deps),
    useLayoutEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => effect("layout", run, deps),
    useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => effect("pending", run, deps),
  };
});
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fixture(currency: Currency = "YER"): InvoiceRevisionView {
  const amount = currency === "YER" ? 1000 : 100000;
  return {
    invoice: { id: 12, patientId: 17, invoiceNumber: "SYNTHETIC-12", patientName: "Synthetic", status: "open", totalMinor: amount, discountMinor: 0,
      baseCurrency: currency, note: null, createdAt: "2026-10-20T10:00:00.000Z",
      items: [{ id: 19, serviceId: null, doctorId: null, description: "Synthetic", quantity: 1, unitPriceMinor: amount, totalMinor: amount, planItemId: null }] },
    sourceHash: "a".repeat(64), settledMinor: 0, remainingMinor: amount, accountDueMinor: amount, work: [],
    repaymentVersion: 0, repaymentTerms: { mode: "full", installments: [] },
    ...(currency === "YER" ? { currencyCorrection: { available: true, targetCurrency: "SAR", settledMinor: 0, accountDueMinor: 0, message: "Synthetic eligible preview" } } : {}),
  };
}
let recovery: InvoiceRevisionCommand | null = null;
let control: FinancialRecoveryControl;
let get: () => Promise<Response>, post: () => Promise<Response>;
const fetchMock = vi.fn(), done = vi.fn(), cancel = vi.fn(), changed = vi.fn();
function render(): ReactNode {
  for (let pass = 0; pass < 30; pass++) {
    hooks.cursor = 0; hooks.changed = false;
    const tree = InvoiceCorrection({ patientId: 17, invoiceId: 12, recovery,
      onRecoveryChange: command => { recovery = command; changed(command); }, financialRecovery: control, onDone: done, onCancel: cancel });
    hooks.layout.splice(0).forEach(run => run()); hooks.pending.splice(0).forEach(run => run());
    if (!hooks.changed) return tree;
  }
  throw new Error("Editor fixture did not settle");
}
async function settle() { for (let pass = 0; pass < 6; pass++) { for (let i = 0; i < 12; i++) await Promise.resolve(); render(); } }
const find = (predicate: (node: Element) => boolean) => nodes(render()).find(predicate);
const label = (value: string) => find(node => node.props["aria-label"] === value);
const button = (value: string) => find(node => node.type === "button" && text(node) === value);
function change(value: string, next: string) { const node = label(value); expect(node).toBeDefined(); (node!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: next } }); render(); }
function click(value: string) { const node = button(value); expect(node).toBeDefined(); (node!.props.onClick as () => void)(); render(); }
const options = () => nodes(label("عملة الفاتورة المصححة")).filter(node => node.type === "option");
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
const states = () => nodes(render()).filter(node => node.props["data-currency"]).map(node => [node.props["data-currency"], node.props["data-readiness"]]);
function saved(): InvoiceRevisionCommand {
  const view = fixture();
  const body = JSON.stringify({ idempotencyKey: "synthetic-frozen-correction", expectedSourceHash: view.sourceHash, reason: "Synthetic", lines: [{ itemId: 19, quantity: 1, unitPrice: "1000" }], discount: "0", repaymentTerms: view.repaymentTerms, expectedRemainingMinor: 1000 });
  return { key: "synthetic-frozen-correction", actor: "synthetic-readiness-admin", patientId: 17, invoiceId: 12, body,
    expected: { original: view.invoice, lines: view.invoice.items, discountMinor: 0, settledMinor: 0, accountDueMinor: 1000, terms: view.repaymentTerms }, outcome: "uncertain", message: "Synthetic frozen recovery" };
}
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.memos.clear(); hooks.layout = []; hooks.pending = [];
  hooks.session = { username: "synthetic-readiness-admin", role: "admin" };
  recovery = null; done.mockReset(); cancel.mockReset(); changed.mockReset(); fetchMock.mockReset();
  control = { ready: true, revision: 0, error: null, reserve: vi.fn(async () => true), acknowledge: vi.fn(async () => undefined) };
  get = async () => json(fixture()); post = async () => json({ code: "stale", message: "Synthetic stale source" }, 409);
  fetchMock.mockImplementation((_url: string, init?: RequestInit) => init?.method === "POST" ? post() : get());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { hooks.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe("real editor currency readiness and retained write boundaries", () => {
  it.each(CURRENCIES)("shows all currencies from %s with exact existing eligibility", async currency => {
    get = async () => json(fixture(currency)); render(); await settle();
    expect(options().map(node => node.props.value)).toEqual(CURRENCIES);
    for (const node of options()) expect(node.props.disabled).toBe(!(node.props.value === currency || currency === "YER" && node.props.value === "SAR"));
    expect(text(render())).toContain("تغيير العملة ليس تحويلًا بسعر صرف");
    const html = renderToStaticMarkup(render());
    expect(html).toContain('dir="rtl"'); expect(html).toContain('aria-label="إتاحة تصحيح العملات"');
    expect(html).toContain('min-w-0'); expect(posts()).toHaveLength(0);
  });
  it.each(["USD", "YER", "OTHER"])("forged unsupported %s change cannot alter a SAR invoice or submit that target", async target => {
    get = async () => json(fixture("SAR")); render(); await settle();
    change("عملة الفاتورة المصححة", target); expect(label("عملة الفاتورة المصححة")?.props.value).toBe("SAR");
    change("سبب التصحيح", "Synthetic correction"); click("تأكيد تصحيح الفاتورة"); await settle();
    expect(posts()).toHaveLength(1); expect(JSON.parse(posts()[0][1].body)).not.toHaveProperty("currency");
  });
  it("retains numeric interpretation and the unchanged request format for eligible YER→SAR", async () => {
    render(); await settle(); change("عملة الفاتورة المصححة", "SAR");
    expect(label("سعر التصحيح 1")?.props.value).toBe("1000");
    change("سبب التصحيح", "Synthetic correction"); click("تأكيد تصحيح الفاتورة"); await settle();
    expect(posts()).toHaveLength(1);
    const body = JSON.parse(posts()[0][1].body);
    expect(body).toMatchObject({ currency: "SAR", expectedSourceHash: "a".repeat(64), lines: [{ itemId: 19, quantity: 1, unitPrice: "1000" }], expectedRemainingMinor: 100000 });
    expect(body).not.toHaveProperty("exchangeRate"); expect(recovery?.outcome).toBe("refused");
    expect(control.acknowledge).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
  });
  it("does not unlock a refused or missing proof", async () => {
    const view = fixture(); view.currencyCorrection = { ...view.currencyCorrection!, available: false, reasonCodes: ["INDEPENDENT_ITEM_SOURCE"] };
    get = async () => json(view); render(); await settle();
    expect(states()).toContainEqual(["SAR", "review"]); expect(text(render())).toContain("مصدر مستقل");
    change("عملة الفاتورة المصححة", "SAR"); expect(label("عملة الفاتورة المصححة")?.props.value).toBe("YER");
  });
  it("renders a missing YER target proof as unverified without blocking same-currency corrections", async () => {
    const view = fixture(); delete view.currencyCorrection; get = async () => json(view); render(); await settle();
    expect(states()).toContainEqual(["SAR", "unverified"]); expect(options().find(node => node.props.value === "YER")?.props.disabled).toBe(false);
    change("عملة الفاتورة المصححة", "SAR"); expect(label("عملة الفاتورة المصححة")?.props.value).toBe("YER");
  });
  it("shows three unverified targets while loading; a late retired preview cannot unlock them", async () => {
    let resolve!: (response: Response) => void; get = () => new Promise(done => { resolve = done; }); render();
    expect(states()).toEqual(CURRENCIES.map(currency => [currency, "unverified"])); expect(options()).toEqual([]);
    hooks.effects.forEach(effect => effect.cleanup?.()); resolve(json(fixture())); await settle();
    expect(options()).toEqual([]); expect(posts()).toHaveLength(0);
  });
  it.each([403, 409, 500])("keeps denied/stale/unavailable GET %i unverified", async status => {
    get = async () => json({ code: status === 403 ? "unauthorized" : "stale", message: "Synthetic unavailable preview" }, status);
    render(); await settle(); expect(states()).toEqual(CURRENCIES.map(currency => [currency, "unverified"]));
    expect(options()).toEqual([]); expect(text(render())).toContain("Synthetic unavailable preview"); expect(posts()).toHaveLength(0);
  });
  it("ignores stale preview responses from a superseded read", async () => {
    let resolve!: (response: Response) => void; get = () => new Promise(done => { resolve = done; }); render();
    get = async () => json(fixture("USD")); click("إعادة قراءة الفاتورة"); await settle();
    resolve(json(fixture())); await settle();
    expect(label("عملة الفاتورة المصححة")?.props.value).toBe("USD");
    expect(states()).toContainEqual(["SAR", "unsupported"]); expect(posts()).toHaveLength(0);
  });
  it.each(["doctor", "reception", "cashier", "accountant"])("retains %s write denial even with a prior eligible preview", async role => {
    render(); await settle(); hooks.session = { username: "synthetic-other", role }; render();
    change("عملة الفاتورة المصححة", "SAR"); expect(label("عملة الفاتورة المصححة")?.props.value).toBe("YER");
    expect(text(render())).toContain("جلسة مدير سارية"); click("تأكيد تصحيح الفاتورة"); await settle();
    expect(posts()).toHaveLength(0); expect(control.reserve).not.toHaveBeenCalled();
  });
  it("blocks a synchronous currency change after send starts, before a React rerender", async () => {
    render(); await settle(); change("سبب التصحيح", "Synthetic correction");
    const currencyChange = label("عملة الفاتورة المصححة")!.props.onChange as (e: { target: { value: string } }) => void;
    const submit = button("تأكيد تصحيح الفاتورة")!.props.onClick as () => void;
    submit(); currencyChange({ target: { value: "SAR" } });
    expect(label("عملة الفاتورة المصححة")?.props.value).toBe("YER");
    await settle(); expect(posts()).toHaveLength(1); expect(JSON.parse(posts()[0][1].body)).not.toHaveProperty("currency");
  });
  it("keeps unknown/malformed target diagnostics unverified instead of opening the selector", async () => {
    const view = fixture(); get = async () => json({ ...view, currencyCorrection: { ...view.currencyCorrection, reasonCodes: ["UNKNOWN"] } });
    render(); await settle(); expect(options()).toEqual([]);
    expect(states()).toEqual(CURRENCIES.map(currency => [currency, "unverified"])); expect(posts()).toHaveLength(0);
  });
  it("does not unlock while the durable journal is unavailable", async () => {
    render(); await settle(); control.ready = false; render(); change("عملة الفاتورة المصححة", "SAR");
    expect(label("عملة الفاتورة المصححة")?.props.value).toBe("YER"); click("تأكيد تصحيح الفاتورة"); await settle(); expect(posts()).toHaveLength(0);
  });
  it("preserves frozen recovery bytes and repeats only that original request after an uncertain response", async () => {
    recovery = saved(); const frozenBody = recovery.body, frozenKey = recovery.key;
    post = async () => { throw new Error("Synthetic lost response"); }; render(); await settle();
    expect(fetchMock).not.toHaveBeenCalled(); expect(options()).toEqual([]); expect(text(render())).toContain("طلب تصحيح محفوظ");
    click("إعادة نفس طلب التصحيح"); await settle();
    expect(recovery).toMatchObject({ body: frozenBody, key: frozenKey, outcome: "uncertain" });
    click("إعادة نفس طلب التصحيح"); await settle();
    expect(posts()).toHaveLength(2); expect(posts().map(([, init]) => init.body)).toEqual([frozenBody, frozenBody]);
    expect(control.acknowledge).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
  });
  it("does not replay a frozen request under a different session owner", async () => {
    recovery = saved(); hooks.session = { username: "another-admin", role: "admin" }; render();
    click("إعادة نفس طلب التصحيح"); await settle(); expect(fetchMock).not.toHaveBeenCalled(); expect(control.reserve).not.toHaveBeenCalled();
  });
});
