import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LabOrderAccountingModal } from "../components/LabOrderAccountingModal";
import type { LabOrder } from "../lib/lab";
import { formatAmount, toBaseAmount, type Currency } from "../lib/money";

// The real component, its callbacks, and money/settings helpers run. React state
// and effects use the repository's clinical-visit-lab-containment harness pattern.
// Fetch is completely intercepted: no app, browser, database, or network starts.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  pending: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const effect = (callback: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined);
    const previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = callback();
      hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
    });
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => {
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useMemo: (factory: () => unknown, deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.memos.get(index);
      if (previous && same(previous.deps, deps)) return previous.value;
      const value = factory();
      hooks.memos.set(index, { deps, value });
      return value;
    },
    useCallback: (callback: unknown, deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.memos.get(index);
      if (previous && same(previous.deps, deps)) return previous.value;
      hooks.memos.set(index, { deps, value: callback });
      return callback;
    },
    useEffect: effect,
    useLayoutEffect: effect,
  };
});

type Element = ReactElement<Record<string, unknown>>;
type Tree = ReturnType<typeof LabOrderAccountingModal>;
type Props = Parameters<typeof LabOrderAccountingModal>[0];
const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
type MockResponse = ReturnType<typeof response>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const originalOrder = (overrides: Partial<LabOrder> = {}): LabOrder => ({
  id: 91001, patientId: 92001, patientName: "Synthetic patient", patientNumber: "S-1",
  patientPhone: null, labName: "Synthetic laboratory", labPhone: null, partyId: 93001,
  labServiceId: null, workType: "Synthetic crown", details: null, toothNumbers: "16",
  shade: null, stumpShade: null, priority: "normal", impressionType: "physical",
  sentDate: "2026-10-05", dueDate: "2026-10-12", status: "sent", receivedAt: null,
  deliveredAt: null, doctorId: null, visitId: null, qualityCheck: "pending",
  qualityNotes: null, remakeOriginalId: null, remakeReason: null, technicianName: null,
  note: null, createdAt: "2026-10-05T09:00:00Z", costMinor: 2500, costCurrency: "USD",
  // Deliberately different from 25 * 531.125: historical base must stay exact.
  baseAmountMinor: 13001, exchangeRate: 531.125, payableId: 94001, isPosted: true,
  expenseCategoryId: 7, expenseAccountCode: "5101", payableAccountCode: "2101",
  ...overrides,
});
const categories: Props["expenseCategories"] = [
  { id: 7, key: "lab", name: "Synthetic lab costs", categoryGroup: "professional",
    accountCode: "5101", accountName: "Synthetic expense A", isActive: true },
  { id: 8, key: "other", name: "Synthetic alternative", categoryGroup: "professional",
    accountCode: "5102", accountName: "Synthetic expense B", isActive: true },
];
const currentSettings = (usd = "600", sar = "150") => ({
  "finance.rate.USD": usd, "finance.rate.SAR": sar,
});
const fetchMock = vi.fn();
let props: Props;
let savedReply: LabOrder;
let settingsRequests: Array<ReturnType<typeof deferred<MockResponse>>>;

function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function contents(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(contents).join("");
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return contents((node as Element).props.children as ReactNode);
}
function renderPass(): Tree {
  hooks.cursor = 0;
  hooks.changed = false;
  return LabOrderAccountingModal(props);
}
function commitEffects(tree: Tree): Tree {
  let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("Lab accounting UI did not settle");
    hooks.pending.splice(0).forEach((effect) => effect());
    if (!hooks.changed) break;
    tree = renderPass();
  } while (rounds <= 20);
  return tree;
}
const render = () => commitEffects(renderPass());
async function flush() {
  for (let pass = 0; pass < 4; pass += 1) {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    render();
  }
}
function byId(id: string, tree = render()): Element {
  const node = elements(tree).find((element) => element.props.id === id);
  if (!node) throw new Error(`Missing lab accounting control: ${id}`);
  return node;
}
function change(id: string, value: string, commit = true): Tree {
  const control = byId(id);
  (control.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
  const tree = renderPass();
  return commit ? commitEffects(tree) : tree;
}
const click = (id: string) => (byId(id).props.onClick as () => void | Promise<void>)();
const writes = () => fetchMock.mock.calls.filter(([, options]) => options?.method === "PATCH");
function sentBody(): Record<string, unknown> {
  expect(writes()).toHaveLength(1);
  expect(writes()[0][0]).toBe("/api/lab/91001");
  expect(writes()[0][1].headers).toEqual({ "Content-Type": "application/json" });
  return JSON.parse(String(writes()[0][1].body));
}
function expectNoMoney(body: Record<string, unknown>) {
  for (const field of ["cost", "costMinor", "costCurrency", "exchangeRate", "expectedExchangeRate", "baseAmountMinor"]) {
    expect(Object.hasOwn(body, field), `metadata-only request unexpectedly owns ${field}`).toBe(false);
  }
}
function preview(state: string, currency: Currency, source: "saved" | "current", tree = render()) {
  const node = byId("lab-accounting-money-preview", tree);
  expect(node.props["data-preview-state"]).toBe(state);
  expect(node.props["data-preview-currency"]).toBe(currency);
  expect(node.props["data-preview-source"]).toBe(source);
  return contents(node);
}
function expectUnavailable(state: "loading" | "unavailable" | "invalid", currency: Currency, tree = render()) {
  const text = preview(state, currency, "current", tree);
  // No former snapshot or conversion can be presented as the new exact quote.
  expect(text).not.toContain("13,001");
  expect(text).not.toContain("531.125");
  expect(text).not.toContain("18,000");
  return text;
}
async function resolveSettings(body: unknown = currentSettings(), index = settingsRequests.length - 1, status = 200) {
  expect(settingsRequests[index]).toBeDefined();
  settingsRequests[index].resolve(response(status, body));
  await flush();
}
function expectCurrent(currency: Currency, minor: number, rate: number) {
  const text = preview("ready", currency, "current");
  expect(text).toContain(formatAmount(toBaseAmount(minor, currency, "YER", rate), "YER"));
  expect(text).toContain(String(rate));
  expect(text).not.toContain("531.125");
}

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  vi.clearAllMocks();
  settingsRequests = [];
  savedReply = originalOrder();
  props = { order: originalOrder(), expenseCategories: categories, baseCurrency: "YER",
    onClose: vi.fn(), onSaved: vi.fn() };
  fetchMock.mockImplementation((url: string, options?: RequestInit) => {
    if (url === "/api/settings" && !options?.method) {
      expect(options?.cache).toBe("no-store");
      const request = deferred<MockResponse>();
      settingsRequests.push(request);
      return request.promise;
    }
    if (url === "/api/lab/91001" && options?.method === "PATCH") {
      return Promise.resolve(response(200, savedReply));
    }
    throw new Error(`Unexpected isolated lab accounting request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  hooks.effects.forEach((effect) => effect.cleanup?.());
  hooks.effects.clear();
  vi.unstubAllGlobals();
});

describe("unchanged monetary intent through real accounting callbacks", () => {
  it.each([
    ["update_accounting", "lab-accounting-save-mapping-btn", true],
    ["post", "lab-accounting-final-post-btn", false],
    ["post", "lab-accounting-repost-btn", true],
    ["unpost", "lab-accounting-unpost-btn", true],
  ] as const)("%s with changed mapping sends no monetary snapshot", async (action, buttonId, isPosted) => {
    props.order = originalOrder({ isPosted });
    render();
    change("lab-accounting-category-select", "8");
    change("lab-accounting-payable-acc-select", "2102");
    expect(preview("saved", "USD", "saved")).toContain("13,001");
    expect(settingsRequests).toHaveLength(0);
    await click(buttonId); await flush();
    const body = sentBody();
    expect(body).toMatchObject({ action, expenseCategoryId: 8,
      expenseAccountCode: "5102", payableAccountCode: "2102" });
    expectNoMoney(body);
    expect(props.onSaved).toHaveBeenCalledExactlyOnceWith(savedReply);
  });

  it("keeps the exact legacy saved base rather than recomputing amount times saved rate", () => {
    render();
    const text = preview("saved", "USD", "saved");
    expect(text).toContain("13,001");
    expect(text).not.toContain("13,278");
    expect(text).toContain("531.125");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["25.00", "025.000", "25"])("reverting equivalent original amount %s restores exact saved snapshot", async (originalText) => {
    render();
    change("lab-accounting-cost-input", "30");
    const stale = settingsRequests.at(-1)!;
    change("lab-accounting-cost-input", originalText);
    expect(preview("saved", "USD", "saved")).toContain("13,001");
    stale.resolve(response(200, currentSettings("999"))); await flush();
    expect(preview("saved", "USD", "saved")).toContain("13,001");
    await click("lab-accounting-save-mapping-btn");
    expectNoMoney(sentBody());
  });

  it("reverting currency restores the original snapshot and ignores the late foreign quote", async () => {
    render(); change("lab-accounting-currency-select", "SAR");
    const foreign = settingsRequests.at(-1)!;
    change("lab-accounting-currency-select", "USD");
    foreign.resolve(response(200, currentSettings("600", "999"))); await flush();
    expect(preview("saved", "USD", "saved")).toContain("13,001");
    await click("lab-accounting-unpost-btn");
    expectNoMoney(sentBody());
  });

  it("unpriced legacy order can save only mapping without creating a zero/null cost intent", async () => {
    props.order = originalOrder({ costMinor: null, costCurrency: null, baseAmountMinor: null,
      exchangeRate: 1, isPosted: false });
    render(); change("lab-accounting-category-select", "8");
    await click("lab-accounting-save-mapping-btn");
    expectNoMoney(sentBody());
  });

  it("replacing the order prop disables submission before passive effects initialize its form", async () => {
    render(); change("lab-accounting-cost-input", "30");
    await resolveSettings();
    expectCurrent("USD", 3000, 600);
    props.order = originalOrder({ id: 91002, costMinor: 8000, costCurrency: "SAR",
      exchangeRate: 150, baseAmountMinor: 12000 });
    const immediate = renderPass();
    const save = byId("lab-accounting-save-mapping-btn", immediate);
    expect(save.props.disabled).toBe(true);
    await (save.props.onClick as () => Promise<void>)();
    expect(writes()).toHaveLength(0);
    expect(props.onSaved).not.toHaveBeenCalled();
    commitEffects(immediate);
  });
});

describe("explicit positive edits use the current selected-currency quote", () => {
  it("sends the original large valid amount text so server parsing matches the reviewed minor units", async () => {
    const raw = "35184372088832.1953125";
    render(); change("lab-accounting-currency-select", "SAR");
    change("lab-accounting-cost-input", raw);
    await resolveSettings();
    expectCurrent("SAR", 3518437208883220, 150);
    await click("lab-accounting-save-mapping-btn");
    expect(sentBody()).toMatchObject({ cost: raw, costCurrency: "SAR", expectedExchangeRate: 150 });
    // Reformatting the parsed minor amount as 35184372088832.2 can reparse one
    // minor unit higher. The real callback must retain the entered decimal text.
    expect(sentBody().cost).not.toBe("35184372088832.2");
  });

  it.each([
    ["USD", "30", 3000, 600],
    ["SAR", "30.25", 3025, 150],
    ["YER", "17500", 17500, 1],
  ] as const)("sends intended %s amount and matching current expected rate", async (currency, cost, minor, rate) => {
    render();
    change("lab-accounting-currency-select", currency);
    change("lab-accounting-cost-input", cost);
    if (currency !== "YER") await resolveSettings();
    expectCurrent(currency, minor, rate);
    await click("lab-accounting-save-mapping-btn");
    expect(sentBody()).toMatchObject({ cost, costCurrency: currency, expectedExchangeRate: rate });
    expect(sentBody()).not.toHaveProperty("exchangeRate");
    expect(sentBody()).not.toHaveProperty("baseAmountMinor");
  });

  it("same-currency amount edit hides saved FX before its first passive effect", async () => {
    render();
    const immediate = change("lab-accounting-cost-input", "30", false);
    expectUnavailable("loading", "USD", immediate);
    commitEffects(immediate);
    expect(settingsRequests).toHaveLength(1);
    expect(byId("lab-accounting-save-mapping-btn").props.disabled).toBe(true);
    // Disabled markup is backed by a guard in the actual callback as well.
    await click("lab-accounting-save-mapping-btn");
    expect(writes()).toHaveLength(0);
    await resolveSettings();
    expectCurrent("USD", 3000, 600);
    expect(byId("lab-accounting-save-mapping-btn").props.disabled).toBe(false);
  });

  it.each(["missing", "http-failure", "network-failure", "json-failure"])("%s leaves edited money unavailable and unsent", async (mode) => {
    render(); change("lab-accounting-cost-input", "30");
    const request = settingsRequests.at(-1)!;
    if (mode === "network-failure") request.reject(new Error("Synthetic settings unavailable"));
    else if (mode === "json-failure") request.resolve({ ok: true, status: 200,
      json: async () => { throw new Error("Synthetic malformed settings"); } });
    else request.resolve(response(mode === "http-failure" ? 503 : 200, {}));
    await flush();
    expectUnavailable("unavailable", "USD");
    expect(byId("lab-accounting-save-mapping-btn").props.disabled).toBe(true);
    await click("lab-accounting-save-mapping-btn");
    expect(writes()).toHaveLength(0);
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  it("does not retain an earlier successful exact quote while another currency is pending or missing", async () => {
    render(); change("lab-accounting-cost-input", "30");
    await resolveSettings(); expectCurrent("USD", 3000, 600);
    const immediate = change("lab-accounting-currency-select", "SAR", false);
    expectUnavailable("loading", "SAR", immediate); commitEffects(immediate);
    await resolveSettings({ "finance.rate.USD": "600" });
    expectUnavailable("unavailable", "SAR");
    await click("lab-accounting-repost-btn");
    expect(writes()).toHaveLength(0);
  });

  it("late A to B to A settings cannot win against the latest edit generation", async () => {
    render(); change("lab-accounting-cost-input", "30");
    const firstA = settingsRequests.at(-1)!;
    change("lab-accounting-currency-select", "SAR");
    const b = settingsRequests.at(-1)!;
    change("lab-accounting-currency-select", "USD");
    const lastA = settingsRequests.at(-1)!;
    expect(settingsRequests).toHaveLength(3);
    firstA.resolve(response(200, currentSettings("500"))); await flush();
    expectUnavailable("loading", "USD");
    b.resolve(response(200, currentSettings("555", "140"))); await flush();
    expectUnavailable("loading", "USD");
    lastA.resolve(response(200, currentSettings("620"))); await flush();
    expectCurrent("USD", 3000, 620);
    await click("lab-accounting-save-mapping-btn");
    expect(sentBody()).toMatchObject({ cost: "30", costCurrency: "USD", expectedExchangeRate: 620 });
  });

  it("an obsolete failure cannot remove the newer successful quote", async () => {
    render(); change("lab-accounting-cost-input", "30");
    const old = settingsRequests.at(-1)!;
    change("lab-accounting-cost-input", "31");
    await resolveSettings(currentSettings("620"));
    expectCurrent("USD", 3100, 620);
    old.reject(new Error("Synthetic late failure")); await flush();
    expectCurrent("USD", 3100, 620);
  });

  it("a quote refusal requires explicit refresh and uses the newly reviewed rate on retry", async () => {
    render(); change("lab-accounting-cost-input", "30");
    await resolveSettings();
    fetchMock.mockImplementationOnce(() => Promise.resolve(response(409, {
      code: "lab_accounting_rate_changed", message: "Synthetic current rate changed",
    })));
    await click("lab-accounting-save-mapping-btn"); await flush();
    expectUnavailable("unavailable", "USD");
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(contents(byId("lab-accounting-error"))).toContain("Synthetic current rate changed");
    await click("lab-accounting-save-mapping-btn");
    expect(writes()).toHaveLength(1);
    await click("lab-accounting-refresh-rate-btn"); render();
    expectUnavailable("loading", "USD");
    await resolveSettings(currentSettings("620"));
    expectCurrent("USD", 3000, 620);
    await click("lab-accounting-save-mapping-btn");
    expect(writes()).toHaveLength(2);
    expect(JSON.parse(String(writes()[1][1].body)))
      .toMatchObject({ cost: "30", costCurrency: "USD", expectedExchangeRate: 620 });
    expect(props.onSaved).toHaveBeenCalledExactlyOnceWith(savedReply);
  });

  it("same-render duplicate callbacks issue one PATCH and lock the monetary inputs while pending", async () => {
    render();
    const pending = deferred<MockResponse>();
    fetchMock.mockImplementationOnce(() => pending.promise);
    const submit = byId("lab-accounting-save-mapping-btn").props.onClick as () => Promise<void>;
    const first = submit();
    const repeated = submit();
    expect(writes()).toHaveLength(1);
    render();
    expect(byId("lab-accounting-cost-input").props.disabled).toBe(true);
    expect(byId("lab-accounting-currency-select").props.disabled).toBe(true);
    expect(byId("lab-accounting-save-mapping-btn").props.disabled).toBe(true);
    pending.resolve(response(200, savedReply));
    await Promise.all([first, repeated]); await flush();
    expect(writes()).toHaveLength(1);
    expect(props.onSaved).toHaveBeenCalledExactlyOnceWith(savedReply);
    expect(byId("lab-accounting-cost-input").props.disabled).toBe(false);
  });

  it("late quote refusal belongs to its submitted edit and cannot invalidate a newer ready currency", async () => {
    render(); change("lab-accounting-cost-input", "30");
    await resolveSettings();
    const pending = deferred<MockResponse>();
    fetchMock.mockImplementationOnce(() => pending.promise);
    const submitted = click("lab-accounting-save-mapping-btn");
    expect(byId("lab-accounting-currency-select").props.disabled).toBe(true);
    // Deliberate direct callback: this models programmatic state replacement,
    // not a browser clicking a disabled select. The old response still needs an owner.
    change("lab-accounting-currency-select", "SAR");
    await resolveSettings(currentSettings("600", "155"));
    expectCurrent("SAR", 3000, 155);
    pending.resolve(response(409, { code: "lab_accounting_rate_changed",
      message: "Synthetic prior USD quote changed" }));
    await submitted; await flush();
    expectCurrent("SAR", 3000, 155);
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });

  it.each(["", " ", "0", "-1", "garbage", "900719925474099200"])("invalid edit %s never sends a destructive monetary request", async (cost) => {
    render(); change("lab-accounting-cost-input", cost);
    expectUnavailable("invalid", "USD");
    for (const id of ["lab-accounting-save-mapping-btn", "lab-accounting-repost-btn", "lab-accounting-unpost-btn"]) {
      expect(byId(id).props.disabled).toBe(true);
      await click(id);
    }
    expect(writes()).toHaveLength(0);
    expect(settingsRequests).toHaveLength(0);
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(contents(render())).not.toContain("25 USD");
  });

  it("unpriced legacy cost does not treat unparsable nonblank input as unchanged money", async () => {
    props.order = originalOrder({ costMinor: null, baseAmountMinor: null, exchangeRate: 1,
      isPosted: false });
    render(); change("lab-accounting-cost-input", "not-a-price");
    expectUnavailable("invalid", "USD");
    await click("lab-accounting-save-mapping-btn");
    expect(writes()).toHaveLength(0);
    expect(props.onSaved).not.toHaveBeenCalled();
  });
});
