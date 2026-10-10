import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientCases } from "../components/PatientCases";
import type { SessionInfo } from "../components/SessionProvider";
import type { CasePlanItem, SpecialtyCase } from "../lib/db";

// Actual component handlers, synthetic records and controlled fetch only. The
// wrapper key is honored so a patient/authority ABA really retires the old owner.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  pending: [] as Array<() => void>,
  session: null as SessionInfo | null,
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined);
    const previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = run();
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
      const index = slot(undefined); const previous = hooks.memos.get(index);
      if (previous && same(previous.deps, deps)) return previous.value;
      const value = factory(); hooks.memos.set(index, { deps, value }); return value;
    },
    useCallback: (callback: unknown, deps?: readonly unknown[]) => {
      const index = slot(undefined); const previous = hooks.memos.get(index);
      if (previous && same(previous.deps, deps)) return previous.value;
      hooks.memos.set(index, { deps, value: callback }); return callback;
    },
    useEffect: effect,
    useLayoutEffect: effect,
  };
});

type Element = ReactElement<Record<string, unknown>>;
type Guard = () => boolean;
const ACTION = "عرض قسم التقويم للمريض";
const UNCERTAIN_WARNING = "تعذّر تأكيد نتيجة الحفظ. قد يكون الطلب نُفّذ. الكتابة متوقفة حتى إعادة تحميل السجل ومراجعته. المسودة غير المؤكدة لا تُرسل مجددًا؛ ألغها بعد المراجعة قبل بدء طلب جديد. لن يُعاد إرسال الطلب تلقائيًا.";
const REVIEW_NOTICE = "أُعيد تحميل السجل للمراجعة فقط؛ لا يعني ذلك تأكيد نتيجة الطلب السابق. المسودة غير المؤكدة لا تُرسل مجددًا؛ ألغها بعد المراجعة وأعد فتحها لبدء طلب جديد. لم يُعد إرسال أي طلب.";
const UNCERTAIN_LEAVE = "نتيجة الحفظ غير مؤكدة؛ قد يكون الطلب نُفّذ. المغادرة لا تلغي الطلب ولا تعيد إرساله، وستُترك أي مسودة غير محفوظة. هل تريد مغادرة القسم؟";
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  if (typeof element.type === "function") return elements((element.type as (props: Record<string, unknown>) => ReactNode)(element.props));
  return [element, ...elements(element.props.children as ReactNode)];
}
function contents(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(contents).join("");
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return contents((node as Element).props.children as ReactNode);
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status, redirected: false,
  headers: { get: (name: string): string | null => name.toLowerCase() === "content-type" ? "application/json" : null },
  json: async () => body,
});
type Response = ReturnType<typeof response>;
const fetchMock = vi.fn();
const confirmMock = vi.fn(() => false);
const navigate = vi.fn();
let guard: Guard | null;
const registrations: Array<{ guard: Guard; cleanup: () => void }> = [];
const registerGuard = vi.fn((next: Guard) => {
  guard = next;
  const cleanup = vi.fn(() => { if (guard === next) guard = null; });
  registrations.push({ guard: next, cleanup });
  return cleanup;
});
// The page owns tab navigation and calls the guard registered by PatientCases.
const onOpenOrtho = vi.fn(() => { if (guard?.() ?? true) navigate(); });
let props: Parameters<typeof PatientCases>[0];
let payload: unknown;
let nextRead: Promise<Response> | null;
let nextWrite: ReturnType<typeof deferred<Response>> | null;
let workspaceKey: string | null;

const row = (changes: Partial<SpecialtyCase> = {}): SpecialtyCase => ({
  id: null, kind: "ortho", orthoCaseId: 71, patientId: 91,
  specialty: "orthodontics", title: "Canonical orthodontic case", site: null, problem: null,
  responsiblePartyId: null, responsibleName: null, status: "active", startedOn: "2026-10-01",
  completedAt: null, outcome: null, itemsTotal: 0, itemsDone: 0, createdBy: "synthetic", ...changes,
});
const planItem = (id = 101): CasePlanItem => ({
  id, planId: 11, planTitle: "Synthetic plan", serviceName: `Service ${id}`, category: null,
  toothCode: null, status: "planned", doctorName: null, caseId: 5, priority: 1, sortOrder: id,
});
function validPayload(patientId = 91) {
  return {
    cases: [
      row({ patientId }),
      row({ id: 8, kind: "specialty", orthoCaseId: 72, patientId, title: "Bridged orthodontic case" }),
      row({ orthoCaseId: 73, patientId, title: "Historical orthodontic case", status: "closed" }),
      row({ id: 9, kind: "specialty", orthoCaseId: null, patientId, title: "Standalone orthodontic specialty" }),
      row({ id: 5, kind: "specialty", orthoCaseId: null, patientId, title: "Root canal case", specialty: "endodontics" }),
    ],
    problems: [], items: [planItem(), planItem(102)], dependencies: [], planVisible: true,
  };
}
function successfulMutation(url: string, options: RequestInit): Response {
  const body = options.body ? JSON.parse(String(options.body)) : {};
  if (url.endsWith("/cases") || /^\/api\/cases\/\d+$/.test(url)) {
    return response(options.method === "POST" ? 201 : 200, row({
      id: options.method === "POST" ? 25 : Number(url.split("/").at(-1)), kind: "specialty", orthoCaseId: null,
      patientId: props.patientId, specialty: "endodontics", ...body,
    }));
  }
  if (url.endsWith("/problems") || /^\/api\/problems\/\d+$/.test(url)) {
    return response(options.method === "POST" ? 201 : 200, {
      id: 51, patientId: props.patientId, label: "Synthetic problem", site: null, specialty: null,
      status: "active", caseId: null, caseTitle: null, notedBy: "synthetic", notedAt: "2026-10-05T20:00:00Z",
      resolvedBy: null, resolvedAt: null, ...body,
    });
  }
  return response(200, { ok: true });
}
function unmount() { hooks.effects.forEach((entry) => entry.cleanup?.()); }
function resetHooks() {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
}
function render() {
  let tree: ReactNode = null; let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("PatientCases did not settle");
    hooks.cursor = 0; hooks.changed = false;
    const wrapper = PatientCases(props);
    if (workspaceKey !== wrapper.key) {
      unmount(); resetHooks(); workspaceKey = wrapper.key;
    }
    tree = (wrapper.type as (p: typeof wrapper.props) => ReactNode)(wrapper.props);
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return { tree, nodes: elements(tree) };
}
async function flushMicrotasks() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
async function settle() {
  await flushMicrotasks();
  return render();
}
function control(testId: string) {
  const found = render().nodes.find((node) => node.props["data-testid"] === testId);
  if (!found) throw new Error(`Missing ${testId}`);
  return found;
}
function button(label: string, index = 0) {
  const found = render().nodes.filter((node) => node.type === "button" && contents(node.props.children as ReactNode) === label)[index];
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
function field(attribute: string, value: string) {
  const found = render().nodes.find((node) => ["input", "select", "textarea"].includes(String(node.type)) && node.props[attribute] === value);
  if (!found) throw new Error(`Missing field ${attribute}=${value}`);
  return found;
}
const clickHandler = (node: Element) => node.props.onClick as () => void | Promise<void>;
const changeHandler = (node: Element) => node.props.onChange as (event: { target: { value: string } }) => void;
const blurHandler = (node: Element) => node.props.onBlur as (event: { target: { value: string } }) => void;
const change = (node: Element, value: string) => changeHandler(node)({ target: { value } });
const writes = () => fetchMock.mock.calls.filter(([, options]) => options?.method);
const caseReads = () => fetchMock.mock.calls.filter(([url, options]) => !options?.method && url.endsWith("/cases"));
const shortcuts = () => render().nodes.filter((node) => node.type === "button" && contents(node.props.children as ReactNode) === ACTION);
async function mount() { render(); await settle(); expect(control("patient-cases")).toBeTruthy(); }
const uncertainOutcomes = ["transport", "server 500", "server 503", "empty success", "non-JSON success", "non-JSON content type", "malformed success", "redirected success"] as const;
type UncertainOutcome = typeof uncertainOutcomes[number];
function resolveUnknown(outcome: UncertainOutcome, pending = nextWrite!) {
  if (outcome === "transport") pending.reject(new TypeError("Synthetic result lost after dispatch"));
  else if (outcome === "server 500" || outcome === "server 503") pending.resolve(response(outcome === "server 500" ? 500 : 503, { message: "Synthetic server error" }));
  else if (outcome === "empty success") pending.resolve(response(200, null));
  else if (outcome === "malformed success") pending.resolve(response(200, {}));
  else if (outcome === "non-JSON success") pending.resolve({ ...response(200, null), json: async () => { throw new SyntaxError("Synthetic invalid JSON"); } });
  else if (outcome === "non-JSON content type") pending.resolve({ ...successfulMutation(writes()[0][0], writes()[0][1]), headers: { get: () => "text/html" } });
  else pending.resolve({ ...successfulMutation(writes()[0][0], writes()[0][1]), redirected: true });
}
async function prepareAmbiguousWrite(kind: "POST" | "PUT") {
  await mount();
  const shortcut = clickHandler(control("cases-open-ortho-71"));
  const priority = field("aria-label", "أولوية Service 101");
  const newProblem = clickHandler(button("+ مشكلة"));
  let attempt: () => void | Promise<void>;
  if (kind === "POST") {
    clickHandler(button("+ حالة جديدة"))();
    change(field("placeholder", "علاج عصب — سن ٣٦"), "Ambiguous case draft");
    attempt = clickHandler(button("حفظ الحالة"));
  } else {
    change(priority, "7"); attempt = () => blurHandler(priority)({ target: { value: "7" } });
  }
  return { shortcut, priority, newProblem, attempt };
}

beforeEach(() => {
  resetHooks(); workspaceKey = null; guard = null; registrations.length = 0;
  hooks.session = { username: "synthetic-a", role: "doctor", permissions: null };
  vi.clearAllMocks(); confirmMock.mockReturnValue(false);
  props = { patientId: 91, canWrite: true, onOpenOrtho, onNavigationGuardChange: registerGuard };
  payload = validPayload(); nextRead = null; nextWrite = null;
  vi.stubGlobal("window", { confirm: confirmMock });
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (options?.method) return nextWrite ? nextWrite.promise : successfulMutation(url, options);
    if (url === "/api/parties?kind=doctor") return response(200, []);
    if (url.endsWith("/cases")) {
      if (nextRead) { const pending = nextRead; nextRead = null; return pending; }
      return response(200, payload);
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe("PatientCases orthodontic navigation containment", () => {
  it("offers the exact patient-level action only on canonical, bridged and historical linked rows", async () => {
    await mount();
    expect(shortcuts().map((node) => node.props["data-testid"])).toEqual([
      "cases-open-ortho-71", "cases-open-ortho-72", "cases-open-ortho-73",
    ]);
    for (const shortcut of shortcuts()) {
      expect(contents(shortcut.props.children as ReactNode)).toBe(ACTION);
      expect(shortcut.props.disabled).toBe(false);
      await clickHandler(shortcut)();
    }
    expect(onOpenOrtho).toHaveBeenCalledTimes(3);
    expect(onOpenOrtho.mock.calls).toEqual([
      [{ patientId: 91, orthoCaseId: 71, pillar: "wires" }],
      [{ patientId: 91, clinicalCaseId: 8, orthoCaseId: 72, pillar: "wires" }],
      [{ patientId: 91, orthoCaseId: 73, pillar: "wires" }],
    ]);
    expect(navigate).toHaveBeenCalledTimes(3); expect(confirmMock).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
    expect(contents(render().tree)).toContain("Standalone orthodontic specialty");
    const standalone = render().nodes.find((node) => node.type === "li" && contents(node.props.children as ReactNode).includes("Standalone orthodontic specialty"))!;
    expect(elements(standalone).some((node) => node.props["data-testid"])).toBe(false);
  });

  it.each(["completed", "closed"] as const)("keeps historical %s cases navigable for both canonical and bridged rows", async (status) => {
    payload = { ...validPayload(), cases: [row({ status }), row({ id: 8, kind: "specialty", orthoCaseId: 72, status })] };
    await mount(); expect(shortcuts()).toHaveLength(2);
    for (const shortcut of shortcuts()) await clickHandler(shortcut)();
    expect(navigate).toHaveBeenCalledTimes(2); expect(writes()).toHaveLength(0);
  });

  it("supports both optional callbacks being absent without offering a dead shortcut", async () => {
    props = { patientId: 91, canWrite: false };
    await mount(); expect(shortcuts()).toHaveLength(0);
    expect(registerGuard).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
    expect(contents(render().tree)).toContain("Canonical orthodontic case");
  });

  it("supports navigation without a guard registrar and a guard registrar without navigation", async () => {
    props = { ...props, onNavigationGuardChange: undefined };
    await mount(); await clickHandler(control("cases-open-ortho-71"))();
    expect(navigate).toHaveBeenCalledOnce(); expect(registerGuard).not.toHaveBeenCalled();
    props = { ...props, onOpenOrtho: undefined, onNavigationGuardChange: registerGuard };
    render(); expect(shortcuts()).toHaveLength(0); expect(guard!()).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("registers and cleans up the exact guard identity without clearing a newer registration", async () => {
    await mount(); const old = registrations[0];
    expect(old.guard()).toBe(true); expect(registerGuard).toHaveBeenCalledTimes(1);
    props = { ...props, onNavigationGuardChange: (next) => registerGuard(next) };
    render(); expect(registrations).toHaveLength(2);
    expect(old.cleanup).toHaveBeenCalledOnce();
    expect(guard).toBe(registrations[1].guard);
    // A same-owner effect replacement can keep the same guard; ABA below checks
    // delayed cleanup across distinct owner identities.
    expect(registerGuard.mock.calls.every(([value]) => typeof value === "function")).toBe(true);
    unmount(); expect(guard).toBeNull(); expect(old.guard()).toBe(false);
  });

  it.each([
    ["foreign patient", { patientId: 92 }],
    ["string patient", { patientId: "91" }],
    ["canonical row with a specialty id", { id: 8 }],
    ["missing orthodontic id", { orthoCaseId: null }],
    ["zero orthodontic id", { orthoCaseId: 0 }],
    ["negative orthodontic id", { orthoCaseId: -1 }],
    ["fractional orthodontic id", { orthoCaseId: 1.5 }],
    ["unsafe orthodontic id", { orthoCaseId: Number.MAX_SAFE_INTEGER + 1 }],
    ["string orthodontic id", { orthoCaseId: "71" }],
    ["undefined orthodontic id", { orthoCaseId: undefined }],
    ["unknown row kind", { kind: "other" }],
    ["canonical row with the wrong specialty", { specialty: "endodontics" }],
    ["bridge with the wrong specialty", { kind: "specialty", id: 8, specialty: "endodontics" }],
    ["non-text title", { title: { label: "Malformed title" } }],
    ["unknown case status", { status: "unknown" }],
    ["linked row with a noncanonical waiting status", { status: "waiting" }],
    ["linked row with a noncanonical cancelled status", { status: "cancelled" }],
    ["bridge without a specialty id", { kind: "specialty", id: null }],
    ["bridge with zero specialty id", { kind: "specialty", id: 0 }],
    ["bridge with unsafe specialty id", { kind: "specialty", id: Number.MAX_SAFE_INTEGER + 1 }],
    ["bridge with string specialty id", { kind: "specialty", id: "8" }],
  ] satisfies Array<[string, Record<string, unknown>]>)("rejects the whole payload for a %s, including otherwise valid navigation rows", async (_name, malformed) => {
    payload = { ...validPayload(), cases: [row(), { ...row({ orthoCaseId: 74 }), ...malformed }] };
    render(); const ui = await settle();
    expect(ui.nodes.some((node) => node.props["data-testid"] === "patient-cases")).toBe(false);
    expect(ui.nodes.some((node) => node.props.role === "alert")).toBe(true);
    expect(shortcuts()).toHaveLength(0); expect(onOpenOrtho).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  });

  it.each(["cases", "problems", "items", "dependencies"])("rejects a malformed %s collection without publishing any case actions", async (collection) => {
    payload = { ...validPayload(), [collection]: null };
    render(); await settle();
    expect(shortcuts()).toHaveLength(0);
    expect(render().nodes.some((node) => node.props.role === "alert")).toBe(true);
    expect(contents(render().tree)).not.toContain("Canonical orthodontic case");
  });

  it("rejects null case rows instead of exposing the valid subset", async () => {
    payload = { ...validPayload(), cases: [row(), null] };
    render(); await settle(); expect(shortcuts()).toHaveLength(0);
    expect(render().nodes.some((node) => node.props.role === "alert")).toBe(true);
  });

  it.each(["reception", "assistant"])("allows read-only %s navigation without mutation or doctor lookup", async (role) => {
    hooks.session = { username: `synthetic-${role}`, role, permissions: null };
    props = { ...props, canWrite: false }; await mount();
    expect(shortcuts()).toHaveLength(3); await clickHandler(control("cases-open-ortho-71"))();
    expect(navigate).toHaveBeenCalledOnce(); expect(writes()).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/parties?kind=doctor")).toBe(false);
    expect(render().nodes.filter((node) => node.type === "button").map((node) => contents(node.props.children as ReactNode))).toEqual([ACTION, ACTION, ACTION]);
  });

  it("does not confuse denied plan visibility with denied linked-case navigation", async () => {
    hooks.session = { ...hooks.session!, permissions: { canViewPlans: false } as NonNullable<SessionInfo["permissions"]> };
    payload = { ...validPayload(), items: [], dependencies: [], planVisible: false };
    await mount(); expect(contents(render().tree)).toContain("عرض خطط العلاج غير مفعّل لحسابك.");
    expect(shortcuts()).toHaveLength(3); await clickHandler(control("cases-open-ortho-72"))();
    expect(navigate).toHaveBeenCalledOnce(); expect(writes()).toHaveLength(0);
    expect(render().nodes.some((node) => String(node.props["aria-label"] ?? "").startsWith("أولوية "))).toBe(false);
  });

  it.each([null, { username: " ", role: "doctor" }, { username: "synthetic", role: "unknown" }])("does not fetch or navigate without a readable session: %j", async (session) => {
    hooks.session = session; props = { ...props, canWrite: false };
    render(); await settle(); expect(caseReads()).toHaveLength(0); expect(shortcuts()).toHaveLength(0);
    expect(contents(render().tree)).toContain("غير مصرّح لك بعرض حالات هذا المريض.");
  });

  const drafts = [
    { name: "case", open: "+ حالة جديدة", attribute: "placeholder", field: "علاج عصب — سن ٣٦", value: "Unsaved case title", dismiss: "إلغاء" },
    { name: "problem", open: "+ مشكلة", attribute: "aria-label", field: "المشكلة", value: "Unsaved problem", dismiss: "إلغاء" },
    { name: "closing", open: "اكتملت", attribute: "placeholder", field: "النتيجة (اختياري)", value: "Unsaved outcome", dismiss: "رجوع" },
    { name: "dependency", open: "+ يتطلب", attribute: "aria-label", field: "البند المطلوب قبله", value: "102", dismiss: "إلغاء" },
  ];
  it.each(drafts)("guards the $name draft synchronously and retains it when navigation is cancelled", async (draft) => {
    await mount(); const shortcut = clickHandler(control("cases-open-ortho-71"));
    clickHandler(button(draft.open))();
    // No render between opening the form and consulting the retained guard.
    expect(guard!()).toBe(false); expect(confirmMock).toHaveBeenCalledOnce();
    change(field(draft.attribute, draft.field), draft.value); confirmMock.mockClear();
    await shortcut(); expect(navigate).not.toHaveBeenCalled(); expect(confirmMock).toHaveBeenCalledOnce();
    expect(field(draft.attribute, draft.field).props.value).toBe(draft.value);
    expect(guard!()).toBe(false); expect(field(draft.attribute, draft.field).props.value).toBe(draft.value);
    expect(writes()).toHaveLength(0);
    confirmMock.mockReturnValue(true); await shortcut(); expect(navigate).toHaveBeenCalledOnce();
    expect(field(draft.attribute, draft.field).props.value).toBe(draft.value);
    clickHandler(button(draft.dismiss))(); confirmMock.mockClear();
    expect(guard!()).toBe(true); expect(confirmMock).not.toHaveBeenCalled();
  });

  it.each(drafts)("does not let retained $name editors or dismissals replace or revive a newer draft", async (draft) => {
    await mount(); clickHandler(button(draft.open))();
    const oldField = field(draft.attribute, draft.field);
    change(oldField, draft.value);
    const oldDismiss = clickHandler(button(draft.dismiss));
    const intermediateField = field(draft.attribute, draft.field);
    const latest = draft.name === "dependency" ? "" : `${draft.value} updated`;
    change(intermediateField, latest);
    change(oldField, "stale edit"); oldDismiss();
    expect(field(draft.attribute, draft.field).props.value).toBe(latest);
    expect(guard!()).toBe(false); expect(writes()).toHaveLength(0);
    clickHandler(button(draft.dismiss))(); confirmMock.mockClear();
    change(intermediateField, "revived stale edit"); oldDismiss();
    expect(guard!()).toBe(true); expect(confirmMock).not.toHaveBeenCalled();
    clickHandler(button(draft.open))(); change(intermediateField, "old editor over new draft");
    expect(field(draft.attribute, draft.field).props.value).toBe("");
    expect(writes()).toHaveLength(0);
  });

  it.each(drafts)("rejects an ordinary retained $name save after Cancel and reopen without another read", async (draft) => {
    await mount(); clickHandler(button(draft.open))(); change(field(draft.attribute, draft.field), draft.value);
    const saveLabel = draft.name === "case" ? "حفظ الحالة" : draft.name === "closing" ? "تأكيد: اكتملت" : "حفظ";
    const retiredSave = clickHandler(button(saveLabel)); const reads = caseReads().length;
    clickHandler(button(draft.dismiss))();
    await retiredSave(); expect(writes()).toHaveLength(0); expect(caseReads()).toHaveLength(reads);
    clickHandler(button(draft.open))();
    await retiredSave(); expect(writes()).toHaveLength(0); expect(field(draft.attribute, draft.field).props.value).toBe("");
    const freshValue = draft.name === "dependency" ? draft.value : `${draft.value} renewed`;
    change(field(draft.attribute, draft.field), freshValue);
    await retiredSave();
    expect(writes()).toHaveLength(0); expect(caseReads()).toHaveLength(reads);
    expect(field(draft.attribute, draft.field).props.value).toBe(freshValue);
    // The current form still owns a usable explicit submit; rejecting the old
    // callback must not merely leave the workspace permanently busy or inert.
    await clickHandler(button(saveLabel))(); await settle();
    expect(writes()).toHaveLength(1); expect(caseReads()).toHaveLength(reads + 1);
    const bodyField = draft.name === "case" ? "title" : draft.name === "problem" ? "label" : draft.name === "closing" ? "outcome" : "requiresItemId";
    expect(JSON.parse(String(writes()[0][1].body))[bodyField]).toBe(freshValue);
    expect(render().nodes.some((node) => ["input", "textarea", "select"].includes(String(node.type)) && node.props[draft.attribute] === draft.field)).toBe(false);
  });

  it("tracks priority onChange before render and clears only when restored to the saved value", async () => {
    await mount(); const priority = field("aria-label", "أولوية Service 101");
    const shortcut = clickHandler(control("cases-open-ortho-71"));
    change(priority, " 9 "); expect(guard!()).toBe(false); await shortcut();
    expect(navigate).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
    change(priority, " 1 "); confirmMock.mockClear();
    expect(guard!()).toBe(true); expect(confirmMock).not.toHaveBeenCalled();
    await shortcut(); expect(navigate).toHaveBeenCalledOnce(); expect(writes()).toHaveLength(0);
  });

  it.each(["success", "http rejection", "network rejection"])("latches a priority blur write before render with no duplicate or queued navigation: %s", async (outcome) => {
    await mount(); const priority = field("aria-label", "أولوية Service 101");
    const shortcut = clickHandler(control("cases-open-ortho-71")); const registered = guard!;
    nextWrite = deferred<Response>();
    change(priority, "7"); blurHandler(priority)({ target: { value: "7" } });
    blurHandler(priority)({ target: { value: "7" } });
    change(priority, "99"); confirmMock.mockClear(); confirmMock.mockReturnValue(true);
    // All four checks happen before rendering the disabled button state.
    await shortcut(); expect(registered()).toBe(false); await shortcut(); expect(registered()).toBe(false);
    expect(onOpenOrtho).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled(); expect(confirmMock).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe("/api/plan-items/101/case");
    expect(writes()[0][1].method).toBe("PUT");
    expect(JSON.parse(String(writes()[0][1].body))).toEqual({ caseId: 5, priority: "7" });
    expect(control("cases-open-ortho-71").props.disabled).toBe(true);
    if (outcome === "success") {
      payload = { ...validPayload(), items: [{ ...planItem(), priority: 7 }, planItem(102)] };
      nextWrite.resolve(response(200, { ok: true }));
    } else if (outcome === "http rejection") nextWrite.resolve(response(409, { message: "Synthetic priority conflict" }));
    else nextWrite.reject(new TypeError("Synthetic connection loss"));
    await settle();
    expect(writes()).toHaveLength(1); expect(navigate).not.toHaveBeenCalled(); expect(onOpenOrtho).not.toHaveBeenCalled();
    confirmMock.mockClear(); confirmMock.mockReturnValue(false);
    if (outcome === "success") {
      expect(registered()).toBe(true); expect(confirmMock).not.toHaveBeenCalled();
      expect(field("aria-label", "أولوية Service 101").props.defaultValue).toBe(7);
    } else if (outcome === "http rejection") {
      expect(registered()).toBe(false); expect(confirmMock).toHaveBeenCalledOnce();
      expect(render().nodes.some((node) => node.props.role === "alert")).toBe(true);
      await clickHandler(control("cases-open-ortho-71"))(); expect(navigate).not.toHaveBeenCalled();
      expect(confirmMock).toHaveBeenCalledTimes(2);
    } else {
      expect(registered()).toBe(false); expect(confirmMock).toHaveBeenCalledOnce();
      expect(confirmMock).toHaveBeenLastCalledWith(UNCERTAIN_LEAVE);
      expect(contents(render().tree)).toContain(UNCERTAIN_WARNING);
      expect(shortcuts()).toHaveLength(0);
      await shortcut(); expect(onOpenOrtho).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
      expect(confirmMock).toHaveBeenCalledOnce();
      expect(button("إعادة تحميل الحالات للمراجعة")).toBeTruthy(); expect(caseReads()).toHaveLength(1);
    }
    expect(writes()).toHaveLength(1);
  });

  it.each((["POST", "PUT"] as const).flatMap((method) => uncertainOutcomes.map((outcome) => ({ method, outcome }))))(
    "fences $method replay after $outcome until explicit review and a fresh permitted decision", async ({ method, outcome }) => {
      const { shortcut, priority, newProblem, attempt } = await prepareAmbiguousWrite(method);
      const retainedGuard = guard!; nextWrite = deferred<Response>();
      const writing = attempt(); expect(writes()).toHaveLength(1);
      expect(writes()[0][1].method).toBe(method);
      resolveUnknown(outcome); await writing; await flushMicrotasks(); nextWrite = null;
      // The uncertain flag must be set synchronously before any subsequent render.
      await attempt(); change(priority, "99"); blurHandler(priority)({ target: { value: "99" } }); newProblem();
      await shortcut(); expect(writes()).toHaveLength(1); expect(caseReads()).toHaveLength(1);
      expect(onOpenOrtho).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
      expect(retainedGuard()).toBe(false); expect(confirmMock).toHaveBeenLastCalledWith(UNCERTAIN_LEAVE);
      expect(contents(render().tree)).toContain(UNCERTAIN_WARNING); expect(shortcuts()).toHaveLength(0);
      expect(render().nodes.some((node) => node.props["aria-label"] === "المشكلة")).toBe(false);
      if (method === "POST") expect(field("placeholder", "علاج عصب — سن ٣٦").props.value).toBe("Ambiguous case draft");
      // A matching server row is evidence for review, never proof that identifies
      // the ambiguous request or permission to clear/resubmit its draft.
      payload = { ...validPayload(),
        cases: [...validPayload().cases, row({ id: 25, kind: "specialty", orthoCaseId: null, specialty: "endodontics", title: "Ambiguous case draft" })],
        items: [{ ...planItem(), priority: 7 }, planItem(102)],
      };
      await clickHandler(button("إعادة تحميل الحالات للمراجعة"))(); await settle();
      expect(caseReads()).toHaveLength(2); expect(shortcuts()).toHaveLength(3);
      expect(contents(render().tree)).toContain(REVIEW_NOTICE); expect(writes()).toHaveLength(1);
      await attempt(); await shortcut(); newProblem();
      if (method === "POST") {
        expect(field("placeholder", "علاج عصب — سن ٣٦").props.value).toBe("Ambiguous case draft");
        await clickHandler(button("حفظ الحالة"))();
        change(field("placeholder", "علاج عصب — سن ٣٦"), "Disallowed new edit");
        expect(field("placeholder", "علاج عصب — سن ٣٦").props.value).toBe("Ambiguous case draft");
      }
      await flushMicrotasks(); expect(writes()).toHaveLength(1);
      expect(render().nodes.some((node) => node.props["aria-label"] === "المشكلة")).toBe(false);
      confirmMock.mockClear(); confirmMock.mockReturnValue(false);
      await clickHandler(control("cases-open-ortho-71"))();
      expect(confirmMock).toHaveBeenCalledOnce(); expect(confirmMock).toHaveBeenLastCalledWith(UNCERTAIN_LEAVE); expect(navigate).not.toHaveBeenCalled();
      confirmMock.mockReturnValue(true); await clickHandler(control("cases-open-ortho-71"))();
      expect(navigate).toHaveBeenCalledOnce(); expect(writes()).toHaveLength(1); expect(caseReads()).toHaveLength(2);
      if (method === "PUT") {
        const freshPriority = field("aria-label", "أولوية Service 101");
        change(freshPriority, "8"); blurHandler(freshPriority)({ target: { value: "8" } });
        await settle(); expect(writes()).toHaveLength(2);
        expect(JSON.parse(String(writes()[1][1].body))).toEqual({ caseId: 5, priority: "8" });
      }
    },
  );

  it.each([1, 7])("requires an actual post-review priority edit, not a fresh blur of retained DOM text (server=%i)", async serverPriority => {
    const { attempt, priority: oldPriority } = await prepareAmbiguousWrite("PUT");
    nextWrite = deferred<Response>(); attempt(); resolveUnknown("server 500");
    await settle(); nextWrite = null;
    payload = { ...validPayload(), items: [{ ...planItem(), priority: serverPriority }, planItem(102)] };
    await clickHandler(button("إعادة تحميل الحالات للمراجعة"))(); await settle();
    const current = field("aria-label", "أولوية Service 101");
    expect(current.props.defaultValue).toBe(serverPriority);
    // React may retain dirty DOM value 7 even when defaultValue is now 1.
    blurHandler(current)({ target: { value: "7" } });
    blurHandler(current)({ target: { value: "7" } });
    change(oldPriority, "99"); blurHandler(oldPriority)({ target: { value: "99" } });
    await settle(); expect(writes()).toHaveLength(1); expect(caseReads()).toHaveLength(2);
    change(current, "8"); blurHandler(current)({ target: { value: "8" } });
    await settle(); expect(writes()).toHaveLength(2);
    expect(JSON.parse(String(writes()[1][1].body))).toEqual({ caseId: 5, priority: "8" });
  });

  it.each((["POST", "PUT"] as const).flatMap((method) => ["server error", "malformed payload", "transport"].map((readFailure) => ({ method, readFailure }))))(
    "keeps the $method uncertainty fence through a $readFailure review failure and later canonical recovery", async ({ method, readFailure }) => {
      const { attempt, shortcut, priority } = await prepareAmbiguousWrite(method);
      nextWrite = deferred<Response>(); const writing = attempt(); resolveUnknown("transport");
      await writing; await flushMicrotasks(); nextWrite = null;
      const review = deferred<Response>(); nextRead = review.promise;
      await clickHandler(button("إعادة تحميل الحالات للمراجعة"))();
      if (readFailure === "transport") review.reject(new TypeError("Synthetic review connection loss"));
      else if (readFailure === "server error") review.resolve(response(503, { message: "Review unavailable" }));
      else review.resolve(response(200, { ...validPayload(), cases: [row({ patientId: 92 })] }));
      await settle(); expect(caseReads()).toHaveLength(2); expect(shortcuts()).toHaveLength(0);
      await attempt(); change(priority, "9"); blurHandler(priority)({ target: { value: "9" } }); await shortcut();
      expect(writes()).toHaveLength(1); expect(guard!()).toBe(false);
      expect(confirmMock).toHaveBeenLastCalledWith(UNCERTAIN_LEAVE);
      if (method === "POST") expect(field("placeholder", "علاج عصب — سن ٣٦").props.value).toBe("Ambiguous case draft");
      await clickHandler(button("إعادة تحميل الحالات للمراجعة"))(); await settle();
      expect(caseReads()).toHaveLength(3); expect(shortcuts()).toHaveLength(3);
      await attempt();
      if (method === "POST") await clickHandler(button("حفظ الحالة"))();
      expect(writes()).toHaveLength(1); expect(guard!()).toBe(false);
      expect(confirmMock).toHaveBeenLastCalledWith(UNCERTAIN_LEAVE);
      expect(contents(render().tree)).toContain(REVIEW_NOTICE);
      if (method === "PUT") {
        const freshPriority = field("aria-label", "أولوية Service 101");
        change(freshPriority, "10"); blurHandler(freshPriority)({ target: { value: "10" } });
        await settle(); expect(writes()).toHaveLength(2);
      }
    },
  );

  it.each(drafts)("quarantines the $name draft through review until explicit cancellation and reopening", async (draft) => {
    await mount(); clickHandler(button(draft.open))(); change(field(draft.attribute, draft.field), draft.value);
    const oldField = field(draft.attribute, draft.field); const oldDismiss = clickHandler(button(draft.dismiss));
    const saveLabel = draft.name === "case" ? "حفظ الحالة" : draft.name === "closing" ? "تأكيد: اكتملت" : "حفظ";
    const oldSave = clickHandler(button(saveLabel));
    nextWrite = deferred<Response>(); const writing = oldSave(); resolveUnknown("server 500");
    await writing; await flushMicrotasks(); nextWrite = null;
    change(oldField, "Lost edit"); oldDismiss(); await oldSave();
    expect(writes()).toHaveLength(1); expect(field(draft.attribute, draft.field).props.value).toBe(draft.value);
    expect(field(draft.attribute, draft.field).props.disabled).toBe(true);
    expect(button(saveLabel).props.disabled).toBe(true); expect(button(draft.dismiss).props.disabled).toBe(true);
    await clickHandler(button("إعادة تحميل الحالات للمراجعة"))(); await settle();
    change(oldField, "Retained edit"); oldDismiss(); await oldSave();
    change(field(draft.attribute, draft.field), "Fresh edit"); await clickHandler(button(saveLabel))();
    expect(field(draft.attribute, draft.field).props.value).toBe(draft.value); expect(writes()).toHaveLength(1);
    expect(field(draft.attribute, draft.field).props.disabled).toBe(true);
    expect(button(saveLabel).props.disabled).toBe(true); expect(button(draft.dismiss).props.disabled).toBe(false);
    expect(guard!()).toBe(false); expect(confirmMock).toHaveBeenLastCalledWith(UNCERTAIN_LEAVE);
    expect(contents(render().tree)).toContain(REVIEW_NOTICE);
    const postReviewSave = clickHandler(button(saveLabel)); const reviewedReads = caseReads().length;
    // Only a current cancellation and explicit reopening constitute a new form.
    clickHandler(button(draft.dismiss))(); expect(writes()).toHaveLength(1);
    change(oldField, "Retained editor after cancellation"); oldDismiss(); await oldSave();
    await postReviewSave(); expect(writes()).toHaveLength(1); expect(caseReads()).toHaveLength(reviewedReads);
    clickHandler(button(draft.open))();
    // This callback was captured after the canonical review, so read-sequence
    // fencing alone cannot distinguish it from the newly reopened form.
    await postReviewSave(); expect(writes()).toHaveLength(1); expect(caseReads()).toHaveLength(reviewedReads);
    expect(field(draft.attribute, draft.field).props.value).toBe("");
    expect(field(draft.attribute, draft.field).props.disabled).toBe(false);
    change(field(draft.attribute, draft.field), draft.value);
    await postReviewSave(); expect(writes()).toHaveLength(1); expect(caseReads()).toHaveLength(reviewedReads);
    expect(field(draft.attribute, draft.field).props.value).toBe(draft.value);
    await clickHandler(button(saveLabel))(); await settle();
    expect(writes()).toHaveLength(2);
    expect(render().nodes.some((node) => ["input", "textarea", "select"].includes(String(node.type)) && node.props[draft.attribute] === draft.field)).toBe(false);
    expect(guard!()).toBe(false); expect(confirmMock).toHaveBeenLastCalledWith(UNCERTAIN_LEAVE);
  });

  it.each(["POST", "PUT"] as const)("keeps an ordinary known409 $method rejection retryable with its draft retained", async (method) => {
    const { attempt } = await prepareAmbiguousWrite(method);
    nextWrite = deferred<Response>(); const writing = attempt();
    nextWrite.resolve(response(409, { message: "Known synthetic conflict" }));
    await writing; await settle(); nextWrite = null;
    expect(contents(render().tree)).toContain("Known synthetic conflict");
    expect(contents(render().tree)).not.toContain(UNCERTAIN_WARNING); expect(shortcuts()).toHaveLength(3);
    expect(guard!()).toBe(false); expect(confirmMock).not.toHaveBeenLastCalledWith(UNCERTAIN_LEAVE);
    if (method === "POST") {
      expect(field("placeholder", "علاج عصب — سن ٣٦").props.value).toBe("Ambiguous case draft");
      await clickHandler(button("حفظ الحالة"))();
    } else {
      const freshPriority = field("aria-label", "أولوية Service 101");
      blurHandler(freshPriority)({ target: { value: "7" } });
    }
    await settle(); expect(writes()).toHaveLength(2); expect(caseReads()).toHaveLength(2);
    expect(contents(render().tree)).not.toContain(UNCERTAIN_WARNING);
    if (method === "POST") expect(render().nodes.some((node) => node.props.placeholder === "علاج عصب — سن ٣٦")).toBe(false);
  });

  it.each(["foreign patient", "missing id", "unsafe id"])("treats a %s case success body as an unknown outcome rather than retry authorization", async (malformed) => {
    const { attempt } = await prepareAmbiguousWrite("POST"); nextWrite = deferred<Response>();
    const writing = attempt();
    nextWrite.resolve(response(201, row({ id: malformed === "missing id" ? null : malformed === "unsafe id" ? Number.MAX_SAFE_INTEGER + 1 : 25,
      kind: "specialty", orthoCaseId: null, patientId: malformed === "foreign patient" ? 92 : 91 })));
    await writing; await flushMicrotasks(); nextWrite = null;
    await attempt(); expect(writes()).toHaveLength(1); expect(caseReads()).toHaveLength(1);
    expect(shortcuts()).toHaveLength(0); expect(contents(render().tree)).toContain(UNCERTAIN_WARNING);
  });

  it("rejects a captured shortcut from a prior read while allowing the freshly read row", async () => {
    await mount(); const oldShortcut = clickHandler(control("cases-open-ortho-71"));
    const priority = field("aria-label", "أولوية Service 101");
    const oldSend = clickHandler(button("بانتظار"));
    payload = { ...validPayload(), items: [{ ...planItem(), priority: 4 }, planItem(102)] };
    change(priority, "4"); blurHandler(priority)({ target: { value: "4" } }); await settle();
    expect(caseReads()).toHaveLength(2); await oldShortcut();
    await oldSend(); change(priority, "99"); blurHandler(priority)({ target: { value: "99" } });
    expect(guard!()).toBe(true); expect(confirmMock).not.toHaveBeenCalled();
    expect(onOpenOrtho).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
    await clickHandler(control("cases-open-ortho-71"))(); expect(navigate).toHaveBeenCalledOnce();
    expect(writes()).toHaveLength(1);
  });

  it("retires shortcuts after an invalid reload even when previously rendered cards remain", async () => {
    await mount(); const oldShortcut = clickHandler(control("cases-open-ortho-71"));
    payload = { ...validPayload(), cases: [row(), row({ patientId: 92, orthoCaseId: 74 })] };
    await clickHandler(button("بانتظار"))(); await settle();
    expect(shortcuts()).toHaveLength(0); await oldShortcut();
    expect(onOpenOrtho).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
    expect(render().nodes.some((node) => node.props.role === "alert")).toBe(true);
    expect(writes()).toHaveLength(1);
  });

  it.each((["patient", "logout"] as const).flatMap((changed) => ["late 503", "late transport", "late malformed JSON", "late valid body"].map((completion) => ({ changed, completion }))))(
    "ignores $completion from an old write after $changed A→B→A without fencing the new owner", async ({ changed, completion }) => {
      const { attempt, shortcut, priority } = await prepareAmbiguousWrite("POST");
      const originalProps = { ...props }; const originalSession = hooks.session; const oldGuard = guard!;
      nextWrite = deferred<Response>(); const pendingWrite = nextWrite; const writing = attempt();
      const body = deferred<unknown>(); const json = vi.fn(() => body.promise);
      if (completion === "late malformed JSON" || completion === "late valid body") {
        pendingWrite.resolve({ ...response(201, null), json }); await flushMicrotasks(); expect(json).toHaveBeenCalledOnce();
      }
      if (changed === "patient") props = { ...props, patientId: 92 };
      else hooks.session = null;
      payload = validPayload(props.patientId); render(); await settle();
      await attempt(); await shortcut(); change(priority, "99"); blurHandler(priority)({ target: { value: "99" } });
      expect(writes()).toHaveLength(1); expect(oldGuard()).toBe(false);
      props = originalProps; hooks.session = originalSession;
      payload = { ...validPayload(), cases: [row({ title: "Fresh A after old pending mutation" })] };
      render(); await settle(); const freshGuard = guard!; const reads = caseReads().length;
      expect(freshGuard).not.toBe(oldGuard); expect(freshGuard()).toBe(true);
      if (completion === "late 503") pendingWrite.resolve(response(503, { message: "Retired write failure" }));
      else if (completion === "late transport") pendingWrite.reject(new TypeError("Retired write connection loss"));
      else if (completion === "late malformed JSON") body.reject(new SyntaxError("Retired malformed body"));
      else body.resolve(row({ id: 25, kind: "specialty", orthoCaseId: null, specialty: "endodontics", title: "Old request result" }));
      await writing; await settle(); nextWrite = null;
      await attempt(); await shortcut(); change(priority, "99"); blurHandler(priority)({ target: { value: "99" } });
      expect(writes()).toHaveLength(1); expect(caseReads()).toHaveLength(reads);
      expect(contents(render().tree)).toContain("Fresh A after old pending mutation");
      expect(contents(render().tree)).not.toContain("Old request result");
      expect(contents(render().tree)).not.toContain(UNCERTAIN_WARNING);
      expect(render().nodes.some((node) => node.props.role === "alert")).toBe(false);
      expect(render().nodes.some((node) => node.props.placeholder === "علاج عصب — سن ٣٦")).toBe(false);
      expect(guard).toBe(freshGuard); expect(freshGuard()).toBe(true); expect(oldGuard()).toBe(false);
      expect(confirmMock).not.toHaveBeenCalled(); expect(onOpenOrtho).not.toHaveBeenCalled();
      await clickHandler(control("cases-open-ortho-71"))(); expect(navigate).toHaveBeenCalledOnce();
    },
  );

  const replacements = ["patient", "principal", "permission", "role", "canWrite"] as const;
  it.each(replacements.flatMap((changed) => ["headers", "body"].map((phase) => ({ changed, phase }))))(
    "rejects retained callbacks and late $phase after $changed A→B→A replacement", async ({ changed, phase }) => {
      await mount(); const originalProps = { ...props }; const originalSession = hooks.session;
      const oldShortcut = clickHandler(control("cases-open-ortho-71")); const oldGuard = guard!;
      const oldCleanup = registrations[0].cleanup;
      const oldPriority = field("aria-label", "أولوية Service 101");
      const oldOpenProblem = clickHandler(button("+ مشكلة"));
      clickHandler(button("+ حالة جديدة"))(); change(field("placeholder", "علاج عصب — سن ٣٦"), "Old owner draft");
      const oldSave = clickHandler(button("حفظ الحالة"));
      const headers = deferred<Response>(); const body = deferred<unknown>(); const json = vi.fn(() => body.promise);
      nextRead = phase === "headers" ? headers.promise : Promise.resolve({ ...response(200, null), json });
      const saving = oldSave(); await settle();
      const oldSignal = caseReads().at(-1)![1].signal as AbortSignal;
      expect(writes()).toHaveLength(1); if (phase === "body") expect(json).toHaveBeenCalledOnce();
      if (changed === "patient") props = { ...props, patientId: 92 };
      else if (changed === "principal") hooks.session = { ...hooks.session!, username: "synthetic-b" };
      else if (changed === "permission") hooks.session = { ...hooks.session!, permissions: { canViewPlans: false } as NonNullable<SessionInfo["permissions"]> };
      else if (changed === "role") hooks.session = { ...hooks.session!, role: "admin" };
      else props = { ...props, canWrite: false };
      payload = validPayload(props.patientId); render(); await settle();
      expect(control("patient-cases")).toBeTruthy(); expect(oldSignal.aborted).toBe(true);
      await oldShortcut(); await oldSave(); oldOpenProblem();
      change(oldPriority, "99"); blurHandler(oldPriority)({ target: { value: "99" } });
      expect(oldGuard()).toBe(false); expect(writes()).toHaveLength(1); expect(onOpenOrtho).not.toHaveBeenCalled();
      props = originalProps; hooks.session = originalSession;
      payload = { ...validPayload(), cases: [row({ title: "Fresh A owner" })] };
      render(); await settle(); const freshGuard = guard!;
      expect(freshGuard).not.toBe(oldGuard); expect(freshGuard()).toBe(true);
      oldCleanup(); expect(guard).toBe(freshGuard);
      await oldShortcut(); await oldSave(); oldOpenProblem();
      change(oldPriority, "99"); blurHandler(oldPriority)({ target: { value: "99" } });
      if (phase === "headers") headers.resolve(response(403, { message: "Late retired-owner denial" }));
      else body.resolve({ ...validPayload(), cases: [row({ title: "Stale A body" })] });
      await saving; await settle();
      expect(contents(render().tree)).toContain("Fresh A owner");
      expect(contents(render().tree)).not.toContain("Stale A body");
      expect(contents(render().tree)).not.toContain("Late retired-owner denial");
      expect(render().nodes.some((node) => node.type === "input" && node.props["aria-label"] === "المشكلة")).toBe(false);
      expect(render().nodes.some((node) => node.props.role === "alert")).toBe(false);
      expect(guard).toBe(freshGuard); expect(freshGuard()).toBe(true); expect(oldGuard()).toBe(false);
      expect(writes()).toHaveLength(1); expect(onOpenOrtho).not.toHaveBeenCalled(); expect(confirmMock).not.toHaveBeenCalled();
      await clickHandler(control("cases-open-ortho-71"))(); expect(navigate).toHaveBeenCalledOnce();
    },
  );

  it.each(["headers", "body"])("ignores retained callbacks and late read %s after unmount", async (phase) => {
    await mount(); const oldShortcut = clickHandler(control("cases-open-ortho-71")); const oldGuard = guard!;
    const oldPriority = field("aria-label", "أولوية Service 101");
    clickHandler(button("+ حالة جديدة"))(); change(field("placeholder", "علاج عصب — سن ٣٦"), "Unmounted draft");
    const oldSave = clickHandler(button("حفظ الحالة"));
    const headers = deferred<Response>(); const body = deferred<unknown>();
    nextRead = phase === "headers" ? headers.promise : Promise.resolve({ ...response(200, null), json: () => body.promise });
    const saving = oldSave(); await settle(); const oldSignal = caseReads().at(-1)![1].signal as AbortSignal;
    unmount(); hooks.changed = false; expect(guard).toBeNull(); expect(oldSignal.aborted).toBe(true);
    await oldShortcut(); await oldSave(); change(oldPriority, "99"); blurHandler(oldPriority)({ target: { value: "99" } });
    expect(oldGuard()).toBe(false);
    if (phase === "headers") headers.resolve(response(200, validPayload())); else body.resolve(validPayload());
    await saving; for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(hooks.changed).toBe(false); expect(guard).toBeNull(); expect(caseReads()).toHaveLength(2);
    expect(writes()).toHaveLength(1); expect(onOpenOrtho).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
