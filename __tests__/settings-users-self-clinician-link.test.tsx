/** Actual Settings Users handlers with synthetic React scheduling and captured writes.
 * These assertions do not emulate the financial writer or claim browser/PG proof. */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UsersAndDoctorsPage from "../app/settings/users/page";
import { parseDoctorPermissions } from "../lib/doctor-permissions";
type Hooks = { values: unknown[]; cursor: number; changed: boolean; mounted: boolean; lateUpdates: number;
  effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void; layout: boolean }>;
  memos: Map<number, { deps?: readonly unknown[]; value: unknown }>; pending: Array<() => void>; layout: Array<() => void> };
const identity = vi.hoisted(() => ({ session: { username: "self-admin", role: "admin" } as { userId?: number; username: string; role: string } | null }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => identity.session }));
const runtime = vi.hoisted(() => ({ current: null as Hooks | null, editorUpdaters: [] as Array<(current: unknown) => unknown> }));
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
        const previous = hooks.values[index];
        if (typeof value === "function" && previous && typeof previous === "object" && "username" in previous && "partyId" in previous) runtime.editorUpdaters.push(value as (current: unknown) => unknown);
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
    hooks.layout.splice(0).forEach((effect) => effect());
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
let patchReply: (() => Promise<ReturnType<typeof response>>) | null = null;
let accountRole = "admin";
let accountUsername = "self-admin";
const writes: Array<{ url: string; body: Record<string, unknown> }> = [];
beforeEach(() => {
  hooks = { values: [], cursor: 0, changed: false, mounted: true, lateUpdates: 0,
    effects: new Map(), memos: new Map(), pending: [], layout: [] };
  runtime.editorUpdaters.length = 0;
  patchReply = null; accountRole = "admin"; accountUsername = "self-admin";
  identity.session = { username: "self-admin", role: "admin" }; writes.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      writes.push({ url, body: JSON.parse(String(init.body)) }); return patchReply ? patchReply() : response({ id: 71, username: accountUsername, role: accountRole, partyId: 81, partyName: "طبيب اصطناعي" });
    }
    if (init?.method && init.method !== "GET") throw new Error("Unexpected mutation");
    if (url === "/api/users") return response([{ id: 71, username: accountUsername, displayName: "حساب اصطناعي",
      role: accountRole, isActive: true, partyId: null, createdAt: "2026-10-31T00:00:00.000Z" }]);
    if (url === "/api/services?all=1") return response([]);
    if (url === "/api/parties?kind=doctor") return response([{ id: 81, name: "طبيب اصطناعي" }]);
    throw new Error(`Unexpected read ${url}`);
  }));
});
afterEach(() => { hooks.effects.forEach(effect => effect.cleanup?.()); hooks.mounted = false; vi.unstubAllGlobals(); });
function open() { (button("تعديل الملف").props.onClick as () => void)(); render(); }
function selector() { return nodes(render()).find(node => node.type === "select" && node.props["aria-label"] === "ربط الطبيب"); }
function role(value: string) {
  const control = nodes(render()).find(node => node.type === "select" && nodes(node.props.children as ReactNode).some(option => option.props.value === "doctor"));
  if (!control) throw new Error("Missing role selector");
  (control.props.onChange as (e: unknown) => void)({ target: { value } }); render();
}

function exportGrant() {
  const label = nodes(render()).find(node => node.type === "label" && text(node).includes("تصدير دراسات التقويم"));
  const checkbox = label && nodes(label).find(node => node.type === "input" && node.props.type === "checkbox");
  if (!checkbox) throw new Error("Missing actual export permission checkbox");
  return checkbox;
}
function permissionsTab() {
  const tab = nodes(render()).find(node => node.type === "button" && text(node).includes("الصلاحيات والخصوصية"));
  if (!tab) throw new Error("Missing actual permissions tab");
  (tab.props.onClick as () => void)(); render();
}
async function savePermissions() {
  await (button("حفظ التغييرات والصلاحيات").props.onClick as () => Promise<void>)();
  expect(writes).toHaveLength(1);
  return writes[0].body;
}
describe("explicit export grants across role changes", () => {
  it.each(["doctor", "reception"])("does not inherit synthesized admin export authority when changing to %s", async nextRole => {
    await ready(); open(); role(nextRole); permissionsTab();
    expect(exportGrant().props.checked).toBe(false);
    expect(writes).toEqual([]);
    const body = await savePermissions();
    expect(body.role).toBe(nextRole);
    // Like export, the medication-catalog grant (owner decision 6839071994) is explicit: a role change never inherits it.
    expect(body.permissions).toEqual({ ...parseDoctorPermissions(undefined, "admin"), canExportOrthoStudies: false, canManageMedicationCatalog: false });
    expect(body).not.toHaveProperty("commissionConfig");
  });
  it.each(["doctor", "reception"])("requires the actual checkbox to grant export after admin becomes %s", async nextRole => {
    await ready(); open(); role(nextRole); permissionsTab();
    const checkbox = exportGrant(); expect(checkbox.props.checked).toBe(false);
    (checkbox.props.onChange as (e: unknown) => void)({ target: { checked: true } }); render();
    expect(exportGrant().props.checked).toBe(true);
    const body = await savePermissions();
    expect(body.role).toBe(nextRole);
    expect(body.permissions).toEqual({ ...parseDoctorPermissions(undefined, "admin"), canManageMedicationCatalog: false });
    expect(body).not.toHaveProperty("commissionConfig");
  });
  it("retains an explicit grant for a same-role event and clears only that grant on a subsequent role transition", async () => {
    accountRole = "doctor"; accountUsername = "other-doctor";
    await ready(); open(); permissionsTab();
    (exportGrant().props.onChange as (e: unknown) => void)({ target: { checked: true } }); render();
    (nodes(render()).find(node => node.type === "button" && text(node).includes("البيانات الأساسية"))!.props.onClick as () => void)(); render();
    role("doctor"); permissionsTab(); expect(exportGrant().props.checked).toBe(true);
    (nodes(render()).find(node => node.type === "button" && text(node).includes("البيانات الأساسية"))!.props.onClick as () => void)(); render();
    role("reception"); permissionsTab(); expect(exportGrant().props.checked).toBe(false);
    const body = await savePermissions();
    expect(body.role).toBe("reception");
    expect(body.permissions).toEqual({ ...parseDoctorPermissions(undefined, "doctor"), canExportOrthoStudies: false });
  });
});
describe("own admin clinical identity selector", () => {
  it("shows an empty deliberate selector for self without writing on load or open", async () => {
    await ready(); expect(writes).toEqual([]); open(); await settle();
    expect(selector()?.props.value).toBe(""); expect(writes).toEqual([]);
    expect(text(render())).toContain("هويتي الطبية");
    expect(text(render())).toContain("لا يمنح صلاحية إصدار وصفة باسم طبيب آخر");
  });
  it("explicit selection uses only the unchanged link_doctor PATCH", async () => {
    await ready(); open();
    (selector()!.props.onChange as (e: unknown) => void)({ target: { value: "81" } });
    await settle();
    expect(writes).toEqual([{ url: "/api/users/71", body: { action: "link_doctor", partyId: 81 } }]);
    expect(selector()?.props.value).toBe(81);
    expect(runtime.editorUpdaters).toHaveLength(1);
    expect(runtime.editorUpdaters[0](null)).toBeNull();
  });
  it("preserves an unsaved profile draft while refreshing only confirmed clinical identity", async () => {
    await ready(); open();
    const name = nodes(render()).find(node => node.type === "input" && node.props.value === "حساب اصطناعي")!;
    (name.props.onChange as (e: unknown) => void)({ target: { value: "اسم مسودة" } }); render();
    const password = nodes(render()).find(node => node.type === "input" && node.props.type === "password")!;
    (password.props.onChange as (e: unknown) => void)({ target: { value: "synthetic-unsaved-password" } }); render();
    await (selector()!.props.onChange as (e: unknown) => Promise<void>)({ target: { value: "81" } });
    expect(selector()?.props.value).toBe(81);
    expect(nodes(render()).some(node => node.type === "input" && node.props.type === "password" && node.props.value === "synthetic-unsaved-password")).toBe(true);
    expect(nodes(render()).some(node => node.type === "input" && node.props.value === "اسم مسودة")).toBe(true);
    expect(writes).toEqual([{ url: "/api/users/71", body: { action: "link_doctor", partyId: 81 } }]);
  });
  it.each([{ id: 72 }, { username: "other-admin" }, { role: "doctor" }, { partyId: 82 }, { partyName: 42 }])("ignores mismatched successful response identity %j", async mismatch => {
    patchReply = async () => response({ id: 71, username: "self-admin", role: "admin", partyId: 81, partyName: "طبيب اصطناعي", ...mismatch });
    await ready(); open();
    await (selector()!.props.onChange as (e: unknown) => Promise<void>)({ target: { value: "81" } });
    expect(selector()?.props.value).toBe(""); expect(writes).toHaveLength(1);
  });
  it("does not close a newer editor when an old deliberate link completes", async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;
    const pending = new Promise<ReturnType<typeof response>>(done => { resolve = done; });
    patchReply = () => pending;
    await ready(); open();
    const saving = (selector()!.props.onChange as (e: unknown) => Promise<void>)({ target: { value: "81" } });
    (button("إغلاق").props.onClick as () => void)(); open();
    resolve(response({ id: 71, username: "self-admin", role: "admin", partyId: 81, partyName: "طبيب اصطناعي" })); await saving; await settle();
    expect(selector()?.props.value).toBe(""); expect(writes).toHaveLength(1);
  });
  it("keeps the editor for a failed explicit link without assuming success", async () => {
    patchReply = async () => response({ message: "رفض الربط التجريبي" }, 403);
    await ready(); open();
    await (selector()!.props.onChange as (e: unknown) => Promise<void>)({ target: { value: "81" } });
    expect(selector()).toBeTruthy(); expect(text(render())).toContain("رفض الربط التجريبي");
    expect(writes).toHaveLength(1);
  });
  it.each(["other-admin", "SELF-ADMIN", " self-admin", ""])('does not expose another or normalized identity %s', async username => {
    accountUsername = username; await ready(); open(); expect(selector()).toBeUndefined(); expect(writes).toEqual([]);
  });
  it.each([null, { username: "self-admin", role: "reception" }, { username: "", role: "admin" }])("fails closed for ineligible session %j", async session => {
    identity.session = session; await ready(); open(); expect(selector()).toBeUndefined(); expect(writes).toEqual([]);
  });
  it("does not expose self admin identity for an unsaved role conversion", async () => {
    accountRole = "reception"; await ready(); open(); role("admin"); expect(selector()).toBeUndefined(); expect(writes).toEqual([]);
  });
  it("hides self admin identity when the draft role leaves admin", async () => {
    await ready(); open(); role("reception"); expect(selector()).toBeUndefined(); expect(writes).toEqual([]);
  });
  it("preserves the existing doctor selector independently of admin self identity", async () => {
    accountRole = "doctor"; accountUsername = "other-doctor"; await ready(); open();
    expect(selector()).toBeTruthy(); expect(text(render())).not.toContain("هويتي الطبية"); expect(writes).toEqual([]);
  });
});


it('requires immutable own-account identity when supplied by the session', async () => {
  identity.session = { userId: 72, username: 'self-admin', role: 'admin' };
  await ready(); open(); expect(selector()).toBeUndefined(); expect(writes).toEqual([]);
});
it('retires a pending link and retained callback on immutable account change', async () => {
  identity.session = { userId: 71, username: 'self-admin', role: 'admin' };
  let resolve!: (value: ReturnType<typeof response>) => void;
  patchReply = () => new Promise(done => { resolve = done; });
  await ready(); open();
  const old = selector()!.props.onChange as (e: unknown) => Promise<void>;
  const saving = old({target:{value:'81'}});
  identity.session = { userId: 72, username: 'self-admin', role: 'admin' };
  await ready();
  resolve(response({id:71,username:'self-admin',role:'admin',partyId:81,partyName:'طبيب اصطناعي'}));
  await saving; await settle(); await old({target:{value:'81'}});
  expect(writes).toHaveLength(1); expect(selector()).toBeUndefined();
  expect(runtime.editorUpdaters).toHaveLength(0);
});
it('grants saved active prescription reprint only through an explicit reception permission edit', async () => {
  accountRole = 'reception'; accountUsername = 'reception-account';
  await ready(); open();
  const permissions = nodes(render()).find(node => node.type === 'button' && text(node).includes('الصلاحيات'))!;
  (permissions.props.onClick as () => void)(); render();
  const label = nodes(render()).find(node => node.type === 'label' && text(node).includes('إعادة طباعة الوصفات المحفوظة الفاعلة فقط'))!;
  const control = nodes(label).find(node => node.type === 'input')!;
  expect(control.props.checked).toBe(false); expect(writes).toEqual([]);
  (control.props.onChange as (event: unknown) => void)({target:{checked:true}}); render();
  const save = nodes(render()).find(node => node.type === 'button' && text(node).includes('حفظ التغييرات'))!;
  await (save.props.onClick as () => Promise<void>)();
  expect(writes).toHaveLength(1);
  expect(writes[0].body.permissions).toMatchObject({canPrintSavedPrescriptions:true});
  expect(writes[0].body.action).toBeUndefined();
});

it('sends one explicit link for repeated same-tick selections', async () => {
  let resolve!: (value: ReturnType<typeof response>) => void;
  patchReply = () => new Promise(done => { resolve = done; });
  await ready(); open();
  const change = selector()!.props.onChange as (event: unknown) => Promise<void>;
  const first = change({target:{value:'81'}});
  await change({target:{value:'81'}});
  expect(writes).toHaveLength(1);
  resolve(response({id:71,username:'self-admin',role:'admin',partyId:81,partyName:'طبيب اصطناعي'}));
  await first;
});
it('ignores a retained link callback after the editor is closed and reopened', async () => {
  await ready(); open();
  const old = selector()!.props.onChange as (event: unknown) => Promise<void>;
  (button('إغلاق').props.onClick as () => void)(); open();
  await old({target:{value:'81'}});
  expect(writes).toEqual([]); expect(selector()?.props.value).toBe('');
});
