import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.values)) hooks.values[i] = initial; return i; };
  return { ...react, useState: (initial: unknown) => { const i = slot(initial); return [hooks.values[i], (v: unknown) => { hooks.values[i] = v; }]; },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })], useEffect: () => {} };
});
import { LabOrderShadeEditor } from "../components/LabOrderShadeEditor";
import { LabShadeSelector } from "../components/LabShadeSelector";
import type { LabOrder } from "../lib/lab";
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as Element; return [el, ...elements(el.props.children as ReactNode)];
}
let props: Parameters<typeof LabOrderShadeEditor>[0];
const fetchMock = vi.fn();
function render() { hooks.cursor = 0; return elements(LabOrderShadeEditor(props)); }
function save() { (render().find(el => el.type === "button")!.props.onClick as () => void)(); }
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0;
  props = { order: { id: 70, toothNumbers: "11(Crown)", shade: "OM3", shadeSpecification: null } as LabOrder,
    onSaved: vi.fn(), onClose: vi.fn() };
  fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
describe("structured shade edit handlers", () => {
  it("keeps the legacy global shade read-only and sends only structured optimistic input", async () => {
    const fields = render().find(el => el.type === LabShadeSelector)!;
    expect(fields.props.globalShade).toBe("OM3"); expect(fields.props.globalShadeReadOnly).toBe(true);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    save(); await flush();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: "update_shade", shadeSpecification: null, expectedShadeSpecification: null });
    expect(props.onSaved).toHaveBeenCalledOnce();
  });
  it("blocks same-tick repeated save and cancellation while a save is pending", () => {
    fetchMock.mockReturnValue(new Promise(() => {})); save(); save();
    expect(fetchMock).toHaveBeenCalledOnce();
    const preventDefault = vi.fn();
    (render().find(el => el.type === "dialog")!.props.onCancel as (event: unknown) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
  });
  it("retains a conflict and does not claim success", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ message: "Synthetic stale shades" }) });
    save(); await flush();
    expect(render().some(el => el.props.role === "alert" && el.props.children === "Synthetic stale shades")).toBe(true);
    expect(props.onSaved).not.toHaveBeenCalled();
  });
  it("does not overwrite malformed stored specifications", () => {
    props.order.shadeSpecificationWarning = "Synthetic malformed data"; save();
    expect(fetchMock).not.toHaveBeenCalled(); expect(render().find(el => el.type === "button")!.props.disabled).toBe(true);
  });
  it("rejects zone selections for teeth outside the order", () => {
    const selector = render().find(el => el.type === LabShadeSelector)!;
    (selector.props.onChange as (value: unknown) => void)({ version: 1, teeth: [{ toothCode: 21, cervical: null, body: null, incisal: null }] });
    save(); expect(fetchMock).not.toHaveBeenCalled(); expect(render().some(el => el.props.role === "alert")).toBe(true);
  });
});
