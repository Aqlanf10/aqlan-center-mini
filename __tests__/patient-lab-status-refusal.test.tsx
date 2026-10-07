import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientLabOrders } from "../components/PatientLabOrders";
import { LabDeliveryAppointmentModal } from "../components/LabDeliveryAppointmentModal";
import type { LabOrder } from "../lib/lab";

// Source-only candidate. Runs the actual component handlers/effects in the existing
// repository's lightweight hook-harness style. All requests are synthetic.
// These checks do not claim real React scheduling or built-browser acceptance.
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
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined);
    const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory();
    hooks.memos.set(index, { deps, value });
    return value;
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
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ username: "synthetic-admin", role: "admin" }),
}));
vi.mock("../components/SettingsProvider", () => ({
  useClinicName: () => "Synthetic clinic",
  useSetting: () => "Synthetic clinic contact",
}));
vi.mock("../components/LabDentalChart", () => ({ LabDentalChart: () => null }));
vi.mock("../components/LabPrescriptionModal", () => ({ LabPrescriptionModal: () => null }));
vi.mock("../components/LabDeliveryAppointmentModal", () => ({ LabDeliveryAppointmentModal: () => null }));

type Element = ReactElement<Record<string, unknown>>;
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
function render() {
  let tree: ReturnType<typeof PatientLabOrders> | null = null;
  let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("Lab status refusal harness did not settle");
    hooks.cursor = 0;
    hooks.changed = false;
    tree = PatientLabOrders({ patientId: 82001, patientName: "Synthetic patient" });
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
async function flush() {
  for (let pass = 0; pass < 8; pass += 1) {
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    render();
  }
}
function find(predicate: (node: Element) => boolean) {
  const node = elements(render()).find(predicate);
  if (!node) throw new Error("Missing lab control");
  return node;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (status: number, payload: unknown) => ({
  status, ok: status >= 200 && status < 300, json: async () => payload,
}) as Response;

const order = (id: number, status: LabOrder["status"]): LabOrder => ({
  id, status, patientId: 82001, patientName: "Synthetic patient", patientNumber: "SYN-82001",
  patientPhone: null, labName: "Synthetic lab", labPhone: null, partyId: null, labServiceId: null,
  workType: `Synthetic crown ${id}`, details: "Synthetic detail", toothNumbers: "14", shade: "A2",
  stumpShade: null, priority: "normal", impressionType: "physical", sentDate: "2026-10-01",
  dueDate: "2026-10-10", receivedAt: null, deliveredAt: null, doctorId: null, visitId: null,
  qualityCheck: "pending", qualityNotes: null, remakeOriginalId: null, remakeReason: null,
  technicianName: null, note: "Synthetic instruction", createdAt: "2026-10-01T00:00:00Z",
});
const originalOrders = [order(81001, "sent"), order(81002, "in_progress"), order(81003, "received")];
const actions = [
  { id: 81001, status: "received", label: "✓ استلام من المختبر" },
  { id: 81002, status: "received", label: "✓ استلام من المختبر" },
  { id: 81003, status: "delivered", label: "✓ تسليم وتركيب للمريض" },
] as const;
type Action = (typeof actions)[number];
const fallback = "تعذّر تحديث حالة طلب المعمل.";
const uncertain = "تعذّر تأكيد تحديث حالة طلب المعمل. تحقّق من حالته قبل إعادة المحاولة.";
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
let read: () => Promise<Response>;
let write: () => Promise<Response>;
const confirmMock = vi.fn(() => true);
const reads = () => fetchMock.mock.calls.filter(([url, init]) => url.startsWith("/api/lab?") && !init?.method);
const writes = () => fetchMock.mock.calls.filter(([, init]) => !!init?.method);
const alerts = () => elements(render()).filter((node) => node.props.role === "alert").map(contents);
const booking = () => elements(render()).find((node) => node.type === LabDeliveryAppointmentModal);
function card(id: number) {
  return find((node) => node.key === String(id));
}
function button(id: number, label: string) {
  const found = elements(card(id)).find((node) => node.type === "button" && contents(node).trim() === label);
  if (!found) throw new Error(`Missing synthetic order ${id} control ${label}`);
  return found;
}
function handler(action: Action) {
  return button(action.id, action.label).props.onClick as () => void;
}
function invoke(action: Action) { handler(action)(); }
function assertOriginalRows() {
  expect(contents(card(81001))).toContain("قيد العمل بالمختبر");
  expect(contents(card(81002))).toContain("قيد التصنيع في المعمل");
  expect(contents(card(81003))).toContain("مستلم بالعيادة");
  for (const item of originalOrders) {
    expect(contents(card(item.id))).toContain(item.workType);
    expect(contents(card(item.id))).toContain(item.labName);
    expect(contents(card(item.id))).toContain(item.note);
  }
}
function assertUnlocked() {
  for (const action of actions) expect(button(action.id, action.label).props.disabled).toBe(false);
  expect(button(81003, "📅حجز موعد تسليم").props.disabled).toBe(false);
}
function assertWrite(action: Action, index = 0) {
  const [url, init] = writes()[index];
  expect(url).toBe(`/api/lab/${action.id}`);
  expect(init?.method).toBe("PATCH");
  expect(init?.headers).toEqual({ "Content-Type": "application/json" });
  expect(JSON.parse(String(init?.body))).toEqual({ status: action.status });
}

beforeEach(async () => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.changed = false;
  hooks.effects.clear();
  hooks.memos.clear();
  hooks.pending = [];
  vi.clearAllMocks();
  read = async () => response(200, { orders: structuredClone(originalOrders), labs: [] });
  write = async () => response(200, { ok: true });
  confirmMock.mockReturnValue(true);
  fetchMock.mockImplementation((url, init) => {
    if (init?.method) return write();
    if (url === "/api/lab?patientId=82001") return read();
    if (url === "/api/laboratories") return Promise.resolve(response(200, { laboratories: [] }));
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { confirm: confirmMock });
  render();
  await flush();
  expect(reads()).toHaveLength(1);
});
afterEach(() => {
  hooks.effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

describe.each(actions)("patient lab status refusal: $id to $status", (action) => {
  it.each([401, 403, 404, 409, 500])("shows a %s refusal without refreshing, changing rows or opening booking", async (status) => {
    write = async () => response(status, { message: `Synthetic refusal ${status}` });
    invoke(action);
    await flush();
    expect(alerts()).toEqual([`Synthetic refusal ${status}`]);
    expect(writes()).toHaveLength(1);
    assertWrite(action);
    expect(reads()).toHaveLength(1);
    expect(booking()).toBeUndefined();
    assertOriginalRows();
    assertUnlocked();
  });

  it.each([null, {}, { message: "" }, { message: "  " }, { message: 1 }, { message: {} }])(
    "uses a render-safe fallback for an unusable refusal payload %j", async (body) => {
      write = async () => response(409, body);
      invoke(action);
      await flush();
      expect(alerts()).toEqual([fallback]);
      expect(reads()).toHaveLength(1);
      expect(booking()).toBeUndefined();
      assertOriginalRows();
      assertUnlocked();
    },
  );

  it("contains unreadable refusal JSON", async () => {
    write = async () => ({ ...response(500, null), json: async () => { throw new Error("Synthetic invalid JSON"); } }) as Response;
    invoke(action);
    await flush();
    expect(alerts()).toEqual([fallback]);
    expect(writes()).toHaveLength(1);
    expect(reads()).toHaveLength(1);
    expect(booking()).toBeUndefined();
    assertUnlocked();
  });

  it("keeps duplicate commands blocked while the refusal body is still being decoded", async () => {
    const body = deferred<unknown>();
    write = async () => ({ ...response(409, null), json: () => body.promise }) as Response;
    const click = handler(action);
    click();
    await flush();
    click();
    expect(writes()).toHaveLength(1);
    expect(button(action.id, action.label).props.disabled).toBe(true);
    body.resolve({ message: "Synthetic decoded refusal" });
    await flush();
    expect(alerts()).toEqual(["Synthetic decoded refusal"]);
    assertUnlocked();
  });

  it("does not repeat the existing API conflict message's false refresh claim", async () => {
    write = async () => response(409, { message: "حالة العمل تغيّرت من جهاز آخر. حدّثت القائمة — راجعها." });
    invoke(action);
    await flush();
    expect(alerts()).toEqual(["حالة العمل تغيّرت من جهاز آخر. أعد تحميل القائمة وراجعها قبل إعادة المحاولة."]);
    expect(reads()).toHaveLength(1);
    assertOriginalRows();
  });

  it("contains a lost response, reports uncertainty, and never automatically repeats the mutation", async () => {
    write = async () => { throw new Error("Synthetic disconnected response"); };
    invoke(action);
    await flush();
    expect(alerts()).toEqual([uncertain]);
    expect(writes()).toHaveLength(1);
    assertWrite(action);
    expect(reads()).toHaveLength(1);
    expect(booking()).toBeUndefined();
    assertOriginalRows();
    assertUnlocked();
  });

  it("permits an explicit same-order, same-status retry without carrying the old error", async () => {
    write = async () => response(409, { message: "Synthetic stale state" });
    invoke(action);
    await flush();
    const retry = deferred<Response>();
    write = () => retry.promise;
    read = async () => response(200, {
      orders: originalOrders.map((item) => item.id === action.id ? { ...item, status: action.status } : item), labs: [],
    });
    invoke(action);
    expect(alerts()).toEqual([]);
    expect(reads()).toHaveLength(1);
    retry.resolve(response(200, { ok: true }));
    await flush();
    expect(writes()).toHaveLength(2);
    assertWrite(action, 0);
    assertWrite(action, 1);
    expect(reads()).toHaveLength(2);
    expect(alerts()).toEqual([]);
    if (action.status === "received") {
      expect(booking()?.props.order).toEqual({ ...originalOrders.find((item) => item.id === action.id), status: "received" });
    } else {
      expect(booking()).toBeUndefined();
      expect(contents(card(action.id))).toContain("تم التسليم للمريض");
    }
  });

  it("blocks same-tick duplicates and other mutations until the refusal settles", async () => {
    const pending = deferred<Response>();
    write = () => pending.promise;
    const click = handler(action);
    const other = handler(actions.find((item) => item.id !== action.id)!);
    const cancel = button(81001, "✕ إلغاء الإرسالية").props.onClick as () => void;
    click(); click(); other(); cancel();
    expect(writes()).toHaveLength(1);
    expect(confirmMock).not.toHaveBeenCalled();
    for (const item of actions) expect(button(item.id, item.label).props.disabled).toBe(true);
    expect(button(81003, "📅حجز موعد تسليم").props.disabled).toBe(true);
    pending.resolve(response(403, { message: "Synthetic refusal" }));
    await flush();
    assertUnlocked();
    expect(alerts()).toEqual(["Synthetic refusal"]);
  });

  it("keeps the lock through the accepted write's pending refresh and preserves received-only booking", async () => {
    const refresh = deferred<Response>();
    const click = handler(action);
    const other = handler(actions.find((item) => item.id !== action.id)!);
    read = () => refresh.promise;
    invoke(action);
    await flush();
    expect(reads()).toHaveLength(2);
    expect(booking()).toBeUndefined();
    click(); other();
    expect(writes()).toHaveLength(1);
    refresh.resolve(response(200, {
      orders: originalOrders.map((item) => item.id === action.id ? { ...item, status: action.status } : item), labs: [],
    }));
    await flush();
    expect(alerts()).toEqual([]);
    if (action.status === "received") {
      expect(booking()?.props.order).toEqual({ ...originalOrders.find((item) => item.id === action.id), status: "received" });
      (booking()!.props.onClose as () => void)();
      expect(booking()).toBeUndefined();
    } else expect(booking()).toBeUndefined();
    expect(writes()).toHaveLength(1);
  });

  it("preserves successful HTTP status handling without requiring a readable success body", async () => {
    write = async () => ({ ...response(200, null), json: async () => { throw new Error("Synthetic unreadable success"); } }) as Response;
    invoke(action);
    await flush();
    expect(alerts()).toEqual([]);
    expect(writes()).toHaveLength(1);
    assertWrite(action);
    expect(reads()).toHaveLength(2);
    expect(Boolean(booking())).toBe(action.status === "received");
  });

  it.each(["refusal", "network"])("retains a %s after an unrelated delayed list read completes", async (outcome) => {
    (button(81003, "📅حجز موعد تسليم").props.onClick as () => void)();
    const refresh = booking()!.props.onAppointmentBooked as () => void;
    (booking()!.props.onClose as () => void)();
    const click = handler(action);
    const pending = deferred<Response>();
    read = () => pending.promise;
    refresh();
    write = outcome === "network"
      ? async () => { throw new Error("Synthetic lost response"); }
      : async () => response(409, { message: "Synthetic refusal" });
    click();
    await flush();
    const message = outcome === "network" ? uncertain : "Synthetic refusal";
    expect(alerts()).toEqual([message]);
    pending.resolve(response(200, { orders: structuredClone(originalOrders), labs: [] }));
    await flush();
    expect(alerts()).toEqual([message]);
    expect(writes()).toHaveLength(1);
    expect(reads()).toHaveLength(2);
    expect(booking()).toBeUndefined();
    assertOriginalRows();
    assertUnlocked();
  });
});

it("keeps cancellation payload, confirmation and lock ownership intact", async () => {
  const pending = deferred<Response>();
  write = () => pending.promise;
  const cancel = button(81001, "✕ إلغاء الإرسالية").props.onClick as () => void;
  const receive = handler(actions[0]);
  cancel(); cancel(); receive();
  expect(confirmMock).toHaveBeenCalledTimes(1);
  expect(writes()).toHaveLength(1);
  expect(writes()[0][0]).toBe("/api/lab/81001");
  expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ status: "cancelled", note: "إلغاء من ملف المريض" });
  pending.resolve(response(403, { message: "Synthetic cancellation refusal" }));
  await flush();
  expect(alerts()).toEqual(["Synthetic cancellation refusal"]);
  assertUnlocked();
});

it("declining cancellation leaves the status command available", async () => {
  confirmMock.mockReturnValue(false);
  (button(81001, "✕ إلغاء الإرسالية").props.onClick as () => void)();
  expect(writes()).toHaveLength(0);
  write = async () => response(409, { message: "Synthetic refusal" });
  invoke(actions[0]);
  await flush();
  expect(writes()).toHaveLength(1);
  assertWrite(actions[0]);
  assertUnlocked();
});

it("shares the synchronous lock with creation without changing the creation payload", async () => {
  (find((node) => node.type === "button" && contents(node).trim() === "+ طلب معمل جديد").props.onClick as () => void)();
  (find((node) => node.type === "input" && node.props.list === "patient-labs-list").props.onChange as (event: unknown) => void)({ target: { value: "Synthetic lab" } });
  const submit = find((node) => node.type === "form").props.onSubmit as (event: unknown) => Promise<void>;
  const receive = handler(actions[0]);
  const pending = deferred<Response>();
  write = () => pending.promise;
  void submit({ preventDefault() {} });
  void submit({ preventDefault() {} });
  receive();
  expect(writes()).toHaveLength(1);
  expect(writes()[0][0]).toBe("/api/lab");
  expect(writes()[0][1]?.method).toBe("POST");
  expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({
    patientId: 82001, labName: "Synthetic lab", workType: "تاج زيركون كامل",
    priority: "normal", details: null, sentDate: expect.any(String), dueDate: expect.any(String), note: null,
  });
  pending.resolve(response(403, { message: "Synthetic creation refusal" }));
  await flush();
  expect(alerts()).toEqual(["Synthetic creation refusal"]);
  assertUnlocked();
});

it("blocks a same-tick create submission after a status command started", async () => {
  (find((node) => node.type === "button" && contents(node).trim() === "+ طلب معمل جديد").props.onClick as () => void)();
  (find((node) => node.type === "input" && node.props.list === "patient-labs-list").props.onChange as (event: unknown) => void)({ target: { value: "Synthetic lab" } });
  const submit = find((node) => node.type === "form").props.onSubmit as (event: unknown) => Promise<void>;
  const pending = deferred<Response>();
  write = () => pending.promise;
  invoke(actions[0]);
  void submit({ preventDefault() {} });
  expect(writes()).toHaveLength(1);
  assertWrite(actions[0]);
  pending.resolve(response(409, { message: "Synthetic refusal" }));
  await flush();
  assertUnlocked();
});
