import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return i; };
  return { ...react, useState: (initial: unknown) => { const i = slot(typeof initial === "function" ? initial() : initial); return [hooks.values[i], (v: unknown) => { hooks.values[i] = typeof v === "function" ? v(hooks.values[i]) : v; }]; },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })], useEffect: () => {} };
});
import { LabOrderClinicalEditor } from "../components/LabOrderClinicalEditor";
import { LabShadeSelector } from "../components/LabShadeSelector";
import type { LabOrder } from "../lib/lab";
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as Element; return [el, ...elements(el.props.children as ReactNode)];
}
let props: Parameters<typeof LabOrderClinicalEditor>[0];
const fetchMock = vi.fn();
function render() { hooks.cursor = 0; return elements(LabOrderClinicalEditor(props)); }
function save() { (render().find(el => el.type === "button")!.props.onClick as () => void)(); }
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0;
  props = { order: { id: 70, doctorId: 10, workType: "تاج", partyId: null, labName: "Synthetic old lab", labPhone: null, toothNumbers: "11(Crown)", shade: "OM3", shadeSpecification: null } as LabOrder,
    onSaved: vi.fn(), onClose: vi.fn() };
  fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
describe("clinical dispatch correction handlers", () => {
  it("preserves legacy shade, lab and roles until explicit edits and sends an exact expected snapshot", async () => {
    const fields = render().find(el => el.type === LabShadeSelector)!;
    expect(fields.props.globalShade).toBe("OM3");
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    save(); await flush();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.action).toBe("update_clinical");
    expect(body.clinical).toEqual(body.expectedClinical);
    expect(body.clinical).toEqual({ doctorId: 10, workType: "تاج", partyId: null, labName: "Synthetic old lab", labPhone: null,
      toothNumbers: "11(Crown)", shade: "OM3", shadeSpecification: null });
    expect(props.onSaved).toHaveBeenCalledOnce();
  });
  it("blocks saving contradictory denture roles without rewriting them", () => {
    const work = render().find(el => el.props["aria-label"] === "نوع العمل في التصحيح")!;
    (work.props.onChange as (event: unknown) => void)({ target: { value: "طقم جزئي" } });
    save(); expect(fetchMock).not.toHaveBeenCalled();
    expect(render().find(el => el.props["aria-label"] === "أسنان الإرسالية للتصحيح")!.props.value).toBe("11(Crown)");
    expect(render().some(el => el.props.role === "alert")).toBe(true);
  });
  it("blocks same-tick repeat and Escape during save", () => {
    fetchMock.mockReturnValue(new Promise(() => {})); save(); save();
    expect(fetchMock).toHaveBeenCalledOnce();
    (render().find(el => el.type === "dialog")!.props.onCancel as (event: unknown) => void)({ preventDefault() {} });
    expect(props.onClose).not.toHaveBeenCalled();
  });
  it("reports financial lab lock or stale conflict without closing", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ message: "Synthetic financial lab lock" }) });
    save(); await flush(); expect(props.onSaved).not.toHaveBeenCalled();
    expect(render().some(el => el.props.role === "alert" && el.props.children === "Synthetic financial lab lock")).toBe(true);
  });
  it("allows explicit emptying of the legacy global shade without sending money fields", async () => {
    const fields = render().find(el => el.type === LabShadeSelector)!;
    (fields.props.onGlobalShadeChange as (value: string) => void)("");
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }); save(); await flush();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.clinical.shade).toBeNull(); expect(body.expectedClinical.shade).toBe("OM3");
    expect(body.clinical).not.toHaveProperty("costMinor");
  });
});
