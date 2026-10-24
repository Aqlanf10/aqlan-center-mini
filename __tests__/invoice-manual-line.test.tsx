import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MANUAL_LINE_VALUE, ServiceSelect, type ServiceItem } from "../components/ServiceSelect";
import { replaceRowService, emptyToothFields } from "../components/dental/invoice-tooth-selection";
import { selectManualLine, type ManualLineRow } from "../components/invoice-manual-line";

/* «بند يدوي حر» as an explicit controlled state. Synthetic services; no routes, database or browser. */
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, memos: new Map<number, { dependencies: readonly unknown[]; value: unknown }>() }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
    },
    useMemo: (factory: () => unknown, dependencies: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.memos.get(index);
      if (previous && previous.dependencies.length === dependencies.length && dependencies.every((value, offset) => Object.is(value, previous.dependencies[offset]))) return previous.value;
      const value = factory();
      hooks.memos.set(index, { dependencies, value });
      return value;
    },
  };
});
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.memos.clear(); });

const services: ServiceItem[] = [
  { id: 501, name: "تاج زركونيا اصطناعي", category: "crown", priceMinor: 120_000 },
  { id: 502, name: "كشف اصطناعي", category: "consultation", priceMinor: 5_000 },
];
type Props = Parameters<typeof ServiceSelect>[0];
function render(props: Props) {
  hooks.cursor = 0;
  const select = elements(ServiceSelect(props)).find((node) => node.type === "select")!;
  return { value: select.props.value, choose: (value: string) => (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }) };
}

describe("ServiceSelect: explicit manual line", () => {
  it("dispatches the manual callback, never onChange, and never NaN", () => {
    const onChange = vi.fn(), onManualSelect = vi.fn();
    const view = render({ services, value: null, onChange, allowManual: true, manualSelected: false, onManualSelect });
    expect(view.value).toBe("");
    view.choose(MANUAL_LINE_VALUE);
    expect(onManualSelect).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    for (const malformed of ["NaN", "not-a-service", "0", "-3", "501.5", "Infinity"]) view.choose(malformed);
    expect(onChange).not.toHaveBeenCalled();
    view.choose("501");
    expect(onChange).toHaveBeenCalledWith(501, services[0]);
    view.choose("");
    expect(onChange).toHaveBeenLastCalledWith(0, null);
    expect(onChange.mock.calls.every(([id]) => Number.isSafeInteger(id) && id >= 0)).toBe(true);
  });

  it("keeps the manual option selected while the owner says so, and ignores it when manual is not offered", () => {
    const onChange = vi.fn(), onManualSelect = vi.fn();
    expect(render({ services, value: null, onChange, allowManual: true, manualSelected: true, onManualSelect }).value).toBe(MANUAL_LINE_VALUE);
    const plain = render({ services, value: null, onChange });
    plain.choose(MANUAL_LINE_VALUE);
    expect(onChange).not.toHaveBeenCalled();
  });
});

type Row = ManualLineRow & { quantity: string };
const row = (patch: Partial<Row> = {}): Row => ({ key: "r1", caseId: "", serviceId: "", doctorId: "", description: "", price: "", priceReason: "", quantity: "1", ...emptyToothFields("none"), ...patch });

describe("selectManualLine", () => {
  it("re-selecting manual keeps the typed description and price", () => {
    const typed = row({ manual: true, description: "بند يدوي اصطناعي", price: "12,345", doctorId: "7" });
    expect(selectManualLine([typed], 0)).toEqual([typed]);
  });

  it("from the empty choice keeps what was typed and marks the line manual", () => {
    expect(selectManualLine([row({ description: "وصف كتبه المستخدم", price: "900" })], 0)[0])
      .toMatchObject({ manual: true, serviceId: "", description: "وصف كتبه المستخدم", price: "900" });
  });

  it("from a catalogue service drops its name, price, price reason, doctor and tooth/case linkage", () => {
    const catalogue = row({ serviceId: "501", description: "تاج زركونيا اصطناعي", price: "120,000", priceReason: "سبب", doctorId: "7", caseId: "33", toothCode: 26, groupId: "g1" });
    expect(selectManualLine([catalogue], 0)[0]).toEqual(row({ manual: true }));
  });
});

describe("controlled loop wired like the ledger row", () => {
  it("manual ↔ catalogue switching: manual input survives re-selection; no catalogue price, name, doctor or tooth leaks", () => {
    let rows: Row[] = [row()];
    const props = (): Props => ({
      services, value: rows[0].serviceId ? Number(rows[0].serviceId) : null,
      // The ledger's catalogue handler: a catalogue choice (or the empty choice) is never manual.
      onChange: (id, srv) => { rows = replaceRowService(rows, 0, { serviceId: id ? String(id) : "", doctorId: "", manual: false,
        price: srv ? String(srv.priceMinor) : "", description: srv ? srv.name : rows[0].description }, srv ? "per_tooth_episode" : "none"); },
      allowManual: true, manualSelected: rows[0].manual === true, onManualSelect: () => { rows = selectManualLine(rows, 0); },
    });
    render(props()).choose(MANUAL_LINE_VALUE);
    expect(render(props()).value).toBe(MANUAL_LINE_VALUE);
    rows = rows.map((item) => ({ ...item, description: "بند يدوي اصطناعي", price: "12345", doctorId: "9" }));
    render(props()).choose(MANUAL_LINE_VALUE);  // re-selection after re-render
    expect(rows[0]).toMatchObject({ manual: true, serviceId: "", description: "بند يدوي اصطناعي", price: "12345", doctorId: "9" });
    render(props()).choose("501");
    expect(rows[0]).toMatchObject({ manual: false, serviceId: "501", price: "120000", description: "تاج زركونيا اصطناعي", doctorId: "" });
    rows = rows.map((item) => ({ ...item, toothCode: 26, doctorId: "4" }));
    render(props()).choose(MANUAL_LINE_VALUE);
    expect(render(props()).value).toBe(MANUAL_LINE_VALUE);
    expect(rows[0]).toMatchObject({ manual: true, serviceId: "", price: "", description: "", doctorId: "", toothCode: null });
  });
});
