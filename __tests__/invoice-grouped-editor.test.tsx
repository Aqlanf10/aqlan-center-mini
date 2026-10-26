import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientLedger } from "../components/PatientLedger";
import { ServiceSelect } from "../components/ServiceSelect";
import { ToothSelectionDialog } from "../components/dental/ToothSelectionDialog";
import { TreatmentEntryChoice } from "../components/TreatmentEntryChoice";
import { formatMoney, parseAmount, type Currency } from "../lib/money";
import type { FinancialCommand } from "../lib/financial-command-journal";

// Execute the actual ledger wrapper, content and private InvoiceForm. The hook
// harness is intentionally DOM-free; every edit goes through rendered callbacks,
// and assertions inspect the real preview/save transport rather than a second
// implementation of invoice grouping. All patients, doctors and routes are fake.
const hooks = vi.hoisted(() => {
  type Store = {
    values: unknown[]; cursor: number; changed: boolean;
    effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>;
    memos: Map<number, { deps?: readonly unknown[]; value: unknown }>;
    pending: Array<() => void>;
  };
  const make = (): Store => ({ values: [], cursor: 0, changed: false, effects: new Map(), memos: new Map(), pending: [] });
  return { make, current: make(), outer: make(), inner: make(), form: make() };
});
const journal = vi.hoisted(() => ({ reserved: [] as FinancialCommand[] }));
vi.mock("../lib/financial-command-journal", async original => ({
  ...await original<typeof import("../lib/financial-command-journal")>(),
  readFinancialJournal: async () => ({ revision: 0, command: null }),
  reserveFinancialCommand: async (_scope: unknown, revision: number, command: FinancialCommand) => {
    journal.reserved.push(structuredClone(command));
    return { revision, command };
  },
  acknowledgeFinancialCommand: async () => ({ revision: 1, command: null }),
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic-group-owner", role: "admin" }) }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const h = hooks.current, index = h.cursor++;
    if (!(index in h.values)) h.values[index] = initial;
    return index;
  };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const h = hooks.current, index = slot(undefined), previous = h.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); h.memos.set(index, { deps, value }); return value;
  };
  const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const h = hooks.current, index = slot(undefined), previous = h.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    h.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = run();
      h.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
    });
  };
  return { ...react,
    useState: (initial: unknown) => {
      const h = hooks.current, index = slot(typeof initial === "function" ? initial() : initial);
      if (!h.memos.has(index)) h.memos.set(index, { value: (value: unknown) => {
        const next = typeof value === "function" ? value(h.values[index]) : value;
        if (!Object.is(next, h.values[index])) h.changed = true;
        h.values[index] = next;
      } });
      return [h.values[index], h.memos.get(index)!.value];
    },
    useId: () => `synthetic-group-${slot("id")}`,
    useRef: (initial: unknown) => hooks.current.values[slot({ current: initial })],
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: effect, useLayoutEffect: effect,
  };
});

type Element = ReactElement<Record<string, unknown>>;
type Item = { serviceId: number; toothCode: number; price: string; quantity: number; doctorId?: number; caseId?: number; episodeTeeth?: number[]; [field: string]: unknown };
type Body = { currency: Currency; discount: string; items: Item[]; [field: string]: unknown };
const elements = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(elements)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...elements((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bucket = { billedMinor: 0, collectedMinor: 0, openingMinor: 0, dueMinor: 0 };
const ledger = { invoices: [], payments: [], plans: [], opening: null, openingAccess: { add: true, edit: true }, baseCurrency: "YER", balance: bucket,
  balances: { YER: bucket, SAR: bucket, USD: bucket } };
const services = ["bridge", "crown", "rct", "filling", "cleaning"].map((category, index) => ({
  id: 31 + index, name: `Synthetic ${category}`, category, priceMinor: 1000, priceSarMinor: 2500,
  priceUsdMinor: 1200, priceConfigured: true, isActive: true,
}));
const fetchMock = vi.fn();
let historical = false;
let write: () => Promise<Response>;
let offerCaseChoices = false;
let offerExistingPlan = false;
let refusedTooth: number | null = null;

function renderLedger(): ReactNode {
  for (let round = 0; round < 30; round++) {
    for (const h of [hooks.outer, hooks.inner]) { h.cursor = 0; h.changed = false; }
    hooks.current = hooks.outer;
    const wrapper = PatientLedger({ patientId: 901 }) as Element;
    hooks.outer.pending.splice(0).forEach(run => run());
    if (typeof wrapper.type !== "function") return wrapper;
    hooks.current = hooks.inner;
    const tree = (wrapper.type as (props: Record<string, unknown>) => ReactNode)(wrapper.props);
    hooks.inner.pending.splice(0).forEach(run => run());
    if (!hooks.outer.changed && !hooks.inner.changed) return tree;
  }
  throw new Error("Synthetic grouped ledger did not settle");
}
function renderForm(): ReactNode {
  const form = elements(renderLedger()).find(node => typeof node.type === "function" && node.type.name === "InvoiceForm" && !!node.props.historical === historical);
  expect(form, "real InvoiceForm should be mounted through PatientLedger").toBeDefined();
  for (let round = 0; round < 30; round++) {
    hooks.current = hooks.form; hooks.form.cursor = 0; hooks.form.changed = false;
    const tree = (form!.type as (props: Record<string, unknown>) => ReactNode)(form!.props);
    hooks.form.pending.splice(0).forEach(run => run());
    if (!hooks.form.changed) return tree;
  }
  throw new Error("Synthetic grouped invoice form did not settle");
}
async function flush(render: () => ReactNode = renderForm) {
  for (let pass = 0; pass < 5; pass++) {
    for (let tick = 0; tick < 15; tick++) await Promise.resolve();
    render();
  }
}
const node = (id: string, root: ReactNode = renderForm()) => {
  const result = elements(root).find(one => one.props["data-testid"] === id);
  expect(result, id).toBeDefined(); return result!;
};
const input = (label: string, root: ReactNode = renderForm()) => {
  const result = elements(root).find(one => one.props["aria-label"] === label);
  expect(result, label).toBeDefined(); return result!;
};
const change = (element: Element, value: string) => (element.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
const click = (element: Element) => (element.props.onClick as () => void)();
const cards = () => elements(renderForm()).filter(one => /^invoice-row-\d+$/.test(String(one.props["data-testid"])));
const calls = (url: string) => fetchMock.mock.calls.filter(([target]) => target === url);
const body = (url = "/api/invoices/clinical-preview"): Body => {
  const requests = calls(url); expect(requests.length).toBeGreaterThan(0);
  return JSON.parse(requests.at(-1)![1].body) as Body;
};
async function preview() { renderForm(); await vi.advanceTimersByTimeAsync(351); await flush(); return body(); }
function selectService(category: string) {
  const service = services.find(one => one.category === category)!;
  const picker = elements(renderForm()).find(one => one.type === ServiceSelect)!;
  (picker.props.onChange as (id: number, service: unknown) => void)(service.id, service); renderForm();
}
function openTeeth(index = 0) {
  click(node(`invoice-tooth-button-${index}`));
  const dialog = elements(renderForm()).find(one => one.type === ToothSelectionDialog);
  expect(dialog).toBeDefined(); return dialog!;
}
function confirmTeeth(teeth: number[], index = 0, surfacesByTooth?: Record<number, string>) {
  const dialog = openTeeth(index);
  (dialog.props.onConfirm as (selection: { teeth: number[]; surfaces: string; surfacesByTooth?: Record<number, string>; scope: null }) => void)(
    { teeth, surfaces: "", scope: null, ...(surfacesByTooth ? { surfacesByTooth } : {}) },
  );
  renderForm();
}
function saveButton() {
  const result = elements(renderForm()).find(one => one.type === "button" && text(one).trim() === (historical ? "احفظ الاتفاق التاريخي" : "احفظ الفاتورة"));
  expect(result).toBeDefined(); return result!;
}
async function openForm(legacy = false) {
  historical = legacy; renderLedger(); await flush(renderLedger);
  click(node("treatment-entry-open", renderLedger()));
  const choice = elements(renderLedger()).find(one => one.type === TreatmentEntryChoice)!;
  (choice.props.onSelect as (kind: string) => void)(legacy ? "legacy" : "invoice");
  vi.useFakeTimers(); renderForm(); await flush();
}
function expectCanonicalOnly(items: Item[]) {
  for (const item of items) {
    expect(item.quantity).toBe(1);
    const fields = new Set(["serviceId", "catalogPriceMinor", "priceQuote", "doctorId", "description", "price", "priceReason", "quantity", "toothCode", "surfaces", "episodeTeeth", "scope", "caseId", "planItemId"]);
    expect(Object.keys(item).filter(field => !fields.has(field))).toEqual([]);
  }
}

beforeEach(() => {
  hooks.outer = hooks.make(); hooks.inner = hooks.make(); hooks.form = hooks.make(); hooks.current = hooks.outer;
  historical = false; offerCaseChoices = false; offerExistingPlan = false; refusedTooth = null; journal.reserved.length = 0; fetchMock.mockReset();
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm: vi.fn(() => true) });
  write = async () => json({ message: "Synthetic explicit refusal" }, 409);
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/patients/901/ledger") return Promise.resolve(json(ledger));
    if (url === "/api/services") return Promise.resolve(json(services));
    if (url === "/api/parties?kind=doctor") return Promise.resolve(json([{ id: 11, name: "Synthetic doctor one", kind: "doctor" }, { id: 12, name: "Synthetic doctor two", kind: "doctor" }]));
    if (url === "/api/invoices/clinical-preview") {
      const request = JSON.parse(String(init?.body)) as Body;
      return Promise.resolve(json({ existingPlanId: request.existingPlanId,
        planChoices: offerExistingPlan ? [{ id: 801, compatible: true }] : [], lines: request.items.map((item, line) => ({
        line, kind: "clinical", specialty: item.serviceId === 33 ? "endodontics" : item.serviceId === 34 ? "restorative" : "prosthodontics", specialtyLabel: "Synthetic specialty",
        item: item.planItemId ? { mode: "existing", id: item.planItemId } : { mode: "new", id: null },
        itemCandidates: offerExistingPlan ? [{ id: 800 + item.toothCode, planId: 801, clinicalCaseId: null }] : [],
        case: { mode: item.caseId ? "existing" : "new", id: item.caseId ?? null, title: item.caseId ? "Synthetic retained case" : null,
          options: offerCaseChoices ? [{ id: 501, title: "Synthetic case one" }, { id: 502, title: "Synthetic case two" }] : [] },
        refusal: item.toothCode === refusedTooth ? "synthetic_child_refusal" : null,
        refusalMessage: item.toothCode === refusedTooth ? "Synthetic tooth requires review" : null,
      })) }));
    }
    if (url === "/api/patients/901/historical-documents/preview") return Promise.resolve(json({ message: "Synthetic historical preview refusal" }, 409));
    if (url === "/api/invoices" || url === "/api/patients/901/historical-documents") return write();
    return Promise.reject(new Error(`Unexpected synthetic route: ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  for (const h of [hooks.outer, hooks.inner, hooks.form]) h.effects.forEach(effect => effect.cleanup?.());
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("InvoiceForm grouped tooth editing", () => {
  it("reviews and saves different filling surfaces in one priced entry with independent canonical teeth", async () => {
    await openForm(); selectService("filling"); confirmTeeth([26, 16], 0, { 16: "OM", 26: "DB" });
    expect(cards()).toHaveLength(1);
    expect(elements(renderForm()).filter(one => one.props["aria-label"] === "الطبيب المكلّف بالبند")).toHaveLength(1);
    expect(Number(input("الكمية").props.value)).toBe(2);
    expect(input("الكمية").props.disabled === true || input("الكمية").props.readOnly === true).toBe(true);
    change(input("الطبيب المكلّف بالبند"), "11");
    change(input("الخصم"), "200"); change(input("سبب الخصم"), "Synthetic filling discount");
    const request = await preview();
    expect(request.items.map(item => [item.toothCode, item.surfaces, item.doctorId, item.quantity, item.catalogPriceMinor])).toEqual([
      [16, "MO", 11, 1, 1000], [26, "DB", 11, 1, 1000],
    ]);
    expect(request.items.every(item => !Object.hasOwn(item, "episodeTeeth"))).toBe(true);
    expectCanonicalOnly(request.items);
    expect(text(node("invoice-line-total-0"))).toContain(formatMoney(2000, "YER"));
    expect(text(node("invoice-financial-summary"))).toContain(formatMoney(1800, "YER"));
    const dialog = openTeeth();
    expect(dialog.props.initial).toMatchObject({ teeth: [16, 26], surfacesByTooth: { 16: "MO", 26: "DB" } });
    (dialog.props.onCancel as () => void)(); renderForm();
    expect(saveButton().props.disabled).toBe(false);
    click(saveButton()); await flush();
    expect(calls("/api/invoices")).toHaveLength(1);
    expect(body("/api/invoices").items).toEqual(request.items);
    expect(body("/api/invoices")).toMatchObject({ currency: "YER", discount: "200", discountReason: "Synthetic filling discount" });
  });

  it("splits a filling for a different doctor and price while retaining each tooth's surfaces", async () => {
    await openForm(); selectService("filling"); confirmTeeth([16, 26, 36], 0, { 16: "MO", 26: "D", 36: "BL" });
    change(input("الطبيب المكلّف بالبند"), "11");
    click(node("invoice-split-tooth-1")); renderForm();
    expect(cards()).toHaveLength(2);
    expect(elements(renderForm()).some(one => one.props["data-testid"] === "invoice-split-notice")).toBe(false);
    change(input("الطبيب المكلّف بالبند", node("invoice-row-1")), "12");
    change(input("السعر", node("invoice-row-1")), "1500");
    change(input("سبب تغيير السعر", node("invoice-row-1")), "Synthetic individual filling agreement");
    const request = await preview();
    expect(request.items.map(item => [item.toothCode, item.surfaces, item.doctorId, parseAmount(item.price, "YER")])).toEqual([
      [16, "MO", 11, 1000], [26, "D", 12, 1500], [36, "BL", 11, 1000],
    ]);
    expect(text(node("invoice-financial-summary"))).toContain(formatMoney(3500, "YER"));
    expectCanonicalOnly(request.items);
    const dialog = openTeeth();
    expect(dialog.props.initial).toMatchObject({ teeth: [16, 36], surfacesByTooth: { 16: "MO", 36: "BL" } });
    (dialog.props.onCancel as () => void)();
  });

  it("changes one filling's surfaces without migrating another tooth's clinical case", async () => {
    offerCaseChoices = true;
    await openForm(); selectService("filling"); confirmTeeth([16, 26], 0, { 16: "MO", 26: "D" });
    await preview();
    change(input("الحالة", node("invoice-clinical-preview-0")), "501"); await preview();
    change(input("الحالة", node("invoice-clinical-preview-1")), "502");
    const before = await preview();
    expect(before.items.map(item => item.caseId)).toEqual([501, 502]);
    confirmTeeth([16, 26], 0, { 16: "B", 26: "D" });
    const changed = await preview();
    expect(changed.items.map(item => [item.toothCode, item.surfaces, item.caseId ?? null])).toEqual([
      [16, "B", null], [26, "D", 502],
    ]);
    expect(changed.items.every(item => !Object.hasOwn(item, "episodeTeeth"))).toBe(true);
  });

  it("keeps a cancelled filling review unchanged and removes old surfaces when replacing a tooth", async () => {
    await openForm(); selectService("filling"); confirmTeeth([16, 26], 0, { 16: "MO", 26: "DB" });
    const before = await preview(), previewCount = calls("/api/invoices/clinical-preview").length;
    const dialog = openTeeth();
    expect(dialog.props.initial).toMatchObject({ teeth: [16, 26], surfacesByTooth: { 16: "MO", 26: "DB" } });
    (dialog.props.onCancel as () => void)(); renderForm();
    await vi.advanceTimersByTimeAsync(351); await flush();
    expect(calls("/api/invoices/clinical-preview")).toHaveLength(previewCount);
    expect(body().items).toEqual(before.items);
    confirmTeeth([16, 36], 0, { 16: "MO", 36: "" });
    const replaced = await preview();
    expect(replaced.items.map(item => [item.toothCode, item.surfaces ?? null])).toEqual([[16, "MO"], [36, null]]);
    const reopened = openTeeth();
    expect(reopened.props.initial).toMatchObject({ teeth: [16, 36], surfacesByTooth: { 16: "MO", 36: "" } });
    expect((reopened.props.initial as { surfacesByTooth: Record<number, string> }).surfacesByTooth).not.toHaveProperty("26");
    (reopened.props.onCancel as () => void)();
  });

  it("ignores a dismissed filling dialog callback without replacing teeth or its existing notice", async () => {
    await openForm(); selectService("filling"); confirmTeeth([16, 26], 0, { 16: "MO", 26: "DB" });
    const before = await preview(), notice = text(node("invoice-split-notice"));
    const dismissed = openTeeth();
    (dismissed.props.onCancel as () => void)(); renderForm();
    (dismissed.props.onConfirm as (selection: { teeth: number[]; surfaces: string; scope: null }) => void)(
      { teeth: [36], surfaces: "B", scope: null },
    );
    renderForm();
    expect(text(node("invoice-split-notice"))).toBe(notice);
    expect((await preview()).items).toEqual(before.items);
    expect(elements(renderForm()).some(one => one.type === ToothSelectionDialog)).toBe(false);
    openTeeth();
    (dismissed.props.onConfirm as (selection: { teeth: number[]; surfaces: string; scope: null }) => void)(
      { teeth: [36], surfaces: "B", scope: null },
    );
    expect(elements(renderForm()).some(one => one.type === ToothSelectionDialog)).toBe(true);
    expect(text(node("invoice-split-notice"))).toBe(notice);
    expect((await preview()).items).toEqual(before.items);
  });

  it("refuses filling teeth already present in a separate entry without erasing either set of surfaces", async () => {
    await openForm(); selectService("filling"); confirmTeeth([16, 26], 0, { 16: "MO", 26: "DB" });
    click(node("invoice-split-tooth-1")); renderForm();
    change(input("الطبيب المكلّف بالبند", node("invoice-row-1")), "12");
    const before = await preview();
    confirmTeeth([16, 26, 36], 0, { 16: "M", 26: "O", 36: "B" });
    renderForm(); await vi.advanceTimersByTimeAsync(351); await flush();
    expect(body().items).toEqual(before.items);
    expect(cards()).toHaveLength(2);
    expect(text(node("invoice-split-notice"))).toContain("26");
    expect(elements(renderForm()).some(one => one.type === ToothSelectionDialog)).toBe(false);
    click(input("حذف البند 2", node("invoice-row-1"))); renderForm();
    expect(elements(renderForm()).some(one => one.props["data-testid"] === "invoice-split-notice")).toBe(false);
  });

  it("preserves explicit filling plan choices on display split but clears all choices after a surface edit", async () => {
    offerExistingPlan = true;
    await openForm(); selectService("filling"); confirmTeeth([16, 26], 0, { 16: "MO", 26: "DB" });
    await preview(); change(node("invoice-existing-plan"), "801"); await preview();
    change(node("invoice-plan-item-0"), "816"); await preview();
    change(node("invoice-plan-item-1"), "826");
    const selected = await preview();
    expect(selected.items.map(item => item.planItemId)).toEqual([816, 826]);
    const previewCount = calls("/api/invoices/clinical-preview").length;
    click(node("invoice-split-tooth-1")); renderForm();
    expect(node("invoice-plan-item-0").props.value).toBe(816);
    expect(node("invoice-plan-item-1").props.value).toBe(826);
    expect(saveButton().props.disabled).toBe(false);
    expect((await preview()).items).toEqual(selected.items);
    expect(calls("/api/invoices/clinical-preview")).toHaveLength(previewCount);
    confirmTeeth([16], 0, { 16: "B" });
    expect(saveButton().props.disabled).toBe(true);
    const changed = await preview();
    expect(changed.existingPlanId).toBeNull();
    expect(changed.items.map(item => [item.toothCode, item.surfaces, item.planItemId])).toEqual([
      [16, "B", null], [26, "DB", null],
    ]);
  });

  it("reprices every filling in the new currency, clears financial selections and preserves only current tooth surfaces", async () => {
    offerExistingPlan = true;
    await openForm(); selectService("filling"); confirmTeeth([16, 26], 0, { 16: "MO", 26: "DB" });
    change(input("السعر"), "1700"); change(input("سبب تغيير السعر"), "Synthetic YER agreement");
    change(input("الخصم"), "400"); change(input("سبب الخصم"), "Synthetic YER discount");
    await preview(); change(node("invoice-existing-plan"), "801"); await preview();
    change(node("invoice-plan-item-0"), "816"); await preview();
    change(node("invoice-plan-item-1"), "826");
    const selected = await preview();
    expect(selected.items.map(item => item.planItemId)).toEqual([816, 826]);
    change(input("عملة الفاتورة"), "SAR");
    expect(elements(renderForm()).some(one => one.props["data-testid"] === "invoice-split-notice")).toBe(false);
    expect(input("الخصم").props.value).toBe("");
    expect(input("السعر").props.value).toBe("25.00");
    change(input("الخصم"), "5"); change(input("سبب الخصم"), "Synthetic SAR discount");
    const repriced = await preview();
    expect(repriced).toMatchObject({ currency: "SAR", discount: "5", existingPlanId: null });
    expect(repriced.items.map(item => [item.toothCode, item.surfaces, item.price, item.priceReason, item.planItemId])).toEqual([
      [16, "MO", "25.00", "", null], [26, "DB", "25.00", "", null],
    ]);
    expect(text(node("invoice-line-total-0"))).toContain(formatMoney(5000, "SAR"));
    expect(text(node("invoice-financial-summary"))).toContain(formatMoney(4500, "SAR"));
    expectCanonicalOnly(repriced.items);
  });

  it("replaces a filling group with a new service without carrying its surfaces, clinical links or manual price", async () => {
    offerCaseChoices = true;
    await openForm(); selectService("filling"); confirmTeeth([16, 26], 0, { 16: "MO", 26: "DB" });
    change(input("الطبيب المكلّف بالبند"), "11");
    change(input("السعر"), "1700"); change(input("سبب تغيير السعر"), "Synthetic old filling price");
    await preview(); change(input("الحالة", node("invoice-clinical-preview-0")), "501");
    await preview();
    const staleFillingDialog = openTeeth();
    (staleFillingDialog.props.onCancel as () => void)(); renderForm();
    selectService("cleaning");
    expect(elements(renderForm()).some(one => one.props["data-testid"] === "invoice-split-notice")).toBe(false);
    (staleFillingDialog.props.onConfirm as (selection: { teeth: number[]; surfaces: string; surfacesByTooth: Record<number, string>; scope: null }) => void)(
      { teeth: [16, 26], surfaces: "", surfacesByTooth: { 16: "MO", 26: "DB" }, scope: null },
    );
    expect(elements(renderForm()).some(one => one.props["data-testid"] === "invoice-split-notice")).toBe(false);
    expect(cards()).toHaveLength(1);
    expect(input("السعر").props.value).toBe("1,000");
    expect(input("الطبيب المكلّف بالبند").props.value).toBe("");
    const changed = await preview();
    expect(changed.items).toHaveLength(1);
    expect(changed.items[0]).toMatchObject({ serviceId: 35, scope: "full_mouth", quantity: 1, priceReason: "", planItemId: null });
    for (const field of ["toothCode", "surfaces", "caseId", "episodeTeeth"]) expect(changed.items[0]).not.toHaveProperty(field);
    selectService("filling");
    const dialog = openTeeth();
    expect(dialog.props.initial).toMatchObject({ teeth: [] });
    expect(saveButton().props.disabled).toBe(true);
    (dialog.props.onCancel as () => void)();
  });

  it("keeps a refused filling visible inside the group and blocks saving all children", async () => {
    refusedTooth = 26;
    await openForm(); selectService("filling"); confirmTeeth([16, 26], 0, { 16: "MO", 26: "DB" }); await preview();
    expect(cards()).toHaveLength(1);
    expect(node("invoice-clinical-preview-1").props["data-preview-state"]).toBe("refused");
    expect(node("invoice-group-details-0").props.open).toBe(true);
    expect(text(renderForm())).toContain("Synthetic tooth requires review");
    expect(saveButton().props.disabled).toBe(true);
    click(saveButton()); await flush();
    expect(calls("/api/invoices")).toHaveLength(0);
  });

  it.each(["bridge", "crown", "rct"])("%s selection is one visible entry, with canonical per-tooth preview and save", async category => {
    await openForm(); selectService(category); confirmTeeth([33, 31, 32]);
    expect(cards()).toHaveLength(1);
    expect(node("invoice-tooth-chip-0").props.className).toContain("rounded-xl");
    expect(node("invoice-tooth-chip-0").props.className).not.toContain("rounded-full");
    expect(elements(renderForm()).filter(one => one.type === ServiceSelect)).toHaveLength(1);
    expect(elements(renderForm()).filter(one => one.props["aria-label"] === "الطبيب المكلّف بالبند")).toHaveLength(1);
    expect(elements(renderForm()).filter(one => one.props["aria-label"] === "السعر")).toHaveLength(1);
    const quantity = input("الكمية");
    expect(Number(quantity.props.value)).toBe(3);
    expect(quantity.props.disabled === true || quantity.props.readOnly === true).toBe(true);
    expect(text(node("invoice-line-total-0"))).toContain(formatMoney(3000, "YER"));
    change(input("الطبيب المكلّف بالبند"), "11");
    change(input("السعر"), "1500");
    change(input("سبب تغيير السعر"), "Synthetic grouped agreement");
    const previewBody = await preview();
    expect(previewBody.items.map(one => one.toothCode)).toEqual([31, 32, 33]);
    expect(previewBody.items.every(one => one.doctorId === 11 && one.price === "1500" && one.priceReason === "Synthetic grouped agreement")).toBe(true);
    expectCanonicalOnly(previewBody.items);
    for (const item of previewBody.items) {
      if (category === "rct") expect(item).not.toHaveProperty("episodeTeeth");
      else expect(item.episodeTeeth).toEqual([31, 32, 33]);
    }
    expect(text(node("invoice-line-total-0"))).toContain(formatMoney(4500, "YER"));
    expect(saveButton().props.disabled).toBe(false);
    click(saveButton()); await flush();
    expect(calls("/api/invoices")).toHaveLength(1);
    const submitted = body("/api/invoices");
    expect(submitted.items).toEqual(previewBody.items);
    expectCanonicalOnly(submitted.items);
    expect(submitted).toMatchObject({ patientId: 901, currency: "YER", existingPlanId: null, idempotencyKey: previewBody.idempotencyKey });
  });

  it("splits a tooth for a different doctor and price without changing its clinical episode or remerging", async () => {
    await openForm(); selectService("bridge"); confirmTeeth([31, 32, 33]);
    change(input("الطبيب المكلّف بالبند"), "11");
    const before = await preview();
    click(node("invoice-split-tooth-1")); renderForm();
    expect(cards()).toHaveLength(2);
    const unchanged = await preview();
    expect(unchanged.items).toEqual(before.items);
    const individual = node("invoice-row-1");
    expect(node("invoice-tooth-chip-1").props.className).toContain("rounded-full");
    expect(node("invoice-tooth-chip-1").props.className).not.toContain("rounded-xl");
    change(input("الطبيب المكلّف بالبند", individual), "12");
    change(input("السعر", node("invoice-row-1")), "2000");
    change(input("سبب تغيير السعر", node("invoice-row-1")), "Synthetic individual price");
    const split = await preview();
    expect(split.items.map(one => [one.toothCode, one.doctorId, one.price])).toEqual([[31, 11, "1,000"], [32, 12, "2000"], [33, 11, "1,000"]]);
    expect(split.items.every(one => JSON.stringify(one.episodeTeeth) === "[31,32,33]")).toBe(true);
    // Even deliberately restoring matching commercial values does not undo the
    // user's explicit split, so the next doctor edit cannot silently fan out.
    change(input("الطبيب المكلّف بالبند", node("invoice-row-1")), "11");
    change(input("سبب تغيير السعر", node("invoice-row-1")), "");
    change(input("السعر", node("invoice-row-1")), "1,000");
    expect(cards()).toHaveLength(2);
    expectCanonicalOnly((await preview()).items);
  });

  it("keeps explicit same-plan child selections and ready preview evidence when only the display group is split", async () => {
    offerExistingPlan = true;
    await openForm(); selectService("rct"); confirmTeeth([31, 32, 33]); await preview();
    change(node("invoice-existing-plan"), "801"); await preview();
    for (const [index, tooth] of [31, 32, 33].entries()) {
      change(node(`invoice-plan-item-${index}`), String(800 + tooth));
      await preview();
    }
    const selected = body();
    expect(selected.existingPlanId).toBe(801);
    expect(selected.items.map(item => item.planItemId)).toEqual([831, 832, 833]);
    expect(cards()).toHaveLength(1);
    expect(saveButton().props.disabled).toBe(false);
    const previewCount = calls("/api/invoices/clinical-preview").length;
    click(node("invoice-split-tooth-1")); renderForm();
    expect(cards()).toHaveLength(2);
    expect(node("invoice-existing-plan").props.value).toBe(801);
    for (const [index, itemId] of [831, 832, 833].entries()) {
      expect(node(`invoice-plan-item-${index}`).props.value).toBe(itemId);
      expect(node(`invoice-clinical-preview-${index}`).props["data-preview-state"]).toBe("ready");
    }
    expect(saveButton().props.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(351); await flush();
    expect(calls("/api/invoices/clinical-preview")).toHaveLength(previewCount);
    expect(body()).toEqual(selected);
    click(saveButton()); await flush();
    expect(calls("/api/invoices")).toHaveLength(1);
    expect(body("/api/invoices").existingPlanId).toBe(801);
    expect(body("/api/invoices").items).toEqual(selected.items);
    expectCanonicalOnly(body("/api/invoices").items);
  });

  it("reselection preserves the retained tooth's separate doctor, price, case and key, and only new teeth inherit group defaults", async () => {
    offerCaseChoices = true;
    await openForm(); selectService("rct"); confirmTeeth([31, 32, 33]);
    change(input("الطبيب المكلّف بالبند"), "11"); change(input("السعر"), "1500");
    change(input("سبب تغيير السعر"), "Synthetic group price");
    click(node("invoice-split-tooth-1")); renderForm();
    const retainedKey = node("invoice-row-1").props["data-row-key"];
    change(input("الطبيب المكلّف بالبند", node("invoice-row-1")), "12");
    change(input("السعر", node("invoice-row-1")), "2000");
    change(input("سبب تغيير السعر", node("invoice-row-1")), "Synthetic retained price");
    await preview();
    change(input("الحالة", node("invoice-row-1")), "501");
    const dialog = openTeeth();
    expect(dialog.props.initial).toMatchObject({ teeth: [31, 33] });
    (dialog.props.onCancel as () => void)();
    confirmTeeth([31, 34]);
    expect(cards()).toHaveLength(2);
    expect(cards().find(one => one.props["data-tooth"] === 32)?.props["data-row-key"]).toBe(retainedKey);
    const next = await preview();
    expect([...next.items].sort((left, right) => left.toothCode - right.toothCode).map(one => [one.toothCode, one.doctorId, one.price, one.caseId ?? null])).toEqual([
      [31, 11, "1500", null], [32, 12, "2000", 501], [34, 11, "1500", null],
    ]);
    expect(next.items.every(one => !Object.hasOwn(one, "episodeTeeth"))).toBe(true);
    expectCanonicalOnly(next.items);
  });

  it("refuses a tooth already owned by a separate entry instead of silently stealing or duplicating it", async () => {
    await openForm(); selectService("bridge"); confirmTeeth([31, 32, 33]);
    click(node("invoice-split-tooth-1"));
    change(input("الطبيب المكلّف بالبند", node("invoice-row-1")), "12");
    const before = await preview();
    confirmTeeth([31, 32, 34]);
    renderForm(); await vi.advanceTimersByTimeAsync(351); await flush();
    expect(body().items).toEqual(before.items);
    expect(cards()).toHaveLength(2);
    expect(input("الطبيب المكلّف بالبند", node("invoice-row-1")).props.value).toBe("12");
    expect(elements(renderForm()).some(one => one.type === ToothSelectionDialog)).toBe(false);
    expect(text(node("invoice-split-notice"))).not.toBe("");
  });

  it("resolves captured service controls by stable row key after another group is removed", async () => {
    await openForm(); selectService("rct"); confirmTeeth([31, 32]);
    const firstPicker = elements(renderForm()).find(one => one.type === ServiceSelect)!;
    click(input("+ بند آخر")); renderForm();
    const secondPicker = elements(renderForm()).filter(one => one.type === ServiceSelect).at(-1)!;
    const crown = services.find(one => one.category === "crown")!;
    (secondPicker.props.onChange as (id: number, service: unknown) => void)(crown.id, crown);
    confirmTeeth([41], 2);
    const capturedSecond = elements(node("invoice-row-2")).find(one => one.type === ServiceSelect)!;
    click(input("حذف البند 1", node("invoice-row-0"))); renderForm();
    expect(cards()).toHaveLength(1);
    expect(() => {
      (firstPicker.props.onChange as (id: number, service: unknown) => void)(0, null);
      (firstPicker.props.onManualSelect as () => void)();
    }).not.toThrow();
    expect(elements(renderForm()).find(one => one.type === ServiceSelect)!.props.value).toBe(crown.id);
    // This surviving row moved from canonical index 2 to index 0.
    expect(() => (capturedSecond.props.onChange as (id: number, service: unknown) => void)(0, null)).not.toThrow();
    expect(elements(renderForm()).find(one => one.type === ServiceSelect)!.props.value).toBeNull();
    selectService("bridge");
    (capturedSecond.props.onChange as (id: number, service: unknown) => void)(0, null);
    (capturedSecond.props.onManualSelect as () => void)();
    expect(elements(renderForm()).find(one => one.type === ServiceSelect)!.props.value).toBe(31);
  });

  it("keeps the group intact while entering an incomplete price and fails closed until the amount is valid", async () => {
    await openForm(); selectService("rct"); confirmTeeth([31, 32, 33]);
    await preview();
    change(input("السعر"), "");
    expect(cards()).toHaveLength(1);
    change(input("السعر"), ".");
    expect(cards()).toHaveLength(1);
    expect(Number(input("الكمية").props.value)).toBe(3);
    expect(saveButton().props.disabled).toBe(true);
    expect(text(node("invoice-line-total-0"))).toContain("راجع المبلغ");
    renderForm(); await vi.advanceTimersByTimeAsync(351); await flush();
    expect(calls("/api/invoices/clinical-preview")).toHaveLength(1);
    change(input("السعر"), "1750");
    change(input("سبب تغيير السعر"), "Synthetic completed price");
    const ready = await preview();
    expect(cards()).toHaveLength(1);
    expect(ready.items.map(item => item.price)).toEqual(["1750", "1750", "1750"]);
    expect(text(node("invoice-line-total-0"))).toContain(formatMoney(5250, "YER"));
    expect(saveButton().props.disabled).toBe(false);
  });

  it("does not hide a refused child's clinical review behind an otherwise valid group", async () => {
    refusedTooth = 32;
    await openForm(); selectService("rct"); confirmTeeth([31, 32, 33]); await preview();
    expect(cards()).toHaveLength(1);
    expect(node("invoice-clinical-preview-1").props["data-preview-state"]).toBe("refused");
    expect(text(renderForm())).toContain("Synthetic tooth requires review");
    expect(saveButton().props.disabled).toBe(true);
    click(saveButton()); await flush();
    expect(calls("/api/invoices")).toHaveLength(0);
  });

  it("recomputes child-sum totals and discounts after currency changes, without multiplying canonical quantities", async () => {
    await openForm(); selectService("crown"); confirmTeeth([31, 32, 33]);
    change(input("الخصم"), "300"); change(input("سبب الخصم"), "Synthetic discount");
    let request = await preview();
    expect(text(node("invoice-financial-summary"))).toContain(formatMoney(2700, "YER"));
    expect(request.discount).toBe("300");
    change(input("عملة الفاتورة"), "SAR");
    expect(input("الخصم").props.value).toBe("");
    expect(input("السعر").props.value).toBe("25.00");
    change(input("الخصم"), "5"); change(input("سبب الخصم"), "Synthetic SAR discount");
    request = await preview();
    expect(request.currency).toBe("SAR");
    expect(request.items.reduce((sum, item) => sum + parseAmount(item.price, "SAR")! * item.quantity, 0)).toBe(7500);
    expect(text(node("invoice-line-total-0"))).toContain(formatMoney(7500, "SAR"));
    expect(text(node("invoice-financial-summary"))).toContain(formatMoney(7000, "SAR"));
    expectCanonicalOnly(request.items);
  });

  it("keeps a retained pending/recovery command immutable even when pre-submit editor callbacks are invoked", async () => {
    await openForm(); selectService("bridge"); confirmTeeth([31, 32, 33]);
    change(input("الطبيب المكلّف بالبند"), "11"); await preview();
    const before = body();
    const stalePrice = input("السعر"), staleDoctor = input("الطبيب المكلّف بالبند"), staleQuantity = input("الكمية"), staleDiscount = input("الخصم");
    const staleSplit = node("invoice-split-tooth-1");
    const staleDialog = openTeeth();
    (staleDialog.props.onCancel as () => void)(); renderForm();
    let release!: (response: Response) => void;
    write = () => new Promise(resolve => { release = resolve; });
    click(saveButton()); await flush();
    expect(calls("/api/invoices")).toHaveLength(1);
    const serialized = calls("/api/invoices")[0][1].body;
    const original = journal.reserved[0].original;
    const tryStaleEdits = () => {
      change(stalePrice, "9999"); change(staleDoctor, "12"); change(staleQuantity, "9"); change(staleDiscount, "500");
      click(staleSplit);
      (staleDialog.props.onConfirm as (selection: { teeth: number[]; surfaces: string; scope: null }) => void)({ teeth: [41], surfaces: "", scope: null });
      renderForm();
    };
    tryStaleEdits(); await vi.advanceTimersByTimeAsync(351); await flush();
    expect(cards()).toHaveLength(1);
    expect(input("السعر").props.value).toBe("1,000");
    expect(input("الطبيب المكلّف بالبند").props.value).toBe("11");
    expect(Number(input("الكمية").props.value)).toBe(3);
    expect(input("الخصم").props.value).toBe("");
    expect(calls("/api/invoices/clinical-preview")).toHaveLength(1);
    expect(calls("/api/invoices")).toHaveLength(1);
    expect(journal.reserved[0].original).toBe(original);
    expect(body("/api/invoices").items).toEqual(before.items);
    release(json({ message: "Synthetic uncertain write" }, 500)); await flush();
    tryStaleEdits(); await vi.advanceTimersByTimeAsync(351); await flush();
    expect(cards()).toHaveLength(1);
    expect(input("السعر").props.value).toBe("1,000");
    expect(calls("/api/invoices/clinical-preview")).toHaveLength(1);
    write = async () => json({ message: "Synthetic explicit refusal" }, 409);
    const retry = elements(renderForm()).find(one => one.type === "button" && text(one) === "إعادة نفس طلب الفاتورة")!;
    click(retry); await flush();
    expect(calls("/api/invoices")).toHaveLength(2);
    expect(calls("/api/invoices")[1][1].body).toBe(serialized);
    expect(journal.reserved.every(command => command.original === original)).toBe(true);
  });

  it("retains a historical bridge as one whole agreed value, not a price multiplied by selected teeth", async () => {
    await openForm(true); selectService("bridge"); confirmTeeth([31, 32, 33]);
    expect(node("invoice-tooth-chip-0").props.className).toContain("rounded-full");
    expect(node("invoice-tooth-chip-0").props.className).not.toContain("rounded-xl");
    change(input("السعر"), "9000"); change(input("سبب تغيير السعر"), "Synthetic historical whole agreement");
    change(input("المدفوع قبل النظام"), "2000"); change(input("تاريخ المعلومات التاريخية"), "2026-01-01");
    expect(cards()).toHaveLength(1);
    expect(Number(input("الكمية").props.value)).toBe(1);
    expect(text(node("invoice-line-total-0"))).toContain(formatMoney(9000, "YER"));
    expect(text(node("invoice-financial-summary"))).toContain(formatMoney(7000, "YER"));
    renderForm(); await vi.advanceTimersByTimeAsync(351); await flush();
    const historicalRequest = body("/api/patients/901/historical-documents/preview");
    expect(historicalRequest.items).toHaveLength(1);
    expect(historicalRequest.items[0]).toMatchObject({ toothCode: 31, episodeTeeth: [31, 32, 33], price: "9000", quantity: 1 });
    expectCanonicalOnly(historicalRequest.items);
    expect(calls("/api/invoices/clinical-preview")).toHaveLength(0);
    expect(calls("/api/invoices")).toHaveLength(0);
  });
});
