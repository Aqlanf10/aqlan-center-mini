import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientCases } from "../components/PatientCases";
import { createPatientNavigation } from "../lib/patient-navigation";
import { focusDestination, readPatientRecordFocus, type PatientCaseFocus } from "../lib/patient-workspace-focus";
import type { SessionInfo } from "../components/SessionProvider";

// Reconstructed behavior tests: the real component, event handlers and canonical
// guard run against a small hook driver. Only transport/session are synthetic.
type Driver = {
  values: unknown[]; cursor: number;
  effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>; layoutEffects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>;
  memos: Map<number, { deps?: readonly unknown[]; value: unknown }>;
  pending: Array<() => void>; layoutPending: Array<() => void>;
};
const hooks = vi.hoisted(() => ({ current: null as unknown as Driver }));
const authority = vi.hoisted(() => ({ session: null as SessionInfo | null }));
const newDriver = (): Driver => ({ values: [], cursor: 0, effects: new Map(), layoutEffects: new Map(), memos: new Map(), pending: [], layoutPending: [] });
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (state: Driver, initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.values)) state.values[index] = initial;
    return index;
  };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const state = hooks.current;
    const index = slot(state, undefined);
    const previous = state.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory();
    state.memos.set(index, { deps, value });
    return value;
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      const state = hooks.current;
      const index = slot(state, typeof initial === "function" ? initial() : initial);
      return [state.values[index], (value: unknown) => { state.values[index] = typeof value === "function" ? value(state.values[index]) : value; }];
    },
    useRef: (initial: unknown) => { const state = hooks.current; return state.values[slot(state, { current: initial })]; },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const state = hooks.current;
      const index = slot(state, undefined);
      const previous = state.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      state.pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        state.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const state = hooks.current;
      const index = slot(state, undefined);
      const previous = state.layoutEffects.get(index);
      if (previous && same(previous.deps, deps)) return;
      state.layoutPending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        state.layoutEffects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => authority.session }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  const found: Element[] = [];
  Children.forEach(node, (child) => {
    if (isValidElement<Record<string, unknown>>(child)) {
      found.push(child);
      found.push(...elements(child.props.children as ReactNode));
    }
  });
  return found;
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  const parts: string[] = [];
  Children.forEach(node, (child) => {
    if (typeof child === "string" || typeof child === "number") parts.push(String(child));
    else if (isValidElement<{ children?: ReactNode }>(child)) parts.push(text(child.props.children));
  });
  return parts.join(" ");
}
function caseRow(patientId = 91, id = 17, title = "حالة أصلية") {
  return {
    id, patientId, title, kind: "specialty", orthoCaseId: null, specialty: "endodontics",
    site: "36", problem: "تشخيص محفوظ", responsiblePartyId: 7, responsibleName: "الطبيب المسؤول",
    status: "active", startedOn: "2026-10-03", completedAt: null, outcome: null,
    itemsTotal: 1, itemsDone: 0, createdBy: "doctor",
  };
}
function payload(patientId = 91, title = "حالة أصلية") {
  return {
    cases: [caseRow(patientId, 17, title), caseRow(patientId, 18, "حالة أخرى")],
    problems: [], items: [], dependencies: [], planVisible: true,
  };
}
type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const response = (body: unknown, status = 200): Reply => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const focus: PatientCaseFocus = { kind: "case", patientId: 91, caseId: 17 };
const nextFocus: PatientCaseFocus = { ...focus, caseId: 18 };
let state: Driver;
let props: ComponentProps<typeof PatientCases>;
let guard: (() => boolean) | null;
let caseResponse: Reply | Promise<Reply>;
let writeResponse: Reply | Promise<Reply>;
let url: URL;
let navigation: ReturnType<typeof createPatientNavigation>;
const fetchMock = vi.fn();
const confirm = vi.fn(() => false);
const replaceState = vi.fn();
const pushState = vi.fn();
function view() {
  hooks.current = state;
  state.cursor = 0;
  const tree = PatientCases(props);
  state.layoutPending.splice(0).forEach((effect) => effect());
  state.pending.splice(0).forEach((effect) => effect());
  return { tree, nodes: elements(tree), text: text(tree) };
}
async function settle() { for (let index = 0; index < 40; index += 1) await Promise.resolve(); }
async function loaded() { view(); await settle(); return view(); }
function button(label: string, exact = false) {
  const node = view().nodes.find((element) => element.type === "button" && (exact ? text(element) === label : text(element).includes(label)));
  expect(node, label).toBeDefined();
  return node!;
}
const click = (node: Element) => (node.props.onClick as () => unknown)();
function input(attribute: string, value: string) {
  const node = view().nodes.find((element) => element.props[attribute] === value);
  expect(node, value).toBeDefined();
  return node!;
}
function change(node: Element, value: string) {
  (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
function openCase(title = "مسودة الحالة") {
  click(button("+ حالة جديدة"));
  change(input("placeholder", "علاج عصب — سن ٣٦"), title);
  return button("حفظ الحالة");
}
const titleDraft = () => view().nodes.find((node) => node.props.placeholder === "علاج عصب — سن ٣٦")?.props.value;
const problemDraft = () => view().nodes.find((node) => node.props["aria-label"] === "المشكلة")?.props.value;
const selected = () => view().nodes.filter((node) => node.props["data-focused-case"] !== undefined).map((node) => node.props["data-focused-case"]);
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");
const caseReads = () => fetchMock.mock.calls.filter(([target, init]) => typeof target === "string" && target.endsWith("/cases") && !init?.method);

beforeEach(() => {
  state = newDriver(); hooks.current = state; guard = null;
  authority.session = { username: "doctor-one", role: "doctor", permissions: null };
  props = { patientId: 91, canWrite: true, focus, onNavigationGuardChange: (next) => { guard = next; } };
  caseResponse = response(payload());
  writeResponse = response({ message: "رفض حفظ تجريبي" }, 409);
  confirm.mockReset().mockReturnValue(false); replaceState.mockReset(); pushState.mockReset();
  fetchMock.mockReset().mockImplementation(async (target: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") return writeResponse;
    return target.endsWith("/cases") ? caseResponse : response([]);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { confirm, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  url = new URL("https://clinic.test/patients/91?tab=treatment&sub=cases&focus=case&focusPatient=91&focusCase=17");
  replaceState.mockImplementation((_state, _title, href: string) => { url = new URL(href, url); });
  const host = { get location() { return url; }, history: { replaceState, pushState, length: 4 } } as unknown as Window;
  navigation = createPatientNavigation(host, {
    canLeave: () => guard?.() ?? false,
    onChange: () => {
      const requested = readPatientRecordFocus(url.search, 91);
      if (requested.status === "valid" && requested.focus.kind === "case") props.focus = requested.focus;
    },
  });
});
afterEach(() => {
  state.layoutEffects.forEach((effect) => effect.cleanup?.()); state.effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

describe("reconstructed PatientCases ownership and focus", () => {
  it("focuses only the exact fresh case without opening a form or writing", async () => {
    await loaded();
    expect(selected()).toEqual(["17"]);
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-focus-ready")).toBe(true);
    expect(titleDraft()).toBeUndefined();
    expect(writes()).toHaveLength(0);
  });

  it.each(["missing", "wrong focus patient", "duplicate", "wrong row patient"])("has explicit unavailable focus and no fallback for %s", async (kind) => {
    if (kind === "missing") props.focus = { ...focus, caseId: 999 };
    if (kind === "wrong focus patient") props.focus = { ...focus, patientId: 92 };
    if (kind === "duplicate") caseResponse = response({ ...payload(), cases: [caseRow(), caseRow()] });
    if (kind === "wrong row patient") caseResponse = response({ ...payload(), cases: [caseRow(92)] });
    await loaded();
    expect(selected()).toEqual([]);
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-focus-unavailable")).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("keeps a dirty form and the exact URL when canonical same-tab navigation is refused", async () => {
    await loaded(); openCase();
    const before = url.href;
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(false);
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(false);
    expect(url.href).toBe(before);
    expect(titleDraft()).toBe("مسودة الحالة");
    expect(selected()).toEqual(["17"]);
    expect(confirm).not.toHaveBeenCalled();
    click(button("إلغاء", true));
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(true);
    await loaded();
    expect(selected()).toEqual(["18"]);
    expect(writes()).toHaveLength(0);
  });

  it("blocks repeated submit, stale cancel, sibling opener and navigation synchronously while a write is pending", async () => {
    await loaded();
    const save = openCase();
    const cancel = button("إلغاء", true);
    const sibling = button("+ مشكلة");
    const pending = deferred<Reply>(); writeResponse = pending.promise;
    click(save); click(save); click(cancel); click(sibling);
    expect(writes()).toHaveLength(1);
    expect(titleDraft()).toBe("مسودة الحالة");
    expect(problemDraft()).toBeUndefined();
    expect(guard?.()).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    pending.resolve(response({ message: "رفض حفظ تجريبي" }, 409)); await settle();
    click(save); // A captured pre-request handler cannot resubmit after settlement.
    expect(writes()).toHaveLength(1);
    expect(titleDraft()).toBe("مسودة الحالة");
    expect(view().text).toContain("رفض حفظ تجريبي");
  });

  it.each([401, 403, 404])("retires authorized rows and hidden form owners before reading a non-JSON %s body", async (status) => {
    await loaded(); openCase();
    const body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    caseResponse = { ok: false, status, json };
    props.focus = nextFocus;
    await loaded();
    expect(json).not.toHaveBeenCalled();
    expect(view().text).not.toContain("حالة أصلية");
    expect(titleDraft()).toBeUndefined();
    expect(selected()).toEqual([]);
    expect(guard?.()).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("keeps a retired writer locked until its request settles and never revives its hidden form", async () => {
    await loaded();
    const save = openCase();
    const pending = deferred<Reply>(); writeResponse = pending.promise;
    click(save);
    const json = vi.fn(async () => { throw new SyntaxError("HTML denial"); });
    caseResponse = { ok: false, status: 403, json };
    props.focus = nextFocus;
    await loaded();
    expect(json).not.toHaveBeenCalled();
    expect(titleDraft()).toBeUndefined();
    expect(guard?.()).toBe(false);
    pending.resolve(response({ message: "رسالة الكاتب القديم" }, 409)); await settle();
    expect(guard?.()).toBe(true);
    expect(view().text).not.toContain("رسالة الكاتب القديم");
    expect(view().text).not.toContain("حالة أصلية");
    expect(writes()).toHaveLength(1);
  });

  it.each(["patient", "authority"])("fences a late read after a %s switch", async (kind) => {
    const previous = deferred<Reply>(); caseResponse = previous.promise;
    view();
    const nextPatient = kind === "patient" ? 92 : 91;
    if (kind === "authority") authority.session = { username: "doctor-two", role: "doctor", permissions: null };
    props = { ...props, patientId: nextPatient, focus: { ...focus, patientId: nextPatient } };
    caseResponse = response(payload(nextPatient, "حالة السياق الجديد"));
    await loaded();
    previous.resolve(response(payload(91, "حالة القراءة القديمة"))); await settle();
    expect(view().text).toContain("حالة السياق الجديد");
    expect(view().text).not.toContain("حالة القراءة القديمة");
    expect(selected()).toEqual(["17"]);
    expect(writes()).toHaveLength(0);
  });

  it.each(["patient", "authority"])("fences stale mutation handlers and a late write after a %s switch", async (kind) => {
    await loaded();
    const save = openCase("مسودة المالك السابق");
    const pending = deferred<Reply>(); writeResponse = pending.promise;
    click(save);
    const nextPatient = kind === "patient" ? 92 : 91;
    if (kind === "authority") authority.session = { username: "doctor-two", role: "doctor", permissions: null };
    props = { ...props, patientId: nextPatient, focus: { ...focus, patientId: nextPatient } };
    caseResponse = response(payload(nextPatient, "حالة السياق الجديد"));
    await loaded();
    click(save);
    expect(guard?.()).toBe(false);
    expect(titleDraft()).toBeUndefined();
    const reads = caseReads().length;
    pending.resolve(response({ ok: true })); await settle();
    expect(caseReads()).toHaveLength(reads);
    expect(view().text).toContain("حالة السياق الجديد");
    expect(titleDraft()).toBeUndefined();
    expect(guard?.()).toBe(kind === "patient");
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-write-uncertain")).toBe(kind === "authority");
    expect(writes()).toHaveLength(1);
  });

  it("preserves an independent same-context draft when a successful sibling write refreshes the projection", async () => {
    await loaded();
    click(button("+ مشكلة"));
    change(input("aria-label", "المشكلة"), "مسودة مشكلة محفوظة محليًا");
    const save = openCase();
    writeResponse = response(caseRow(91, 19, "حالة جديدة"), 201);
    caseResponse = response(payload(91, "حالة بعد التحديث"));
    click(save); await settle();
    expect(view().text).toContain("حالة بعد التحديث");
    expect(titleDraft()).toBeUndefined();
    expect(problemDraft()).toBe("مسودة مشكلة محفوظة محليًا");
    expect(guard?.()).toBe(false);
    expect(writes()).toHaveLength(1);
  });

  it("refuses stale writes during and after a failed refresh while leaving idle cancellation usable", async () => {
    await loaded();
    const savedHandler = openCase();
    const pending = deferred<Reply>(); caseResponse = pending.promise;
    click(button("تحديث السجل", true));
    view();
    click(savedHandler); click(button("حفظ الحالة"));
    expect(writes()).toHaveLength(0);
    expect(selected()).toEqual([]);
    pending.resolve(response({ message: "فشل قراءة مؤقت" }, 503)); await settle();
    click(savedHandler); click(button("حفظ الحالة"));
    expect(writes()).toHaveLength(0);
    expect(titleDraft()).toBe("مسودة الحالة");
    click(button("إلغاء", true));
    expect(titleDraft()).toBeUndefined();
    expect(guard?.()).toBe(true);
    caseResponse = response(payload());
    click(button("إعادة المحاولة", true));
    await loaded();
    click(openCase("بعد قراءة جديدة")); await settle();
    expect(writes()).toHaveLength(1);
  });

  it("recovers a failed post-save read using the real retry control without losing a sibling draft", async () => {
    await loaded();
    click(button("+ مشكلة"));
    change(input("aria-label", "المشكلة"), "مشكلة تنتظر حفظًا مستقلًا");
    const save = openCase();
    writeResponse = response(caseRow(91, 19, "حالة مؤكدة"), 201);
    caseResponse = response({ message: "قراءة السجل غير متاحة مؤقتًا" }, 503);
    click(save); await settle();
    expect(titleDraft()).toBeUndefined();
    expect(problemDraft()).toBe("مشكلة تنتظر حفظًا مستقلًا");
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-write-uncertain")).toBe(false);
    click(button("حفظ", true));
    expect(writes()).toHaveLength(1);
    caseResponse = response(payload());
    click(button("إعادة المحاولة", true)); await settle();
    expect(problemDraft()).toBe("مشكلة تنتظر حفظًا مستقلًا");
    writeResponse = response({ id: 21, patientId: 91, label: "مشكلة تنتظر حفظًا مستقلًا" }, 201);
    click(button("حفظ", true)); await settle();
    expect(writes()).toHaveLength(2);
    expect(problemDraft()).toBeUndefined();
  });

  it.each(["case", "problem", "dependency"])("contains a possible 500-after-commit for %s creation across cancel/reopen", async (kind) => {
    if (kind === "dependency") {
      caseResponse = response({ ...payload(), items: [101, 102].map((id) => ({ id, planId: 20, planTitle: "خطة قائمة", serviceName: `خدمة ${id}`, category: "rct", toothCode: 36, status: "planned", doctorName: "طبيب", caseId: 17, priority: 1, sortOrder: id })) });
    }
    await loaded();
    const open = () => {
      if (kind === "case") return openCase();
      if (kind === "problem") {
        click(button("+ مشكلة")); change(input("aria-label", "المشكلة"), "مشكلة قد تكون حُفظت");
        return button("حفظ", true);
      }
      click(button("+ يتطلب")); change(input("aria-label", "البند المطلوب قبله"), "102");
      return button("حفظ", true);
    };
    const save = open();
    const json = vi.fn(async () => ({ message: "تعذّر الحفظ. أعد المحاولة." }));
    writeResponse = { ok: false, status: 500, json };
    click(save); await settle();
    expect(json).not.toHaveBeenCalled();
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-write-uncertain")).toBe(true);
    expect(view().text).toContain("لا يستمر بعد إعادة تحميل الصفحة");
    click(save);
    click(button("إلغاء", true));
    click(open()); await settle();
    expect(writes()).toHaveLength(1);
    expect(button("راجعت السجل، بدء طلب جديد", true).props.disabled).toBe(true);
    click(button("راجعت السجل، بدء طلب جديد", true));
    expect(confirm).not.toHaveBeenCalled();
    click(button("تحديث السجل للمراجعة", true)); await settle();
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-write-uncertain")).toBe(true);
    click(button(kind === "case" ? "حفظ الحالة" : "حفظ", true));
    expect(writes()).toHaveLength(1);
    confirm.mockReturnValue(true);
    click(button("راجعت السجل، بدء طلب جديد", true));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("قد ينشئ سجلًا مكررًا"));
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-write-uncertain")).toBe(false);
    expect(writes()).toHaveLength(1); // Acknowledging intent itself never sends.
    click(open()); await settle();
    expect(writes()).toHaveLength(2);
  });

  it.each(["transport", "malformed body", "wrong success shape"])("keeps an uncertain-attempt latch after %s instead of allowing an accidental repeat", async (kind) => {
    await loaded();
    const save = openCase();
    if (kind === "transport") fetchMock.mockImplementationOnce(async () => { throw new TypeError("connection lost after dispatch"); });
    else if (kind === "malformed body") writeResponse = { ok: true, status: 201, json: async () => { throw new SyntaxError("truncated JSON"); } };
    else writeResponse = response({ ok: true }, 201); // Create routes return the actual owned record.
    click(save); await settle();
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-write-uncertain")).toBe(true);
    expect(titleDraft()).toBe("مسودة الحالة");
    click(button("إلغاء", true));
    click(openCase("طلب يبدو جديدًا")); await settle();
    expect(writes()).toHaveLength(1);
    expect(view().text).not.toContain("لن يُسجَّل");
  });

  it("keeps the pending lock through a delayed success body, then retains uncertainty after malformed settlement", async () => {
    await loaded();
    const save = openCase();
    const cancel = button("إلغاء", true);
    const body = deferred<unknown>();
    writeResponse = { ok: true, status: 201, json: () => body.promise };
    click(save); await settle();
    click(save); click(cancel);
    expect(guard?.()).toBe(false);
    expect(titleDraft()).toBe("مسودة الحالة");
    expect(writes()).toHaveLength(1);
    body.resolve(null); await settle();
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-write-uncertain")).toBe(true);
    click(button("إلغاء", true));
    click(openCase()); await settle();
    expect(writes()).toHaveLength(1);
  });

  it("requires a successful canonical review and a current explicit acknowledgment, without inferring success from matching rows", async () => {
    await loaded();
    const oldSave = openCase("نفس عنوان الحالة");
    writeResponse = response({ message: "unknown" }, 500);
    click(oldSave); await settle();
    const oldAcknowledge = button("راجعت السجل، بدء طلب جديد", true);
    confirm.mockReturnValue(true);
    caseResponse = response({ message: "review failed" }, 503);
    click(button("تحديث السجل للمراجعة", true)); await settle();
    click(oldAcknowledge); click(button("راجعت السجل، بدء طلب جديد", true));
    expect(confirm).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
    caseResponse = response({ ...payload(), cases: [caseRow(91, 99, "نفس عنوان الحالة"), caseRow()] });
    click(button("تحديث السجل للمراجعة", true)); await settle();
    expect(view().text).toContain("نفس عنوان الحالة");
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-write-uncertain")).toBe(true);
    click(oldSave); click(oldAcknowledge);
    expect(writes()).toHaveLength(1);
    expect(confirm).not.toHaveBeenCalled();
    click(button("راجعت السجل، بدء طلب جديد", true));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(titleDraft()).toBeUndefined();
    click(oldSave);
    expect(writes()).toHaveLength(1);
    writeResponse = response(caseRow(91, 100, "طلب مستقل"), 201);
    click(openCase("طلب مستقل")); await settle();
    expect(writes()).toHaveLength(2);
  });

  it("allows a separately clicked retry after a definitive 400 rejection without labeling it uncertain", async () => {
    await loaded();
    writeResponse = response({ message: "رفض قبل الحفظ" }, 400);
    click(openCase()); await settle();
    expect(titleDraft()).toBe("مسودة الحالة");
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-write-uncertain")).toBe(false);
    click(button("حفظ الحالة", true)); await settle();
    expect(writes()).toHaveLength(2);
  });

  it("keeps generic late-write uncertainty after a same-patient authority switch without restoring old data", async () => {
    await loaded();
    const pending = deferred<Reply>(); writeResponse = pending.promise;
    click(openCase("مسودة سريرية للمالك السابق"));
    authority.session = { username: "doctor-two", role: "doctor", permissions: null };
    caseResponse = response(payload(91, "سجل بالصلاحية الحالية"));
    await loaded();
    const json = vi.fn(async () => ({ message: "تفاصيل استجابة قديمة" }));
    pending.resolve({ ok: false, status: 500, json }); await settle();
    expect(json).not.toHaveBeenCalled();
    expect(view().text).toContain("سجل بالصلاحية الحالية");
    expect(view().text).not.toContain("تفاصيل استجابة قديمة");
    expect(titleDraft()).toBeUndefined();
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-write-uncertain")).toBe(true);
    click(openCase("محاولة تحت الصلاحية الحالية"));
    expect(writes()).toHaveLength(1);
    expect(button("راجعت السجل، بدء طلب جديد", true).props.disabled).toBe(true);
    click(button("تحديث السجل للمراجعة", true)); await settle();
    confirm.mockReturnValue(true);
    click(button("راجعت السجل، بدء طلب جديد", true));
    expect(titleDraft()).toBeUndefined();
    writeResponse = response(caseRow(91, 99, "طلب مستقل مؤكد"), 201);
    click(openCase("طلب مستقل مؤكد")); await settle();
    expect(writes()).toHaveLength(2);
  });

  it("stores a late unknown result for its original patient and retains it when returning to that patient", async () => {
    await loaded();
    const pending = deferred<Reply>(); writeResponse = pending.promise;
    click(openCase("طلب المريض الأول"));
    props = { ...props, patientId: 92, focus: { ...focus, patientId: 92 } };
    caseResponse = response(payload(92, "سجل المريض الثاني"));
    await loaded();
    pending.resolve(response({ message: "unknown original patient result" }, 500)); await settle();
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-write-uncertain")).toBe(false);
    expect(view().text).toContain("سجل المريض الثاني");
    expect(guard?.()).toBe(true);
    writeResponse = response(caseRow(92, 22, "حالة المريض الثاني"), 201);
    click(openCase("حالة المريض الثاني")); await settle();
    expect(writes()).toHaveLength(2);
    props = { ...props, patientId: 91, focus };
    caseResponse = response(payload(91, "قراءة جديدة للمريض الأول"));
    await loaded();
    expect(view().text).toContain("قراءة جديدة للمريض الأول");
    expect(titleDraft()).toBeUndefined();
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-write-uncertain")).toBe(true);
    click(openCase("إعادة إرسال ممنوعة"));
    expect(writes()).toHaveLength(2);
    expect(button("راجعت السجل، بدء طلب جديد", true).props.disabled).toBe(true);
  });

  it("invalidates a completed uncertainty review on authority change and requires a new current-authority review", async () => {
    await loaded();
    writeResponse = response({ message: "unknown" }, 500);
    click(openCase()); await settle();
    click(button("تحديث السجل للمراجعة", true)); await settle();
    const staleAcknowledgment = button("راجعت السجل، بدء طلب جديد", true);
    expect(staleAcknowledgment.props.disabled).toBe(false);
    authority.session = { username: "doctor-two", role: "doctor", permissions: null };
    await loaded();
    confirm.mockReturnValue(true);
    click(staleAcknowledgment); click(button("راجعت السجل، بدء طلب جديد", true));
    expect(confirm).not.toHaveBeenCalled();
    expect(button("راجعت السجل، بدء طلب جديد", true).props.disabled).toBe(true);
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-write-uncertain")).toBe(true);
    click(button("تحديث السجل للمراجعة", true)); await settle();
    click(button("راجعت السجل، بدء طلب جديد", true));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(view().nodes.some((node) => node.props["data-testid"] === "case-write-uncertain")).toBe(false);
    expect(writes()).toHaveLength(1);
  });
});

function commitCaseOwnerUnmount(driver: Driver) {
  driver.layoutEffects.forEach((entry) => { entry.cleanup?.(); entry.cleanup = undefined; });
}
function finishCasePassiveUnmount(driver: Driver) {
  driver.effects.forEach((entry) => { entry.cleanup?.(); entry.cleanup = undefined; });
}

describe("case commit ownership and abandoned focus", () => {
  it("committed unmount retires a captured new write and guard before passive cleanup", async () => {
    await loaded(); const retainedSave = openCase(); const retainedGuard = guard!; const retiredState = state;
    commitCaseOwnerUnmount(retiredState);
    click(retainedSave); await settle(); expect(writes()).toHaveLength(0);
    expect(guard).toBeNull(); expect(retainedGuard()).toBe(false);
    state = newDriver(); await loaded(); const replacementGuard = guard;
    finishCasePassiveUnmount(retiredState);
    expect(guard).toBe(replacementGuard); expect(guard).not.toBeNull();
    click(openCase("مسودة المالك الجديد")); await settle(); expect(writes()).toHaveLength(1);
  });

  it("an abandoned focus-only render does not retire the committed focus readiness", async () => {
    await loaded(); const save = openCase(); const reads = caseReads().length;
    // React work-in-progress hook state/effect queues are discarded, but refs
    // are shared with the committed tree. Neither effect phase is committed.
    const abandoned: Driver = { ...state, values: [...state.values], cursor: 0,
      effects: new Map(state.effects), layoutEffects: new Map(state.layoutEffects),
      memos: new Map(state.memos), pending: [], layoutPending: [] };
    hooks.current = abandoned; PatientCases({ ...props, focus: nextFocus });
    view();
    expect(caseReads()).toHaveLength(reads);
    expect(selected()).toEqual(["17"]);
    click(save); await settle();
    expect(writes()).toHaveLength(1); expect(caseReads()).toHaveLength(reads);
  });

  it("a committed new focus fences the old write before the next passive read starts", async () => {
    await loaded(); const save = openCase(); const reads = caseReads().length;
    props = { ...props, focus: nextFocus }; hooks.current = state; state.cursor = 0;
    PatientCases(props);
    state.layoutPending.splice(0).forEach((effect) => effect());
    click(save); await settle();
    expect(writes()).toHaveLength(0); expect(caseReads()).toHaveLength(reads);
    state.pending.splice(0).forEach((effect) => effect()); await settle(); view();
    expect(selected()).toEqual(["18"]);
  });
});
