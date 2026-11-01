/** Actual component handlers under synthetic hooks; not browser or database proof. */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RadiologyRequests } from "../components/RadiologyRequests";
const state = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, mounted: true, lateUpdates: 0, effects: [] as Array<() => void>, cleanup: [] as Array<() => void>, session: { username: "synthetic", role: "doctor" } }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => state.session }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = initial;
    return [state.slots[index], (value: unknown) => { if (!state.mounted) state.lateUpdates++; state.slots[index] = typeof value === "function" ? value(state.slots[index]) : value; }]; },
  useRef: (initial: unknown) => { const index = state.cursor++; if (!(index in state.slots)) state.slots[index] = { current: initial }; return state.slots[index]; },
  useEffect: (run: () => void | (() => void)) => { const index = state.cursor++; if (!(index in state.slots)) { state.slots[index] = true; state.effects.push(() => { const cleanup = run(); if (cleanup) state.cleanup.push(cleanup); }); } },
}));
type Element = ReactElement<Record<string, unknown>>;
const KEY = "11111111-1111-4111-8111-111111111111", CENTER = "22222222-2222-4222-8222-222222222222";
let fetchMock: ReturnType<typeof vi.fn>;
let storage: Map<string, string>;
function render() {
  state.cursor = 0;
  const panel = RadiologyRequests({ patientId: 7, visitId: 9 });
  const rendered = (panel.type as (props: unknown) => ReactNode)(panel.props);
  state.effects.splice(0).forEach(effect => effect());
  return rendered;
}
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...nodes(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
}
function button(label: string) { const node = nodes(render()).find(node => node.type === "button" && text(node.props.children as ReactNode) === label); if (!node) throw new Error(label); return node; }
function click(label: string) { (button(label).props.onClick as () => void)(); }
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
function change(node: Element, value: string) { (node.props.onChange as (event: unknown) => void)({ target: { value } }); }
async function ready() {
  fetchMock.mockResolvedValueOnce(response({ requests: [], nextCursor: null, canIssue: true }));
  click("عرض / تحديث السجل"); await flush();
  fetchMock.mockResolvedValueOnce(response({ centers: [{ id: CENTER, name: "مركز", address: "عنوان", active: true }] }));
  click("طلب أشعة جديد"); await flush();
  change(nodes(render()).find(node => node.type === "select")!, CENTER);
  const inputs = nodes(render()).filter(node => node.type === "input");
  change(inputs[0], "بانوراما"); change(inputs[1], "الفكين");
}
beforeEach(() => {
  state.slots = []; state.cursor = 0; state.effects = []; state.cleanup = []; state.mounted = true; state.lateUpdates = 0;
  state.session = { username: "synthetic", role: "doctor" };
  fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("crypto", { randomUUID: vi.fn(() => KEY) });
  storage = new Map();
  vi.stubGlobal("window", { open: vi.fn(), print: vi.fn(), confirm: vi.fn(() => false), addEventListener: vi.fn(), removeEventListener: vi.fn(), sessionStorage: {
    getItem: vi.fn((key: string) => storage.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }), removeItem: vi.fn((key: string) => { storage.delete(key); }),
  } });
});
afterEach(() => { state.cleanup.forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });
it("retains the exact key and frozen body on ambiguous response, unknown recovery, and retry without auto-print", async () => {
  await ready(); fetchMock.mockRejectedValueOnce(new Error("lost response"));
  click("إصدار وحفظ الطلب"); await flush();
  const first = fetchMock.mock.calls.find(call => call[1]?.method === "POST")![1].body;
  expect(JSON.parse(first).commandKey).toBe(KEY);
  expect(nodes(render()).filter(node => ["input", "select", "textarea"].includes(String(node.type))).every(node => node.props.disabled)).toBe(true);
  fetchMock.mockResolvedValueOnce(response({ state: "unknown" })); click("التحقق من نتيجة الإصدار"); await flush();
  expect(fetchMock.mock.calls.at(-1)![0]).toContain(`/commands/${KEY}?visitId=9&patientId=7`);
  expect(text(render())).toContain("إعادة نفس الطلب بأمان");
  fetchMock.mockResolvedValueOnce(response({ id: KEY, replayed: true })); click("إعادة نفس الطلب بأمان"); await flush();
  const posts = fetchMock.mock.calls.filter(call => call[1]?.method === "POST");
  expect(posts).toHaveLength(2); expect(posts[1][1].body).toBe(first); expect(crypto.randomUUID).toHaveBeenCalledOnce();
  expect(nodes(render()).some(node => node.type === "a" && node.props.href === `/print/radiology-request/${KEY}?patientId=7`)).toBe(true);
  expect(window.open).not.toHaveBeenCalled(); expect(window.print).not.toHaveBeenCalled();
});
it("synchronously fences double clicks before React rerenders", async () => {
  await ready(); let finish!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const handler = button("إصدار وحفظ الطلب").props.onClick as () => void;
  handler(); handler();
  expect(fetchMock.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  finish(response({ id: KEY, replayed: false })); await flush();
  expect(crypto.randomUUID).toHaveBeenCalledOnce();
});
it("ignores an issuance response after unmount and scopes remounts to patient and principal", async () => {
  await ready(); let finish!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); click("إصدار وحفظ الطلب");
  state.cleanup.forEach(cleanup => cleanup()); state.mounted = false;
  finish(response({ id: KEY })); await flush(); expect(state.lateUpdates).toBe(0);
  const before = RadiologyRequests({ patientId: 7, visitId: 9 }).key;
  expect(RadiologyRequests({ patientId: 8, visitId: 9 }).key).not.toBe(before);
  state.session = { username: "other", role: "doctor" };
  expect(RadiologyRequests({ patientId: 7, visitId: 9 }).key).not.toBe(before);
  expect(window.open).not.toHaveBeenCalled();
});
it("allows reception history links but exposes no issuance before a positive server capability", async () => {
  state.session = { username: "reception", role: "reception" };
  expect(text(render())).not.toContain("طلب أشعة جديد");
  fetchMock.mockResolvedValueOnce(response({ requests: [{ id: KEY, doctorName: "طبيب", centerName: "مركز", createdAtLabel: "اليوم" }], nextCursor: null, canIssue: false }));
  click("عرض / تحديث السجل"); await flush();
  expect(text(render())).toContain("طباعة A6"); expect(text(render())).not.toContain("طلب أشعة جديد");
  expect(fetchMock.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
});
it("ignores stale history results after unmount", async () => {
  let finish!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); click("عرض / تحديث السجل");
  state.cleanup.forEach(cleanup => cleanup()); state.mounted = false;
  finish(response({ requests: [], nextCursor: null, canIssue: true })); await flush(); expect(state.lateUpdates).toBe(0);
});

it("persists only an opaque key and blocks fresh issuance after reload while recovery remains unknown", async () => {
  await ready(); fetchMock.mockRejectedValueOnce(new Error("lost response")); click("إصدار وحفظ الطلب"); await flush();
  expect([...storage.values()]).toEqual([KEY]);
  expect([...storage.keys()]).toEqual(['radiology-request:v1:["synthetic",7,9]']);
  state.cleanup.forEach(cleanup => cleanup()); state.slots = []; state.cursor = 0; state.effects = []; state.cleanup = [];
  render(); render();
  expect(button("إعادة نفس الطلب بأمان").props.disabled).toBe(true);
  fetchMock.mockResolvedValueOnce(response({ state: "unknown" })); click("التحقق من نتيجة الإصدار"); await flush();
  expect(button("إعادة نفس الطلب بأمان").props.disabled).toBe(true);
  expect([...storage.values()]).toEqual([KEY]); expect(crypto.randomUUID).toHaveBeenCalledOnce();
  const postsBefore = fetchMock.mock.calls.filter(call => call[1]?.method === "POST").length;
  click("إعادة نفس الطلب بأمان"); await flush();
  expect(fetchMock.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(postsBefore);
});
it("fails closed without a POST when durable-key storage cannot be written", async () => {
  await ready(); vi.mocked(window.sessionStorage.setItem).mockImplementation(() => { throw new Error("storage denied"); });
  click("إصدار وحفظ الطلب"); await flush();
  expect(fetchMock.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
  expect(text(render())).toContain("storage denied");
});
it("fails closed with disabled issuance when stored key is malformed", async () => {
  storage.set('radiology-request:v1:["synthetic",7,9]', "corrupt"); await ready();
  expect(button("إصدار وحفظ الطلب").props.disabled).toBe(true);
  click("إصدار وحفظ الطلب"); await flush(); expect(fetchMock.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
  expect(crypto.randomUUID).not.toHaveBeenCalled();
});

it("clears an uncertain opaque reference only after explicit confirmation, with no automatic POST or new key", async () => {
  await ready(); fetchMock.mockRejectedValueOnce(new Error("lost response")); click("إصدار وحفظ الطلب"); await flush();
  const posts = fetchMock.mock.calls.filter(call => call[1]?.method === "POST").length;
  click("بدء طلب مستقل بعد مراجعة السجل");
  expect(window.confirm).toHaveBeenCalledOnce(); expect([...storage.values()]).toEqual([KEY]); expect(crypto.randomUUID).toHaveBeenCalledOnce();
  vi.mocked(window.confirm).mockReturnValue(true); click("بدء طلب مستقل بعد مراجعة السجل");
  expect(storage.size).toBe(0); expect(crypto.randomUUID).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(posts);
  expect(text(render())).toContain("لم يصدر طلب جديد تلقائيًا");
  expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining("قد يكون قد حُفظ"));
});
