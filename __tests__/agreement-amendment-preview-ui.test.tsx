import { type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Run the real panel, effects and event handlers using disposable local state.
// No database, browser session or financial writer is contacted by these tests.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  pending: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = initial;
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
    useMemo: (compute: () => unknown) => { hooks.cursor++; return compute(); },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.effects.get(index);
      if (previous?.deps && deps && previous.deps.length === deps.length
        && previous.deps.every((value, i) => Object.is(value, deps[i]))) return;
      hooks.pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});
import { AgreementAmendmentPanel } from "../components/AgreementAmendmentPanel";

const PLAN_ID = 19;
const STORAGE_KEY = `aqlan:agreement-amendment:pending:${PLAN_ID}`;
const MULTI_ITEM_REASON = "تعدد بنود العلاج يحتاج تخصيصًا ماليًا مستقلًا؛ لا يُخمّن فرق السعر.";
const GENERIC = "البيانات أو الهجرة المالية غير جاهزة؛ لا يمكن حفظ التعديل.";
const ADMIN_ONLY = "يتطلب تعديل اتفاق العلاج جلسة مدير سارية.";
const fetchMock = vi.fn();
const onChanged = vi.fn(async () => {});
let storage: Map<string, string>;
let removeItem: ReturnType<typeof vi.fn>;
let setItem: ReturnType<typeof vi.fn>;
type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...nodes(element.props.children as ReactNode)];
}
function render() {
  let tree: ReactElement;
  let rounds = 0;
  do {
    if (++rounds > 10) throw new Error("Hook render did not settle");
    hooks.cursor = 0; hooks.changed = false;
    tree = AgreementAmendmentPanel({ planId: PLAN_ID, onChanged });
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return { html: renderToStaticMarkup(tree), nodes: nodes(tree) };
}
function click(label: string) {
  const button = render().nodes.find((node) => node.type === "button" && node.props.children === label);
  expect(button, label).toBeDefined();
  expect(button!.props.disabled).not.toBe(true);
  (button!.props.onClick as () => void)();
  render();
}
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return render();
}
async function open() {
  click("ترقية خدمة الاتفاق بفرق مؤرخ");
  return settle();
}
function response(payload: unknown, status = 200, redirected = false): Response {
  return { status, ok: status >= 200 && status < 300, redirected, json: async () => payload } as Response;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function expectNoNewAttempt() {
  expect(setItem).not.toHaveBeenCalled();
  expect(removeItem).not.toHaveBeenCalled();
  expect(onChanged).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
}
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.effects.clear(); hooks.pending = [];
  storage = new Map();
  setItem = vi.fn((key: string, value: string) => { storage.set(key, value); });
  removeItem = vi.fn((key: string) => { storage.delete(key); });
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem, removeItem });
  fetchMock.mockReset(); onChanged.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  hooks.effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

describe("agreement amendment preview refusal display", () => {
  it.each([false, true])("keeps a valid preview and its pending-request input guard (pending: %s)", async (pending) => {
    if (pending) storage.set(STORAGE_KEY, JSON.stringify({ key: "synthetic-pending-key", body: "{}" }));
    fetchMock.mockResolvedValueOnce(response({ planId: PLAN_ID, patientId: 1, currency: "YER", itemId: 1,
      caseId: null, quantity: 19, oldServiceId: 1, oldUnitMinor: 10000, previousAgreementMinor: 190000,
      recordedPaymentsMinor: 0, recordedRefundsMinor: 0, sourceHash: "synthetic-source-hash",
      services: [{ id: 1, name: "Synthetic crown", category: null }] }));
    const page = await open();
    expect(page.nodes.some((node) => node.type === "select")).toBe(true);
    expect(page.nodes.find((node) => node.type === "fieldset")?.props.disabled).toBe(pending);
    expect(page.nodes.some((node) => node.props.role === "alert")).toBe(false);
    expectNoNewAttempt();
  });

  it.each([
    [409, { code: "conflict", message: MULTI_ITEM_REASON }, MULTI_ITEM_REASON],
    [401, { message: "يجب تسجيل الدخول" }, "يجب تسجيل الدخول"],
    [403, { code: "unauthorized", message: ADMIN_ONLY }, ADMIN_ONLY],
    [404, { code: "missing", message: "الخطة غير موجودة." }, "الخطة غير موجودة."],
    [400, { code: "invalid", message: "معرف الخطة غير صالح." }, "معرف الخطة غير صالح."],
  ])("shows the controlled %s preview reason without enabling a financial command", async (status, payload, expected) => {
    fetchMock.mockResolvedValueOnce(response(payload, status as number));
    const page = await open();
    expect(page.html).toContain(expected);
    expect(page.html).not.toContain(GENERIC);
    expect(page.nodes.some((node) => node.type === "select")).toBe(false);
    expect(page.nodes.find((node) => node.type === "button"
      && node.props.children === "حفظ فرق التعديل المؤرخ")?.props.disabled).toBe(true);
    expectNoNewAttempt();
  });

  it.each([
    [500, { code: "conflict", message: MULTI_ITEM_REASON }],
    [503, { message: "PRIVATE SQL / connection details" }],
    [409, { code: "conflict", message: "<script>PRIVATE SQL / connection details</script>" }],
    [409, { code: "conflict", message: `${MULTI_ITEM_REASON} PRIVATE suffix` }],
    [409, { code: "invalid", message: MULTI_ITEM_REASON }],
    [409, { message: MULTI_ITEM_REASON }],
    [409, { code: "conflict", message: { toString: "PRIVATE" } }],
    [409, null],
    [409, [MULTI_ITEM_REASON]],
    [401, { message: "PRIVATE session details" }],
    [403, { code: "unauthorized", message: "PRIVATE access details" }],
    [200, { planId: PLAN_ID + 1, sourceHash: "wrong-plan" }],
  ])("uses the generic fallback for unsafe or malformed %s responses", async (status, payload) => {
    fetchMock.mockResolvedValueOnce(response(payload, status as number));
    const page = await open();
    expect(page.html).toContain(GENERIC);
    expect(page.html).not.toContain("PRIVATE");
    expect(page.html).not.toContain(MULTI_ITEM_REASON);
    expectNoNewAttempt();
  });

  it.each(["network", "json", "redirect"])("uses the generic fallback for %s failure", async (failure) => {
    if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("PRIVATE network detail"));
    else if (failure === "json") fetchMock.mockResolvedValueOnce({ ...response(null, 409),
      json: async () => { throw new Error("PRIVATE malformed JSON"); } });
    else fetchMock.mockResolvedValueOnce(response({ code: "conflict", message: MULTI_ITEM_REASON }, 409, true));
    const page = await open();
    expect(page.html).toContain(GENERIC);
    expect(page.html).not.toContain("PRIVATE");
    expectNoNewAttempt();
  });

  it.each([409, 401, 403, 500, "malformed", "network"])("retains the exact pending attempt after a %s preview failure and replays only that body", async (status) => {
    const command = { key: "synthetic-pending-key", body: JSON.stringify({ idempotencyKey: "synthetic-pending-key",
      expectedSourceHash: "synthetic-hash", newServiceId: 2, newUnitMinor: 15000, reason: "Synthetic documented agreement" }) };
    const stored = JSON.stringify(command);
    storage.set(STORAGE_KEY, stored);
    const payload = status === 409 ? { code: "conflict", message: MULTI_ITEM_REASON }
      : status === 401 ? { message: "يجب تسجيل الدخول" } : { code: "unauthorized", message: ADMIN_ONLY };
    if (status === "network") fetchMock.mockRejectedValueOnce(new Error("Synthetic network failure"));
    else if (status === "malformed") fetchMock.mockResolvedValueOnce(response(null, 409));
    else fetchMock.mockResolvedValueOnce(response(payload, status as number));
    const page = await open();
    expect(page.html).toContain("لا تغيّر الطلب حتى تتأكد نتيجته.");
    expect(page.html).not.toContain("تحديث المعاينة وتصحيح الطلب المرفوض");
    expect(page.html).not.toContain("رفضه الخادم نهائيًا ولم يحفظ.");
    expect(page.html).toContain("تحقق من حالة طلب التعديل المحفوظ");
    expect(storage.get(STORAGE_KEY)).toBe(stored);
    expectNoNewAttempt();
    fetchMock.mockResolvedValueOnce(response({ message: "Uncertain synthetic reply" }, 500));
    click("إعادة الطلب المحفوظ نفسه");
    await settle();
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", body: command.body, redirect: "manual" });
    expect(storage.get(STORAGE_KEY)).toBe(stored);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("keeps the pending retry single-flight even when the same click handler fires twice", async () => {
    const command = { key: "synthetic-pending-key", body: JSON.stringify({ idempotencyKey: "synthetic-pending-key",
      expectedSourceHash: "synthetic-hash", newServiceId: 2, newUnitMinor: 15000, reason: "Synthetic reason" }) };
    storage.set(STORAGE_KEY, JSON.stringify(command));
    fetchMock.mockResolvedValueOnce(response({ code: "conflict", message: MULTI_ITEM_REASON }, 409));
    const page = await open();
    const retry = page.nodes.find((node) => node.type === "button" && node.props.children === "إعادة الطلب المحفوظ نفسه")!;
    const pendingReply = deferred<Response>();
    fetchMock.mockReturnValueOnce(pendingReply.promise);
    (retry.props.onClick as () => void)();
    (retry.props.onClick as () => void)();
    expect(fetchMock).toHaveBeenCalledTimes(2); // One preview and exactly one retry.
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST", body: command.body });
    expect(render().nodes.find((node) => node.type === "button" && node.props.children === "جارٍ التحقق…")?.props.disabled).toBe(true);
    pendingReply.resolve(response({ message: "Synthetic uncertain result" }, 500));
    await settle();
    expect(storage.get(STORAGE_KEY)).toBe(JSON.stringify(command));
    expect(removeItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("ignores an obsolete preview after close/reopen and preserves the latest controlled refusal", async () => {
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    await open();
    click("ترقية خدمة الاتفاق بفرق مؤرخ");
    fetchMock.mockResolvedValueOnce(response({ code: "conflict", message: MULTI_ITEM_REASON }, 409));
    await open();
    old.resolve(response({ code: "unauthorized", message: ADMIN_ONLY }, 403));
    const page = await settle();
    expect(page.html).toContain(MULTI_ITEM_REASON);
    expect(page.html).not.toContain(ADMIN_ONLY);
    expectNoNewAttempt();
  });
});
