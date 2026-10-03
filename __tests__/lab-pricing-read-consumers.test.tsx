/** Actual global LabPage JSX/callbacks with synthetic hooks and transport.
 * No DOM, server, database, network, session admission or financial-engine proof.
 * The ownership assertions concern automatic prices only, not the entire draft. */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LabPage from "../app/lab/page";
import { toInputAmount } from "../lib/money";

type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
const harness = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  memos: new Map<number, { value: unknown; deps?: readonly unknown[] }>(),
  effects: new Map<number, Effect>(), pending: [] as Array<() => void>, layout: [] as Array<() => void>,
  session: { username: "synthetic-doctor", role: "doctor", permissions: { canViewCostPrices: true } } as {
    username: string; role: string; permissions: { canViewCostPrices: boolean } | null;
  } | null,
}));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b
    && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (compute: () => unknown, deps?: readonly unknown[]) => {
    const index = harness.cursor++;
    const previous = harness.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = compute(); harness.memos.set(index, { value, deps }); return value;
  };
  const effect = (layout: boolean) => (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = harness.cursor++;
    const previous = harness.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    const record: Effect = { deps, cleanup: previous?.cleanup };
    harness.effects.set(index, record);
    (layout ? harness.layout : harness.pending).push(() => {
      if (harness.effects.get(index) !== record) return;
      previous?.cleanup?.();
      const cleanup = run();
      record.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    });
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = harness.cursor++;
      if (!(index in harness.values)) harness.values[index] = typeof initial === "function" ? initial() : initial;
      return [harness.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(harness.values[index]) : update;
        if (!Object.is(next, harness.values[index])) harness.changed = true;
        harness.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => {
      const index = harness.cursor++;
      if (!(index in harness.values)) harness.values[index] = { current: initial };
      return harness.values[index];
    },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: effect(false), useLayoutEffect: effect(true),
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => harness.session }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic", useSetting: () => "" }));
vi.mock("../components/PageHeader", () => ({ PageHeader: () => null, StatCard: () => null }));
vi.mock("../components/LabDentalChart", () => ({ LabDentalChart: () => null }));
vi.mock("../components/LabPrescriptionModal", () => ({ LabPrescriptionModal: () => null }));
vi.mock("../components/LabDeliveryAppointmentModal", () => ({ LabDeliveryAppointmentModal: () => null }));
vi.mock("../components/LabOrderAccountingModal", () => ({ LabOrderAccountingModal: () => null }));

type Element = ReactElement<Record<string, unknown>>;
const fetchMock = vi.fn();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let reads: ReturnType<typeof deferred<Response>>[];
const price = { costMinor: 2350, costCurrency: "USD", ruleId: 801 };
const withheld = { code: "lab_pricing_withheld", message: "عرض أسعار تكلفة المختبر غير متاح لحسابك." };
const patients = [101, 102].map(id => ({ id, patientNumber: `SYN-${id}`, fullName: `Synthetic patient ${id}`, phone: null }));
function response(payload: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(JSON.stringify(payload)) } as Response;
}
function nodes(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const element = tree as Element;
  return [element, ...nodes(element.props.children as ReactNode)];
}
function text(tree: ReactNode): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join("");
  return tree && typeof tree === "object" && "props" in tree ? text((tree as Element).props.children as ReactNode) : "";
}
function render(passive = true): ReactNode {
  let tree: ReactNode;
  let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("Synthetic pricing render did not settle");
    harness.cursor = 0; harness.changed = false;
    tree = LabPage();
    harness.layout.splice(0).forEach(run => run());
    if (passive) harness.pending.splice(0).forEach(run => run());
  } while (harness.changed);
  return tree;
}
async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
  return render();
}
function control(predicate: (node: Element) => boolean, tree = render()): Element {
  const found = nodes(tree).find(predicate);
  if (!found) throw new Error("Missing actual global lab control");
  return found;
}
function click(label: string) {
  (control(node => node.type === "button" && text(node).includes(label)).props.onClick as () => void)();
  return render();
}
function change(node: Element, value: string) {
  (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
const costInput = (tree = render()) => control(node => node.type === "input" && node.props.placeholder === "إجمالي تكلفة المختبر", tree);
const currencyInput = () => control(node => node.type === "select" && text(node).includes("دولار (USD)"));
const priceStatus = () => text(control(node => "data-lab-pricing-status" in node.props));
const form = (tree = render()) => control(node => node.type === "form", tree);
const save = (tree = render()) => (form(tree).props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault() {} });
const submitted = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")
  .map(([, init]) => JSON.parse(String(init.body)) as Record<string, unknown>);
const selectLab = (id: string) => { change(control(node => node.type === "select" && text(node).includes("اختر المختبر المعتمد")), id); return render(); };
const selectService = (id: string, passive = true) => {
  change(control(node => node.type === "select" && text(node).includes("اختر من دليل خدمات المختبر")), id);
  return render(passive);
};
async function selectPatient(id: number) {
  if (nodes(render()).some(node => node.type === "button" && text(node).includes("تغيير المريض"))) click("تغيير المريض");
  change(control(node => node.props["aria-label"] === "بحث عن المريض"), "Synthetic");
  render(); await vi.advanceTimersByTimeAsync(300); await flush();
  click(`Synthetic patient ${id}`);
}
async function ready() {
  render(); await flush(); click("إرسال عمل جديد للمختبر");
  await selectPatient(101);
  selectLab("401"); selectService("501");
  expect(reads).toHaveLength(1);
}
async function settle(index = reads.length - 1, payload: unknown = { resolved: price }, status = 200) {
  reads[index].resolve(response(payload, status));
  return flush();
}
function assertNoAutomaticPrice() {
  const tree = render();
  expect(text(tree)).not.toContain("تم جلب السعر تلقائياً");
  expect(nodes(tree).some(node => "data-lab-pricing-equation" in node.props)).toBe(false);
  expect(costInput(tree).props.value).toBe("");
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));
  harness.values = []; harness.cursor = 0; harness.changed = false;
  harness.memos.clear(); harness.effects.clear(); harness.pending = []; harness.layout = [];
  harness.session = { username: "synthetic-doctor", role: "doctor", permissions: { canViewCostPrices: true } };
  reads = []; fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/lab" && init?.method === "POST") return Promise.resolve(response({ id: 301 }, 201));
    if (init?.method && init.method !== "GET") throw new Error(`Unexpected mutation ${url}`);
    if (url === "/api/lab") return Promise.resolve(response({ orders: [], labs: [] }));
    if (url === "/api/laboratories") return Promise.resolve(response({ laboratories: [401, 402].map(id => ({
      id, name: `Synthetic lab ${id}`, phone: null, whatsapp: null, currency: "YER", deliveryDays: 7, isActive: true,
    })) }));
    if (url === "/api/lab/services") return Promise.resolve(response({ services: [501, 502].map(id => ({
      id, name: `Synthetic service ${id}`, code: `SYN-${id}`, category: "prostho", toothScope: "single_tooth", isActive: true,
    })) }));
    if (url === "/api/finance/expense-categories") return Promise.resolve(response({ categories: [] }));
    if (url.startsWith("/api/patients?q=")) return Promise.resolve(response(patients));
    if (url.startsWith("/api/lab/pricing?")) {
      const read = deferred<Response>(); reads.push(read); return read.promise;
    }
    throw new Error(`Unexpected read ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  harness.effects.forEach(effect => effect.cleanup?.());
  vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("deliberately withheld pricing in the actual global create form", () => {
  it("explains withholding, supplies neither zero nor no-rule, and preserves canonical omitted-cost inputs", async () => {
    await ready(); await settle(0, withheld, 403);
    expect(priceStatus()).toContain("عرض أسعار تكلفة المختبر غير متاح لحسابك");
    expect(priceStatus()).toContain("يمكنك حفظ الطلب السريري");
    expect(priceStatus()).not.toContain("لا توجد قاعدة");
    expect(priceStatus()).not.toContain("أعد اختيار الخدمة");
    assertNoAutomaticPrice();
    await save();
    expect(submitted()).toEqual([{
      patientId: 101, labName: "Synthetic lab 401", workType: "Synthetic service 501", priority: "normal",
      impressionType: "physical", sentDate: "2026-10-03", dueDate: "2026-10-10", partyId: 401, labServiceId: 501, isPosted: true,
    }]);
    expect(submitted()[0]).not.toHaveProperty("cost");
    expect(submitted()[0]).not.toHaveProperty("costCurrency");
  });
  it("retains an explicitly edited amount and currency when pricing is withheld", async () => {
    await ready(); change(costInput(), "71.25"); change(currencyInput(), "SAR");
    await settle(0, withheld, 403);
    expect(costInput().props.value).toBe("71.25"); expect(currencyInput().props.value).toBe("SAR");
    await save();
    expect(submitted()[0]).toMatchObject({ cost: "71.25", costCurrency: "SAR", patientId: 101, partyId: 401, labServiceId: 501, isPosted: true });
  });
  it("preserves an explicit zero rather than substituting zero for a withheld price", async () => {
    await ready(); await settle(0, withheld, 403); change(costInput(), "0");
    await save(); expect(submitted()[0]).toMatchObject({ cost: "0", costCurrency: "YER" });
  });
  it.each([401, 403, 404, 500])("keeps generic HTTP %s distinct from explicit withholding and missing rule", async status => {
    await ready(); await settle(0, { message: "Synthetic failure" }, status);
    expect(priceStatus()).toContain("تعذّر جلب سعر المختبر");
    expect(priceStatus()).not.toContain("غير متاح لحسابك");
    expect(priceStatus()).not.toContain("لا توجد قاعدة");
    assertNoAutomaticPrice(); await save(); expect(submitted()[0]).not.toHaveProperty("cost");
  });
  it.each([{}, { resolved: undefined }, { resolved: false }, { resolved: { ...price, costMinor: -1 } },
    { resolved: { ...price, costCurrency: "BAD" } }])("does not label malformed success as a missing rule: %j", async payload => {
    await ready(); await settle(0, payload);
    expect(priceStatus()).toContain("تعذّر جلب سعر المختبر"); assertNoAutomaticPrice();
  });
  it("reserves no-rule text for an explicit successful resolved:null", async () => {
    await ready(); await settle(0, { resolved: null });
    expect(priceStatus()).toContain("لا توجد قاعدة تسعير سارية");
    assertNoAutomaticPrice(); await save(); expect(submitted()[0]).not.toHaveProperty("cost");
  });
  it.each(["transport", "json"])("keeps %s failure settled and allows omitted-cost server fallback", async kind => {
    await ready();
    if (kind === "transport") reads[0].reject(new Error("Synthetic transport"));
    else reads[0].resolve(new Response("{", { status: 200, headers: { "Content-Type": "application/json" } }));
    await flush(); expect(priceStatus()).toContain("تعذّر جلب سعر المختبر");
    await save(); expect(submitted()[0]).not.toHaveProperty("cost");
  });
  it("continues to block an unsettled automatic price, while explicit manual input can save", async () => {
    await ready(); await save(); expect(submitted()).toEqual([]);
    expect(text(render())).toContain("انتظر جلب السعر للاختيار الحالي");
    change(costInput(), "18"); change(currencyInput(), "USD"); await save();
    expect(submitted()[0]).toMatchObject({ cost: "18", costCurrency: "USD" });
  });
});

describe("automatic price ownership and explicit manual revisions", () => {
  it("keeps allowed unit quantity/currency and manual amount/currency semantics", async () => {
    await ready(); await settle();
    change(control(node => node.props.placeholder === "مثال: 14(Abutment), 15(Pontic), 16(Abutment)"), "11,12,13");
    expect(costInput().props.value).toBe(toInputAmount(2350 * 3, "USD"));
    expect(currencyInput().props.value).toBe("USD");
    await save(); expect(submitted()[0]).toMatchObject({ cost: toInputAmount(2350 * 3, "USD"), costCurrency: "USD", toothNumbers: "11,12,13" });
  });
  it.each(["lab", "service", "date"])("drops a prior automatic price immediately on %s change and saves omission after withholding", async kind => {
    await ready(); await settle();
    if (kind === "lab") selectLab("402");
    else if (kind === "service") selectService("502");
    else {
      change(control(node => node.type === "input" && node.props.type === "date" && node.props.value === "2026-10-03"), "2026-10-04"); render();
    }
    assertNoAutomaticPrice(); await settle(reads.length - 1, withheld, 403);
    assertNoAutomaticPrice(); await save(); expect(submitted()[0]).not.toHaveProperty("cost");
  });
  it.each(["patient", "username", "role", "permissions", "logout"])("retires an already resolved automatic price on %s change", async kind => {
    await ready(); await settle();
    const oldSubmit = form().props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>;
    if (kind === "patient") await selectPatient(102);
    else if (kind === "username") harness.session = { ...harness.session!, username: "another-synthetic-doctor" };
    else if (kind === "role") harness.session = { ...harness.session!, role: "reception" };
    else if (kind === "permissions") harness.session = { ...harness.session!, permissions: { canViewCostPrices: false } };
    else harness.session = null;
    render(); assertNoAutomaticPrice();
    expect(currencyInput().props.value).toBe("YER");
    await oldSubmit({ preventDefault() {} }); expect(submitted()).toEqual([]);
    await settle(reads.length - 1, withheld, 403); assertNoAutomaticPrice();
    // This is a price-read test, not a whole-draft or logout save authorization assertion.
  });
  it("does not revive the old price after authority A→B→A even before passive cleanup", async () => {
    await ready(); await settle();
    harness.session = { ...harness.session!, permissions: { canViewCostPrices: false } }; render(false);
    expect(costInput(render(false)).props.value).toBe("");
    harness.session = { ...harness.session!, permissions: { canViewCostPrices: true } }; render(false);
    expect(costInput(render(false)).props.value).toBe("");
    render(); await settle(reads.length - 1, withheld, 403); assertNoAutomaticPrice();
  });
  it("does not let a retired currency handler promote an old automatic price to manual", async () => {
    await ready(); await settle(); const oldCurrency = currencyInput();
    harness.session = { ...harness.session!, permissions: { canViewCostPrices: false } }; render(false);
    change(oldCurrency, "SAR"); render(); await settle(reads.length - 1, withheld, 403);
    assertNoAutomaticPrice(); await save(); expect(submitted()[0]).not.toHaveProperty("cost");
  });
  it("ignores an old response and late JSON after selection or authority retirement", async () => {
    await ready(); const body = deferred<unknown>();
    reads[0].resolve({ ok: true, status: 200, json: () => body.promise } as Response); await flush();
    selectService("502"); harness.session = { ...harness.session!, permissions: { canViewCostPrices: false } }; render(false);
    body.resolve({ resolved: price });
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(costInput(render(false)).props.value).toBe("");
    render(); await settle(reads.length - 1, withheld, 403); assertNoAutomaticPrice();
    reads[1].resolve(response({ resolved: { ...price, costMinor: 999999 } })); await flush(); assertNoAutomaticPrice();
  });
  it("keeps an explicit manual edit made before the passive lookup starts", async () => {
    await ready(); await settle();
    const tree = selectService("502", false);
    change(costInput(tree), "74.5"); render(false); render();
    await settle(); expect(costInput().props.value).toBe("74.5");
    await save(); expect(submitted()[0]).toMatchObject({ cost: "74.5", costCurrency: "YER", labServiceId: 502 });
  });
  it("keeps edits made while a lookup is pending, including an explicitly cleared amount", async () => {
    await ready(); change(costInput(), ""); change(currencyInput(), "SAR"); await settle();
    expect(costInput().props.value).toBe(""); expect(currencyInput().props.value).toBe("SAR");
    await save(); expect(submitted()[0]).not.toHaveProperty("cost"); expect(submitted()[0]).not.toHaveProperty("costCurrency");
  });
  it("retains explicit same-selection manual input across patient/authority price refresh", async () => {
    await ready(); await settle(); change(costInput(), "73"); change(currencyInput(), "SAR");
    harness.session = { ...harness.session!, username: "another-synthetic-doctor" }; render(); await settle();
    expect(costInput().props.value).toBe("73"); expect(currencyInput().props.value).toBe("SAR");
    await selectPatient(102); await settle();
    expect(costInput().props.value).toBe("73"); expect(currencyInput().props.value).toBe("SAR");
  });
  it("keeps the existing replacement of an earlier manual value by an allowed new rule selection", async () => {
    await ready(); await settle(); change(costInput(), "73"); change(currencyInput(), "SAR");
    selectService("502"); await settle(reads.length - 1, { resolved: { ...price, costMinor: 9700 } });
    expect(costInput().props.value).toBe(toInputAmount(9700, "USD")); expect(currencyInput().props.value).toBe("USD");
  });
  it("retains manual input from an earlier selection when the new read is deliberately withheld", async () => {
    await ready(); await settle(); change(costInput(), "73"); change(currencyInput(), "SAR");
    selectService("502"); await settle(reads.length - 1, withheld, 403);
    expect(costInput().props.value).toBe("73"); expect(currencyInput().props.value).toBe("SAR");
    await save(); expect(submitted()[0]).toMatchObject({ cost: "73", costCurrency: "SAR", labServiceId: 502 });
  });
  it("preserves manual A through withheld B and a same-B patient refresh that resolves", async () => {
    await ready(); await settle(); change(costInput(), "73"); change(currencyInput(), "SAR");
    selectService("502"); await settle(reads.length - 1, withheld, 403);
    await selectPatient(102); await settle(reads.length - 1, { resolved: { ...price, costMinor: 9700 } });
    expect(costInput().props.value).toBe("73"); expect(currencyInput().props.value).toBe("SAR");
    await save(); expect(submitted()[0]).toMatchObject({ patientId: 102, labServiceId: 502, cost: "73", costCurrency: "SAR" });
  });
  it("preserves base new-selection replacement for manual A→B withheld→A allowed", async () => {
    await ready(); await settle(); change(costInput(), "73"); change(currencyInput(), "SAR");
    selectService("502"); await settle(reads.length - 1, withheld, 403);
    selectService("501"); await settle(reads.length - 1, { resolved: { ...price, costMinor: 9700 } });
    expect(costInput().props.value).toBe(toInputAmount(9700, "USD")); expect(currencyInput().props.value).toBe("USD");
  });
  it("makes an explicit amount edit retain the visible automatic currency", async () => {
    await ready(); await settle(); change(costInput(), "73");
    harness.session = { ...harness.session!, permissions: { canViewCostPrices: false } }; render(); await settle(reads.length - 1, withheld, 403);
    expect(costInput().props.value).toBe("73"); expect(currencyInput().props.value).toBe("USD");
    await save(); expect(submitted()[0]).toMatchObject({ cost: "73", costCurrency: "USD" });
  });
  it("accepts legitimate zero automatic price without calling it withheld or missing", async () => {
    await ready(); await settle(0, { resolved: { ...price, costMinor: 0 } });
    expect(text(render())).toContain("تم جلب السعر تلقائياً");
    expect(costInput().props.value).toBe(toInputAmount(0, "USD"));
    await save(); expect(submitted()[0]).toMatchObject({ cost: toInputAmount(0, "USD"), costCurrency: "USD" });
  });
});
