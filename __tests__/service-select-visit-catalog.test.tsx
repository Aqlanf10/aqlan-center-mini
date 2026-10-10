import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceSelect, type ServiceItem } from "../components/ServiceSelect";
import { formatMoney, type Currency } from "../lib/money";

// Exercise the real, presentational selector with the project's lightweight hook
// harness. All services are synthetic; no routes, database, or browser are used.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[],
  cursor: 0,
  memos: new Map<number, { dependencies: readonly unknown[]; value: unknown }>(),
}));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) {
        hooks.values[index] = typeof initial === "function" ? initial() : initial;
      }
      return [hooks.values[index], (value: unknown) => {
        hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value;
      }];
    },
    useMemo: (factory: () => unknown, dependencies: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.memos.get(index);
      if (previous && previous.dependencies.length === dependencies.length
        && dependencies.every((value, offset) => Object.is(value, previous.dependencies[offset]))) {
        return previous.value;
      }
      const value = factory();
      hooks.memos.set(index, { dependencies, value });
      return value;
    },
  };
});

type Element = ReactElement<Record<string, unknown>>;
type Props = Parameters<typeof ServiceSelect>[0];

function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}

function contents(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(contents).join("");
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return contents((node as Element).props.children as ReactNode);
}

function serviceFixtures(): ServiceItem[] {
  return [
    {
      id: 71001, name: "Composite restoration", category: "filling", priceMinor: 12500, isActive: true,
      priceIn: {
        YER: { minor: 12500, source: "catalog" },
        SAR: { minor: 8200, source: "catalog" },
        USD: { minor: 2400, source: "converted" },
      },
    },
    { id: 71002, name: "Custom appliance check", category: "Custom category", priceMinor: 17000 },
    { id: 71003, name: "General visit support", category: null, priceMinor: 21000, isActive: true },
    { id: 71004, name: "Inactive restoration", category: "filling", priceMinor: 50000, isActive: false },
    {
      id: 71005, name: "Unconfigured procedure", category: "cleaning", priceMinor: 99000,
      priceConfigured: false,
      priceIn: { SAR: { minor: 7700, source: "catalog" }, USD: { minor: 4400, source: "catalog" } },
    },
    {
      id: 71006, name: "Provisional procedure", category: "rct", priceMinor: 16000,
      priceProvisional: true,
      priceIn: { SAR: { minor: 12300, source: "catalog" }, USD: { minor: 3300, source: "converted" } },
    },
    {
      id: 71007, name: "No foreign rate", category: "crown", priceMinor: 198000,
      priceIn: { SAR: { minor: null, source: "none" } },
    },
    {
      id: 71008, name: "Configured zero price", category: "consultation", priceMinor: 0,
      priceConfigured: true,
      priceIn: { SAR: { minor: 0, source: "catalog" }, USD: { minor: 0, source: "catalog" } },
    },
  ];
}

function mount(overrides: Partial<Props> = {}) {
  const onChange = vi.fn<Props["onChange"]>();
  let props: Props = { services: serviceFixtures(), value: null, onChange, ...overrides };
  const render = () => {
    hooks.cursor = 0;
    return ServiceSelect(props);
  };
  const nodes = () => elements(render());
  const find = (predicate: (node: Element) => boolean) => {
    const node = nodes().find(predicate);
    if (!node) throw new Error("Missing native catalogue selector control");
    return node;
  };
  const select = () => find((node) => node.type === "select");
  const search = () => find((node) => node.type === "input" && node.props.type === "search");
  const options = () => elements(select()).filter((node) => node.type === "option");
  const option = (id: number | string) => {
    const node = options().find((item) => String(item.props.value) === String(id));
    if (!node) throw new Error(`Missing catalogue option ${id}`);
    return node;
  };
  const editSearch = (value: string) => {
    (search().props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
  };
  const choose = (value: number | string) => {
    (select().props.onChange as (event: { target: { value: string } }) => void)({ target: { value: String(value) } });
  };
  return {
    onChange, render, nodes, find, select, search, options, option, editSearch, choose,
    optionIds: () => options().map((node) => String(node.props.value)),
    update: (next: Partial<Props>) => { props = { ...props, ...next }; },
  };
}

const fetchMock = vi.fn(() => { throw new Error("The native catalogue selector must not make network requests"); });

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.memos.clear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("native visit catalogue selection", () => {
  it("starts at the placeholder and keeps canonical, custom, and null-category active services reachable", () => {
    const view = mount({ searchable: true, catalogCurrency: "SAR" });
    expect(view.select().props.value).toBe("");
    expect(contents(view.option(""))).toBe("— اختر الخدمة من الدليل المصنف —");
    expect(view.optionIds()).toEqual(["", "71001", "71002", "71003", "71005", "71006", "71007", "71008"]);
    const groups = view.nodes().filter((node) => node.type === "optgroup");
    expect(groups.map((node) => node.props.label)).toContain("❖ Custom category");
    expect(groups.map((node) => node.props.label)).toContain("❖ عام");
    expect(groups.map((node) => node.props.label)).toContain("❖ 🦷 حشوات");
    expect(view.search().props["aria-label"]).toBe("بحث في الخدمات");
    expect(view.nodes().some((node) => node.props.role === "dialog")).toBe(false);
    expect(view.optionIds()).not.toContain("manual");
    expect(view.onChange).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters only visible options, preserves the controlled value, and restores every active option when cleared", () => {
    const services = serviceFixtures();
    const before = JSON.stringify(services);
    const view = mount({ services, searchable: true, value: 71003 });
    const allIds = view.optionIds();

    view.editSearch("  RESTORATION  ");
    expect(view.optionIds()).toEqual(["", "71001"]);
    expect(view.search().props.value).toBe("  RESTORATION  ");
    expect(view.select().props.value).toBe("71003");
    expect(view.nodes().filter((node) => node.type === "optgroup")).toHaveLength(1);

    view.editSearch("No matching synthetic service");
    expect(view.optionIds()).toEqual([""]);
    expect(view.nodes().filter((node) => node.type === "optgroup")).toHaveLength(0);
    expect(contents(view.find((node) => node.props.role === "status"))).toBe("لا خدمة تطابق البحث.");
    expect(view.select().props.value).toBe("71003");

    view.editSearch("   ");
    expect(view.optionIds()).toEqual(allIds);
    expect(view.select().props.value).toBe("71003");
    expect(view.nodes().some((node) => node.props.role === "status")).toBe(false);
    expect(JSON.stringify(services)).toBe(before);
    expect(view.onChange).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits exactly the existing ID and original object only after an explicit native selection", () => {
    const services = serviceFixtures();
    const view = mount({ services, searchable: true, catalogCurrency: "USD" });
    view.editSearch("composite");
    expect(view.onChange).not.toHaveBeenCalled();
    view.choose(view.option(71001).props.value as number);
    expect(view.onChange).toHaveBeenCalledTimes(1);
    expect(view.onChange.mock.calls[0][0]).toBe(71001);
    expect(view.onChange.mock.calls[0][1]).toBe(services[0]);
    expect(view.select().props.value).toBe("");
    view.update({ value: 71001 });
    expect(view.select().props.value).toBe("71001");
    expect(view.onChange).toHaveBeenCalledTimes(1);
    view.choose("");
    expect(view.onChange).toHaveBeenCalledTimes(2);
    expect(view.onChange).toHaveBeenLastCalledWith(0, null);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores inactive, unknown, manual, malformed, and filtered-out synthetic selections", () => {
    const view = mount({ searchable: true });
    for (const value of [71004, 79999, "manual", "not-a-service", "71001.5"]) view.choose(value);
    view.editSearch("composite");
    view.choose(71002);
    expect(view.optionIds()).toEqual(["", "71001"]);
    expect(view.onChange).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("combines opt-in category and name filters without selecting a service", () => {
    const view = mount({ searchable: true, showCategoryTabs: true });
    const initialIds = view.optionIds();
    const filling = view.find((node) => node.type === "button" && contents(node).includes("حشوات"));
    (filling.props.onClick as () => void)();
    expect(view.optionIds()).toEqual(["", "71001"]);
    view.editSearch("General");
    expect(view.optionIds()).toEqual([""]);
    const all = view.find((node) => node.type === "button" && contents(node).includes("الكل"));
    (all.props.onClick as () => void)();
    expect(view.optionIds()).toEqual(["", "71003"]);
    view.editSearch("");
    expect(view.optionIds()).toEqual(initialIds);
    expect(view.onChange).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps disabled search, category controls, and selection inert even if their handlers are invoked", () => {
    const view = mount({ searchable: true, showCategoryTabs: true, disabled: true });
    const initialIds = view.optionIds();
    expect(view.search().props.disabled).toBe(true);
    expect(view.select().props.disabled).toBe(true);
    const buttons = view.nodes().filter((node) => node.type === "button");
    expect(buttons.length).toBeGreaterThan(1);
    for (const button of buttons) {
      expect(button.props.disabled).toBe(true);
      (button.props.onClick as () => void)();
    }
    view.editSearch("composite");
    view.choose(71001);
    view.choose("");
    expect(view.search().props.value).toBe("");
    expect(view.optionIds()).toEqual(initialIds);
    expect(view.onChange).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retain hidden search filtering after the searchable opt-in is removed", () => {
    const view = mount({ searchable: true });
    const initialIds = view.optionIds();
    view.editSearch("composite");
    expect(view.optionIds()).toEqual(["", "71001"]);
    view.update({ searchable: false });
    expect(view.nodes().some((node) => node.type === "input")).toBe(false);
    expect(view.optionIds()).toEqual(initialIds);
    expect(view.onChange).not.toHaveBeenCalled();
  });
});

describe("opt-in catalogue currency display", () => {
  it.each([
    { currency: "SAR" as Currency, configured: 8200, provisional: 12300 },
    { currency: "USD" as Currency, configured: 2400, provisional: 3300 },
  ])("uses projected $currency amounts and price states without changing service identity", ({ currency, configured, provisional }) => {
    const services = serviceFixtures();
    const before = JSON.stringify(services);
    const view = mount({ services, searchable: true, catalogCurrency: currency, base: "YER" });
    expect(contents(view.option(71001))).toBe(`Composite restoration · ${formatMoney(configured, currency)}`);
    expect(contents(view.option(71006))).toBe(`Provisional procedure · ${formatMoney(provisional, currency)} · سعر مؤقت`);
    expect(contents(view.option(71005))).toBe("Unconfigured procedure · — · غير مُسعّر");
    expect(contents(view.option(71007))).toBe("No foreign rate · — · لا سعر بهذه العملة");
    expect(contents(view.option(71002))).toBe("Custom appliance check · — · لا سعر بهذه العملة");
    expect(contents(view.option(71008))).toBe(`Configured zero price · ${formatMoney(0, currency)}`);
    expect(contents(view.option(71001))).not.toContain(formatMoney(services[0].priceMinor, currency));

    const active = services.filter((service) => service.isActive !== false);
    for (const service of active) {
      view.choose(view.option(service.id).props.value as number);
      const call = view.onChange.mock.calls.at(-1);
      expect(call?.[0]).toBe(service.id);
      expect(call?.[1]).toBe(service);
    }
    expect(view.onChange).toHaveBeenCalledTimes(active.length);
    expect(JSON.stringify(services)).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("updates both the option and selected-price summary when the visit currency changes", () => {
    const view = mount({ searchable: true, catalogCurrency: "SAR", value: "71006" });
    expect(contents(view.render())).toContain(`السعر القياسي: ${formatMoney(12300, "SAR")} · سعر مؤقت`);
    view.update({ catalogCurrency: "USD" });
    expect(contents(view.option(71006))).toBe(`Provisional procedure · ${formatMoney(3300, "USD")} · سعر مؤقت`);
    expect(contents(view.render())).toContain(`السعر القياسي: ${formatMoney(3300, "USD")} · سعر مؤقت`);
    expect(contents(view.render())).not.toContain(formatMoney(12300, "SAR"));
    expect(view.select().props.value).toBe("71006");
    expect(view.onChange).not.toHaveBeenCalled();
  });

  it("retains the YER fallback while distinguishing unconfigured and provisional prices", () => {
    const view = mount({ searchable: true, catalogCurrency: "YER" });
    expect(contents(view.option(71002))).toBe(`Custom appliance check · ${formatMoney(17000, "YER")}`);
    expect(contents(view.option(71007))).toBe(`No foreign rate · ${formatMoney(198000, "YER")}`);
    expect(contents(view.option(71005))).toBe("Unconfigured procedure · — · غير مُسعّر");
    expect(contents(view.option(71006))).toBe(`Provisional procedure · ${formatMoney(16000, "YER")} · سعر مؤقت`);
    expect(view.onChange).not.toHaveBeenCalled();
  });
});

describe("legacy ServiceSelect callers", () => {
  it("preserves the native default, YER prices, placeholder, and optional manual entry", () => {
    const view = mount();
    expect(view.select().props.value).toBe("");
    expect(view.select().props["aria-label"]).toBe("اختيار الخدمة");
    expect(view.select().props.disabled).toBe(false);
    expect(view.nodes().some((node) => node.type === "input" || node.type === "button")).toBe(false);
    expect(contents(view.option(71001))).toBe(`Composite restoration · ${formatMoney(12500, "YER")}`);
    expect(contents(view.option(71005))).toBe(`Unconfigured procedure · ${formatMoney(99000, "YER")}`);
    expect(contents(view.option(71006))).toBe(`Provisional procedure · ${formatMoney(16000, "YER")}`);
    expect(view.optionIds()).not.toContain("manual");
    expect(view.optionIds()).not.toContain("71004");
    view.update({ allowManual: true, placeholder: "Legacy placeholder" });
    expect(contents(view.option(""))).toBe("Legacy placeholder");
    expect(contents(view.option("manual"))).toBe("✍️ — بند يدوي حر —");
    expect(view.onChange).not.toHaveBeenCalled();
  });

  it("preserves explicit base pricing until catalogCurrency is opted into", () => {
    const view = mount({ base: "SAR", value: 71001 });
    expect(contents(view.option(71001))).toBe(`Composite restoration · ${formatMoney(12500, "SAR")}`);
    expect(contents(view.render())).toContain(`السعر القياسي: ${formatMoney(12500, "SAR")}`);
    expect(contents(view.render())).not.toContain(formatMoney(8200, "SAR"));
    view.update({ catalogCurrency: "SAR" });
    expect(contents(view.option(71001))).toBe(`Composite restoration · ${formatMoney(8200, "SAR")}`);
    expect(contents(view.render())).toContain(`السعر القياسي: ${formatMoney(8200, "SAR")}`);
    expect(view.onChange).not.toHaveBeenCalled();
  });
});
