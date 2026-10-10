import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientOrtho, type AdjustmentForm } from "../components/PatientOrtho";
import type { SessionInfo } from "../components/SessionProvider";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../lib/doctor-permissions";

// STATUS: UNRUN. Source-authored deterministic regressions. Actual parent,
// workspace, local forms, read guards and mutation guards execute. The hook
// simulator below is not React/DOM/StrictMode evidence; the separate real-React
// acceptance fixture covers those lifetimes. No route/database/network runs.
type Scope = {
  values: unknown[]; cursor: number; live: boolean;
  effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>;
  memos: Map<number, { deps?: readonly unknown[]; value: unknown }>;
};
const hooks = vi.hoisted(() => ({
  current: null as Scope | null, changed: false, retiredWrites: 0,
  layout: [] as Array<() => void>, passive: [] as Array<() => void>,
  session: null as SessionInfo | null, contexts: new Map<unknown, unknown>(),
  existingRefresh: null as (() => void) | null,
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic", useSetting: () => "" }));
vi.mock("../components/LegacyOnboardingChecklist", () => ({ LegacyOnboardingChecklist: () => null }));
vi.mock("../components/OrthoPackageLink", () => ({ OrthoPackageLink: ({ onChanged }: { onChanged: () => void }) => {
  hooks.existingRefresh = onChanged; return null;
} }));
vi.mock("../components/PatientCeph", () => ({ PatientCeph: () => null }));
vi.mock("../components/PatientDiagnosis", () => ({ PatientDiagnosis: () => null }));
vi.mock("../components/WebCephRecordsGrid", () => ({ WebCephRecordsGrid: () => null }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const scope = () => { if (!hooks.current) throw new Error("Hook outside a component scope"); return hooks.current; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b
    && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const owner = scope(); const index = owner.cursor++; const prior = owner.memos.get(index);
    if (prior && same(prior.deps, deps)) return prior.value;
    const value = factory(); owner.memos.set(index, { deps, value }); return value;
  };
  const effect = (callback: () => void | (() => void), deps: readonly unknown[] | undefined, layout: boolean) => {
    const owner = scope(); const index = owner.cursor++; const prior = owner.effects.get(index);
    if (prior && same(prior.deps, deps)) return;
    const entry = { deps, cleanup: undefined as (() => void) | undefined }; owner.effects.set(index, entry);
    (layout ? hooks.layout : hooks.passive).push(() => {
      if (!owner.live) return; prior?.cleanup?.(); entry.cleanup = callback() || undefined;
    });
  };
  return { ...react,
    createContext: (initial: unknown) => { const context = { initial }; return Object.assign(context, { Provider: context }); },
    useContext: (context: { initial: unknown }) => hooks.contexts.has(context) ? hooks.contexts.get(context) : context.initial,
    useState: (initial: unknown) => {
      const owner = scope(); const index = owner.cursor++;
      if (!(index in owner.values)) owner.values[index] = typeof initial === "function" ? initial() : initial;
      return [owner.values[index], (update: unknown) => {
        if (!owner.live) { hooks.retiredWrites++; return; }
        const value = typeof update === "function" ? update(owner.values[index]) : update;
        if (!Object.is(value, owner.values[index])) hooks.changed = true;
        owner.values[index] = value;
      }];
    },
    useRef: (initial: unknown) => {
      const owner = scope(); const index = owner.cursor++;
      if (!(index in owner.values)) owner.values[index] = { current: initial }; return owner.values[index];
    },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(callback, deps, false),
    useLayoutEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(callback, deps, true),
  };
});

type Element = ReactElement<Record<string, unknown>>;
type Component = (props: Record<string, unknown>) => ReactNode;
type Case = ComponentProps<typeof AdjustmentForm>["caseRow"];
type ResponseLike = { ok: boolean; status: number; json: () => Promise<unknown> };
type Pending = { id: number; url: string; method: string; init?: RequestInit; json: ReturnType<typeof vi.fn>;
  headers: (status: number) => void; body: (value: unknown) => void; fail: (message?: string) => void };
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const principalA = (): SessionInfo => ({ username: "synthetic-ortho-a", role: "doctor", displayName: "Synthetic A",
  permissions: { ...DEFAULT_DOCTOR_PERMISSIONS } });
// Contract bound, kept local so the semantic preimage counterfactual below can
// import the frozen pre-fix component, which has no new timeout export.
const READ_BOUND_MS = 15_000;
const fixture = (id = patientId, changes: Partial<Case> = {}): Case & { patientId: number } => ({
  id: 41, patientId: id, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: "accepted-case-a",
  status: "active", phase: "working", startDate: "2026-01-04", plannedMonths: 18,
  upperWire: "014 NiTi", lowerWire: "012 NiTi", planId: null, retainer: null, retainerOn: null, note: null,
  closedAt: null, closedBy: null, closedNote: null, baselineKind: null, baselineRecordedAt: null,
  elastics: null, responsibleDoctorName: null, legacyFinancialMode: null, remainingObjectives: null, photosVisible: false,
  adjustments: [{ id: 51, visitId: null, visitSigned: true, doneOn: "2026-09-04", phase: "working",
    upperWire: "014 NiTi", lowerWire: "012 NiTi", elastics: "class_ii", elasticNote: "synthetic prior regimen",
    done: "synthetic historical adjustment", nextWeeks: 6, note: null, recordedBy: "synthetic doctor", photos: [] }],
  progress: { monthsElapsed: 9, monthsPlanned: 18, monthsRemaining: 9, percent: 50,
    overdue: false, adjustments: 1, lastAdjustment: "2026-09-04", daysSinceLast: 30 }, ...changes,
});
const contact = (id = patientId) => ({ patient: { id, fullName: "Synthetic patient", phone: "700000001" } });
let patientId: number; let requests: Pending[]; let unexpected: string[];
let scopes = new Map<string, Scope>(); let componentIds = new Map<unknown, number>(); let seen = new Set<string>();
let executed = new Set<string>();
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<ResponseLike>>();
const createURL = vi.fn<(file: Blob | MediaSource) => string>();
const revokeURL = vi.fn<(url: string) => void>();
type NavigationRegistration = { guard: () => boolean; cleanupCalls: number };
let navigationRegistration: NavigationRegistration | null = null;
let navigationRegistrations: NavigationRegistration[] = [];
let delayNavigationCleanup = false;
let delayedNavigationCleanup: Array<() => void> = [];
const confirmLeave = vi.fn<(message: string) => boolean>();
// Observe the component's real guard. The parent callback owns only its lease;
// delaying its cleanup must not let an old owner withdraw a newer registration.
function registerNavigationGuard(guard: () => boolean): () => void {
  const registration = { guard, cleanupCalls: 0 };
  navigationRegistration = registration; navigationRegistrations.push(registration);
  return () => {
    registration.cleanupCalls++;
    const clear = () => { if (navigationRegistration === registration) navigationRegistration = null; };
    if (delayNavigationCleanup) delayedNavigationCleanup.push(clear); else clear();
  };
}
function currentNavigation() {
  expect(navigationRegistration).not.toBeNull(); return navigationRegistration!;
}
function retire(scope: Scope) {
  scope.live = false; scope.effects.forEach((entry) => entry.cleanup?.()); scope.effects.clear();
}
function unmount() {
  scopes.forEach(retire); scopes.clear(); hooks.layout = []; hooks.passive = []; hooks.current = null; hooks.contexts.clear();
}
function execute(component: Component, props: Record<string, unknown>, path: string): ReactNode {
  seen.add(path); let owner = scopes.get(path);
  if (!owner) { owner = { values: [], cursor: 0, live: true, effects: new Map(), memos: new Map() }; scopes.set(path, owner); }
  owner.cursor = 0; const prior = hooks.current; hooks.current = owner;
  executed.add(component.name);
  try { return component(props); } finally { hooks.current = prior; }
}
function expand(node: ReactNode, path: string): ReactNode {
  if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${index}`));
  if (!node || typeof node !== "object" || !("props" in node)) return node;
  const element = node as Element; const identity = `${path}:${String(element.key ?? "")}`;
  if (element.type && typeof element.type === "object" && "initial" in element.type) {
    const had = hooks.contexts.has(element.type); const prior = hooks.contexts.get(element.type);
    hooks.contexts.set(element.type, element.props.value);
    try { return expand(element.props.children as ReactNode, `${identity}/provider`); }
    finally { if (had) hooks.contexts.set(element.type, prior); else hooks.contexts.delete(element.type); }
  }
  // Execute every local function, including forms nested below host elements.
  // Peripheral modules above are explicit null stubs. No parent/form callback,
  // ownership condition, read function, or mutation function is replaced.
  if (typeof element.type === "function") {
    if (!componentIds.has(element.type)) componentIds.set(element.type, componentIds.size);
    const ownerPath = `${identity}/component-${componentIds.get(element.type)}`;
    return expand(execute(element.type as Component, element.props, ownerPath), `${ownerPath}/result`);
  }
  return { ...element, props: { ...element.props, children: expand(element.props.children as ReactNode, `${identity}/children`) } };
}
function render(): ReactNode {
  let tree: ReactNode = null; let rounds = 0;
  do {
    if (++rounds > 30) throw new Error("Orthodontic composition did not settle");
    hooks.changed = false; seen = new Set();
    tree = expand(execute(() => PatientOrtho({ patientId, onNavigationGuardChange: registerNavigationGuard }), {}, "patient-ortho"), "patient-ortho/result");
    for (const [key, scope] of scopes) if (!seen.has(key)) { retire(scope); scopes.delete(key); }
    hooks.layout.splice(0).forEach((effect) => effect()); hooks.passive.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
}
function one(predicate: (element: Element) => boolean, tree: ReactNode = render()) {
  const matches = elements(tree).filter(predicate); expect(matches).toHaveLength(1); return matches[0];
}
const workspace = () => one((node) => node.props["data-testid"] === "patient-ortho-workspace");
const control = (label: string) => one((node) => node.props["aria-label"] === label);
const button = (label: string) => one((node) => node.type === "button" && text(node).trim() === label);
function click(node: Element) { expect(node.props.disabled).not.toBe(true); (node.props.onClick as () => void)(); render(); }
function edit(label: string, value: string) {
  (control(label).props.onChange as (event: unknown) => void)({ target: { value } }); render();
}
function form() { return one((node) => node.type === "form"); }
function submit(node = form()) { return (node.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault: vi.fn() }); }
function fields() {
  return elements(render()).filter((node) => ["input", "select", "textarea"].includes(String(node.type)) && node.props.type !== "file")
    .map((node) => ({ label: node.props["aria-label"], value: node.props.value }));
}
function hidden(expected: "loading" | "error" | "denied") {
  const tree = render(); expect(workspace().props["data-read-state"]).toBe(expected);
  expect(elements(tree).filter((node) => ["form", "input", "textarea", "select", "img", "a"].includes(String(node.type)))).toEqual([]);
  expect(text(tree)).not.toMatch(/accepted-case-a|Synthetic patient|700000001|private-draft|synthetic prior regimen/);
}
async function drain() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
async function flush() { for (let round = 0; round < 4; round++) { await drain(); render(); } }
const reads = () => requests.filter((one) => one.method === "GET");
const writes = () => requests.filter((one) => one.method !== "GET");
function pair() {
  const ortho = reads().filter((one) => one.url.startsWith("/api/ortho?")).at(-1);
  const patient = reads().filter((one) => /^\/api\/patients\/\d+$/.test(one.url)).at(-1);
  expect(ortho).toBeDefined(); expect(patient).toBeDefined(); return { ortho: ortho!, patient: patient! };
}
function respond(request: Pending, body: unknown, status = 200) { request.headers(status); request.body(body); }
async function grant(empty = false) {
  const current = pair(); respond(current.ortho, { cases: empty ? [] : [fixture()] }); respond(current.patient, contact()); await flush();
  expect(workspace().props["data-read-state"]).toBe("ready");
}
async function mount(empty = false) { render(); hidden("loading"); await grant(empty); }
function refresh() { click(control("تحديث كابينة التقويم")); hidden("loading"); return pair(); }
async function retry(empty = false) { click(control("إعادة تحميل كابينة التقويم")); hidden("loading"); await grant(empty); }
async function failClinical() {
  const current = refresh(); respond(current.patient, contact()); respond(current.ortho, {}, 503); await flush(); hidden("error");
}
function adjustment() {
  click(button("⚡ سجّل شدّة وجلسة جديدة الآن")); edit("ما نُفّذ في الشدّة", "private-draft adjustment");
  expect(executed.has("PatientOrthoWorkspace")).toBe(true); expect(executed.has("AdjustmentForm")).toBe(true);
  return form();
}
function addPhoto(name = "synthetic.png") {
  const file = new File(["synthetic image bytes"], name, { type: "image/png", lastModified: 123456 });
  (control("اختيار صور").props.onChange as (event: unknown) => void)({ target: { files: [file], value: "" } }); render(); return file;
}

beforeEach(() => {
  unmount(); scopes = new Map(); componentIds = new Map(); executed = new Set(); hooks.changed = false; hooks.retiredWrites = 0;
  patientId = 19; hooks.session = principalA(); hooks.existingRefresh = null; requests = []; unexpected = []; fetchMock.mockReset(); createURL.mockReset(); revokeURL.mockReset();
  navigationRegistration = null; navigationRegistrations = []; delayNavigationCleanup = false; delayedNavigationCleanup = [];
  confirmLeave.mockReset(); confirmLeave.mockReturnValue(false);
  vi.stubGlobal("window", { confirm: confirmLeave, prompt: vi.fn() });
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-04T06:00:00Z"));
  createURL.mockImplementation(() => `blob:synthetic-ortho-${createURL.mock.calls.length}`);
  vi.spyOn(URL, "createObjectURL").mockImplementation(createURL);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeURL);
  fetchMock.mockImplementation((url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "/api/parties?kind=doctor") return Promise.resolve({ ok: true, status: 200, json: async () => [{ id: 71, name: "Synthetic responsible doctor" }] });
    const isRead = method === "GET" && (/^\/api\/ortho\?patientId=(19|20)$/.test(url) || /^\/api\/patients\/(19|20)$/.test(url));
    const isWrite = ["POST", "PATCH"].includes(method) && ["/api/ortho", "/api/ortho/41", "/api/ortho/baseline",
      "/api/appointments", "/api/visits/61/clinical", "/api/patients/19/documents", "/api/patients/20/documents"].includes(url);
    if (!isRead && !isWrite) { unexpected.push(`${method} ${url}`); return Promise.reject(new Error("Unexpected synthetic request")); }
    const head = deferred<ResponseLike>(); const body = deferred<unknown>(); const json = vi.fn(() => body.promise);
    requests.push({ id: requests.length + 1, url, method, init, json,
      headers: (status) => head.resolve({ ok: status >= 200 && status < 300, status, json }),
      body: body.resolve, fail: (message = "Synthetic transport failure") => head.reject(new TypeError(message)) });
    // AbortSignal is recorded but intentionally ignored by transport completion.
    return head.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  unmount();
  try { expect(unexpected).toEqual([]); }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); }
});

describe("PatientOrtho owner-bound navigation guard (source gate, UNRUN)", () => {
  const dirtyWarning = "هناك عمل غير محفوظ في التقويم. هل تريد تجاهله ومغادرة القسم؟";
  const uncertainWarning = "نتيجة الحفظ غير مؤكدة؛ قد يكون الطلب نُفّذ. المغادرة لا تلغي الطلب ولا تعيد إرساله، وستُترك أي مسودة غير محفوظة. هل تريد مغادرة القسم؟";

  it("registers before reads complete, allows clean departure, and retires its guard on unmount", async () => {
    render(); hidden("loading");
    const registered = currentNavigation();
    expect(navigationRegistrations).toHaveLength(1); expect(registered.guard()).toBe(true);
    await grant(); expect(currentNavigation()).toBe(registered); expect(registered.guard()).toBe(true);
    expect(confirmLeave).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
    unmount(); expect(registered.cleanupCalls).toBe(1); expect(navigationRegistration).toBeNull();
    expect(registered.guard()).toBe(false); expect(confirmLeave).not.toHaveBeenCalled();
  });

  it.each(["patient", "principal", "permissions"] as const)("replaces the %s A→B→A guard without allowing delayed old cleanup to remove the current lease", async (kind) => {
    await mount(); adjustment(); addPhoto();
    const first = currentNavigation(); const original = hooks.session;
    delayNavigationCleanup = true;
    if (kind === "patient") patientId = 20;
    else if (kind === "principal") hooks.session = { ...original!, username: "synthetic-ortho-b" };
    else hooks.session = { ...original!, permissions: { ...original!.permissions!, canEditPlans: false } };
    render(); hidden("loading");
    const second = currentNavigation(); expect(second).not.toBe(first); expect(first.guard()).toBe(false);
    if (kind === "patient") patientId = 19; else hooks.session = original;
    render(); hidden("loading");
    const third = currentNavigation(); expect(third).not.toBe(first); expect(third).not.toBe(second);
    expect(navigationRegistrations).toHaveLength(3);
    expect(first.cleanupCalls).toBe(1); expect(second.cleanupCalls).toBe(1);
    expect(second.guard()).toBe(false); expect(third.guard()).toBe(true);
    expect(delayedNavigationCleanup).toHaveLength(2);
    delayedNavigationCleanup.splice(0).forEach((cleanup) => cleanup());
    expect(currentNavigation()).toBe(third); expect(third.guard()).toBe(true);
    expect(confirmLeave).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
    expect(revokeURL).toHaveBeenCalledExactlyOnceWith("blob:synthetic-ortho-1");
    delayNavigationCleanup = false;
    unmount(); expect(third.cleanupCalls).toBe(1); expect(navigationRegistration).toBeNull();
    expect(third.guard()).toBe(false);
  });

  it("keeps the same guard and unsaved values across a display-name-only refresh", async () => {
    await mount(); adjustment(); const registered = currentNavigation(); const before = fields();
    const readCount = reads().length;
    hooks.session = { ...hooks.session!, displayName: "Updated synthetic display name" }; render();
    expect(currentNavigation()).toBe(registered); expect(navigationRegistrations).toHaveLength(1);
    expect(registered.cleanupCalls).toBe(0); expect(reads()).toHaveLength(readCount);
    expect(registered.guard()).toBe(false); expect(confirmLeave).toHaveBeenCalledExactlyOnceWith(dirtyWarning);
    expect(fields()).toEqual(before);
  });

  it.each(["new", "baseline", "adjustment"] as const)("does not treat unedited %s defaults or same-value input as unsaved work", async (kind) => {
    await mount(kind !== "adjustment");
    if (kind === "new") click(button("+ فتح حالة تقويم جديدة"));
    else if (kind === "baseline") { click(button("تسجيل حالة سابقة (قبل النظام)")); await flush(); }
    else click(button("⚡ سجّل شدّة وجلسة جديدة الآن"));
    const label = kind === "new" ? "نظام البراكيت" : kind === "baseline" ? "الأهداف المتبقية" : "ما نُفّذ في الشدّة";
    const before = fields(); edit(label, String(control(label).props.value));
    expect(currentNavigation().guard()).toBe(true); expect(fields()).toEqual(before);
    expect(confirmLeave).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
  });

  it.each(["new", "baseline"] as const)("retains the exact edited %s fields when departure is cancelled", async (kind) => {
    await mount(true);
    if (kind === "new") { click(button("+ فتح حالة تقويم جديدة")); edit("نظام البراكيت", "private-draft prescription"); edit("المدة المتوقعة", "27"); }
    else { click(button("تسجيل حالة سابقة (قبل النظام)")); await flush(); edit("الأهداف المتبقية", "private-draft objectives"); edit("النظام المالي السابق", "per_session"); }
    const before = fields();
    expect(currentNavigation().guard()).toBe(false); expect(confirmLeave).toHaveBeenCalledExactlyOnceWith(dirtyWarning);
    expect(fields()).toEqual(before); expect(writes()).toEqual([]); expect(hooks.retiredWrites).toBe(0);
  });

  it("cancelled departure preserves adjustment values and both exact queued Files for the eventual save", async () => {
    await mount(); adjustment(); const first = addPhoto("one.png"); const second = addPhoto("two.png");
    edit("دور صور الجلسة", "progress"); edit("أسابيع حتى الشدّة القادمة", "5");
    const before = fields(); const previews = elements(render()).filter((node) => node.type === "img").map((node) => node.props.src);
    expect(currentNavigation().guard()).toBe(false); expect(confirmLeave).toHaveBeenCalledExactlyOnceWith(dirtyWarning);
    expect(fields()).toEqual(before);
    expect(elements(render()).filter((node) => node.type === "img").map((node) => node.props.src)).toEqual(previews);
    expect(createURL.mock.calls).toEqual([[first], [second]]); expect(revokeURL).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
    const pending = submit(); respond(writes()[0], { id: 81 }); await flush();
    const firstUpload = writes().filter((request) => request.url.endsWith("/documents"))[0]; expect(firstUpload).toBeDefined();
    expect((firstUpload.init!.body as FormData).get("file")).toBe(first); respond(firstUpload, {}); await flush();
    const secondUpload = writes().filter((request) => request.url.endsWith("/documents"))[1]; expect(secondUpload).toBeDefined();
    expect((secondUpload.init!.body as FormData).get("file")).toBe(second); respond(secondUpload, {}); await pending; await flush();
    expect(writes()).toHaveLength(3); expect(hooks.retiredWrites).toBe(0);
  });

  it("confirmation only permits navigation; unmount then disposes the draft and makes captured setters and submit inert", async () => {
    await mount(); const oldForm = adjustment(); const oldInput = control("ما نُفّذ في الشدّة"); const file = addPhoto();
    const registered = currentNavigation(); const before = fields();
    confirmLeave.mockReturnValue(true);
    expect(registered.guard()).toBe(true); expect(confirmLeave).toHaveBeenCalledExactlyOnceWith(dirtyWarning);
    expect(fields()).toEqual(before); expect(currentNavigation()).toBe(registered);
    expect(revokeURL).not.toHaveBeenCalled(); expect(createURL).toHaveBeenCalledExactlyOnceWith(file); expect(writes()).toEqual([]);
    unmount();
    expect(revokeURL).toHaveBeenCalledExactlyOnceWith("blob:synthetic-ortho-1");
    expect(registered.guard()).toBe(false); expect(navigationRegistration).toBeNull();
    (oldInput.props.onChange as (event: unknown) => void)({ target: { value: "retired-handler-change" } });
    await submit(oldForm); await drain();
    expect(scopes.size).toBe(0); expect(writes()).toEqual([]); expect(hooks.retiredWrites).toBe(0);
    expect(confirmLeave).toHaveBeenCalledTimes(1); expect(revokeURL).toHaveBeenCalledTimes(1);
  });

  it("blocks a held save synchronously without confirmation even when its draft has only unedited defaults", async () => {
    await mount(); click(button("⚡ سجّل شدّة وجلسة جديدة الآن"));
    const registered = currentNavigation(); expect(registered.guard()).toBe(true);
    const pending = submit(); expect(writes()).toHaveLength(1);
    // No render between the request and guard: busy ownership must be synchronous.
    expect(registered.guard()).toBe(false); expect(confirmLeave).not.toHaveBeenCalled();
    writes()[0].headers(200); await flush();
    expect(registered.guard()).toBe(false); expect(confirmLeave).not.toHaveBeenCalled();
    writes()[0].body({ id: 81 }); await pending; await flush();
    expect(registered.guard()).toBe(true); expect(confirmLeave).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1);
  });

  it("retains hidden dirty work in the guard while a clinical reread is unavailable", async () => {
    await mount(); adjustment(); addPhoto(); const registered = currentNavigation(); const before = fields();
    await failClinical(); hidden("error");
    expect(currentNavigation()).toBe(registered); expect(registered.guard()).toBe(false);
    expect(confirmLeave).toHaveBeenCalledExactlyOnceWith(dirtyWarning); expect(revokeURL).not.toHaveBeenCalled();
    await retry(); expect(fields()).toEqual(before); expect(writes()).toEqual([]);
  });

  it("warns about an uncertain result without replaying the request or disposing a retained draft on confirmation", async () => {
    await mount(); const oldForm = adjustment(); const before = fields();
    const pending = submit(oldForm); expect(writes()).toHaveLength(1); writes()[0].fail(); await pending; await flush();
    expect(elements(render()).some((node) => node.props["data-testid"] === "ortho-write-uncertain")).toBe(true);
    const registered = currentNavigation();
    expect(registered.guard()).toBe(false); expect(confirmLeave).toHaveBeenLastCalledWith(uncertainWarning);
    expect(fields()).toEqual(before); expect(writes()).toHaveLength(1);
    confirmLeave.mockReturnValue(true); expect(registered.guard()).toBe(true);
    expect(confirmLeave).toHaveBeenLastCalledWith(uncertainWarning); expect(fields()).toEqual(before);
    await submit(oldForm); await submit(); await flush();
    expect(writes()).toHaveLength(1); expect(confirmLeave).toHaveBeenCalledTimes(2);
    expect(elements(render()).some((node) => node.props["data-testid"] === "ortho-write-uncertain")).toBe(true);
    unmount(); expect(registered.guard()).toBe(false); expect(hooks.retiredWrites).toBe(0);
  });

  it("does not treat a confirmed booking receipt as unsaved work after edited booking fields", async () => {
    await mount(); adjustment(); const saving = submit(); respond(writes()[0], { id: 81 }); await saving; await flush(); await grant();
    expect(currentNavigation().guard()).toBe(true);
    click(button("📅 حجز الموعد المقترح الآن")); edit("تاريخ الجلسة القادمة", "2026-12-12"); edit("وقت الجلسة القادمة", "17:45");
    expect(currentNavigation().guard()).toBe(false); expect(confirmLeave).toHaveBeenLastCalledWith(dirtyWarning);
    confirmLeave.mockClear();
    const booking = submit(); expect(currentNavigation().guard()).toBe(false); expect(confirmLeave).not.toHaveBeenCalled();
    respond(writes()[1], {}); await booking; await flush();
    expect(text(render())).toContain("تم حجز الجلسة القادمة بنجاح");
    expect(currentNavigation().guard()).toBe(true); expect(confirmLeave).not.toHaveBeenCalled(); expect(writes()).toHaveLength(2);
  });

  it("blocks a pending signature but lets its confirmed receipt leave without an unsaved-work prompt", async () => {
    const prior = fixture(); const row = fixture(19, { adjustments: [{ ...prior.adjustments[0], visitId: 61, visitSigned: false, doneOn: "2026-10-04" }] });
    render(); const initial = pair(); respond(initial.ortho, { cases: [row] }); respond(initial.patient, contact()); await flush();
    const registered = currentNavigation(); expect(registered.guard()).toBe(true);
    const captured = button("وقّع الزيارة وأرسله للاستقبال").props.onClick as () => void;
    captured(); expect(registered.guard()).toBe(false); expect(confirmLeave).not.toHaveBeenCalled();
    respond(writes()[0], { patientId: 19, invoiceId: null, invoiceCurrency: null, duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null }); await flush();
    expect(text(render())).toContain("وُقّعت زيارة اليوم"); expect(registered.guard()).toBe(true);
    expect(confirmLeave).not.toHaveBeenCalled(); captured(); await flush(); expect(writes()).toHaveLength(1);
  });
});

describe("PatientOrtho outstanding-change navigation guard (source gate, UNRUN)", () => {
  const dirtyWarning = "هناك عمل غير محفوظ في التقويم. هل تريد تجاهله ومغادرة القسم؟";

  it("leaves clean before booking, while an untouched booking form is open, and after Back", async () => {
    await mount(); adjustment(); const saving = submit(); respond(writes()[0], { id: 81 }); await saving; await flush(); await grant();
    const registered = currentNavigation(); const before = fields();
    expect(registered.guard()).toBe(true);
    click(button("📅 حجز الموعد المقترح الآن"));
    expect(control("تاريخ الجلسة القادمة").props.value).toBeTypeOf("string");
    expect(control("وقت الجلسة القادمة").props.value).toBeTypeOf("string");
    expect(registered.guard()).toBe(true);
    click(button("رجوع"));
    expect(fields()).toEqual(before); expect(registered.guard()).toBe(true);
    expect(confirmLeave).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1);
  });

  it("keeps changed booking values dirty until both original date and time are restored", async () => {
    await mount(); adjustment(); const saving = submit(); respond(writes()[0], { id: 81 }); await saving; await flush(); await grant();
    click(button("📅 حجز الموعد المقترح الآن"));
    const date = String(control("تاريخ الجلسة القادمة").props.value);
    const time = String(control("وقت الجلسة القادمة").props.value); const before = fields();
    edit("تاريخ الجلسة القادمة", "2026-12-12"); edit("وقت الجلسة القادمة", "17:45");
    expect(currentNavigation().guard()).toBe(false); expect(confirmLeave).toHaveBeenLastCalledWith(dirtyWarning);
    edit("تاريخ الجلسة القادمة", date);
    expect(currentNavigation().guard()).toBe(false); expect(control("وقت الجلسة القادمة").props.value).toBe("17:45");
    edit("وقت الجلسة القادمة", time); confirmLeave.mockClear();
    expect(fields()).toEqual(before); expect(currentNavigation().guard()).toBe(true);
    click(button("رجوع")); expect(currentNavigation().guard()).toBe(true);
    expect(confirmLeave).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1);
  });

  it.each(["new", "baseline", "adjustment"] as const)("clears reverted %s edits without clearing another field's outstanding change", async (kind) => {
    await mount(kind !== "adjustment");
    if (kind === "new") click(button("+ فتح حالة تقويم جديدة"));
    else if (kind === "baseline") { click(button("تسجيل حالة سابقة (قبل النظام)")); await flush(); }
    else click(button("⚡ سجّل شدّة وجلسة جديدة الآن"));
    const label = kind === "new" ? "نظام البراكيت" : kind === "baseline" ? "الأهداف المتبقية" : "ما نُفّذ في الشدّة";
    const otherLabel = kind === "new" ? "المدة المتوقعة" : kind === "baseline" ? "الأشهر المتبقية" : "أسابيع حتى الشدّة القادمة";
    const original = String(control(label).props.value); const otherOriginal = String(control(otherLabel).props.value);
    const before = fields();
    edit(label, `${original} synthetic changed value`); edit(otherLabel, "5");
    expect(currentNavigation().guard()).toBe(false); expect(confirmLeave).toHaveBeenLastCalledWith(dirtyWarning);
    edit(label, original);
    expect(currentNavigation().guard()).toBe(false); expect(control(otherLabel).props.value).toBe("5");
    edit(otherLabel, otherOriginal); confirmLeave.mockClear();
    expect(fields()).toEqual(before); expect(currentNavigation().guard()).toBe(true); expect(confirmLeave).not.toHaveBeenCalled();
    // A second edit/revert cycle must establish and clear its own outstanding baseline.
    edit(label, `${original} another value`); expect(currentNavigation().guard()).toBe(false);
    edit(label, original); confirmLeave.mockClear();
    expect(fields()).toEqual(before); expect(currentNavigation().guard()).toBe(true);
    expect(confirmLeave).not.toHaveBeenCalled(); expect(writes()).toEqual([]);
  });

  it("returns a photo-only draft to clean after all Files are removed and revokes each preview exactly once", async () => {
    await mount(); click(button("⚡ سجّل شدّة وجلسة جديدة الآن")); const before = fields();
    const registered = currentNavigation(); expect(registered.guard()).toBe(true);
    const first = addPhoto("one.png"); const second = addPhoto("two.png");
    expect(registered.guard()).toBe(false); expect(confirmLeave).toHaveBeenLastCalledWith(dirtyWarning);
    const deleteButtons = () => elements(render()).filter((node) => node.type === "button" && text(node).trim() === "حذف");
    expect(deleteButtons()).toHaveLength(2); click(deleteButtons()[0]);
    expect(registered.guard()).toBe(false); expect(deleteButtons()).toHaveLength(1);
    expect(revokeURL.mock.calls).toEqual([["blob:synthetic-ortho-1"]]);
    click(deleteButtons()[0]); confirmLeave.mockClear();
    expect(deleteButtons()).toEqual([]); expect(fields()).toEqual(before);
    expect(elements(render()).filter((node) => node.type === "img")).toEqual([]);
    expect(registered.guard()).toBe(true); expect(confirmLeave).not.toHaveBeenCalled();
    expect(createURL.mock.calls).toEqual([[first], [second]]);
    expect(revokeURL.mock.calls).toEqual([["blob:synthetic-ortho-1"], ["blob:synthetic-ortho-2"]]);
    expect(writes()).toEqual([]); unmount();
    expect(revokeURL).toHaveBeenCalledTimes(2); expect(hooks.retiredWrites).toBe(0);
  });

  it("removing the photo queue cannot clear a separate outstanding clinical edit", async () => {
    await mount(); click(button("⚡ سجّل شدّة وجلسة جديدة الآن"));
    const original = String(control("ما نُفّذ في الشدّة").props.value);
    edit("ما نُفّذ في الشدّة", "private-draft clinical work"); addPhoto(); click(button("حذف"));
    expect(currentNavigation().guard()).toBe(false); expect(confirmLeave).toHaveBeenLastCalledWith(dirtyWarning);
    expect(control("ما نُفّذ في الشدّة").props.value).toBe("private-draft clinical work");
    edit("ما نُفّذ في الشدّة", original); confirmLeave.mockClear();
    expect(currentNavigation().guard()).toBe(true); expect(confirmLeave).not.toHaveBeenCalled();
    expect(revokeURL).toHaveBeenCalledExactlyOnceWith("blob:synthetic-ortho-1"); expect(writes()).toEqual([]);
  });
});

describe("PatientOrtho recorded bracket prescription truth", () => {
  // Uses the actual parent/workspace and the existing semantic label, so these
  // assertions also execute against the pre-fix render without new selectors.
  function prescriptionValue() {
    const cell = one((node) => node.type === "div" && Array.isArray(node.props.children)
      && node.props.children.some((child: ReactNode) => child && typeof child === "object"
        && "props" in child && child.type === "span" && text(child) === "فلسفة البراكيت"));
    return elements(cell).filter((node) => node.type === "span").at(-1)!;
  }
  async function openPrescription(changes: Partial<Case>) {
    const row = fixture(19, changes);
    const before = structuredClone(row);
    render(); const current = pair();
    respond(current.ortho, { cases: [row] }); respond(current.patient, contact()); await flush();
    click(one((node) => node.type === "button" && elements(node)
      .some((child) => child.type === "span" && text(child) === "خطة العلاج والميكانيكا")));
    return { row, before };
  }

  it.each([null, "", "   "])("labels absent prescription %j as unrecorded rather than inventing Roth/MBT", async (bracketSystem) => {
    const { row, before } = await openPrescription({ bracketSystem });
    expect(text(prescriptionValue())).toBe("غير مسجّلة");
    expect(text(render())).not.toContain("Roth / MBT");
    expect(row).toEqual(before);
    expect(writes()).toEqual([]);
    expect(reads()).toHaveLength(2);
  });

  it.each(["Roth", "MBT 022", "Roth / MBT", "وصفة خاصة مسجّلة", "  Custom / prescribed  "])(
    "preserves the exact recorded prescription %j without substituting a default", async (bracketSystem) => {
      const { row, before } = await openPrescription({ bracketSystem, planId: 73, note: "Canonical plan notes" });
      expect(text(prescriptionValue())).toBe(bracketSystem);
      expect(text(render())).toContain("Canonical plan notes");
      expect(row).toEqual(before);
      expect(writes()).toEqual([]);
    },
  );

  it("does not carry a previous recorded prescription through a refresh with unrecorded data", async () => {
    await openPrescription({ bracketSystem: "Prior recorded prescription", planId: 73 });
    expect(text(prescriptionValue())).toBe("Prior recorded prescription");
    const current = refresh();
    expect(text(render())).not.toContain("Prior recorded prescription");
    respond(current.ortho, { cases: [fixture(19, { bracketSystem: null, planId: 73 })] });
    respond(current.patient, contact()); await flush();
    expect(text(prescriptionValue())).toBe("غير مسجّلة");
    expect(text(render())).not.toMatch(/Prior recorded prescription|Roth \/ MBT/);
    expect(writes()).toEqual([]);
  });

  it("keeps closed and legacy case prescriptions unrecorded without altering their context", async () => {
    const { row, before } = await openPrescription({ bracketSystem: null, status: "completed", phase: "retention",
      baselineKind: "legacy", legacyFinancialMode: "installments", planId: 73,
      remainingObjectives: "Recorded baseline objectives", note: "Original plan notes" });
    expect(text(prescriptionValue())).toBe("غير مسجّلة");
    expect(text(render())).toContain("Recorded baseline objectives");
    expect(text(render())).toContain("Original plan notes");
    expect(row).toEqual(before);
    expect(writes()).toEqual([]);
  });
});

describe("PatientOrtho parent grants and opaque form lifetimes (source gate, UNRUN)", () => {
  it.each([{ key: "ortho" as const, status: 401 }, { key: "patient" as const, status: 403 }])(
    "existing package callback withdraws accepted case/photo/saved references before $key $status (preimage counterfactual, UNRUN)", async ({ key, status }) => {
      // This one test deliberately uses only exports, props and visible semantics
      // that already exist in the pinned preimage. Its renderer accepts both the
      // old direct PatientOrtho and the new provider/workspace structure.
      // Negative-control execution remains UNRUN: later overlay PatientOrtho.tsx
      // from pinned main e66a2b48e2bb2a7714a35d293a9ece9824e27e3f on the full current-main source tree, and run only
      // this named test. The expected failure is stale case/photo/saved content
      // below after onChanged, not a missing new selector, hook or export.
      const row = fixture(19, { photosVisible: true, adjustments: [{ id: 51, visitId: 61, visitSigned: false,
        doneOn: "2026-10-04", phase: "working", upperWire: "014 NiTi", lowerWire: "012 NiTi",
        elastics: "class_ii", elasticNote: "synthetic prior regimen", done: "accepted clinical reference", nextWeeks: 6,
        note: null, recordedBy: "synthetic doctor", photos: [{ id: 91, title: "accepted-photo-reference",
          isImage: true, photoStage: "progress", photoView: null, takenOn: "2026-10-04" }] }] });
      const accept = async () => {
        const current = pair(); respond(current.ortho, { cases: [row] }); respond(current.patient, contact()); await flush();
      };
      render(); await accept();
      expect(text(render())).toContain("accepted-case-a");
      click(button("⚡ سجّل شدّة وجلسة جديدة الآن"));
      edit("ما نُفّذ في الشدّة", "synthetic submitted adjustment");
      const saving = submit(); expect(writes()).toHaveLength(1);
      respond(writes()[0], { id: 81, visitId: 61 }); await saving; await flush(); await accept();
      const accepted = render();
      expect(text(accepted)).toContain("الجلسة القادمة المقترحة");
      expect(elements(accepted).some((node) => node.type === "a" && node.props.href === "/api/documents/91")).toBe(true);
      expect(elements(accepted).some((node) => node.type === "img" && node.props.alt === "accepted-photo-reference")).toBe(true);
      expect(elements(accepted).some((node) => node.type === "button" && text(node).includes("وقّع الزيارة"))).toBe(true);
      expect(hooks.existingRefresh).toBeTypeOf("function");
      const existingCallback = hooks.existingRefresh!; existingCallback();
      const withdrawn = () => {
        const tree = render();
        expect(text(tree)).not.toMatch(/accepted-case-a|accepted clinical reference|الجلسة القادمة المقترحة/);
        expect(elements(tree).filter((node) => ["img", "a", "form", "input", "select", "textarea"].includes(String(node.type)))).toEqual([]);
        expect(elements(tree).filter((node) => node.type === "button" && /وقّع الزيارة|فتح حالة تقويم جديدة|سجّل شدّة/.test(text(node)))).toEqual([]);
      };
      // Decisive old-source failure: pre-fix load() sets loading but keeps rows,
      // document links, sign controls and saved-next-appointment data rendered.
      withdrawn();
      const current = pair(); const peer = key === "ortho" ? "patient" : "ortho";
      current[key].headers(status); await flush(); withdrawn();
      expect(current[key].json).not.toHaveBeenCalled(); expect(current[peer].json).not.toHaveBeenCalled();
      respond(current[peer], peer === "ortho" ? { cases: [row] } : contact()); await flush(); withdrawn();
      expect(writes()).toHaveLength(1); expect(hooks.retiredWrites).toBe(0);
    },
  );

  it.each([
    { key: "ortho" as const, status: 401 }, { key: "ortho" as const, status: 403 },
    { key: "patient" as const, status: 401 }, { key: "patient" as const, status: 403 },
  ])("$key $status denies at headers before either body or a stalled peer", async ({ key, status }) => {
    await mount(); adjustment(); addPhoto(); const current = refresh();
    const peer = key === "ortho" ? "patient" : "ortho";
    current[key].headers(status); await flush(); hidden("denied");
    expect(current[key].json).not.toHaveBeenCalled(); expect(current[peer].json).not.toHaveBeenCalled();
    expect(current.ortho.init?.signal?.aborted).toBe(true); expect(current.patient.init?.signal?.aborted).toBe(true);
    respond(current[peer], peer === "ortho" ? { cases: [fixture()] } : contact()); await flush(); hidden("denied");
    expect(current[peer].json).not.toHaveBeenCalled(); expect(writes()).toEqual([]); expect(revokeURL).not.toHaveBeenCalled();
    await retry(); expect(control("ما نُفّذ في الشدّة").props.value).toBe("private-draft adjustment");
    expect(createURL).toHaveBeenCalledTimes(1); expect(revokeURL).not.toHaveBeenCalled();
  });

  it.each(["ortho", "patient"] as const)("%s denial cannot wait for a successful peer body", async (key) => {
    await mount(); const current = refresh(); const peer = key === "ortho" ? "patient" : "ortho";
    current[peer].headers(200); await flush(); expect(current[peer].json).toHaveBeenCalledOnce();
    current[key].headers(403); await flush(); hidden("denied"); expect(current[key].json).not.toHaveBeenCalled();
    current[peer].body(peer === "ortho" ? { cases: [fixture()] } : contact()); await flush(); hidden("denied");
    expect(hooks.retiredWrites).toBe(0); expect(writes()).toEqual([]);
  });

  it("bounds an incomplete clinical read and rejects its late body after fresh retry", async () => {
    await mount(); adjustment(); const before = fields(); const old = refresh();
    old.ortho.headers(200); respond(old.patient, contact()); await flush(); hidden("loading");
    await vi.advanceTimersByTimeAsync(READ_BOUND_MS + 1); await flush(); hidden("error");
    expect(old.ortho.init?.signal?.aborted).toBe(true); await retry(); expect(fields()).toEqual(before);
    old.ortho.body({ cases: [fixture(19, { bracketSystem: "retired-timeout-body" })] }); await flush();
    expect(text(render())).not.toContain("retired-timeout-body"); expect(hooks.retiredWrites).toBe(0);
  });

  it("bounds the independent contact read without withdrawing valid clinical work or allowing booking", async () => {
    await mount(); adjustment(); const saving = submit(); respond(writes()[0], { id: 81 }); await saving; await flush(); await grant();
    expect(button("📅 حجز الموعد المقترح الآن").props.disabled).not.toBe(true);
    const current = refresh(); respond(current.ortho, { cases: [fixture()] }); await flush();
    expect(workspace().props["data-read-state"]).toBe("ready");
    expect(text(render())).toContain("accepted-case-a"); expect(button("📅 حجز الموعد المقترح الآن").props.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(READ_BOUND_MS + 1); await flush();
    expect(current.patient.init?.signal?.aborted).toBe(true); expect(workspace().props["data-read-state"]).toBe("ready");
    respond(current.patient, contact()); await flush();
    expect(button("📅 حجز الموعد المقترح الآن").props.disabled).toBe(true);
    expect(elements(render()).filter((node) => node.type === "a" && String(node.props.href).includes("wa.me"))).toEqual([]);
    refresh(); await grant(); expect(button("📅 حجز الموعد المقترح الآن").props.disabled).not.toBe(true);
    expect(writes()).toHaveLength(1); expect(hooks.retiredWrites).toBe(0);
  });

  it.each(["patient", "principal", "permissions"] as const)("committed %s A→B→A retires drafts, old handlers and outstanding responses", async (kind) => {
    await mount(); const oldForm = adjustment(); const oldInput = control("ما نُفّذ في الشدّة"); addPhoto();
    const old = refresh(); old.ortho.headers(200); old.patient.headers(200); await flush();
    const original = hooks.session;
    if (kind === "patient") patientId = 20;
    else if (kind === "principal") hooks.session = { ...original!, username: "synthetic-ortho-b" };
    else hooks.session = { ...original!, permissions: { ...original!.permissions!, canEditPlans: false } };
    render(); hidden("loading");
    if (kind === "patient") patientId = 19; else hooks.session = original;
    render(); hidden("loading");
    expect(revokeURL).toHaveBeenCalledExactlyOnceWith("blob:synthetic-ortho-1");
    const current = pair(); expect(current.ortho.id).not.toBe(old.ortho.id);
    current.patient.headers(403); await flush(); hidden("denied");
    (oldInput.props.onChange as (event: unknown) => void)({ target: { value: "stale-handler-write" } });
    await submit(oldForm); old.ortho.body({ cases: [fixture()] }); old.patient.body(contact()); await flush(); hidden("denied");
    expect(writes()).toEqual([]); expect(hooks.retiredWrites).toBe(0);
    await retry(); click(button("⚡ سجّل شدّة وجلسة جديدة الآن"));
    expect(control("ما نُفّذ في الشدّة").props.value).toBe("");
    expect(elements(render()).filter((node) => node.type === "img")).toEqual([]);
  });

  it("displayName changes preserve exact current values/files without another read", async () => {
    await mount(); adjustment(); const file = addPhoto(); edit("وجه الصورة", "intraoral_frontal");
    edit("دور صور الجلسة", "progress"); edit("أسابيع حتى الشدّة القادمة", "5");
    const before = fields(); const count = requests.length;
    hooks.session = { ...hooks.session!, displayName: "Renamed presentation only" }; render(); await flush();
    expect(fields()).toEqual(before); expect(requests).toHaveLength(count);
    expect(createURL).toHaveBeenCalledExactlyOnceWith(file); expect(revokeURL).not.toHaveBeenCalled();
  });

  it("restores opaque adjustment drafts and exact queued File ownership while old view handlers stay inert", async () => {
    await mount(); adjustment(); const first = addPhoto("one.png"); const second = addPhoto("two.png");
    const oldInput = control("ما نُفّذ في الشدّة"); const oldForm = form(); const before = fields();
    await failClinical(); expect(revokeURL).not.toHaveBeenCalled();
    await retry(); expect(fields()).toEqual(before);
    await submit(oldForm); (oldInput.props.onChange as (event: unknown) => void)({ target: { value: "retired edit" } }); render();
    expect(fields()).toEqual(before); expect(writes()).toEqual([]); expect(hooks.retiredWrites).toBe(0);
    const pending = submit(); const command = writes()[0]; expect(command.url).toBe("/api/ortho/41");
    respond(command, { id: 81 }); await flush();
    const upload = writes().filter((one) => one.url.endsWith("/documents"))[0]; expect(upload).toBeDefined();
    expect((upload.init!.body as FormData).get("file")).toBe(first);
    respond(upload, {}); await flush();
    const next = writes().filter((one) => one.url.endsWith("/documents"))[1]; expect(next).toBeDefined();
    expect((next.init!.body as FormData).get("file")).toBe(second);
    respond(next, {}); await pending; await flush();
    expect(createURL).toHaveBeenCalledTimes(2); expect(revokeURL.mock.calls).toEqual([["blob:synthetic-ortho-1"], ["blob:synthetic-ortho-2"]]);
    unmount(); expect(revokeURL).toHaveBeenCalledTimes(2); expect(hooks.retiredWrites).toBe(0);
  });

  it("preserves new-case and baseline values outside unavailable rendered views", async () => {
    await mount(true); click(button("+ فتح حالة تقويم جديدة")); edit("نظام البراكيت", "private-draft bracket");
    edit("المدة المتوقعة", "27"); const newDraft = fields(); const oldNewForm = form();
    await failClinical(); await retry(true); expect(fields()).toEqual(newDraft); await submit(oldNewForm); expect(writes()).toEqual([]);
    click(button("✕ إغلاق النموذج")); click(button("تسجيل حالة سابقة (قبل النظام)")); await flush();
    edit("النظام المالي السابق", "prepaid_included"); edit("المطاطات الحالية", "private-draft baseline");
    edit("الطبيب المسؤول", "71"); edit("الأهداف المتبقية", "private-draft objectives");
    const baselineDraft = fields(); const oldBaseline = form(); await failClinical(); await retry(true);
    expect(fields()).toEqual(baselineDraft); await submit(oldBaseline); expect(writes()).toEqual([]);
    expect(executed.has("NewCase")).toBe(true); expect(executed.has("LegacyBaselineForm")).toBe(true);
  });

  it.each(["ortho", "patient"] as const)("paired %s denial during a pending save stops uploads, stale errors and success callbacks", async (key) => {
    await mount(); adjustment(); addPhoto(); const oldForm = form();
    const pending = submit(oldForm); const command = writes()[0]; command.headers(200); await flush();
    expect(command.json).toHaveBeenCalledOnce(); const current = refresh(); current[key].headers(403); await flush(); hidden("denied");
    command.body({ id: 81, visitId: 61 }); await pending; await flush(); hidden("denied");
    expect(writes()).toHaveLength(1); expect(text(render())).not.toContain("الجلسة القادمة المقترحة");
    expect(text(render())).not.toContain("تعذّر الاتصال"); expect(hooks.retiredWrites).toBe(0);
    await retry(); expect(elements(render()).some((node) => node.props["data-testid"] === "ortho-write-uncertain")).toBe(true);
    await submit(oldForm); await submit(); await flush(); expect(writes()).toHaveLength(1);
    expect(createURL).toHaveBeenCalledOnce(); expect(revokeURL).not.toHaveBeenCalled();
  });

  it("stops a photo chain when denial arrives during its first upload, without stale error publication", async () => {
    await mount(); adjustment(); addPhoto("one.png"); addPhoto("two.png"); const pending = submit();
    respond(writes()[0], { id: 81 }); await flush(); const upload = writes()[1]; expect(upload.url).toBe("/api/patients/19/documents");
    const current = refresh(); current.patient.headers(401); await flush(); hidden("denied");
    upload.fail("stale upload error must stay private"); await pending; await flush(); hidden("denied");
    expect(writes()).toHaveLength(2); expect(text(render())).not.toContain("stale upload error");
    expect(text(render())).not.toContain("أعد المحاولة من المستندات"); expect(hooks.retiredWrites).toBe(0);
  });

  it.each(["adjustment", "first upload"] as const)("authorized missing-case read stops the next upload after deferred %s completion", async (phase) => {
    await mount(); adjustment(); const first = addPhoto("one.png"); const second = addPhoto("two.png");
    const oldForm = form(); const before = fields(); const pending = submit(oldForm);
    const command = writes()[0];
    if (phase === "first upload") {
      respond(command, { id: 81 }); await flush();
      expect(writes()).toHaveLength(2);
      expect((writes()[1].init!.body as FormData).get("file")).toBe(first);
    }
    refresh(); await grant(true);
    expect(elements(render()).filter((node) => node.type === "form" || node.type === "img")).toEqual([]);
    if (phase === "adjustment") respond(command, { id: 81 });
    else respond(writes()[1], {});
    await pending; await flush();
    expect(writes()).toHaveLength(phase === "adjustment" ? 1 : 2);
    expect(text(render())).not.toContain("الجلسة القادمة المقترحة");
    expect(revokeURL).not.toHaveBeenCalled();
    refresh(); await grant(); expect(fields()).toEqual(before);
    expect(elements(render()).some((node) => node.props["data-testid"] === "ortho-write-uncertain")).toBe(true);
    await submit(oldForm); await submit(); await flush();
    expect(writes()).toHaveLength(phase === "adjustment" ? 1 : 2);
    expect(createURL.mock.calls).toEqual([[first], [second]]); expect(revokeURL).not.toHaveBeenCalled();
    expect(hooks.retiredWrites).toBe(0);
  });

  it("a captured sign command cannot replay after confirmed success even before a fresh case read", async () => {
    const prior = fixture(); const row = fixture(19, { adjustments: [{ ...prior.adjustments[0],
      visitId: 61, visitSigned: false, doneOn: "2026-10-04" }] });
    render(); const current = pair(); respond(current.ortho, { cases: [row] }); respond(current.patient, contact()); await flush();
    const oldSign = button("وقّع الزيارة وأرسله للاستقبال"); const captured = oldSign.props.onClick as () => void;
    captured(); expect(writes()).toHaveLength(1); respond(writes()[0], { patientId: 19, invoiceId: null, invoiceCurrency: null, duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null }); await drain();
    // The completion flag must be read from the live draft before a render too.
    captured(); await flush(); expect(writes()).toHaveLength(1);
    expect(text(render())).toContain("وُقّعت زيارة اليوم");
    hidden("loading");
    captured(); await flush(); expect(writes()).toHaveLength(1);
    const pending = pair(); respond(pending.patient, contact()); respond(pending.ortho, {}, 503); await flush();
    hidden("error"); expect(text(render())).toContain("وُقّعت زيارة اليوم");
    click(control("إعادة تحميل كابينة التقويم"));
    const recovered = pair(); respond(recovered.patient, contact()); respond(recovered.ortho, { cases: [row] }); await flush();
    expect(workspace().props["data-read-state"]).toBe("ready");
    expect(text(render())).toContain("وُقّعت زيارة اليوم");
    expect(elements(render()).some((node) => node.type === "button" && text(node).includes("وقّع الزيارة وأرسله للاستقبال"))).toBe(false);
    captured(); await flush(); expect(writes()).toHaveLength(1);
  });

  it.each(["denial", "patient", "principal"] as const)("retires the successful-sign receipt on %s", async (replacement) => {
    const prior = fixture(); const row = fixture(19, { adjustments: [{ ...prior.adjustments[0],
      visitId: 61, visitSigned: false, doneOn: "2026-10-04" }] });
    render(); const initial = pair(); respond(initial.ortho, { cases: [row] }); respond(initial.patient, contact()); await flush();
    const sign = button("وقّع الزيارة وأرسله للاستقبال"); const captured = sign.props.onClick as () => void;
    captured(); respond(writes()[0], { patientId: 19, invoiceId: null, invoiceCurrency: null, duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null }); await flush();
    expect(text(render())).toContain("وُقّعت زيارة اليوم");
    if (replacement === "denial") { pair().patient.headers(403); await flush(); hidden("denied"); }
    else {
      if (replacement === "patient") patientId = 20;
      else hooks.session = { ...principalA(), username: "synthetic-ortho-b" };
      render(); hidden("loading");
    }
    expect(text(render())).not.toContain("وُقّعت زيارة اليوم");
    captured(); await flush(); expect(writes()).toHaveLength(1);
  });

  it.each([null, {}])("does not publish or replay a malformed successful sign %j", async (payload) => {
    const prior = fixture(); const row = fixture(19, { adjustments: [{ ...prior.adjustments[0],
      visitId: 61, visitSigned: false, doneOn: "2026-10-04" }] });
    render(); const initial = pair(); respond(initial.ortho, { cases: [row] }); respond(initial.patient, contact()); await flush();
    const captured = button("وقّع الزيارة وأرسله للاستقبال").props.onClick as () => void;
    captured(); const stale = refresh(); respond(writes()[0], payload); await flush();
    hidden("error"); expect(text(render())).toContain("تعذّر تأكيد نتيجة التوقيع");
    expect(text(render())).not.toContain("وُقّعت زيارة اليوم");
    expect(stale.ortho.init?.signal?.aborted).toBe(true);
    expect(stale.patient.init?.signal?.aborted).toBe(true);
    respond(stale.ortho, { cases: [row] }); respond(stale.patient, contact()); await flush(); hidden("error");
    captured(); await flush(); expect(writes()).toHaveLength(1);
    click(control("إعادة تحميل كابينة التقويم"));
    const current = pair(); respond(current.patient, contact()); respond(current.ortho, { cases: [{ ...row,
      adjustments: [{ ...row.adjustments[0], visitSigned: true }] }] }); await flush();
    expect(workspace().props["data-read-state"]).toBe("ready");
    captured(); await flush(); expect(writes()).toHaveLength(1);
    expect(elements(render()).some((node) => node.type === "button" && text(node).includes("وقّع الزيارة وأرسله للاستقبال"))).toBe(false);
  });

  it("a captured booking submit cannot replay after confirmed success before or after rendering", async () => {
    await mount(); adjustment(); const saving = submit(); respond(writes()[0], { id: 81 }); await saving; await flush(); await grant();
    click(button("📅 حجز الموعد المقترح الآن")); edit("تاريخ الجلسة القادمة", "2026-12-12"); edit("وقت الجلسة القادمة", "17:45");
    const oldForm = form(); const booking = submit(oldForm); expect(writes()).toHaveLength(2);
    respond(writes()[1], {}); await booking;
    await submit(oldForm); await flush(); expect(writes()).toHaveLength(2);
    expect(text(render())).toContain("تم حجز الجلسة القادمة بنجاح");
    await submit(oldForm); expect(writes()).toHaveLength(2);
    expect(JSON.parse(String(writes()[1].init!.body))).toMatchObject({ patientId: 19, date: "2026-12-12", time: "17:45", durationMinutes: 15 });
  });

  it("Back retires the captured booking form and inputs synchronously and across reopening", async () => {
    await mount(); adjustment(); const saving = submit(); respond(writes()[0], { id: 81 }); await saving; await flush(); await grant();
    click(button("📅 حجز الموعد المقترح الآن")); edit("تاريخ الجلسة القادمة", "2026-12-12"); edit("وقت الجلسة القادمة", "17:45");
    const oldForm = form(); const oldDate = control("تاريخ الجلسة القادمة");
    const oldBack = button("رجوع").props.onClick as () => void;
    oldBack(); await submit(oldForm); expect(writes()).toHaveLength(1); render();
    click(button("📅 حجز الموعد المقترح الآن"));
    await submit(oldForm); oldBack();
    (oldDate.props.onChange as (event: unknown) => void)({ target: { value: "2027-01-01" } }); render();
    expect(control("تاريخ الجلسة القادمة").props.value).toBe("2026-12-12");
    expect(control("وقت الجلسة القادمة").props.value).toBe("17:45"); expect(writes()).toHaveLength(1);
    const current = submit(); expect(writes()).toHaveLength(2); respond(writes()[1], {}, 409); await current; await flush();
    expect(hooks.retiredWrites).toBe(0);
  });

  it.each([false, true])("withdraws saved booking data when its case disappears and restores the same draft (booked=%s)", async (booked) => {
    await mount(); adjustment(); const saving = submit(); respond(writes()[0], { id: 81, visitId: 61 }); await saving; await flush(); await grant();
    click(button("📅 حجز الموعد المقترح الآن")); edit("تاريخ الجلسة القادمة", "2026-12-12"); edit("وقت الجلسة القادمة", "17:45");
    const oldForm = form(); const oldDate = control("تاريخ الجلسة القادمة"); const beforeFields = fields();
    if (booked) { const booking = submit(); respond(writes()[1], {}); await booking; await flush(); }
    const oldLink = elements(render()).find((node) => node.type === "a" && String(node.props.href).includes("wa.me"))?.props.href;
    if (booked) expect(oldLink).toBeTypeOf("string");
    const count = writes().length; refresh(); await grant(true);
    const withdrawn = render();
    expect(elements(withdrawn).filter((node) => ["form", "input", "select", "textarea", "a"].includes(String(node.type)))).toEqual([]);
    expect(text(withdrawn)).not.toMatch(/الجلسة القادمة المقترحة|تم حجز الجلسة القادمة|وقّع الزيارة|2026-12-12|17:45/);
    expect(text(withdrawn)).toContain("احتُفظ بمسودة الموعد دون عرضها");
    await submit(oldForm); (oldDate.props.onChange as (event: unknown) => void)({ target: { value: "2027-01-01" } });
    refresh(); await grant();
    if (booked) {
      expect(text(render())).toContain("تم حجز الجلسة القادمة بنجاح");
      expect(elements(render()).find((node) => node.type === "a" && String(node.props.href).includes("wa.me"))?.props.href).toBe(oldLink);
    } else expect(fields()).toEqual(beforeFields);
    await submit(oldForm); await flush(); expect(writes()).toHaveLength(count); expect(hooks.retiredWrites).toBe(0);
  });

  it("confirmed save consumes the old draft and a genuinely new session inherits only the latest regimen", async () => {
    await mount(); adjustment(); edit("صنف المطاطات", "vertical"); edit("وصف المطاطات", "Updated regimen instructions");
    edit("أسابيع حتى الشدّة القادمة", "2"); edit("ما نُفّذ في الشدّة", "Prior session procedure");
    const oldForm = form(); const saving = submit(oldForm); respond(writes()[0], { id: 81 }); await saving; await flush();
    hidden("loading");
    const prior = fixture(); const updated = fixture(19, { adjustments: [{ ...prior.adjustments[0], id: 81,
      doneOn: "2026-10-04", elastics: "vertical", elasticNote: "Updated regimen instructions", nextWeeks: 2,
      done: "Prior session procedure" }] });
    const current = pair(); respond(current.ortho, { cases: [updated] }); respond(current.patient, contact()); await flush();
    click(button("⚡ سجّل شدّة وجلسة جديدة الآن"));
    expect(control("صنف المطاطات").props.value).toBe("vertical");
    expect(control("وصف المطاطات").props.value).toBe("Updated regimen instructions");
    expect(control("أسابيع حتى الشدّة القادمة").props.value).toBe("2");
    expect(control("ما نُفّذ في الشدّة").props.value).toBe("");
    await submit(oldForm); expect(writes()).toHaveLength(1);
    const next = submit(); expect(writes()).toHaveLength(2);
    expect(JSON.parse(String(writes()[1].init!.body))).toMatchObject({ elastics: "vertical", elasticNote: "Updated regimen instructions", nextWeeks: 2, done: "" });
    respond(writes()[1], {}, 409); await next; await flush(); expect(hooks.retiredWrites).toBe(0);
  });

  it.each(["new", "baseline", "adjustment"] as const)("latches duplicate same-turn %s submits before the disabled render", async (kind) => {
    await mount(kind !== "adjustment");
    if (kind === "new") click(button("+ فتح حالة تقويم جديدة"));
    else if (kind === "baseline") { click(button("تسجيل حالة سابقة (قبل النظام)")); await flush(); edit("النظام المالي السابق", "per_session"); }
    else adjustment();
    const view = form(); const first = submit(view); const duplicate = submit(view);
    expect(writes()).toHaveLength(1); respond(writes()[0], { message: "Synthetic ordinary rejection" }, 409);
    await Promise.all([first, duplicate]); await flush();
    expect(text(render())).toContain("Synthetic ordinary rejection"); expect(writes()).toHaveLength(1);
  });

  it.each([undefined, null, 0, -1, "81", 1.5])("unknown 2xx adjustment id %s cannot upload or automatically repost", async (id) => {
    await mount(); adjustment(); addPhoto(); const pending = submit(); respond(writes()[0], { id }); await pending; await flush();
    expect(writes()).toHaveLength(1); expect(elements(render()).some((node) => node.props["data-testid"] === "ortho-write-uncertain")).toBe(true);
    expect(text(render())).not.toContain("الجلسة القادمة المقترحة"); expect(revokeURL).not.toHaveBeenCalled();
    await failClinical(); await retry(); await submit(); await flush();
    expect(writes()).toHaveLength(1); expect(createURL).toHaveBeenCalledOnce(); expect(hooks.retiredWrites).toBe(0);
  });

  it("current successful-case data with a foreign patient identity cannot grant clinical controls", async () => {
    render(); const current = pair(); respond(current.ortho, { cases: [fixture(20)] }); respond(current.patient, contact()); await flush(); hidden("error");
    expect(writes()).toEqual([]); await retry(); expect(text(render())).toContain("accepted-case-a");
  });

  it("unmount aborts pending reads and ignores late errors and captured submission", async () => {
    await mount(); const oldForm = adjustment(); addPhoto(); const old = refresh(); old.ortho.headers(200); await flush();
    unmount(); expect(old.ortho.init?.signal?.aborted).toBe(true); expect(old.patient.init?.signal?.aborted).toBe(true);
    old.ortho.body({ cases: [fixture()] }); old.patient.fail("retired patient error"); await submit(oldForm); await drain();
    expect(scopes.size).toBe(0); expect(hooks.retiredWrites).toBe(0); expect(writes()).toEqual([]);
    expect(revokeURL).toHaveBeenCalledExactlyOnceWith("blob:synthetic-ortho-1");
  });
});
