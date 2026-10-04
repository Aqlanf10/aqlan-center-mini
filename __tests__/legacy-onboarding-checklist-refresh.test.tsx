import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientOrtho, type AdjustmentForm } from "../components/PatientOrtho";
import { LegacyOnboardingChecklist, LEGACY_ONBOARDING_READ_TIMEOUT_MS } from "../components/LegacyOnboardingChecklist";
import { OrthoPackageLink } from "../components/OrthoPackageLink";
import type { SessionInfo } from "../components/SessionProvider";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../lib/doctor-permissions";
import { legacyOnboarding } from "../lib/legacy-onboarding";

type Owner = {
  values: unknown[]; cursor: number; live: boolean;
  effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>;
  memos: Map<number, { deps?: readonly unknown[]; value: unknown }>;
};
const hooks = vi.hoisted(() => ({
  current: null as Owner | null, changed: false, retiredWrites: 0,
  layout: [] as Array<() => void>, passive: [] as Array<() => void>,
  session: null as SessionInfo | null,
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic", useSetting: () => "" }));
vi.mock("../components/PatientCeph", () => ({ PatientCeph: () => null }));
vi.mock("../components/PatientDiagnosis", () => ({ PatientDiagnosis: () => null }));
vi.mock("../components/WebCephRecordsGrid", () => ({ WebCephRecordsGrid: () => null }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const owner = () => { if (!hooks.current) throw new Error("Hook outside a component lifetime"); return hooks.current; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const scope = owner(); const index = scope.cursor++; const previous = scope.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); scope.memos.set(index, { deps, value }); return value;
  };
  const effect = (callback: () => void | (() => void), deps: readonly unknown[] | undefined, layout: boolean) => {
    const scope = owner(); const index = scope.cursor++; const previous = scope.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    const entry = { deps, cleanup: undefined as (() => void) | undefined };
    scope.effects.set(index, entry);
    (layout ? hooks.layout : hooks.passive).push(() => {
      if (!scope.live) return;
      previous?.cleanup?.(); entry.cleanup = callback() || undefined;
    });
  };
  return { ...react,
    useState: (initial: unknown) => {
      const scope = owner(); const index = scope.cursor++;
      if (!(index in scope.values)) scope.values[index] = typeof initial === "function" ? initial() : initial;
      return [scope.values[index], (update: unknown) => {
        // React ignores retired setters; count them as well so stale-response
        // assertions prove the product guard, rather than only this simulation.
        if (!scope.live) { hooks.retiredWrites += 1; return; }
        const next = typeof update === "function" ? update(scope.values[index]) : update;
        if (!Object.is(next, scope.values[index])) hooks.changed = true;
        scope.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => {
      const scope = owner(); const index = scope.cursor++;
      if (!(index in scope.values)) scope.values[index] = { current: initial };
      return scope.values[index];
    },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(callback, deps, false),
    useLayoutEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(callback, deps, true),
  };
});

type Element = ReactElement<Record<string, unknown>>;
type Case = ComponentProps<typeof AdjustmentForm>["caseRow"];
type Component = (props: Record<string, unknown>) => ReactNode;
const INCLUDED = "الشدّة اليوم مشمولة باتفاق الأقساط — بلا فاتورة مستقلة.";
const OUTSIDE = "الشدّة اليوم تحتاج قرار فوترة (خارج العقد أو تُفوتر كل جلسة).";
const CHECKLIST_LABEL = "تهيئة الحالة السابقة";
const PACKAGE_LABEL = "اتفاق التقويم";
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
type MockResponse = ReturnType<typeof response>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const fixture = (overrides: Partial<Case> = {}): Case => ({
  id: 41, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null,
  status: "active", phase: "working", startDate: "2026-01-01", plannedMonths: 18,
  upperWire: null, lowerWire: null, planId: 51, retainer: null, retainerOn: null, note: null,
  closedAt: null, closedBy: null, closedNote: null, baselineKind: "legacy", baselineRecordedAt: "2026-10-01",
  elastics: null, responsibleDoctorName: null, legacyFinancialMode: "installments", remainingObjectives: null,
  adjustments: [], progress: { monthsElapsed: 9, monthsPlanned: 18, monthsRemaining: 9, percent: 50,
    overdue: false, adjustments: 0, lastAdjustment: null, daysSinceLast: null }, ...overrides,
});
const classification = (funded: boolean, caseId = 41) => ({ onboarding: {
  caseId, ...legacyOnboarding({ legacy: true, financialMode: "installments", openingCurrencies: [],
    activeArrangementCurrencies: [], fundedPlan: funded }),
} });
const plans = (patientId: number) => ({ plans: [{ id: 51, patientId, title: "Synthetic agreement",
  status: "active", installments: [{ id: 61 }] }] });

let patientId: number;
let caseRow: Case;
let classifierRead: (id: number) => Promise<MockResponse>;
let casesRead: (id: number) => Promise<MockResponse>;
let plansRead: (id: number) => Promise<MockResponse>;
let patch: (body: { planId: number | null }) => Promise<MockResponse>;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<MockResponse>>();
const owners = new Map<string, Owner>();
let seen = new Set<string>();
let parentTree: ReactNode;
let componentIds = new Map<unknown, number>();

function retire(scope: Owner) {
  scope.live = false;
  scope.effects.forEach((entry) => entry.cleanup?.());
  scope.effects.clear();
}
function unmount() {
  owners.forEach(retire); owners.clear(); hooks.layout = []; hooks.passive = []; hooks.current = null;
}
function execute(component: Component, props: Record<string, unknown>, path: string): ReactNode {
  seen.add(path);
  let scope = owners.get(path);
  if (!scope) {
    scope = { values: [], cursor: 0, live: true, effects: new Map(), memos: new Map() };
    owners.set(path, scope);
  }
  scope.cursor = 0; const previous = hooks.current; hooks.current = scope;
  try { return component(props); } finally { hooks.current = previous; }
}

// Only these real component families execute. Their direct keyed scope wrappers
// also execute, with distinct hook stores and commit cleanup; clinical editors
// remain ordinary element nodes. The parent's onChanged callback is never mocked
// or invoked manually: every refresh below starts in the real link/unlink handler.
function expand(node: ReactNode, path: string, scopedChild = false): ReactNode {
  if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${index}`));
  if (!node || typeof node !== "object" || !("props" in node)) return node;
  const element = node as Element;
  const identity = `${path}:${String(element.key ?? "")}`;
  if (typeof element.type === "function") {
    const selected = element.type === PatientOrtho || element.type === LegacyOnboardingChecklist || element.type === OrthoPackageLink;
    if (!selected && !scopedChild) return element;
    if (!componentIds.has(element.type)) componentIds.set(element.type, componentIds.size);
    const ownerPath = `${identity}/component-${componentIds.get(element.type)}`;
    return expand(execute(element.type as Component, element.props, ownerPath), `${ownerPath}/result`, true);
  }
  return { ...element, props: { ...element.props, children: expand(element.props.children as ReactNode, `${identity}/children`) } };
}
function render(): ReactNode {
  let tree: ReactNode = null; let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("Checklist composition did not settle");
    hooks.changed = false; seen = new Set();
    parentTree = execute(() => PatientOrtho({ patientId }), {}, "patient-ortho");
    tree = expand(parentTree, "patient-ortho/result");
    for (const [key, scope] of owners) if (!seen.has(key)) { retire(scope); owners.delete(key); }
    hooks.layout.splice(0).forEach((effect) => effect());
    hooks.passive.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
}
const section = (label: string, tree = render()) => elements(tree).find((node) => node.type === "section" && node.props["aria-label"] === label);
const checklist = () => section(CHECKLIST_LABEL);
function checklistProps() {
  render(); const matches = elements(parentTree).filter((node) => node.type === LegacyOnboardingChecklist);
  expect(matches).toHaveLength(1); return matches[0].props;
}
function button(label: string, within: ReactNode = render()) {
  const matches = elements(within).filter((node) => node.type === "button" && text(node).trim() === label);
  expect(matches).toHaveLength(1); return matches[0];
}
function click(node: Element) { expect(node.props.disabled).not.toBe(true); (node.props.onClick as () => void)(); }
function changeAgreement(next: number | null) {
  if (next === null) { click(button("فكّ الربط", section(PACKAGE_LABEL))); return; }
  const select = elements(section(PACKAGE_LABEL)).find((node) => node.type === "select");
  expect(select).toBeDefined();
  (select!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: String(next) } });
  click(button("اربط", section(PACKAGE_LABEL)));
}
function retryChecklist() {
  const buttons = elements(checklist()).filter((node) => node.type === "button");
  expect(buttons).toHaveLength(1); click(buttons[0]);
}
function unknown(tree: ReactNode = checklist()) {
  expect(text(tree)).not.toMatch(/الشدّة اليوم مشمولة|الشدّة اليوم تحتاج قرار فوترة|مستحق جديد|بلا رسوم|تهيئة الحالة السابقة مكتملة|تهيئة الحالة السابقة — خطوات ناقصة|خطة أقساط مربوطة بالحالة/);
  expect(elements(tree).filter((node) => node.type === "li")).toEqual([]);
}
async function drain() { for (let index = 0; index < 40; index += 1) await Promise.resolve(); }
async function flush() { for (let pass = 0; pass < 4; pass += 1) { await drain(); render(); } }
async function mount() { render(); await flush(); }
const classifierCalls = () => fetchMock.mock.calls.filter(([url]) => url.endsWith("/legacy-onboarding"));
const writes = () => fetchMock.mock.calls.filter(([, init]) => !!init?.method);

beforeEach(() => {
  unmount(); componentIds = new Map(); hooks.changed = false; hooks.retiredWrites = 0;
  hooks.session = { username: "synthetic-a", role: "doctor", permissions: { ...DEFAULT_DOCTOR_PERMISSIONS } };
  patientId = 19; caseRow = fixture(); fetchMock.mockReset();
  classifierRead = async () => response(classification(caseRow.planId !== null, caseRow.id));
  casesRead = async () => response({ cases: [caseRow] });
  plansRead = async (id) => response(plans(id));
  patch = async ({ planId }) => { caseRow = { ...caseRow, planId }; return response({ ok: true }); };
  fetchMock.mockImplementation(async (url, init) => {
    if (url === "/api/ortho/41" && init?.method === "PATCH") return patch(JSON.parse(String(init.body)));
    if (init?.method) throw new Error(`Unexpected synthetic mutation: ${url}`);
    const legacy = url.match(/^\/api\/patients\/(\d+)\/legacy-onboarding$/);
    if (legacy) return classifierRead(Number(legacy[1]));
    if (url.startsWith("/api/ortho?patientId=")) return casesRead(Number(url.split("=")[1]));
    if (url.startsWith("/api/plans?patientId=")) return plansRead(Number(url.split("=")[1]));
    if (/^\/api\/patients\/\d+$/.test(url)) return response({ patient: { fullName: "Synthetic patient", phone: null } });
    throw new Error(`Unexpected synthetic read: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("actual orthodontic parent, checklist and package composition", () => {
  it("keeps the classifier unknown until its own current read succeeds", async () => {
    const pending = deferred<MockResponse>(); classifierRead = () => pending.promise;
    await mount(); expect(checklist()).toBeDefined(); unknown();
    expect(text(section(PACKAGE_LABEL))).toContain("✓ باقة تقويم");
    expect(classifierCalls()).toHaveLength(1);
    expect(classifierCalls()[0]).toEqual(["/api/patients/19/legacy-onboarding", {
      cache: "no-store", signal: expect.any(AbortSignal),
    }]);
    expect(checklistProps()).toMatchObject({ patientId: 19, caseId: 41, planId: 51 });
    pending.resolve(response(classification(true))); await flush();
    expect(text(checklist())).toContain(INCLUDED); expect(text(checklist())).toContain("✓ تهيئة الحالة السابقة مكتملة");
    expect(writes()).toEqual([]);
  });

  it.each([51, null])("refreshes the same case after a real %s agreement transition", async (initialPlan) => {
    caseRow = fixture({ planId: initialPlan }); await mount();
    expect(text(checklist())).toContain(initialPlan === null ? OUTSIDE : INCLUDED);
    const pending = deferred<MockResponse>(); classifierRead = () => pending.promise;
    const next = initialPlan === null ? 51 : null;
    changeAgreement(next); await flush();
    unknown(); expect(classifierCalls().length).toBeGreaterThan(1);
    expect(checklistProps()).toMatchObject({ patientId: 19, caseId: 41, planId: next });
    expect(writes()).toEqual([["/api/ortho/41", { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: next }) }]]);
    pending.resolve(response(classification(next !== null))); await flush();
    expect(text(checklist())).toContain(next === null ? OUTSIDE : INCLUDED);
    expect(text(checklist())).not.toContain(next === null ? INCLUDED : OUTSIDE);
    expect(text(section(PACKAGE_LABEL))).toContain(next === null ? "لا اتفاق مالي مربوط بالحالة" : "✓ باقة تقويم");
  });

  it.each([51, null])("refreshes a confirmed write with unchanged planId=%s while the cases reload stalls and fails", async (initialPlan) => {
    caseRow = fixture({ planId: initialPlan }); await mount();
    const before = checklistProps(); const casesPending = deferred<MockResponse>(); const classifierPending = deferred<MockResponse>();
    casesRead = () => casesPending.promise; classifierRead = () => classifierPending.promise;
    changeAgreement(initialPlan === null ? 51 : null); await flush(); unknown();
    const after = checklistProps();
    expect(after.planId).toBe(initialPlan); expect(after.caseId).toBe(before.caseId);
    expect(after.refreshRevision).toBe(Number(before.refreshRevision) + 1);
    expect(classifierCalls()).toHaveLength(2);
    classifierPending.resolve(response(classification(initialPlan === null))); await flush();
    expect(text(checklist())).toContain(initialPlan === null ? INCLUDED : OUTSIDE);
    casesPending.resolve(response({ message: "Synthetic cases unavailable" }, 503)); await flush();
    expect(text(render())).toContain("Synthetic cases unavailable");
    expect(text(checklist())).toContain(initialPlan === null ? INCLUDED : OUTSIDE);
    expect(classifierCalls()).toHaveLength(2); expect(writes()).toHaveLength(1);
  });

  it("does not invalidate the classifier for an unsuccessful package mutation", async () => {
    await mount(); patch = async () => response({ message: "Synthetic refusal" }, 409);
    const before = checklistProps(); changeAgreement(null); await flush();
    expect(text(checklist())).toContain(INCLUDED); expect(classifierCalls()).toHaveLength(1);
    expect(checklistProps().refreshRevision).toBe(before.refreshRevision);
    expect(text(section(PACKAGE_LABEL))).toContain("Synthetic refusal"); expect(writes()).toHaveLength(1);
  });

  it("preserves canonical INCLUDED when only the independent generic plans read fails", async () => {
    plansRead = async () => response({}, 503); await mount();
    expect(text(section(PACKAGE_LABEL))).toContain("تعذّر تحميل اتفاق التقويم");
    expect(text(section(PACKAGE_LABEL))).not.toContain("✓ باقة تقويم");
    expect(text(checklist())).toContain(INCLUDED); expect(text(checklist())).toContain("✓ تهيئة الحالة السابقة مكتملة");
    expect(writes()).toEqual([]);
  });
});

describe("classifier failures and bounded retry", () => {
  it.each([401, 403, 503])("retires old labels on confirmed refresh HTTP %s before reading an error body", async (status) => {
    await mount(); casesRead = async () => response({}, 503);
    const body = deferred<unknown>(); const json = vi.fn(() => body.promise);
    classifierRead = async () => ({ ...response(null, status), json });
    changeAgreement(null); await flush(); unknown(); expect(json).not.toHaveBeenCalled();
    expect(checklist()).toBeDefined(); expect(elements(checklist()).some((node) => node.props.role === "status")).toBe(true);
    const count = classifierCalls().length;
    if (status === 503) {
      const pending = deferred<MockResponse>(); classifierRead = () => pending.promise;
      retryChecklist(); unknown(); await flush(); unknown();
      expect(classifierCalls()).toHaveLength(count + 1);
      pending.resolve(response(classification(false))); await flush(); expect(text(checklist())).toContain(OUTSIDE);
    } else expect(elements(checklist()).filter((node) => node.type === "button")).toEqual([]);
    expect(writes()).toHaveLength(1);
  });

  it.each(["fetch", "body"])("retires labels after a %s failure and retries only the canonical GET", async (stage) => {
    await mount(); casesRead = async () => response({}, 503);
    classifierRead = stage === "fetch"
      ? async () => { throw new Error("Synthetic offline"); }
      : async () => ({ ...response(null), json: async () => { throw new Error("Synthetic malformed JSON"); } });
    changeAgreement(null); await flush(); unknown();
    const before = fetchMock.mock.calls.length;
    classifierRead = async () => response(classification(false)); retryChecklist(); await flush();
    expect(fetchMock.mock.calls.slice(before).map(([url, init]) => [url, init?.method ?? "GET"]))
      .toEqual([["/api/patients/19/legacy-onboarding", "GET"]]);
    expect(text(checklist())).toContain(OUTSIDE); expect(writes()).toHaveLength(1);
  });

  it.each([42, undefined])("rejects a successful classifier read whose case identity is %s", async (caseId) => {
    classifierRead = async () => response({ onboarding: { ...classification(true).onboarding, caseId } });
    await mount(); unknown();
    classifierRead = async () => response(classification(true)); retryChecklist(); await flush();
    expect(text(checklist())).toContain(INCLUDED); expect(writes()).toEqual([]);
  });

  it.each([
    null, { legacy: "true" }, { complete: "true" }, { adjustmentClass: "UNKNOWN" },
    { steps: null }, { steps: [null] }, { steps: [{ key: "plan", done: "false" }] },
  ])("does not turn malformed canonical data into definitive labels: %j", async (invalid) => {
    classifierRead = async () => response({ onboarding: invalid === null ? null : { ...classification(true).onboarding, ...invalid } });
    await mount(); unknown(); expect(checklist()).toBeDefined();
    expect(elements(checklist()).filter((node) => node.type === "button")).toHaveLength(1);
    expect(writes()).toEqual([]);
  });

  it.each(["fetch", "body"])("times out a classifier %s stall and ignores its late result after retry", async (stage) => {
    vi.useFakeTimers(); const request = deferred<MockResponse>(); const body = deferred<unknown>();
    classifierRead = stage === "fetch" ? () => request.promise : async () => ({ ...response(null), json: () => body.promise });
    await mount(); unknown(); const signal = classifierCalls()[0][1]?.signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(LEGACY_ONBOARDING_READ_TIMEOUT_MS); unknown();
    expect(signal.aborted).toBe(true);
    classifierRead = async () => response(classification(true)); retryChecklist(); await flush();
    request.resolve(response(classification(false))); body.resolve(classification(false)); await flush();
    expect(text(checklist())).toContain(INCLUDED); expect(text(checklist())).not.toContain(OUTSIDE);
    expect(vi.getTimerCount()).toBe(0); expect(writes()).toEqual([]);
  });
});

describe("classifier scope and stale completion retirement", () => {
  it.each(["headers", "body"])("an older delayed %s result cannot restore INCLUDED after a real unlink", async (stage) => {
    const request = deferred<MockResponse>(); const body = deferred<unknown>(); const json = vi.fn(() => body.promise);
    classifierRead = stage === "headers" ? () => request.promise : async () => ({ ...response(null), json });
    await mount(); const oldSignal = classifierCalls()[0][1]?.signal as AbortSignal;
    unknown(); classifierRead = async () => response(classification(false));
    changeAgreement(null); await flush(); expect(text(checklist())).toContain(OUTSIDE);
    expect(oldSignal.aborted).toBe(true);
    request.resolve({ ...response(null), json }); body.resolve(classification(true)); await flush();
    expect(text(checklist())).toContain(OUTSIDE); expect(text(checklist())).not.toContain(INCLUDED);
    expect(json).toHaveBeenCalledTimes(stage === "headers" ? 0 : 1); expect(hooks.retiredWrites).toBe(0);
    expect(writes()).toHaveLength(1);
  });

  it("an older delayed denial cannot replace the current classifier after a real link", async () => {
    caseRow = fixture({ planId: null }); const old = deferred<MockResponse>(); classifierRead = () => old.promise;
    await mount(); classifierRead = async () => response(classification(true)); changeAgreement(51); await flush();
    expect(text(checklist())).toContain(INCLUDED);
    old.resolve(response({}, 403)); await flush();
    expect(text(checklist())).toContain(INCLUDED); expect(hooks.retiredWrites).toBe(0); expect(writes()).toHaveLength(1);
  });

  it.each(["patient", "principal", "role", "plan-permission", "payment-permission", "logout"])("retires accepted labels immediately on %s change", async (change) => {
    await mount(); expect(text(checklist())).toContain(INCLUDED);
    const original = hooks.session; const pending = deferred<MockResponse>(); classifierRead = () => pending.promise;
    if (change === "patient") patientId = 20;
    if (change === "principal") hooks.session = { ...original!, username: "synthetic-b" };
    if (change === "role") hooks.session = { ...original!, role: "reception" };
    if (change === "plan-permission") hooks.session = { ...original!, permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewPlans: false } };
    if (change === "payment-permission") hooks.session = { ...original!, permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewPatientPayments: true } };
    if (change === "logout") hooks.session = null;
    render(); unknown(); await flush(); unknown();
    expect(classifierCalls()).toHaveLength(change === "logout" ? 1 : 2);
    pending.resolve(response({}, 403)); await flush(); unknown();
    expect(writes()).toEqual([]); expect(hooks.retiredWrites).toBe(0);
  });

  it.each(["patient", "principal", "role", "plan-permission", "payment-permission", "logout"])("retires pending results and stale package handlers on %s change", async (change) => {
    await mount(); expect(text(checklist())).toContain(INCLUDED);
    const original = hooks.session; const staleButton = button("فكّ الربط", section(PACKAGE_LABEL));
    const old = deferred<MockResponse>(); classifierRead = () => old.promise;
    casesRead = async () => response({}, 503); changeAgreement(null); await flush(); unknown();
    const before = classifierCalls().length; const signal = classifierCalls()[before - 1][1]?.signal as AbortSignal;
    classifierRead = async () => response({}, 403);
    if (change === "patient") patientId = 20;
    if (change === "principal") hooks.session = { ...original!, username: "synthetic-b" };
    if (change === "role") hooks.session = { ...original!, role: "reception" };
    if (change === "plan-permission") hooks.session = { ...original!, permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewPlans: false } };
    if (change === "payment-permission") hooks.session = { ...original!, permissions: { ...DEFAULT_DOCTOR_PERMISSIONS, canViewPatientPayments: true } };
    if (change === "logout") hooks.session = null;
    render(); unknown(); expect(signal.aborted).toBe(true);
    click(staleButton); old.resolve(response(classification(true))); await flush(); unknown();
    expect(hooks.retiredWrites).toBe(0); expect(writes()).toHaveLength(1);
    expect(classifierCalls()).toHaveLength(before + (change === "logout" ? 0 : 1));
    if (change === "patient") expect(classifierCalls().at(-1)?.[0]).toBe("/api/patients/20/legacy-onboarding");
    if (change === "logout") expect(checklist()).toBeUndefined();
  });

  it("A→B→A requires a fresh read and cannot revive A's accepted or pending labels", async () => {
    await mount(); const original = hooks.session;
    hooks.session = { ...original!, username: "synthetic-b" }; classifierRead = async () => response({}, 403);
    render(); unknown(); await flush();
    const pending = deferred<MockResponse>(); classifierRead = () => pending.promise; hooks.session = original;
    render(); unknown(); await flush(); unknown();
    expect(classifierCalls()).toHaveLength(3);
    const latest = deferred<MockResponse>(); classifierRead = () => latest.promise;
    hooks.session = { ...original!, username: "synthetic-b" }; render();
    hooks.session = original; render(); unknown();
    pending.resolve(response(classification(true))); await flush(); unknown();
    latest.resolve(response(classification(false))); await flush();
    expect(text(checklist())).toContain(OUTSIDE); expect(text(checklist())).not.toContain(INCLUDED);
    expect(hooks.retiredWrites).toBe(0); expect(writes()).toEqual([]);
  });

  it.each(["headers", "body"])("unmount aborts a pending classifier %s read without publishing afterward", async (stage) => {
    const request = deferred<MockResponse>(); const body = deferred<unknown>();
    classifierRead = stage === "headers" ? () => request.promise : async () => ({ ...response(null), json: () => body.promise });
    await mount(); const signal = classifierCalls()[0][1]?.signal as AbortSignal;
    unmount(); expect(signal.aborted).toBe(true);
    request.resolve(response(classification(true))); body.resolve(classification(true)); await drain();
    expect(hooks.retiredWrites).toBe(0); expect(owners.size).toBe(0); expect(writes()).toEqual([]);
  });
});
