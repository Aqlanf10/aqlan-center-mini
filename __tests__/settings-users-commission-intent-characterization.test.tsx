/** Actual Settings Users handlers with synthetic React scheduling and captured writes.
 * These assertions do not emulate the financial writer or claim browser/PG proof. */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UsersAndDoctorsPage from "../app/settings/users/page";
import { parseDoctorPermissions, parseDoctorCommissionConfig, type DoctorCommissionConfig } from "../lib/doctor-permissions";
import { resolvePolicyForShare } from "../lib/commission";
import { CommissionCategoryEditor } from "../components/settings/CommissionCategoryEditor";
type Hooks = { values: unknown[]; cursor: number; changed: boolean; mounted: boolean; lateUpdates: number;
  effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void; layout: boolean }>;
  memos: Map<number, { deps?: readonly unknown[]; value: unknown }>; pending: Array<() => void>; layout: Array<() => void> };
const runtime = vi.hoisted(() => ({ current: null as Hooks | null }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const current = () => { if (!runtime.current) throw new Error("Missing synthetic owner"); return runtime.current; };
  const slot = (hooks: Hooks, initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const memo = (compute: () => unknown, deps?: readonly unknown[]) => { const hooks = current(); const index = slot(hooks, undefined); const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = compute(); hooks.memos.set(index, { deps, value }); return value; };
  const effect = (layout: boolean) => (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const hooks = current(); const index = slot(hooks, undefined); const previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    (layout ? hooks.layout : hooks.pending).push(() => { previous?.cleanup?.(); if (previous) previous.cleanup = undefined;
      const cleanup = run(); hooks.effects.set(index, { deps, layout, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => { const hooks = current(); const index = slot(hooks, typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => { if (!hooks.mounted) hooks.lateUpdates++;
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true; hooks.values[index] = next; }]; },
    useRef: (initial: unknown) => { const hooks = current(); return hooks.values[slot(hooks, { current: initial })]; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: effect(false), useLayoutEffect: effect(true),
  };
});
type Element = ReactElement<Record<string, unknown>>;
let hooks: Hooks;
function render(): ReactNode {
  let tree: ReactNode; let rounds = 0;
  do {
    if (++rounds > 25) throw new Error("Actual page did not settle");
    hooks.cursor = 0; hooks.changed = false; runtime.current = hooks;
    tree = UsersAndDoctorsPage(); runtime.current = null;
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
function nodes(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const node = tree as Element; return [node, ...nodes(node.props.children as ReactNode)];
}
function text(tree: ReactNode): string {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree && typeof tree === "object" && "props" in tree) return text((tree as Element).props.children as ReactNode);
  return tree == null || typeof tree === "boolean" ? "" : String(tree);
}
function button(label: string) {
  const item = nodes(render()).find((node) => node.type === "button" && text(node) === label);
  if (!item) throw new Error(`Missing actual button ${label}`);
  return item;
}
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function ready() { render(); await settle(); render(); await settle(); render(); }
const response = (payload: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
let patchReply: (() => Promise<ReturnType<typeof response>>) | null;
let secondAccount: boolean;
const fetchMock = vi.fn();
const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
let rawConfig: DoctorCommissionConfig | null;
const accountId = 71;
const partyPercent = 20;
const at = "2026-10-04T12:00:00.000Z";
const share = { category: "rct" };
beforeEach(() => {
  hooks = { values: [], cursor: 0, changed: false, mounted: true, lateUpdates: 0,
    effects: new Map(), memos: new Map(), pending: [], layout: [] };
  rawConfig = null; patchReply = null; secondAccount = false; writes.splice(0); fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      writes.push({ url, body: JSON.parse(String(init.body)) });
      // Do not emulate the writer; this response only allows actual handler completion/reload.
      return patchReply ? patchReply() : response({ ok: true });
    }
    if (init?.method && init.method !== "GET") throw new Error(`Unexpected mutation ${init.method}`);
    if (url === "/api/users") return response([{ id: accountId, username: "null-policy-doctor", displayName: "طبيب سياسة اصطناعي",
      role: "doctor", isActive: true, partyId: 81, partyName: "جهة سياسة اصطناعية", createdAt: at,
      // Actual listUsers contracts parse SQL NULL, losing raw absence at the UI boundary.
      commissionConfig: parseDoctorCommissionConfig(rawConfig) }, ...(secondAccount ? [{ id: 72, username: "other-doctor", displayName: "طبيب آخر", role: "doctor", isActive: true, partyId: 82, createdAt: at, commissionConfig: parseDoctorCommissionConfig(null) }] : [])]);
    if (url === "/api/services?all=1") return response([]);
    if (url === "/api/parties?kind=doctor") return response([{ id: 81, name: "جهة سياسة اصطناعية", commissionPercent: partyPercent }]);
    throw new Error(`Unexpected read ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  hooks.effects.forEach((effect) => effect.cleanup?.()); hooks.mounted = false;
  vi.unstubAllGlobals();
});

const saveLabel = "حفظ التغييرات والصلاحيات";
function click(node: Element) { return (node.props.onClick as () => void | Promise<void>)(); }
function change(node: Element, value: string | boolean) {
  (node.props.onChange as (event: unknown) => void)({ target: typeof value === "boolean" ? { checked: value } : { value } });
}
function find(predicate: (node: Element) => boolean) {
  const node = nodes(render()).find(predicate);
  if (!node) throw new Error("Missing actual control");
  return node;
}
function namedButton(part: string) { return find(node => node.type === "button" && text(node).includes(part)); }
function open(index = 0) {
  const buttons = nodes(render()).filter(node => node.type === "button" && text(node) === "تعديل الملف");
  if (!buttons[index]) throw new Error("Missing account editor");
  click(buttons[index]); render();
}
function finance() { click(namedButton("النِسب وطريقة احتساب الأتعاب")); render(); }
function percentInput() { return find(node => node.type === "input" && node.props.type === "number" && node.props.value === 30); }
function sent() { return writes.at(-1)!.body.commissionConfig as DoctorCommissionConfig; }
function omitted(body = writes.at(-1)!.body) {
  for (const key of ["commissionConfig", "commissionPercent", "clearCommissionConfig"]) expect(Object.hasOwn(body, key)).toBe(false);
}
function role(value: string) {
  click(namedButton("البيانات الأساسية"));
  change(find(node => node.type === "select" && nodes(node.props.children as ReactNode).some(option => option.props.value === "doctor")), value);
  render();
}
function categoryEditor() { return find(node => node.type === CommissionCategoryEditor); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("actual doctor editor financial intent", () => {
  it("truly omits financial fields on a Basic name edit despite projected30 and rawNULL ordinary20", async () => {
    expect(resolvePolicyForShare({ percent: partyPercent, config: rawConfig }, at, share).percent).toBe(20);
    expect(parseDoctorCommissionConfig(rawConfig).defaultPercent).toBe(30);
    await ready(); open();
    change(find(node => node.type === "input" && node.props.value === "طبيب سياسة اصطناعي"), "اسم طبيب محدّث فقط");
    await click(button(saveLabel)); await ready();
    expect(writes).toHaveLength(1); expect(writes[0].url).toBe(`/api/users/${accountId}`);
    expect(writes[0].body.displayName).toBe("اسم طبيب محدّث فقط"); omitted();
    expect(rawConfig).toBeNull();
    expect(resolvePolicyForShare({ percent: partyPercent, config: rawConfig }, at, share).percent).toBe(20);
  });
  it("omits an already explicit advanced17 from an untouched Basic save", async () => {
    rawConfig = { ...parseDoctorCommissionConfig(null), defaultPercent: 17 };
    await ready(); open(); await click(button(saveLabel)); await ready();
    expect(writes).toHaveLength(1); omitted();
    expect(resolvePolicyForShare({ percent: partyPercent, config: rawConfig }, at, share).percent).toBe(17);
  });
  it("financial-tab visits and permission edits do not establish financial intent", async () => {
    await ready(); open(); finance();
    expect(text(render())).toContain("هذه مسودة إعداد متقدم");
    click(namedButton("الصلاحيات"));
    const beforePermissions = parseDoctorPermissions(undefined, "doctor");
    const toggle = find(node => node.props.role === "button" && text(node).includes("رؤية جميع مرضى المركز"));
    click(toggle);
    await click(button(saveLabel)); await ready();
    expect(writes).toHaveLength(1);
    expect(writes[0].body.permissions).toEqual({ ...beforePermissions, canViewAllPatients: !beforePermissions.canViewAllPatients });
    omitted();
  });
  it.each([0, 12.345, 30])("keeps explicit general %s, including same-value intent, without precision rounding", async value => {
    await ready(); open(); finance(); const input = percentInput();
    expect(input.props).toMatchObject({ step: "any", min: 0, max: 100 });
    change(input, String(value)); await click(button(saveLabel)); await ready();
    expect(writes).toHaveLength(1); expect(sent()).toMatchObject({ defaultPercent: value });
    expect(Object.hasOwn(writes[0].body, "commissionPercent")).toBe(false);
  });
  it("edits exact category/general draft values while retaining custom and legacy keys and special rules", async () => {
    rawConfig = parseDoctorCommissionConfig({ calculationMode: "by_category", defaultPercent: 17, categoryRates: { endo: 72, custom_saved: 41 }, customServiceRates: [{ id: "x", serviceId: 7, serviceName: "خاص", percent: 83 }] });
    const before = structuredClone(rawConfig);
    await ready(); open(); finance();
    (categoryEditor().props.onCategoryChange as (key: string, percent: number) => void)("rct", 12.345);
    (categoryEditor().props.onCategoryChange as (key: string, percent: number) => void)("filling", 0);
    (categoryEditor().props.onDefaultPercentChange as (percent: number) => void)(0.125);
    await click(button(saveLabel)); await ready();
    expect(sent()).toMatchObject({ defaultPercent: 0.125, categoryRates: { rct: 12.345, filling: 0, endo: 72, custom_saved: 41 } });
    expect(sent().customServiceRates).toEqual(before.customServiceRates); expect(sent().serviceRates).toEqual(before.serviceRates);
  });
  it("records an explicit calculation mode and fixed amount edit", async () => {
    await ready(); open(); finance(); click(namedButton("مبلغ مقطوع ثابت"));
    change(find(node => node.type === "input" && node.props.type === "number" && node.props.max === undefined), "725");
    await click(button(saveLabel)); await ready();
    expect(sent()).toMatchObject({ calculationMode: "fixed", fixedAmountPerVisitMinor: 725 });
  });
  it("records explicit basis and deduction choices", async () => {
    await ready(); open(); finance(); click(namedButton("على إجمالي الفواتير الصادرة"));
    const checkbox = find(node => node.type === "input" && node.props.type === "checkbox");
    change(checkbox, !checkbox.props.checked); await click(button(saveLabel)); await ready();
    expect(sent()).toMatchObject({ basis: "invoiced", deductLabCost: !checkbox.props.checked });
  });
  it("resets financial intent after a role change away from doctor and back", async () => {
    await ready(); open(); finance(); change(percentInput(), "12.345"); role("reception");
    expect(nodes(render()).some(node => node.type === "button" && text(node).includes("النِسب وطريقة احتساب الأتعاب"))).toBe(false);
    role("doctor"); await click(button(saveLabel)); await ready(); omitted();
  });
  it("cancelling and reopening the same account does not leak financial intent", async () => {
    await ready(); open(); finance(); change(percentInput(), "12.345"); click(button("إغلاق")); open();
    await click(button(saveLabel)); await ready(); omitted();
  });
  it("cancelling before opening another account does not leak financial intent", async () => {
    secondAccount = true; await ready(); open(); finance(); change(percentInput(), "12.345"); click(button("إغلاق")); open(1);
    await click(button(saveLabel)); await ready(); expect(writes[0].url).toBe("/api/users/72"); omitted();
  });
  it("an unadded special-service draft stays nonfinancial and resets when reopened", async () => {
    await ready(); open(); finance(); click(button("كتابة إجراء خاص"));
    change(find(node => node.props.placeholder === "مثال: تقويم الأسنان، زراعة الغرسة السويسرية..."), "غير مضاف");
    await click(button(saveLabel)); await ready(); omitted(); open(); finance(); click(button("كتابة إجراء خاص"));
    expect(find(node => node.props.placeholder === "مثال: تقويم الأسنان، زراعة الغرسة السويسرية...").props.value).toBe("");
  });
  it.each([0, 0.125])("records an explicitly added special-service percentage %s", async value => {
    await ready(); open(); finance(); click(button("كتابة إجراء خاص"));
    change(find(node => node.props.placeholder === "مثال: تقويم الأسنان، زراعة الغرسة السويسرية..."), "إجراء جديد");
    const input = find(node => node.type === "input" && node.props.type === "number" && node.props.value === 35);
    expect(input.props.step).toBe("any"); change(input, String(value)); click(button("+ إضافة النسبة"));
    await click(button(saveLabel)); await ready();
    expect(sent().customServiceRates).toMatchObject([{ serviceName: "إجراء جديد", percent: value }]);
    expect(sent().serviceRates?.["إجراء جديد"]).toBe(value);
  });
  it("allows fractional new-account percentages without changing creation ownership", async () => {
    await ready(); click(button("+ إضافة طبيب / مستخدم جديد"));
    const input = find(node => node.type === "input" && node.props.type === "number");
    expect(input.props).toMatchObject({ step: "any", min: 0, max: 100 });
    change(input, "12.345"); expect(find(node => node.type === "input" && node.props.type === "number").props.value).toBe(12.345);
    expect(writes).toHaveLength(0);
  });
  it("explicitly removing the last modern service rule retains an authoritative empty array", async () => {
    rawConfig = parseDoctorCommissionConfig({ customServiceRates: [{ id: "last", serviceId: 7, serviceName: "خاص", percent: 0.125 }] });
    await ready(); open(); finance();
    const input = find(node => node.type === "input" && node.props.value === 0.125); expect(input.props.step).toBe("any");
    click(find(node => node.props.title === "حذف هذه النسبة الخاصة")); await click(button(saveLabel)); await ready();
    expect(sent().customServiceRates).toEqual([]); expect(sent().serviceRates).toEqual({});
  });
  it("a failed Save retains the same-session draft and financial intent for a deliberate retry", async () => {
    patchReply = async () => response({ message: "تعذّر الحفظ التجريبي، أعد المحاولة" }, 503);
    await ready(); open(); finance(); change(percentInput(), "12.345"); await click(button(saveLabel)); await ready();
    expect(writes).toHaveLength(1); expect(text(render())).toContain("تعذّر الحفظ التجريبي، أعد المحاولة");
    expect(find(node => node.type === "input" && node.props.value === 12.345)).toBeTruthy();
    patchReply = null; await click(button(saveLabel)); await ready();
    expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]); expect(sent().defaultPercent).toBe(12.345);
  });
  it.each([0, 1])("a delayed old Save cannot close a newer editor for account index %s", async index => {
    secondAccount = true; const pending = deferred<ReturnType<typeof response>>(); patchReply = () => pending.promise;
    await ready(); open(); finance(); change(percentInput(), "12.345"); const saving = click(button(saveLabel));
    click(button("إغلاق")); open(index); pending.resolve(response({ ok: true })); await saving; await ready();
    expect(button(saveLabel)).toBeTruthy(); patchReply = null;
    await click(button(saveLabel)); await ready(); expect(writes).toHaveLength(2);
    expect(writes[1].url).toBe(`/api/users/${index === 0 ? 71 : 72}`); omitted(writes[1].body);
    expect(writes[0].body.commissionConfig).toMatchObject({ defaultPercent: 12.345 });
  });
  it("a captured Save callback cannot submit after its editor session was retired", async () => {
    await ready(); open(); finance(); change(percentInput(), "12.345"); const staleSave = button(saveLabel);
    click(button("إغلاق")); open(); await click(staleSave); await ready(); expect(writes).toHaveLength(0);
    await click(button(saveLabel)); await ready(); omitted();
  });
  it("detects a map-only GET projection before reparsing and permits safe Basic omission", async () => {
    rawConfig = { ...parseDoctorCommissionConfig(null), serviceRates: { "خاص قديم": 41.5 }, customServiceRates: undefined };
    const before = structuredClone(rawConfig);
    await ready(); open(); finance();
    expect(find(node => node.type === "fieldset").props.disabled).toBe(true);
    expect(text(render())).toContain("الإعدادات المالية للقراءة فقط");
    role("doctor"); await click(button(saveLabel)); await ready(); omitted(); expect(rawConfig).toEqual(before);
  });
  it("refuses a dirty financial Save even if a disabled legacy-map control is invoked directly", async () => {
    rawConfig = { ...parseDoctorCommissionConfig(null), serviceRates: { "7": 41.5 }, customServiceRates: undefined };
    await ready(); open(); finance(); change(percentInput(), "12.345");
    await click(button(saveLabel)); await ready(); expect(writes).toHaveLength(0);
    expect(text(render())).toContain("لا يمكن حفظ تعديل مالي لهذه القواعد القديمة بأمان");
  });
});
