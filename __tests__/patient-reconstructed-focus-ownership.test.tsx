import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientPlans } from "../components/PatientPlans";
import { createPatientNavigation } from "../lib/patient-navigation";
import { focusDestination, readPatientRecordFocus, type PatientPlanItemFocus } from "../lib/patient-workspace-focus";
import { projectPatientPlan } from "../lib/patient-plan-projection";
import type { TreatmentPlan } from "../lib/db";

// Separate hook scopes preserve the real parent/inline-child relationship.
// Real handlers and guard registration are used; transport is synthetic only.
type Driver = { values: unknown[]; cursor: number; effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>; layoutEffects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>; memos: Map<number, { deps?: readonly unknown[]; value: unknown }>; pending: Array<() => void>; layoutPending: Array<() => void> };
const hooks = vi.hoisted(() => ({ current: null as unknown as Driver }));
const newDriver = (): Driver => ({ values: [], cursor: 0, effects: new Map(), layoutEffects: new Map(), memos: new Map(), pending: [], layoutPending: [] });
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (state: Driver, initial: unknown) => { const index = state.cursor++; if (!(index in state.values)) state.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const state = hooks.current; const index = slot(state, undefined); const previous = state.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); state.memos.set(index, { deps, value }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => { const state = hooks.current; const index = slot(state, typeof initial === "function" ? initial() : initial); return [state.values[index], (value: unknown) => { state.values[index] = typeof value === "function" ? value(state.values[index]) : value; }]; },
    useRef: (initial: unknown) => { const state = hooks.current; return state.values[slot(state, { current: initial })]; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const state = hooks.current; const index = slot(state, undefined); const previous = state.effects.get(index); if (previous && same(previous.deps, deps)) return;
      state.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); state.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
    },
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const state = hooks.current; const index = slot(state, undefined); const previous = state.layoutEffects.get(index); if (previous && same(previous.deps, deps)) return;
      state.layoutPending.push(() => { previous?.cleanup?.(); const cleanup = effect(); state.layoutEffects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
    },
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic-reader", role: "doctor", permissions: { canEditPlans: true } }) }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  const found: Element[] = [];
  Children.forEach(node, (child) => { if (isValidElement<Record<string, unknown>>(child)) { found.push(child); found.push(...elements(child.props.children as ReactNode)); } });
  return found;
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  const parts: string[] = [];
  Children.forEach(node, (child) => { if (typeof child === "string" || typeof child === "number") parts.push(String(child)); else if (isValidElement<{ children?: ReactNode }>(child)) parts.push(text(child.props.children)); });
  return parts.join(" ");
}
const item = (id: number, toothCode: number) => ({ id, serviceId: 8, serviceName: `إجراء محفوظ ${id}`, category: "rct", toothCode, surfaces: "MO", quantity: 1, unitPriceMinor: 10000, totalMinor: 10000, status: "planned", visitId: null, doneAt: null, note: null, plannedVisitNumber: 1, sessionCount: 1, sessionsCompleted: 0, billingRule: "on_completion", billingStatus: "unbilled", doctorId: 7, doctorName: "طبيب البند الحقيقي" });
const fixture = {
  id: 20, patientId: 91, patientName: "مريض تحقق", patientPhone: null, title: "خطة تحقق", totalMinor: 20000, paidMinor: 0,
  baseCurrency: "YER", status: "active", startDate: "2026-10-03", note: null, createdAt: "2026-10-03", lastReminderAt: null,
  installments: [], progress: { totalMinor: 20000, dueToDateMinor: 0, paidMinor: 0, remainingMinor: 20000, overdueMinor: 0, nextDueDate: null, nextDueAmountMinor: 0, paidCount: 0, count: 0 },
  items: [item(101, 36), item(102, 37)], itemsProgress: { count: 2, doneCount: 0, totalMinor: 20000, doneMinor: 0, remainingMinor: 20000 },
  totalFromItems: true, consentAt: null, consentBy: null, consentNote: null,
} as TreatmentPlan;
const focus: PatientPlanItemFocus = { kind: "plan_item", patientId: 91, planId: 20, itemId: 101, caseId: 17, toothCode: 36 };
const nextFocus: PatientPlanItemFocus = { ...focus, itemId: 102, toothCode: 37 };
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
let parent: Driver; let child: Driver; let childKey: string | null; let auxiliary: Driver;
let props: ComponentProps<typeof PatientPlans>;
let currentGuard: (() => boolean) | null;
let planResponse: ReturnType<typeof response> | Promise<ReturnType<typeof response>>; let caseResponse: ReturnType<typeof response>;
let writeResponse: ReturnType<typeof response> | Promise<ReturnType<typeof response>>;
let url: URL; let navigation: ReturnType<typeof createPatientNavigation>;
const replaceState = vi.fn(); const pushState = vi.fn(); const confirm = vi.fn(() => false); const fetchMock = vi.fn();
const cleanup = (state: Driver) => { state.layoutEffects.forEach((effect) => effect.cleanup?.()); state.effects.forEach((effect) => effect.cleanup?.()); };
function view(state: Driver, component: () => ReactNode) {
  hooks.current = state; state.cursor = 0; const tree = component(); state.layoutPending.splice(0).forEach((effect) => effect()); state.pending.splice(0).forEach((effect) => effect());
  return { tree, nodes: elements(tree), text: text(tree) };
}
const parentView = () => view(parent, () => PatientPlans(props));
function childView() {
  const node = parentView().nodes.find((element) => typeof element.type === "function" && element.type.name === "PlanItems");
  expect(node).toBeDefined();
  if (childKey !== node!.key) { cleanup(child); child = newDriver(); childKey = node!.key; }
  return view(child, () => (node!.type as (input: Record<string, unknown>) => ReactNode)(node!.props));
}
async function settle() { for (let index = 0; index < 35; index += 1) await Promise.resolve(); }
async function loaded() { parentView(); await settle(); parentView(); childView(); await settle(); return childView(); }
function parentButton(label: string) { const result = parentView().nodes.find((node) => node.type === "button" && text(node).includes(label)); expect(result, label).toBeDefined(); return result!; }
function changeInline(label: string, value: string) {
  const current = childView();
  const capture = current.nodes.find((node) => typeof node.props.onChangeCapture === "function")!;
  (capture.props.onChangeCapture as () => void)();
  const control = current.nodes.find((node) => node.props["aria-label"] === label)!;
  expect(control, label).toBeDefined();
  (control.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
const surfaces = () => childView().nodes.find((node) => node.props["aria-label"] === "أسطح البند")?.props.value;
const selected = () => childView().nodes.filter((node) => node.props["data-focused-plan-item"] !== undefined).map((node) => node.props["data-focused-plan-item"]);
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");
beforeEach(() => {
  parent = newDriver(); child = newDriver(); auxiliary = newDriver(); childKey = null; hooks.current = parent; currentGuard = null;
  replaceState.mockReset(); pushState.mockReset(); confirm.mockReset().mockReturnValue(false);
  props = { patientId: 91, focus, onNavigationGuardChange: (guard) => { currentGuard = guard; } };
  planResponse = response({ plans: [projectPatientPlan(fixture, false)], plannedVisits: [], canSeeFinancial: false, baseCurrency: "YER", capabilities: { canEditPlans: true, canViewCatalogPrices: false, canCollectPayments: false, canRecordConsent: false, canCompletePlan: false, canPrintContract: false } });
  caseResponse = response({ cases: [{ id: 17, patientId: 91 }], items: [{ id: 101, planId: 20, caseId: 17, toothCode: 36 }, { id: 102, planId: 20, caseId: 17, toothCode: 37 }], planVisible: true });
  writeResponse = response({ message: "رفض إضافة تجريبي" }, 409);
  fetchMock.mockReset().mockImplementation(async (target: string, init?: RequestInit) => init?.method ? writeResponse : target.endsWith("/cases") ? caseResponse : target.endsWith("/plans") ? planResponse : target === "/api/plan-templates" ? response({ services: [{ id: 8, name: "خدمة متاحة", category: "rct" }] }) : response([]));
  vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("window", { confirm });
  url = new URL("https://clinic.test/patients/91?tab=treatment&sub=plans&focus=plan_item&focusPatient=91&focusPlan=20&focusItem=101&focusCase=17&focusTooth=36");
  replaceState.mockImplementation((_state, _title, href: string) => { url = new URL(href, url); });
  const host = { get location() { return url; }, history: { replaceState, pushState, length: 4 } } as unknown as Window;
  navigation = createPatientNavigation(host, { canLeave: () => currentGuard?.() ?? false, onChange: () => {
    const value = readPatientRecordFocus(url.search, 91); if (value.status === "valid" && value.focus.kind === "plan_item") props.focus = value.focus;
  } });
});
afterEach(() => { cleanup(auxiliary); cleanup(child); cleanup(parent); vi.unstubAllGlobals(); });

describe("patient rebuild acceptance: plan editor same-tab focus integration", () => {
  it("highlights only the exact fresh item without opening a creation/payment form or writing", async () => {
    await loaded(); expect(selected()).toEqual(["101"]); expect(writes()).toHaveLength(0);
    expect(parentView().nodes.some((node) => typeof node.type === "function" && ["TemplatePlanForm", "ConsentForm"].includes(node.type.name))).toBe(false);
  });
  it("hidden case linkage makes item focus unavailable without selecting a substitute", async () => {
    caseResponse = response({ cases: [], items: [], planVisible: false }); await loaded();
    expect(selected()).toEqual([]); expect(parentView().nodes.some((node) => node.props["data-testid"] === "plan-focus-unavailable")).toBe(true);
    expect(writes()).toHaveLength(0);
  });
  it("an open creation form refuses same-tab focus until the user closes it explicitly", async () => {
    await loaded(); (parentButton("قالب تخصص").props.onClick as () => void)(); parentView(); const original = url.href;
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(false);
    expect(url.href).toBe(original); expect(parentView().text).toContain("احفظ النموذج المفتوح أو أغلقه"); expect(confirm).not.toHaveBeenCalled();
    (parentButton("إغلاق القوالب").props.onClick as () => void)(); parentView();
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(true); await loaded();
    expect(selected()).toEqual(["102"]); expect(writes()).toHaveLength(0);
  });
  it("rejected same-tab focus preserves the real inline draft, selected item and URL", async () => {
    await loaded(); changeInline("أسطح البند", "MOD"); parentView(); const original = url.href;
    for (let index = 0; index < 2; index += 1) expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(false);
    expect(surfaces()).toBe("MOD"); expect(selected()).toEqual(["101"]); expect(url.href).toBe(original);
    expect(confirm).toHaveBeenCalledTimes(2); expect(replaceState).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  });
  it("accepted discard remounts the inline form and then selects the fresh target exactly once", async () => {
    await loaded(); changeInline("أسطح البند", "MOD"); parentView(); confirm.mockReturnValue(true);
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(true); await loaded();
    expect(surfaces()).toBe(""); expect(selected()).toEqual(["102"]); expect(replaceState).toHaveBeenCalledTimes(1); expect(writes()).toHaveLength(0);
  });
  it("an in-flight inline write blocks repeated same-tab focus without prompting or duplicating", async () => {
    await loaded(); changeInline("خدمة الخطة", "8"); changeInline("أسطح البند", "MOD");
    const pending = deferred<ReturnType<typeof response>>(); writeResponse = pending.promise;
    const add = childView().nodes.find((node) => node.props["data-action"] === "plan-add-item")!;
    (add.props.onClick as () => void)(); const original = url.href;
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(false);
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(false);
    expect(confirm).not.toHaveBeenCalled(); expect(url.href).toBe(original); expect(writes()).toHaveLength(1);
    pending.resolve(response({ message: "رفض إضافة تجريبي" }, 409)); await settle();
    expect(surfaces()).toBe("MOD"); expect(selected()).toEqual(["101"]); expect(parentView().text).toContain("رفض إضافة تجريبي");
  });
  it("does not announce a new item as focused using the previous read while its GET is pending", async () => {
    await loaded(); const previous = await planResponse; const pending = deferred<ReturnType<typeof response>>(); planResponse = pending.promise;
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(true);
    const beforeFreshRead = parentView();
    expect(beforeFreshRead.nodes.some((node) => node.props["data-testid"] === "plan-focus-ready")).toBe(false);
    expect(beforeFreshRead.nodes.some((node) => node.props["data-testid"] === "plan-focus-unavailable")).toBe(true);
    pending.resolve(previous); await settle();
    expect(selected()).toEqual(["102"]); expect(writes()).toHaveLength(0);
  });

  it.each([401, 403, 404])("clears previously authorized plan data after a non-JSON %s denial", async (status) => {
    await loaded(); expect(selected()).toEqual(["101"]);
    planResponse = { ok: false, status, json: async () => { throw new SyntaxError("HTML denial body"); } };
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(true);
    parentView(); await settle(); const denied = parentView();
    expect(denied.text).not.toContain("خطة تحقق");
    expect(denied.text).not.toContain("إجراء محفوظ");
    expect(denied.text).not.toContain("لا خطط علاج بعد");
    expect(denied.nodes.some((node) => typeof node.type === "function" && node.type.name === "PlanItems")).toBe(false);
    expect(denied.nodes.some((node) => node.type === "button" && text(node).includes("قالب تخصص"))).toBe(false);
    expect(denied.nodes.some((node) => node.props["data-testid"] === "plan-focus-ready")).toBe(false);
    expect(writes()).toHaveLength(0);
  });

});


const childNode = (name: string) => parentView().nodes.find((node) => typeof node.type === "function" && node.type.name === name);
const auxiliaryView = (name: string) => {
  const node = childNode(name); expect(node, name).toBeDefined();
  return view(auxiliary, () => (node!.type as (input: Record<string, unknown>) => ReactNode)(node!.props));
};
const click = (node: Element) => (node.props.onClick as () => void)();
const input = (node: Element, value: string) => (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
const catalog = { id: 8, name: "خدمة متاحة", category: "rct", priceMinor: 10000, isActive: true, sortOrder: 0 };
async function financialPlans() {
  const current = await planResponse; const body = await current.json() as { plans: ReturnType<typeof projectPatientPlan>[]; capabilities: Record<string, boolean> };
  planResponse = response({ ...body, plans: [projectPatientPlan(fixture, true)], canSeeFinancial: true,
    capabilities: { ...body.capabilities, canViewCatalogPrices: true, canRecordConsent: true } });
}

describe("patient rebuild acceptance: reviewed plan draft-owner repairs", () => {
  it.each([
    ["QuickPlanForm", "خطة سريعة", "إغلاق الخطة السريعة"],
    ["QuickAgreementPlanForm", "مبلغ متفق", "إغلاق الاتفاق"],
    ["TemplatePlanForm", "قالب تخصص", "إغلاق القوالب"],
    ["NewPlanFormV2", "خطة متقدمة", "إغلاق المتقدمة"],
  ])("actual %s pending POST blocks close, switch, advanced and navigation synchronously", async (name, openLabel, closeLabel) => {
    await financialPlans();
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((target: string, init?: RequestInit) => {
      if (!init?.method && target === "/api/services") return Promise.resolve(response([catalog]));
      if (!init?.method && target === "/api/plan-templates") return Promise.resolve(response({ services: [catalog], templates: [{ id: "test", name: "قالب اختبار", specialty: "عام", description: "قالب اختبار", steps: [{ key: "step", title: "خطوة", category: "rct", perTooth: false, optional: false, billingRule: "on_completion", sessions: [] }] }] }));
      return originalFetch(target, init);
    });
    await loaded(); click(parentButton(openLabel)); auxiliaryView(name); await settle(); let form = auxiliaryView(name);
    if (name === "QuickPlanForm") {
      const picker = form.nodes.find((node) => typeof node.type === "function" && node.type.name === "QuickServicePicker")!;
      (picker.props.onPick as (service: typeof catalog) => void)(catalog);
    } else if (name === "QuickAgreementPlanForm") {
      input(form.nodes.find((node) => node.type === "input" && node.props.inputMode === "decimal")!, "1000");
    } else if (name === "TemplatePlanForm") {
      click(form.nodes.find((node) => node.type === "button" && text(node).includes("قالب اختبار"))!);
    } else {
      click(form.nodes.find((node) => node.type === "button" && text(node).includes("+ بند علاجي"))!);
      form = auxiliaryView(name);
      const picker = form.nodes.find((node) => typeof node.type === "function" && node.type.name === "ServiceSelect")!;
      (picker.props.onChange as (id: number, service: typeof catalog) => void)(8, catalog);
    }
    form = auxiliaryView(name); const pending = deferred<ReturnType<typeof response>>(); writeResponse = pending.promise;
    const submit = name === "TemplatePlanForm"
      ? () => click(form.nodes.find((node) => node.type === "button" && text(node).includes("أنشئ الخطة من القالب"))!)
      : () => (form.nodes.find((node) => node.type === "form")!.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => undefined });
    submit(); submit();
    expect(writes()).toHaveLength(1);
    click(parentButton(closeLabel));
    for (const label of ["خطة سريعة", "مبلغ متفق", "قالب تخصص", "خطة متقدمة"]) {
      const button = parentView().nodes.find((node) => node.type === "button" && text(node).includes(label));
      if (button) click(button);
    }
    const advanced = form.nodes.find((node) => node.type === "button" && text(node).includes("خطة متقدمة"));
    if (advanced) click(advanced);
    expect(childNode(name)).toBeDefined();
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(false);
    expect(replaceState).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1);
    pending.resolve(response({ message: "رفض إنشاء تجريبي" }, 409)); await settle();
    expect(childNode(name)).toBeDefined(); click(parentButton(closeLabel)); expect(childNode(name)).toBeUndefined();
  });

  it("actual inline consent has an idle no-write cancel and refuses cancel/repeated submit while pending", async () => {
    await financialPlans(); await loaded(); click(parentButton("سجّل موافقة المريض"));
    let form = auxiliaryView("ConsentForm"); click(form.nodes.find((node) => node.props["data-testid"] === "plan-consent-cancel")!);
    expect(childNode("ConsentForm")).toBeUndefined(); expect(writes()).toHaveLength(0);
    click(parentButton("سجّل موافقة المريض")); cleanup(auxiliary); auxiliary = newDriver(); form = auxiliaryView("ConsentForm");
    const pending = deferred<ReturnType<typeof response>>(); writeResponse = pending.promise;
    const submit = form.nodes.find((node) => node.type === "button" && text(node) === "سجّل الموافقة")!;
    click(submit); click(submit); click(form.nodes.find((node) => node.props["data-testid"] === "plan-consent-cancel")!);
    expect(writes()).toHaveLength(1); expect(childNode("ConsentForm")).toBeDefined();
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(false);
    pending.resolve(response({ message: "رفض موافقة تجريبي" }, 409)); await settle();
    form = auxiliaryView("ConsentForm"); click(form.nodes.find((node) => node.props["data-testid"] === "plan-consent-cancel")!);
    expect(childNode("ConsentForm")).toBeUndefined(); expect(writes()).toHaveLength(1);
  });

  it("a sibling save and ordinary refresh preserve the actual draft owner while stale writes stay blocked", async () => {
    const initial = await planResponse; const body = await initial.json() as { plans: ReturnType<typeof projectPatientPlan>[]; capabilities: Record<string, boolean> };
    const sibling: TreatmentPlan = { ...fixture, id: 21, title: "خطة شقيقة", items: [item(103, 38) as TreatmentPlan["items"][number]] };
    planResponse = response({ ...body, plans: [...body.plans, projectPatientPlan(sibling, false)] });
    await loaded(); changeInline("خدمة الخطة", "8"); changeInline("أسطح البند", "MOD");
    const originalChildKey = childKey; const previous = await planResponse;
    const siblingNode = parentView().nodes.find((node) => typeof node.type === "function" && node.type.name === "PlanItems" && (node.props.plan as { id: number }).id === 21)!;
    const siblingView = () => view(auxiliary, () => (siblingNode.type as (input: Record<string, unknown>) => ReactNode)(siblingNode.props));
    siblingView(); await settle();
    const pending = deferred<ReturnType<typeof response>>(); planResponse = pending.promise; writeResponse = response({ ok: true });
    click(siblingView().nodes.find((node) => node.props["aria-label"] === "احذف إجراء محفوظ 103")!); await settle();
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe("/api/plans/21/items?itemId=103");
    expect(surfaces()).toBe("MOD"); expect(childKey).toBe(originalChildKey);
    click(childView().nodes.find((node) => node.props["data-action"] === "plan-add-item")!);
    expect(writes()).toHaveLength(1);
    pending.resolve(response({ message: "Temporary read failure" }, 503)); await settle();
    expect(surfaces()).toBe("MOD"); expect(childKey).toBe(originalChildKey);
    click(childView().nodes.find((node) => node.props["data-action"] === "plan-add-item")!);
    expect(writes()).toHaveLength(1);
    planResponse = previous; click(parentButton("إعادة التحقق")); await settle();
    expect(surfaces()).toBe("MOD"); expect(childKey).toBe(originalChildKey);
    writeResponse = response({ message: "رفض إضافة تجريبي" }, 409);
    click(childView().nodes.find((node) => node.props["data-action"] === "plan-add-item")!); await settle();
    expect(writes()).toHaveLength(2); expect(surfaces()).toBe("MOD");
  });
});

const deniedHtml = () => ({ ok: false, status: 403, json: async () => { throw new SyntaxError("HTML denial body"); } });
async function refreshAsDenied() {
  const refresh = childNode("PlanItems")!.props.onChanged as () => void;
  planResponse = deniedHtml(); refresh(); await settle(); parentView();
}

describe("patient rebuild acceptance: hard denial retires hidden owners safely", () => {
  it.each([
    ["QuickPlanForm", "خطة سريعة"], ["QuickAgreementPlanForm", "مبلغ متفق"],
    ["TemplatePlanForm", "قالب تخصص"], ["NewPlanFormV2", "خطة متقدمة"],
    ["ConsentForm", "سجّل موافقة المريض"],
  ])("an idle %s hidden by HTML 403 does not trap navigation behind an invisible close action", async (name, openLabel) => {
    await financialPlans(); await loaded(); click(parentButton(openLabel)); expect(childNode(name)).toBeDefined();
    await refreshAsDenied();
    expect(childNode(name)).toBeUndefined(); expect(childNode("PlanItems")).toBeUndefined();
    expect(parentView().text).not.toContain("لا خطط علاج بعد");
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(true);
    expect(replaceState).toHaveBeenCalledTimes(1); expect(confirm).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  });

  it.each(["creation", "consent", "inline"])("a pending %s write survives owner removal after HTML 403 until the request settles", async (kind) => {
    if (kind !== "inline") await financialPlans();
    await loaded();
    const pending = deferred<ReturnType<typeof response>>(); writeResponse = pending.promise;
    if (kind === "creation") {
      click(parentButton("مبلغ متفق")); auxiliaryView("QuickAgreementPlanForm"); await settle();
      let form = auxiliaryView("QuickAgreementPlanForm");
      input(form.nodes.find((node) => node.type === "input" && node.props.inputMode === "decimal")!, "1000");
      form = auxiliaryView("QuickAgreementPlanForm");
      (form.nodes.find((node) => node.type === "form")!.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => undefined });
    } else if (kind === "consent") {
      click(parentButton("سجّل موافقة المريض"));
      click(auxiliaryView("ConsentForm").nodes.find((node) => node.type === "button" && text(node) === "سجّل الموافقة")!);
    } else {
      changeInline("خدمة الخطة", "8"); changeInline("أسطح البند", "MOD");
      click(childView().nodes.find((node) => node.props["data-action"] === "plan-add-item")!);
    }
    expect(writes()).toHaveLength(1);
    await refreshAsDenied();
    expect(childNode("PlanItems")).toBeUndefined();
    // React removes the denied subtree. Its effect cleanup must not erase the
    // parent's ownership of an already-dispatched request.
    cleanup(child); cleanup(auxiliary);
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(false);
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(false);
    expect(replaceState).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1);
    // Consent 409 can mean committed consent plus rejected scheduling; actual authorization denial is 403.
    pending.resolve(response({ message: "رفض كتابة بعد سحب الصلاحية" }, kind === "consent" ? 403 : 409)); await settle(); parentView();
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(true);
    expect(replaceState).toHaveBeenCalledTimes(1); expect(writes()).toHaveLength(1);
  });

  it("a pending inline consent cannot be replaced by a sibling plan consent opener", async () => {
    await financialPlans(); const initial = await planResponse;
    const body = await initial.json() as { plans: ReturnType<typeof projectPatientPlan>[]; capabilities: Record<string, boolean> };
    planResponse = response({ ...body, plans: [...body.plans, projectPatientPlan({ ...fixture, id: 21, title: "خطة شقيقة" }, true)] });
    await loaded();
    const openers = () => parentView().nodes.filter((node) => node.type === "button" && text(node).includes("سجّل موافقة المريض"));
    expect(openers()).toHaveLength(2); click(openers()[0]);
    let form = auxiliaryView("ConsentForm"); input(form.nodes.find((node) => node.props["aria-label"] === "كيف وُثّقت الموافقة")!, "موافقة الخطة الأصلية");
    form = auxiliaryView("ConsentForm"); const pending = deferred<ReturnType<typeof response>>(); writeResponse = pending.promise;
    click(form.nodes.find((node) => node.type === "button" && text(node) === "سجّل الموافقة")!);
    expect(writes()).toHaveLength(1); click(openers()[0]);
    expect((childNode("ConsentForm")!.props.plan as { id: number }).id).toBe(20);
    expect(auxiliaryView("ConsentForm").nodes.find((node) => node.props["aria-label"] === "كيف وُثّقت الموافقة")!.props.value).toBe("موافقة الخطة الأصلية");
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(false);
    pending.resolve(response({ message: "رفض موافقة تجريبي" }, 409)); await settle();
    expect((childNode("ConsentForm")!.props.plan as { id: number }).id).toBe(20); expect(writes()).toHaveLength(1);
  });
});

// New reconstruction coverage: these assertions were not part of the recovered suite.
describe("reconstructed plan exact handoff and stale callbacks", () => {
  it.each([
    { planId: 99 }, { itemId: 999 }, { toothCode: 38 }, { caseId: 999 }, { patientId: 92 },
  ])("does not focus a substitute for a mismatched hint %j", async (change) => {
    props.focus = { ...focus, ...change };
    await loaded();
    expect(selected()).toEqual([]);
    expect(parentView().nodes.some((node) => node.props["data-testid"] === "plan-focus-unavailable")).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("truthfully labels cancelled item history rather than claiming missing or selecting another", async () => {
    const initial = await planResponse;
    const body = await initial.json() as { plans: ReturnType<typeof projectPatientPlan>[] };
    planResponse = response({ ...body, plans: [projectPatientPlan({ ...fixture, items: [{ ...fixture.items[0], status: "cancelled" }, fixture.items[1]] }, false)] });
    await loaded();
    expect(selected()).toEqual([]);
    expect(parentView().text).toContain("عرضه التاريخي غير متاح");
    expect(writes()).toHaveLength(0);
  });

  it("hands only the exact authorized existing plan/case/tooth to the existing visit", async () => {
    const onFocus = vi.fn(); props.onFocus = onFocus; props.openVisitId = 78;
    await loaded();
    const button = childView().nodes.find((node) => node.props["data-testid"] === "plan-review-visit-item-101")!;
    click(button);
    expect(onFocus).toHaveBeenCalledExactlyOnceWith({ kind: "visit_work", patientId: 91, visitId: 78, planId: 20, itemId: 101, caseId: 17, toothCode: 36 });
    expect(writes()).toHaveLength(0);
  });

  it("a captured review callback reads the latest authorized case link, never stale context", async () => {
    const onFocus = vi.fn(); props.onFocus = onFocus; props.openVisitId = 78;
    await loaded();
    const oldButton = childView().nodes.find((node) => node.props["data-testid"] === "plan-review-visit-item-101")!;
    caseResponse = response({ cases: [{ id: 17, patientId: 92 }], items: [{ id: 101, planId: 20, caseId: 17, toothCode: 36 }], planVisible: true });
    (childNode("PlanItems")!.props.onChanged as () => void)(); await settle(); parentView();
    click(oldButton);
    expect(onFocus).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
    expect(parentView().text).toContain("تعذّر تأكيد ارتباط البند");
  });

  it("a captured item submit cannot retain write authority after a successful permission refresh", async () => {
    await loaded(); changeInline("خدمة الخطة", "8");
    const oldAdd = childView().nodes.find((node) => node.props["data-action"] === "plan-add-item")!;
    const initial = await planResponse;
    const body = await initial.json() as { capabilities: Record<string, boolean> };
    planResponse = response({ ...body, capabilities: { ...body.capabilities, canEditPlans: false } });
    (childNode("PlanItems")!.props.onChanged as () => void)(); await settle(); parentView();
    click(oldAdd);
    expect(writes()).toHaveLength(0);
  });

  it("a pending old patient read cannot replace a newer patient projection", async () => {
    const pending = deferred<ReturnType<typeof response>>(); planResponse = pending.promise;
    parentView();
    props = { ...props, patientId: 92, focus: null };
    planResponse = response({ plans: [projectPatientPlan({ ...fixture, patientId: 92, title: "خطة المريض الجديد" }, false)], capabilities: {}, plannedVisits: [] });
    parentView(); await settle();
    expect(parentView().text).toContain("خطة المريض الجديد");
    pending.resolve(response({ plans: [projectPatientPlan(fixture, false)], capabilities: {} })); await settle();
    expect(parentView().text).toContain("خطة المريض الجديد");
    expect(parentView().text).not.toContain("خطة تحقق");
  });
});

describe("reconstructed plan guard lifecycle", () => {
  it("a successful permission downgrade retires hidden creation flags without trapping navigation", async () => {
    await loaded(); click(parentButton("قالب تخصص")); expect(childNode("TemplatePlanForm")).toBeDefined();
    const initial = await planResponse;
    const body = await initial.json() as { capabilities: Record<string, boolean> };
    planResponse = response({ ...body, capabilities: { ...body.capabilities, canEditPlans: false } });
    (childNode("PlanItems")!.props.onChanged as () => void)(); await settle();
    expect(childNode("TemplatePlanForm")).toBeUndefined();
    expect(navigation.navigate(focusDestination(nextFocus), nextFocus)).toBe(true);
    expect(confirm).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  });

  it("the registered guard sees a newly opened form before a rerender", async () => {
    await loaded(); const guard = currentGuard!;
    click(parentButton("قالب تخصص"));
    expect(guard()).toBe(false); expect(writes()).toHaveLength(0);
  });

  it("custom service selection is dirty even without a native change event", async () => {
    await financialPlans(); await loaded();
    const picker = childView().nodes.find((node) => typeof node.type === "function" && node.type.name === "ServiceSelect")!;
    (picker.props.onChange as (id: number) => void)(8);
    expect(currentGuard?.()).toBe(false);
    expect(confirm).toHaveBeenCalledOnce(); expect(writes()).toHaveLength(0);
  });
});

const creationKinds = [
  ["QuickPlanForm", "خطة سريعة", "إغلاق الخطة السريعة"],
  ["QuickAgreementPlanForm", "مبلغ متفق", "إغلاق الاتفاق"],
  ["TemplatePlanForm", "قالب تخصص", "إغلاق القوالب"],
  ["NewPlanFormV2", "خطة متقدمة", "إغلاق المتقدمة"],
] as const;
async function prepareCreationCatalog() {
  await financialPlans();
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((target: string, init?: RequestInit) => {
    if (!init?.method && target === "/api/services") return Promise.resolve(response([catalog]));
    if (!init?.method && target === "/api/plan-templates") return Promise.resolve(response({ showPrices: true, services: [catalog], templates: [{ id: "test", name: "قالب اختبار", specialty: "عام", description: "قالب اختبار", steps: [{ key: "step", title: "خطوة", category: "rct", perTooth: false, optional: false, billingRule: "on_completion", sessions: [] }] }] }));
    return original(target, init);
  });
  await loaded();
}
async function fillCreation(name: typeof creationKinds[number][0], openLabel: string) {
  click(parentButton(openLabel)); auxiliaryView(name); await settle();
  let form = auxiliaryView(name);
  if (name === "QuickPlanForm") {
    const picker = form.nodes.find((node) => typeof node.type === "function" && node.type.name === "QuickServicePicker")!;
    (picker.props.onPick as (service: typeof catalog) => void)(catalog);
  } else if (name === "QuickAgreementPlanForm") input(form.nodes.find((node) => node.type === "input" && node.props.inputMode === "decimal")!, "1000");
  else if (name === "TemplatePlanForm") click(form.nodes.find((node) => node.type === "button" && text(node).includes("قالب اختبار"))!);
  else {
    click(form.nodes.find((node) => node.type === "button" && text(node).includes("+ بند علاجي"))!);
    form = auxiliaryView(name);
    const picker = form.nodes.find((node) => typeof node.type === "function" && node.type.name === "ServiceSelect")!;
    (picker.props.onChange as (id: number, service: typeof catalog) => void)(8, catalog);
  }
  form = auxiliaryView(name);
  return { form, submit: () => name === "TemplatePlanForm"
    ? click(form.nodes.find((node) => node.type === "button" && text(node).includes("أنشئ الخطة من القالب"))!)
    : (form.nodes.find((node) => node.type === "form")!.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => undefined }) };
}

describe("reconstructed plan uncertain outcome containment", () => {
  it.each(creationKinds)("%s retains unknown ownership after cancel/reopen and requires reviewed new intent", async (name, openLabel, closeLabel) => {
    await prepareCreationCatalog();
    let { submit } = await fillCreation(name, openLabel);
    writeResponse = response({ message: "قد يكون الخادم حفظ الخطة قبل هذا الخطأ" }, 500);
    submit(); await settle();
    expect(parentView().nodes.some((node) => node.props["data-testid"] === "plan-write-uncertain")).toBe(true);
    expect(parentView().text).toContain("إعادة تحميل الصفحة");
    submit(); expect(writes()).toHaveLength(1);
    click(parentButton(closeLabel)); cleanup(auxiliary); auxiliary = newDriver();
    ({ submit } = await fillCreation(name, openLabel)); submit(); await settle();
    expect(writes()).toHaveLength(1);
    const staleAcknowledge = parentView().nodes.find((node) => node.props["data-testid"] === "plan-new-intent")!;
    click(staleAcknowledge); expect(confirm).not.toHaveBeenCalled();
    click(parentView().nodes.find((node) => node.props["data-testid"] === "plan-review-uncertain")!); await settle();
    expect(parentView().nodes.some((node) => node.props["data-testid"] === "plan-write-uncertain")).toBe(true);
    submit(); expect(writes()).toHaveLength(1);
    confirm.mockReturnValue(true);
    click(staleAcknowledge); expect(confirm).not.toHaveBeenCalled();
    click(parentView().nodes.find((node) => node.props["data-testid"] === "plan-new-intent")!);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("قد يكرر العمل"));
    expect(writes()).toHaveLength(1); expect(childNode(name)).toBeUndefined();
    cleanup(auxiliary); auxiliary = newDriver();
    ({ submit } = await fillCreation(name, openLabel));
    writeResponse = response({ id: 77 }, 201); submit(); await settle();
    expect(writes()).toHaveLength(2); expect(childNode(name)).toBeUndefined();
  });

  it.each(["transport", "malformed", "408", "499"])("inline item %s outcome remains uncertain and never auto-retries", async (kind) => {
    await loaded(); changeInline("خدمة الخطة", "8"); changeInline("أسطح البند", "MOD");
    const add = childView().nodes.find((node) => node.props["data-action"] === "plan-add-item")!;
    if (kind === "transport") fetchMock.mockImplementationOnce(async () => { throw new TypeError("connection lost after dispatch"); });
    else if (kind === "malformed") writeResponse = { ok: true, status: 201, json: async () => { throw new SyntaxError("truncated body"); } };
    else writeResponse = response({ message: "timeout" }, Number(kind));
    click(add); await settle(); click(add);
    expect(writes()).toHaveLength(1); expect(surfaces()).toBe("MOD");
    expect(parentView().nodes.some((node) => node.props["data-testid"] === "plan-write-uncertain")).toBe(true);
  });

  it("an uncertain closed creation form warns before losing local containment", async () => {
    await prepareCreationCatalog(); const { submit } = await fillCreation("QuickAgreementPlanForm", "مبلغ متفق");
    writeResponse = response({}, 500); submit(); await settle(); click(parentButton("إغلاق الاتفاق"));
    expect(currentGuard?.()).toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("قد تفقد التحذير المحلي"));
  });

  it("partial consent scheduling rejection stays review-required, not automatically retryable", async () => {
    await financialPlans(); await loaded(); click(parentButton("سجّل موافقة المريض"));
    const form = auxiliaryView("ConsentForm");
    const submit = form.nodes.find((node) => node.type === "button" && text(node) === "سجّل الموافقة")!;
    writeResponse = response({ message: "سُجّلت الموافقة، وتعذّرت الجدولة" }, 409);
    click(submit); await settle(); click(submit);
    expect(writes()).toHaveLength(1);
    expect(parentView().nodes.some((node) => node.props["data-testid"] === "plan-write-uncertain")).toBe(true);
    click(auxiliaryView("ConsentForm").nodes.find((node) => node.props["data-testid"] === "plan-consent-cancel")!);
    expect(currentGuard?.()).toBe(false);
  });
});

function ownPlanItems(driver: Driver, planId: number) {
  const node = parentView().nodes.find((node) => typeof node.type === "function" && node.type.name === "PlanItems" && (node.props.plan as { id: number }).id === planId)!;
  expect(node).toBeDefined();
  return view(driver, () => (node.type as (props: Record<string, unknown>) => ReactNode)(node.props));
}
function changeOwned(driver: Driver, planId: number, label: string, value: string) {
  const rendered = ownPlanItems(driver, planId);
  (rendered.nodes.find((node) => typeof node.props.onChangeCapture === "function")!.props.onChangeCapture as () => void)();
  input(rendered.nodes.find((node) => node.props["aria-label"] === label)!, value);
}

describe("reconstructed concurrent item completion ownership", () => {
  it.each(["both saved", "second uncertain"])("retains delayed %s acknowledgments while preserving a third draft", async (outcome) => {
    const initial = await planResponse; const body = await initial.json() as { plans: ReturnType<typeof projectPatientPlan>[] };
    const sibling = (id: number) => projectPatientPlan({ ...fixture, id, title: `خطة ${id}`, items: [item(id + 100, 38) as TreatmentPlan["items"][number]] }, false);
    planResponse = response({ ...body, plans: [...body.plans, sibling(21), sibling(22)] });
    await loaded();
    const third = newDriver(); ownPlanItems(auxiliary, 21); ownPlanItems(third, 22); await settle();
    changeInline("خدمة الخطة", "8"); changeInline("أسطح البند", "FIRST");
    changeOwned(auxiliary, 21, "خدمة الخطة", "8"); changeOwned(auxiliary, 21, "أسطح البند", "SECOND");
    changeOwned(third, 22, "أسطح البند", "UNRELATED");
    const firstAdd = childView().nodes.find((node) => node.props["data-action"] === "plan-add-item")!;
    const secondAdd = ownPlanItems(auxiliary, 21).nodes.find((node) => node.props["data-action"] === "plan-add-item")!;
    const first = deferred<ReturnType<typeof response>>(); const second = deferred<ReturnType<typeof response>>();
    const previousFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((target: string, init?: RequestInit) => init?.method === "POST" && target === "/api/plans/20/items" ? first.promise : init?.method === "POST" && target === "/api/plans/21/items" ? second.promise : previousFetch(target, init));
    click(firstAdd); click(secondAdd); expect(writes()).toHaveLength(2);
    const snapshot = await planResponse; const refresh = deferred<ReturnType<typeof response>>(); planResponse = refresh.promise;
    first.resolve(response({ totalMinor: null, financialVisible: false }, 201)); await settle();
    expect(surfaces()).toBe("");
    second.resolve(outcome === "both saved" ? response({ totalMinor: null, financialVisible: false }, 201) : response({ message: "unknown" }, 500)); await settle();
    const secondSurface = () => ownPlanItems(auxiliary, 21).nodes.find((node) => node.props["aria-label"] === "أسطح البند")!.props.value;
    expect(secondSurface()).toBe(outcome === "both saved" ? "" : "SECOND");
    expect(ownPlanItems(third, 22).nodes.find((node) => node.props["aria-label"] === "أسطح البند")!.props.value).toBe("UNRELATED");
    refresh.resolve(snapshot); await settle();
    click(firstAdd); click(secondAdd); expect(writes()).toHaveLength(2);
    if (outcome === "second uncertain") {
      expect(parentView().nodes.some((node) => node.props["data-testid"] === "plan-write-uncertain")).toBe(true);
      click(parentView().nodes.find((node) => node.props["data-testid"] === "plan-review-uncertain")!); await settle();
      confirm.mockReturnValue(true); click(parentView().nodes.find((node) => node.props["data-testid"] === "plan-new-intent")!);
      expect(ownPlanItems(third, 22).nodes.find((node) => node.props["aria-label"] === "أسطح البند")!.props.value).toBe("UNRELATED");
    }
    cleanup(third);
  });
});

describe("reconstructed creation draft freeze and live catalog authority", () => {
  it.each(creationKinds)("%s freezes its submitted owner before pending response", async (name, openLabel) => {
    await prepareCreationCatalog(); const { form, submit } = await fillCreation(name, openLabel);
    const title = form.nodes.find((node) => node.type === "input" && typeof node.props.value === "string" && ["اسم الخطة", "اسم الاتفاق", "عنوان الخطة"].includes(String(node.props["aria-label"])));
    expect(title).toBeDefined();
    const before = title!.props.value;
    const pending = deferred<ReturnType<typeof response>>(); writeResponse = pending.promise;
    submit();
    if (title) input(title, "تعديل لم يرسل");
    const next = auxiliaryView(name);
    expect(next.nodes.some((node) => node.type === "fieldset" && node.props.disabled === true)).toBe(true);
    if (title) {
      const same = next.nodes.find((node) => node.type === "input" && node.props.placeholder === title.props.placeholder && node.props["aria-label"] === title.props["aria-label"]);
      expect(same?.props.value).toBe(before);
    }
    if (name === "QuickPlanForm") {
      const picker = form.nodes.find((node) => typeof node.type === "function" && node.type.name === "QuickServicePicker")!;
      (picker.props.onPick as (service: typeof catalog) => void)({ ...catalog, id: 9, name: "إجراء بعد الإرسال" });
      expect(auxiliaryView(name).text).not.toContain("إجراء بعد الإرسال");
    }
    pending.resolve(response({ id: 77 }, 201)); await settle(); expect(writes()).toHaveLength(1);
  });

  it("an already-mounted template redacts old catalog prices on permission downgrade and preserves its title", async () => {
    await prepareCreationCatalog(); await fillCreation("TemplatePlanForm", "قالب تخصص");
    const before = auxiliaryView("TemplatePlanForm");
    expect(before.text).toContain("الإجمالي التقديري:");
    const initial = await planResponse; const body = await initial.json() as { capabilities: Record<string, boolean> };
    planResponse = response({ ...body, capabilities: { ...body.capabilities, canViewCatalogPrices: false } });
    (childNode("PlanItems")!.props.onChanged as () => void)(); await settle();
    const after = auxiliaryView("TemplatePlanForm");
    expect(after.text).not.toContain("الإجمالي التقديري:");
    expect(after.nodes.some((node) => node.type === "input" && node.props.value === "قالب اختبار")).toBe(true);
  });
});

it("a captured Complete action cannot bypass unresolved item uncertainty", async () => {
  await financialPlans();
  const initial = await planResponse; const body = await initial.json() as { capabilities: Record<string, boolean> };
  const installmentPlan = { ...fixture, installments: [{ id: 1, number: 1, dueDate: "2026-10-03", amountMinor: 20000 }] };
  planResponse = response({ ...body, plans: [projectPatientPlan(installmentPlan, true)], capabilities: { ...body.capabilities, canCompletePlan: true } });
  await loaded(); const complete = parentButton("إنهاء الخطة");
  const picker = childView().nodes.find((node) => typeof node.type === "function" && node.type.name === "ServiceSelect")!;
  (picker.props.onChange as (id: number) => void)(8);
  writeResponse = response({ message: "unknown" }, 500);
  click(childView().nodes.find((node) => node.props["data-action"] === "plan-add-item")!); await settle();
  click(complete); click(parentButton("إنهاء الخطة"));
  expect(writes()).toHaveLength(1);
  expect(parentButton("إنهاء الخطة").props.disabled).toBe(true);
});

it.each(["same service", "descendant change capture"])("%s schedules an owner render so current item actions do not become inert", async (kind) => {
  await financialPlans(); await loaded();
  let picker = childView().nodes.find((node) => typeof node.type === "function" && node.type.name === "ServiceSelect")!;
  (picker.props.onChange as (id: number) => void)(8);
  const initial = childView();
  picker = initial.nodes.find((node) => typeof node.type === "function" && node.type.name === "ServiceSelect")!;
  const before = [...child.values];
  if (kind === "same service") (picker.props.onChange as (id: number) => void)(8);
  else (initial.nodes.find((node) => typeof node.props.onChangeCapture === "function")!.props.onChangeCapture as () => void)();
  // A changed state slot proves React receives a render request even when the
  // service value is unchanged or a captured descendant change does not update an owner field.
  expect(child.values.some((value, index) => typeof value === "number" && !Object.is(value, before[index]))).toBe(true);
  const parentNode = parentView().nodes.find((node) => typeof node.type === "function" && node.type.name === "PlanItems")!;
  const current = view(child, () => (parentNode.type as (props: Record<string, unknown>) => ReactNode)(parentNode.props));
  click(current.nodes.find((node) => node.props["data-action"] === "plan-add-item")!); await settle();
  expect(writes()).toHaveLength(1);
});

// Commit-retirement regressions deliberately withhold passive cleanup. These
// exercise the production event closures, not an invented replacement handler.
function commitOwnerUnmount(driver: Driver) {
  driver.layoutEffects.forEach((entry) => { entry.cleanup?.(); entry.cleanup = undefined; });
}
function finishPassiveUnmount(driver: Driver) {
  driver.effects.forEach((entry) => { entry.cleanup?.(); entry.cleanup = undefined; });
}

describe("plan commit-time owner retirement", () => {
  it("retires parent writes, existing-visit navigation and guard registration before passive cleanup", async () => {
    props.onFocus = vi.fn(); props.openVisitId = 78;
    await loaded(); changeInline("خدمة الخطة", "8");
    const add = childView().nodes.find((node) => node.props["data-action"] === "plan-add-item")!;
    const review = childNode("PlanItems")!.props.onReviewWork as (item: TreatmentPlan["items"][number]) => void;
    const previousGuard = currentGuard!;
    const retiredParent = parent;
    commitOwnerUnmount(retiredParent);
    click(add); review(fixture.items[0]); await settle();
    expect(writes()).toHaveLength(0); expect(props.onFocus).not.toHaveBeenCalled();
    expect(currentGuard).toBeNull(); expect(previousGuard()).toBe(false);
    commitOwnerUnmount(child); finishPassiveUnmount(child);
    parent = newDriver(); child = newDriver(); childKey = null;
    await loaded(); const replacementGuard = currentGuard;
    finishPassiveUnmount(retiredParent);
    expect(currentGuard).toBe(replacementGuard); expect(currentGuard).not.toBeNull();
  });

  it.each(creationKinds)("retired %s submit cannot target a reopened same-kind form while passive cleanup waits", async (name, openLabel, closeLabel) => {
    await prepareCreationCatalog();
    const old = await fillCreation(name, openLabel); const retiredForm = auxiliary;
    click(parentButton(closeLabel)); commitOwnerUnmount(retiredForm);
    auxiliary = newDriver(); const current = await fillCreation(name, openLabel);
    old.submit(); await settle(); expect(writes()).toHaveLength(0);
    current.submit(); await settle(); expect(writes()).toHaveLength(1);
    finishPassiveUnmount(retiredForm);
  });

  it.each(["مبلغ متفق", "قالب تخصص"])("retired Quick Advanced callback cannot escape a committed switch to %s", async (destination) => {
    await prepareCreationCatalog();
    const old = await fillCreation("QuickPlanForm", "خطة سريعة");
    const advanced = old.form.nodes.find((node) => node.type === "button" && text(node).includes("خطة متقدمة"))!;
    expect(advanced).toBeDefined();
    click(parentButton(destination)); commitOwnerUnmount(auxiliary);
    click(advanced);
    expect(childNode("NewPlanFormV2")).toBeUndefined();
    expect(childNode(destination === "مبلغ متفق" ? "QuickAgreementPlanForm" : "TemplatePlanForm")).toBeDefined();
    expect(writes()).toHaveLength(0);
    finishPassiveUnmount(auxiliary);
  });

  it("retired inline owner cannot write or navigate after accepted discard remount", async () => {
    props.onFocus = vi.fn(); props.openVisitId = 78;
    await loaded(); changeInline("خدمة الخطة", "8"); changeInline("أسطح البند", "MOD");
    const old = childView(); const retiredItems = child;
    const add = old.nodes.find((node) => node.props["data-action"] === "plan-add-item")!;
    const remove = old.nodes.find((node) => node.props["aria-label"] === "احذف إجراء محفوظ 101")!;
    const review = old.nodes.find((node) => node.props["data-testid"] === "plan-review-visit-item-101")!;
    confirm.mockReturnValue(true); expect(currentGuard?.()).toBe(true);
    commitOwnerUnmount(retiredItems); child = newDriver(); childKey = null;
    childView(); await settle(); childView();
    click(add); click(remove); click(review); await settle();
    expect(writes()).toHaveLength(0); expect(props.onFocus).not.toHaveBeenCalled();
    changeInline("خدمة الخطة", "8");
    click(childView().nodes.find((node) => node.props["data-action"] === "plan-add-item")!); await settle();
    expect(writes()).toHaveLength(1);
    finishPassiveUnmount(retiredItems);
  });

  it("retired consent submit cannot reuse a newly opened consent owner", async () => {
    await financialPlans(); await loaded(); click(parentButton("سجّل موافقة المريض"));
    const old = auxiliaryView("ConsentForm"); const retiredForm = auxiliary;
    const submit = old.nodes.find((node) => node.type === "button" && text(node) === "سجّل الموافقة")!;
    click(old.nodes.find((node) => node.props["data-testid"] === "plan-consent-cancel")!);
    commitOwnerUnmount(retiredForm);
    click(parentButton("سجّل موافقة المريض")); auxiliary = newDriver(); const current = auxiliaryView("ConsentForm");
    click(submit); await settle(); expect(writes()).toHaveLength(0);
    click(current.nodes.find((node) => node.type === "button" && text(node) === "سجّل الموافقة")!); await settle();
    expect(writes()).toHaveLength(1);
    finishPassiveUnmount(retiredForm);
  });

  it("commit retirement does not release a dispatched request or discard its uncertain outcome", async () => {
    await loaded(); changeInline("خدمة الخطة", "8");
    const add = childView().nodes.find((node) => node.props["data-action"] === "plan-add-item")!;
    const pending = deferred<ReturnType<typeof response>>(); writeResponse = pending.promise;
    click(add); expect(writes()).toHaveLength(1);
    await refreshAsDenied(); commitOwnerUnmount(child);
    expect(currentGuard?.()).toBe(false);
    click(add); expect(writes()).toHaveLength(1);
    pending.resolve(response({ message: "response lost after commit" }, 500)); await settle();
    expect(parentView().nodes.some((node) => node.props["data-testid"] === "plan-write-uncertain")).toBe(true);
    expect(writes()).toHaveLength(1);
    finishPassiveUnmount(child);
  });
});

it.each(["collection", "completion"])("retained parent %s handler cannot dispatch after committed removal", async (kind) => {
  await financialPlans();
  const initial = await planResponse; const body = await initial.json() as { capabilities: Record<string, boolean> };
  const installmentPlan = { ...fixture, installments: [{ id: 1, number: 1, dueDate: "2026-10-03", amountMinor: 20000 }] };
  planResponse = response({ ...body, plans: [projectPatientPlan(installmentPlan, true)], capabilities: { ...body.capabilities, canCollectPayments: true, canCompletePlan: true } });
  await loaded();
  if (kind === "collection") click(parentButton("تحصيل قسط"));
  const retained = parentButton(kind === "collection" ? "سجّل القسط واطبع السند" : "إنهاء الخطة");
  commitOwnerUnmount(parent); click(retained); await settle();
  expect(writes()).toHaveLength(0);
  finishPassiveUnmount(parent);
});

it("retained review navigation cannot replace the canonical URL after a same-path unmount commit", async () => {
  const host = { get location() { return url; }, history: { replaceState, pushState, length: 4 } } as unknown as Window;
  navigation = createPatientNavigation(host, { canLeave: () => currentGuard?.() ?? true, onChange: () => undefined });
  props.openVisitId = 78;
  props.onFocus = (target) => { navigation.navigate(focusDestination(target), target); };
  await loaded();
  const review = childView().nodes.find((node) => node.props["data-testid"] === "plan-review-visit-item-101")!;
  const committedUrl = url.href;
  commitOwnerUnmount(parent); click(review); await settle();
  expect(url.href).toBe(committedUrl); expect(replaceState).not.toHaveBeenCalled(); expect(writes()).toHaveLength(0);
  finishPassiveUnmount(parent);
});
