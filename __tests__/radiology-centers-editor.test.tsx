/** Synthetic React handler tests: no browser, real API, or database claims. */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RadiologyCentersEditor } from "../components/settings/RadiologyCentersEditor";
import { RADIOLOGY_CENTERS_KEY as KEY } from "../lib/radiology-centers";
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value; }]; },
  useLayoutEffect: (run:()=>void)=>run(),
  useRef: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }; return hooks.slots[index]; },
}));
vi.mock("../components/SessionProvider",()=>({useSessionActions:()=>({session:{username:"synthetic-admin",role:"admin"},ready:true})}));
type Element = ReactElement<Record<string, unknown>>;
const center = { id: "11111111-1111-4111-8111-111111111111", name: "مركز", address: "العنوان", active: false };
let editable = true;
let raw = JSON.stringify([center]);
const onSaved = vi.fn();
function render() { hooks.cursor = 0; const owner=RadiologyCentersEditor({ values: { [KEY]: raw }, versions: { [KEY]: "v1" }, editable, onSaved }) as Element; return (owner.type as (props:Record<string,unknown>)=>ReactNode)(owner.props); }
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...nodes(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children as ReactNode);
  return "";
}
function button(label: string) { const found = nodes(render()).find(node => node.type === "button" && text(node.props.children as ReactNode) === label); if (!found) throw new Error(label); return found; }
function click(label: string) { (button(label).props.onClick as () => void)(); }
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(() => { hooks.slots = []; hooks.cursor = 0; editable = true; raw = JSON.stringify([center]); onSaved.mockReset(); });
afterEach(() => vi.unstubAllGlobals());
it("preserves inactive entries and sends the original CAS version on save", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ [KEY]: raw, __versions: { [KEY]: "v2" } }) }); vi.stubGlobal("fetch", fetch);
  click("تعديل مراكز الأشعة");
  const checkbox = nodes(render()).find(node => node.type === "input" && node.props.type === "checkbox")!;
  expect(checkbox.props.checked).toBe(false);
  click("حفظ المراكز"); await flush();
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ [KEY]: raw, __versions: { [KEY]: "v1" }, __expectedActor: "synthetic-admin" });
  expect(onSaved).toHaveBeenCalledOnce(); expect(text(render())).toContain("حُفظت مراكز الأشعة");
});
it("retains edited fields on conflict and disables retries rather than overwriting newer values", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ message: "conflict" }) }); vi.stubGlobal("fetch", fetch);
  click("تعديل مراكز الأشعة");
  const input = nodes(render()).find(node => node.type === "input" && node.props.value === center.name)!;
  (input.props.onChange as (event: unknown) => void)({ target: { value: "اسم معدّل" } });
  click("حفظ المراكز"); await flush();
  expect(nodes(render()).some(node => node.props.value === "اسم معدّل")).toBe(true);
  expect(button("حفظ المراكز").props.disabled).toBe(true);
  click("حفظ المراكز"); expect(fetch).toHaveBeenCalledOnce(); expect(onSaved).not.toHaveBeenCalled();
});
it("deduplicates in-flight saves and rejects malformed successful responses", async () => {
  let finish!: (response: unknown) => void;
  const fetch = vi.fn(() => new Promise(resolve => { finish = resolve; })); vi.stubGlobal("fetch", fetch);
  click("تعديل مراكز الأشعة"); click("حفظ المراكز");
  expect(button("جارٍ الحفظ…").props.disabled).toBe(true); click("جارٍ الحفظ…"); expect(fetch).toHaveBeenCalledOnce();
  finish({ ok: true, json: async () => ({ [KEY]: raw }) }); await flush();
  expect(button("حفظ المراكز").props.disabled).toBe(true); expect(onSaved).not.toHaveBeenCalled();
});
it("provides no editing or deletion for a read-only role and fails closed on malformed saved data", () => {
  editable = false; expect(nodes(render()).filter(node => node.type === "button")).toHaveLength(0);
  editable = true; raw = "{}"; expect(button("تعديل مراكز الأشعة").props.disabled).toBe(true);
  expect(text(render())).toContain("لم تُستبدل تلقائيًا");
});
