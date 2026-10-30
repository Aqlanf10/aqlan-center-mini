import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = value; }];
  } };
});
import { LabShadeSelector, type LabShadeSelectorProps } from "../components/LabShadeSelector";
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const el = node as Element;
  if (typeof el.type === "function") return elements((el.type as (props: Record<string, unknown>) => ReactNode)(el.props));
  return [el, ...elements(el.props.children as ReactNode)];
}
let props: LabShadeSelectorProps;
function render() { hooks.cursor = 0; return elements(LabShadeSelector(props)); }
function select(label: string, value: string) {
  const control = render().find(el => el.type === "select" && el.props["aria-label"] === label);
  expect(control).toBeDefined();
  (control!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0;
  props = { value: null, globalShade: "A2", selectedTeeth: [11, 21],
    onChange: value => { props.value = value; }, onGlobalShadeChange: value => { props.globalShade = value; } };
});
describe("active lab shade selector", () => {
  it("keeps the existing global shade separate from per-tooth zones", () => {
    render(); expect(props.value).toBeNull(); expect(props.globalShade).toBe("A2");
    select("درجة اللون — جسم السن — سن 11", "A3");
    expect(props.value).toEqual({ version: 1, teeth: [{ toothCode: 11, cervical: null, body: { guide: "vita_classical", code: "A3" }, incisal: null }] });
    expect(props.globalShade).toBe("A2");
  });
  it("switches guides explicitly, then selects 3D code with its guide", () => {
    select("دليل اللون — عنق السن — سن 21", "vita_3d_master");
    select("درجة اللون — عنق السن — سن 21", "0M3");
    expect(props.value?.teeth[0].cervical).toEqual({ guide: "vita_3d_master", code: "0M3" });
    select("دليل اللون — اللون العام", "vita_3d_master");
    expect(props.globalShade).toBe("");
    select("درجة اللون — اللون العام", "2M2"); expect(props.globalShade).toBe("2M2");
  });
  it("does not silently rewrite an unclassified legacy shade", () => {
    props.globalShade = "OM3";
    expect(render().some(el => el.props.role === "status")).toBe(true);
    expect(props.globalShade).toBe("OM3"); expect(props.value).toBeNull();
  });
  it("retains details for a deselected tooth until explicit removal", () => {
    select("درجة اللون — جسم السن — سن 11", "A3"); props.selectedTeeth = [21];
    expect(render().some(el => el.props.role === "alert")).toBe(true);
    expect(props.value?.teeth[0].toothCode).toBe(11);
    const remove = render().find(el => el.type === "button");
    (remove!.props.onClick as () => void)(); expect(props.value).toBeNull();
  });
  it("disables all selectors when read-only and clears an explicitly erased last zone", () => {
    select("درجة اللون — جسم السن — سن 11", "A3");
    select("درجة اللون — جسم السن — سن 11", ""); expect(props.value).toBeNull();
    props.disabled = true;
    expect(render().filter(el => el.type === "select").every(el => el.props.disabled === true)).toBe(true);
  });
});
