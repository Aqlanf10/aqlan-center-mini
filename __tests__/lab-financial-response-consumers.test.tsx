/** Synthetic component coverage only: actual page, patient component/read hook,
 * response projection and JSX; mocked hooks, visual children and GET transport.
 * No DOM/browser, application server, database or real mutation is involved. */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LabPage from "../app/lab/page";
import { PatientLabOrders } from "../components/PatientLabOrders";
import { LabPrescriptionModal } from "../components/LabPrescriptionModal";
import { LabDeliveryAppointmentModal } from "../components/LabDeliveryAppointmentModal";
import { LabOrderAccountingModal } from "../components/LabOrderAccountingModal";
import { LAB_FILTER_LABEL, type LabOrder } from "../lib/lab";
import { projectLabOrderResponse } from "../lib/lab-response";
import { formatAmount, formatMoney } from "../lib/money";

// Match the repository's synthetic-hook component tests, without seeding hooks
// by numeric state position or duplicating the components' rendering predicates.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  memos: new Map<number, { value: unknown; deps?: readonly unknown[] }>(),
  effects: new Map<number, { cleanup?: () => void; deps?: readonly unknown[] }>(),
  pending: [] as Array<() => void>, layout: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b
    && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (compute: () => unknown, deps?: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = compute(); hooks.memos.set(index, { value, deps }); return value;
  };
  const effect = (layout: boolean) => (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    (layout ? hooks.layout : hooks.pending).push(() => {
      previous?.cleanup?.();
      const cleanup = run();
      hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
    });
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: effect(false), useLayoutEffect: effect(true),
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic", role: "admin" }) }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic", useSetting: () => "" }));
vi.mock("../components/PageHeader", () => ({ PageHeader: () => null, StatCard: () => null }));
vi.mock("../components/LabDentalChart", () => ({ LabDentalChart: () => null }));
vi.mock("../components/LabPrescriptionModal", () => ({ LabPrescriptionModal: () => null }));
vi.mock("../components/LabDeliveryAppointmentModal", () => ({ LabDeliveryAppointmentModal: () => null }));
vi.mock("../components/LabOrderAccountingModal", () => ({ LabOrderAccountingModal: () => null }));

type Element = ReactElement<Record<string, unknown>>;
type Surface = "patient" | "global";
const fetchMock = vi.fn();
let surface: Surface;
let responseOrder: LabOrder;

function order(extra: Partial<LabOrder> = {}): LabOrder {
  return {
    id: 301, patientId: 101, patientName: "Synthetic patient", patientNumber: "SYN-101", patientPhone: null,
    labName: "Synthetic laboratory", labPhone: null, partyId: 401, labServiceId: 501, serviceName: "Synthetic service",
    workType: "Synthetic crown", details: "Synthetic clinical instructions", toothNumbers: "11", shade: "A2", stumpShade: null,
    priority: "normal", impressionType: "physical", sentDate: "2026-10-01", dueDate: "2026-10-10", status: "received",
    receivedAt: "2026-10-03", deliveredAt: null, doctorId: 601, doctorName: "Synthetic doctor", visitId: 701,
    toothCode: 11, source: "manual", qualityCheck: "pending", qualityNotes: null, remakeOriginalId: null,
    remakeReason: null, technicianName: null, note: "Synthetic clinical note", createdAt: "2026-10-01T12:00:00.000Z",
    costMinor: 1234567, costCurrency: "USD", baseAmountMinor: 7654321, exchangeRate: 6.2,
    financialStatus: "pending_post", payableId: 801, expenseCategoryId: 901, expenseCategoryName: "Synthetic expense category",
    expenseCategoryKey: "synthetic-financial-key", expenseAccountCode: "5199", expenseAccountName: "Synthetic expense account",
    payableAccountCode: "2199", payableAccountName: "Synthetic payable account", isPosted: false, postedAt: null,
    ...extra,
  };
}
function response(payload: unknown): Response {
  // JSON transport omits undefined keys in the same way as the API boundary.
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(payload)) } as Response;
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
function render(): ReactNode {
  let tree: ReactNode;
  let rounds = 0;
  do {
    if (++rounds > 15) throw new Error("Synthetic lab component did not settle");
    hooks.cursor = 0; hooks.changed = false;
    tree = surface === "global" ? LabPage() : PatientLabOrders({ patientId: 101, patientName: "Synthetic patient", base: "YER" });
    hooks.layout.splice(0).forEach((effect) => effect());
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
function control(predicate: (node: Element) => boolean): Element {
  const found = nodes(render()).find(predicate);
  if (!found) throw new Error("Missing actual lab component control");
  return found;
}
function clickLabel(label: string) {
  const button = control((node) => node.type === "button" && text(node).includes(label));
  (button.props.onClick as () => void)();
}
const modal = (type: unknown) => nodes(render()).find((node) => node.type === type);
async function ready(target: Surface, value: LabOrder) {
  surface = target; responseOrder = value;
  render();
  for (let index = 0; index < 30; index++) await Promise.resolve();
  render();
  if (surface === "global") clickLabel(LAB_FILTER_LABEL.all);
  return render();
}
function noFinancialRow(tree: ReactNode) {
  const content = text(tree);
  expect(content).not.toContain("التكلفة:");
  expect(content).not.toContain("مُرحّل محاسبياً");
  expect(content).not.toContain("مربوط بالمصروفات (بانتظار الترحيل النهائي)");
  expect(content).not.toContain("غير مربوط بالمصروفات");
  expect(content).not.toContain("Synthetic expense");
  expect(content).not.toContain(formatAmount(1234567, "USD"));
  expect(content).not.toContain(formatMoney(7654321, "YER"));
  expect(nodes(tree).some((node) => node.props.id === "lab-accounting-btn-301")).toBe(false);
  expect(nodes(tree).some((node) => node.type === LabOrderAccountingModal)).toBe(false);
}
function expectClinicalModal(type: unknown) {
  expect(modal(type)?.props.order).toMatchObject({
    id: 301, patientId: 101, workType: "Synthetic crown", details: "Synthetic clinical instructions",
    toothNumbers: "11", shade: "A2", status: "received", note: "Synthetic clinical note",
    costMinor: null, costCurrency: null,
  });
  expect(modal(type)?.props.order).not.toHaveProperty("baseAmountMinor");
  expect(modal(type)?.props.order).not.toHaveProperty("isPosted");
  expect(modal(type)?.props.order).not.toHaveProperty("expenseCategoryId");
}

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.memos.clear(); hooks.effects.clear(); hooks.pending = []; hooks.layout = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") throw new Error(`Unexpected mutation: ${url}`);
    if (url === "/api/lab" || url === "/api/lab?patientId=101") {
      return Promise.resolve(response({ orders: [responseOrder], labs: [{ labName: "Synthetic laboratory", labPhone: null }] }));
    }
    if (url === "/api/laboratories") return Promise.resolve(response({ laboratories: [] }));
    if (url === "/api/lab/services") return Promise.resolve(response({ services: [] }));
    if (url === "/api/finance/expense-categories") return Promise.resolve(response({ categories: [] }));
    throw new Error(`Unexpected read: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  hooks.effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

describe("actual lab UI consumers of financially denied response projection", () => {
  it.each(["patient", "global"] as const)("keeps %s clinical use without cost, financial badges or an accounting trigger", async (target) => {
    const projected = projectLabOrderResponse(order({ isPosted: true }), false);
    expect(projected).not.toHaveProperty("baseAmountMinor");
    expect(projected).not.toHaveProperty("isPosted");
    const tree = await ready(target, projected);
    noFinancialRow(tree);
    expect(text(tree)).toContain("Synthetic crown");
    expect(text(tree)).toContain("Synthetic laboratory");
    expect(text(tree)).toContain("Synthetic clinical instructions");
    expect(text(tree)).not.toContain("لا توجد طلبات");
    expect(text(tree)).not.toContain("لا توجد أعمال");
    expect(nodes(tree).some((node) => node.props.role === "alert")).toBe(false);

    clickLabel("استمارة المختبر");
    expectClinicalModal(LabPrescriptionModal);
    (modal(LabPrescriptionModal)!.props.onClose as () => void)();
    expect(modal(LabPrescriptionModal)).toBeUndefined();
    clickLabel("حجز موعد تسليم");
    expectClinicalModal(LabDeliveryAppointmentModal);
    noFinancialRow(render());
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("does not reinterpret a withheld false posting flag as an available accounting action", async () => {
    const tree = await ready("global", projectLabOrderResponse(order({ isPosted: false }), false));
    noFinancialRow(tree);
    expect(text(tree)).toContain("Synthetic crown");
    clickLabel(LAB_FILTER_LABEL.unposted);
    expect(text(render())).not.toContain("Synthetic crown");
    expect(text(render())).toContain("لا توجد أعمال تطابق الفلتر المحدد");
    clickLabel(LAB_FILTER_LABEL.all);
    expect(text(render())).toContain("Synthetic crown");
    noFinancialRow(render());
  });
});

describe("actual lab UI preserves explicit authorized financial data", () => {
  it("preserves the patient cost display for an authorized nonzero base amount", async () => {
    const tree = await ready("patient", projectLabOrderResponse(order(), true));
    expect(text(tree)).toContain(`التكلفة: ${formatMoney(7654321, "YER")}`);
    expect(text(tree)).toContain("Synthetic crown");
  });

  it("characterizes the unchanged patient zero-cost guard", async () => {
    const tree = await ready("patient", projectLabOrderResponse(order({ baseAmountMinor: 0, costMinor: 0 }), true));
    expect(text(tree)).not.toContain("التكلفة:");
    expect(text(tree)).toContain("Synthetic crown");
  });

  it.each([true, false])("preserves an explicit isPosted=%s badge and accounting modal trigger", async (isPosted) => {
    const tree = await ready("global", projectLabOrderResponse(order({ isPosted }), true));
    expect(text(tree)).toContain(`التكلفة: ${formatAmount(1234567, "USD")} USD`);
    expect(text(tree)).toContain(isPosted ? "مُرحّل محاسبياً (حـ/ 5199)" : "مربوط بالمصروفات (بانتظار الترحيل النهائي)");
    const button = control((node) => node.type === "button" && node.props.id === "lab-accounting-btn-301");
    expect(text(button)).toContain(isPosted ? "الربط المحاسبي (مُرحّل ✓)" : "معاينة وترحيل القيد");
    (button.props.onClick as () => void)();
    expect(modal(LabOrderAccountingModal)?.props.order).toMatchObject({ isPosted, costMinor: 1234567, expenseCategoryId: 901 });
    (modal(LabOrderAccountingModal)!.props.onClose as () => void)();
    expect(modal(LabOrderAccountingModal)).toBeUndefined();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("keeps explicit false actionable with a legitimate zero cost and no expense category", async () => {
    const tree = await ready("global", projectLabOrderResponse(order({ isPosted: false, costMinor: 0, baseAmountMinor: 0, expenseCategoryId: null }), true));
    expect(text(tree)).not.toContain("التكلفة:");
    const button = control((node) => node.type === "button" && node.props.id === "lab-accounting-btn-301");
    expect(text(button)).toContain("ربط بالمصروفات");
    (button.props.onClick as () => void)();
    expect(modal(LabOrderAccountingModal)?.props.order).toMatchObject({ isPosted: false, costMinor: 0, expenseCategoryId: null });
  });
});
