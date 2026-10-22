// Actual component handlers with synthetic React hooks, not browser rendering.
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClinicHoursEditor } from "../components/settings/ClinicHoursEditor";
const state = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState(initial: unknown) { const i = state.cursor++; if (!(i in state.slots)) state.slots[i] = initial;
    return [state.slots[i], (value: unknown) => { state.slots[i] = typeof value === "function" ? value(state.slots[i]) : value; }]; },
  useRef(initial: unknown) { const i = state.cursor++; if (!(i in state.slots)) state.slots[i] = { current: initial }; return state.slots[i]; },
}));
type Element = ReactElement<Record<string, unknown>>;
function nodes(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const node = tree as Element; return [node, ...nodes(node.props.children as ReactNode)];
}
const values = { "clinic.day_start": "09:00", "clinic.day_end": "13:00", "clinic.shift2_start": "16:00", "clinic.shift2_end": "21:00" };
const versions = Object.fromEntries(Object.keys(values).map((key) => [key, null]));
const onSaved = vi.fn(); const fetcher = vi.fn();
let editable: boolean; let source: Record<string, string>;
function render() { state.cursor = 0; return nodes(ClinicHoursEditor({ values: source, versions, editable, onSaved })); }
function button(label: string) { const result = render().find((n) => n.type === "button" && n.props.children === label); if (!result) throw Error(label); return result; }
function click(label: string) { (button(label).props.onClick as () => void)(); }
function input(label: string) { const result = render().find((n) => n.type === "input" && n.props["aria-label"] === label); if (!result) throw Error(label); return result; }
function change(label: string, value: string) { (input(label).props.onChange as (e: unknown) => void)({ target: { value } }); }
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
beforeEach(() => { state.slots = []; source = { ...values }; editable = true; fetcher.mockReset(); onSaved.mockReset(); vi.stubGlobal("fetch", fetcher); });
afterEach(() => vi.unstubAllGlobals());
describe("clinic period editor batch contract", () => {
  it("clears both second times in a single versioned write without changing first period", async () => {
    fetcher.mockImplementation(async (_url, init) => ({ ok: true, json: async () => ({ ...JSON.parse(init.body), __versions: versions }) }));
    click("تعديل فترات الدوام");
    const radio = render().find((n) => n.type === "input" && n.props.type === "radio" && n.props.checked === false)!;
    (radio.props.onChange as () => void)();
    expect(input("بداية الفترة الثانية").props.disabled).toBe(true);
    const save = button("حفظ فترات الدوام").props.onClick as () => void; save(); save(); await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ ...values, "clinic.shift2_start": "", "clinic.shift2_end": "", __versions: versions });
    expect(onSaved).toHaveBeenCalledOnce();
  });
  it("saves the jointly changed first and second periods, including original four versions", async () => {
    fetcher.mockImplementation(async (_url, init) => ({ ok: true, json: async () => ({ ...JSON.parse(init.body), __versions: versions }) }));
    click("تعديل فترات الدوام"); change("نهاية الفترة الأولى", "14:00"); change("بداية الفترة الثانية", "17:00");
    click("حفظ فترات الدوام"); await settle();
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ ...values, "clinic.day_end": "14:00", "clinic.shift2_start": "17:00", __versions: versions });
  });
  it.each([400, 409, 500, "malformed", "network"])("retains attempted input on %s and does not report saved", async (kind) => {
    fetcher.mockImplementation(async () => {
      if (kind === "network") throw Error("network");
      return { ok: kind === "malformed", status: kind, json: async () => kind === "malformed" ? {} : { message: "رفض الحفظ" } };
    });
    click("تعديل فترات الدوام"); change("بداية الفترة الثانية", "17:00"); click("حفظ فترات الدوام"); await settle();
    expect(input("بداية الفترة الثانية").props.value).toBe("17:00"); expect(onSaved).not.toHaveBeenCalled();
    expect(render().some((n) => n.props.role === "alert")).toBe(true);
  });
  it("blocks incomplete, reversed and overlapping periods before fetch", () => {
    click("تعديل فترات الدوام");
    for (const time of ["", "12:00", "22:00"]) {
      change("بداية الفترة الثانية", time); expect(button("حفظ فترات الدوام").props.disabled).toBe(true); click("حفظ فترات الدوام");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves invalid stored configuration until explicit repair and does not save on cancel", () => {
    source["clinic.shift2_end"] = ""; render(); expect(fetcher).not.toHaveBeenCalled();
    click("تعديل فترات الدوام"); expect(input("بداية الفترة الثانية").props.value).toBe("16:00");
    change("نهاية الفترة الثانية", "20:00"); click("إلغاء"); click("تعديل فترات الدوام");
    expect(input("نهاية الفترة الثانية").props.value).toBe(""); expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires both times when switching from continuous to split, without inventing defaults", () => {
    source["clinic.shift2_start"] = ""; source["clinic.shift2_end"] = "";
    click("تعديل فترات الدوام");
    const radio = render().find((n) => n.type === "input" && n.props.type === "radio" && n.props.checked === false)!;
    (radio.props.onChange as () => void)();
    expect(input("بداية الفترة الثانية").props.value).toBe("");
    expect(button("حفظ فترات الدوام").props.disabled).toBe(true); click("حفظ فترات الدوام");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("offers no editing controls to read-only users", () => { editable = false; expect(render().some((n) => n.type === "button")).toBe(false); });
});
