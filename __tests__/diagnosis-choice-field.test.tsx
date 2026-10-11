import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosisChoiceField } from "../components/DiagnosisChoiceField";
import { DIAGNOSIS_CHOICE_GROUPS } from "../lib/diagnosis-choice-options";

// Actual component handlers/effects with synthetic hooks and focus targets.
// Browser semantics and real append-only saves are covered separately by the
// existing disposable-database security-http diagnosis acceptance suite.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  pending: [] as Array<() => void>,
}));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const effect = (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined), previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    hooks.pending.push(() => {
      previous?.cleanup?.();
      const cleanup = run();
      hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
    });
  };
  const memo = (compute: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined), previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = compute(); hooks.memos.set(index, { deps, value }); return value;
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => {
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useId: () => hooks.values[slot(`synthetic-choice-${hooks.cursor}`)],
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useMemo: memo,
    useLayoutEffect: effect,
    useEffect: effect,
  };
});

type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
const onChange = vi.fn();
const focus = vi.fn();
let props: Parameters<typeof DiagnosisChoiceField>[0];

function render() {
  let tree: ReturnType<typeof DiagnosisChoiceField> | null = null;
  let round = 0;
  do {
    if (++round > 20) throw new Error("Diagnosis choice component did not settle");
    hooks.cursor = 0; hooks.changed = false; tree = DiagnosisChoiceField(props);
    for (const node of nodes(tree)) {
      const ref = node.props.ref as { current: unknown } | ((value: unknown) => void) | undefined;
      const target = { focus: () => focus(node.props["aria-label"]), scrollIntoView: vi.fn(),
        querySelector: () => ({ scrollIntoView: vi.fn() }) };
      if (typeof ref === "function") ref(target);
      else if (ref) ref.current = target;
    }
    hooks.pending.splice(0).forEach(run => run());
  } while (hooks.changed);
  return tree;
}
const find = (predicate: (node: Element) => boolean) => {
  const found = nodes(render()).find(predicate);
  if (!found) throw new Error("Missing diagnosis choice control");
  return found;
};
const canonical = () => find(node => node.type === "input" && node.props["aria-label"] === props.label);
const toggle = () => find(node => node.type === "button" && node.props["aria-label"] === `اختيارات — ${props.label}`);
const search = () => find(node => node.type === "input" && node.props.role === "combobox");
const options = () => nodes(render()).filter(node => node.props.role === "option");
const click = (node: Element) => (node.props.onClick as () => void)();
const change = (node: Element, value: string) => (node.props.onChange as (event: unknown) => void)({ target: { value } });
const key = (node: Element, keyValue: string, composing = false, keyCode = composing ? 229 : 0) => {
  const preventDefault = vi.fn();
  (node.props.onKeyDown as (event: unknown) => void)({
    key: keyValue, preventDefault, isComposing: composing, keyCode,
    nativeEvent: { isComposing: composing, keyCode },
  });
  return preventDefault;
};
const open = () => { click(toggle()); render(); };
const expectUnchanged = (value: string) => {
  expect(canonical().props.value).toBe(value);
  expect(onChange).not.toHaveBeenCalled();
};
const expectValidActiveOption = () => {
  const control = search(), active = control.props["aria-activedescendant"];
  if (active !== undefined && active !== "") {
    expect(options().filter(node => node.props.id === active)).toHaveLength(1);
  }
};

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  onChange.mockReset(); focus.mockReset();
  props = { label: "حقل تشخيص تجريبي", value: "", disabled: false, onChange: value => {
    onChange(value); props = { ...props, value };
  }, groups: [
    { label: "مجموعة تجريبية أ", options: [
      { value: "Synthetic Class II", searchTerms: "خيار ثانٍ skeletal" },
      { value: "Synthetic Class III", searchTerms: "خيار ثالث skeletal" },
    ] },
    { label: "مجموعة تجريبية ب", options: [
      { value: "وصف تجريبي حر", searchTerms: "synthetic free description" },
    ] },
  ] };
});
afterEach(() => { hooks.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe("editable diagnosis choices without inferred clinical values", () => {
  it("starts blank with a bounded free-text input and no automatically selected option", () => {
    expect(canonical().props.value).toBe("");
    expect(canonical().props.maxLength).toBe(200);
    expect(toggle().props["aria-expanded"]).toBe(false);
    expect(nodes(render()).some(node => node.props.role === "combobox")).toBe(false);
    open();
    expect(search().props.value).toBe("");
    expect(search().props["aria-label"]).toBe(`بحث في الاختيارات — ${props.label}`);
    expect(search().props["aria-activedescendant"]).toBeUndefined();
    expect(options()).toHaveLength(3);
    expect(options().every(node => node.props["aria-selected"] === false)).toBe(true);
    expectUnchanged("");
  });

  it("filters groups and Arabic/Latin aliases without editing existing unknown free text", () => {
    props = { ...props, value: "وصف تجريبي غير مدرج 4.25 mm", dir: "rtl" };
    open();
    expect(canonical().props.dir).toBe("rtl");
    change(search(), "  SKELETAL  ");
    expect(options().map(text)).toEqual(["Synthetic Class II", "Synthetic Class III"]);
    expect(nodes(render()).filter(node => node.props.role === "group").map(node => node.props["aria-label"]))
      .toEqual(["مجموعة تجريبية أ"]);
    change(search(), "خيار ثانٍ");
    expect(options().map(text)).toEqual(["Synthetic Class II"]);
    expectUnchanged("وصف تجريبي غير مدرج 4.25 mm");
    change(search(), "zz-no-synthetic-choice");
    expect(options()).toHaveLength(0);
    expect(text(find(node => node.props.role === "status"))).toContain("لا وصف يطابق البحث");
    expectValidActiveOption();
    expectUnchanged("وصف تجريبي غير مدرج 4.25 mm");
  });

  it("replaces the canonical value only on an explicit option click, then permits exact editing and clearing", () => {
    props = { ...props, value: "Existing synthetic clinician wording" };
    open(); change(search(), "free description");
    click(options()[0]);
    expect(onChange.mock.calls).toEqual([["وصف تجريبي حر"]]);
    expect(canonical().props.value).toBe("وصف تجريبي حر");
    expect(toggle().props["aria-expanded"]).toBe(false);
    expect(focus).toHaveBeenLastCalledWith(props.label);
    change(canonical(), "وصف تجريبي حر؛ تفصيل الطبيب 3.75 mm");
    expect(canonical().props.value).toBe("وصف تجريبي حر؛ تفصيل الطبيب 3.75 mm");
    change(canonical(), "");
    expect(canonical().props.value).toBe("");
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("Other returns to the existing input without saving a sentinel or the search query", () => {
    props = { ...props, value: "Existing synthetic wording" };
    open(); change(search(), "unmatched synthetic search");
    click(find(node => node.type === "button" && text(node) === "أخرى — اكتب بحرية"));
    expect(toggle().props["aria-expanded"]).toBe(false);
    expect(focus).toHaveBeenLastCalledWith(props.label);
    expectUnchanged("Existing synthetic wording");
    change(canonical(), "أخرى بصياغة الطبيب التجريبية");
    expect(onChange.mock.calls).toEqual([["أخرى بصياغة الطبيب التجريبية"]]);
  });

  it("opens by keyboard, exposes only valid active IDs, and chooses only after navigation plus Enter", () => {
    expect(key(canonical(), "ArrowDown")).toHaveBeenCalledOnce();
    expect(toggle().props["aria-expanded"]).toBe(true);
    expect(focus).toHaveBeenLastCalledWith(`بحث في الاختيارات — ${props.label}`);
    key(search(), "Enter"); expectUnchanged("");
    key(search(), "ArrowDown"); expectValidActiveOption();
    expect(options()[0].props["aria-selected"]).toBe(true);
    key(search(), "ArrowDown"); expectValidActiveOption();
    expect(options()[1].props["aria-selected"]).toBe(true);
    key(search(), "Enter");
    expect(onChange.mock.calls).toEqual([["Synthetic Class III"]]);
    expect(canonical().props.value).toBe("Synthetic Class III");
    expect(toggle().props["aria-expanded"]).toBe(false);
  });

  it("clears the active ID on filtering, bounds both arrow directions and never selects an empty result", () => {
    open(); key(search(), "ArrowUp");
    expect(options().at(-1)?.props["aria-selected"]).toBe(true);
    for (let index = 0; index < 5; index++) key(search(), "ArrowDown");
    expect(options().at(-1)?.props["aria-selected"]).toBe(true); expectValidActiveOption();
    for (let index = 0; index < 5; index++) key(search(), "ArrowUp");
    expect(options()[0].props["aria-selected"]).toBe(true); expectValidActiveOption();
    change(search(), "free description");
    expect(search().props["aria-activedescendant"]).toBeUndefined();
    key(search(), "Enter"); expectUnchanged("");
    change(search(), "no synthetic match");
    key(search(), "ArrowDown"); key(search(), "ArrowUp"); key(search(), "Enter");
    expect(options()).toHaveLength(0);
    expect(search().props["aria-activedescendant"]).toBeUndefined(); expectUnchanged("");
  });

  it("does not interpret IME composition Enter or arrows as selection", () => {
    expect(key(canonical(), "ArrowDown", true)).not.toHaveBeenCalled();
    expect(toggle().props["aria-expanded"]).toBe(false);
    open(); key(search(), "ArrowDown");
    const active = search().props["aria-activedescendant"];
    expect(key(search(), "ArrowDown", true)).not.toHaveBeenCalled();
    expect(key(search(), "Enter", true)).not.toHaveBeenCalled();
    expect(key(search(), "Enter", false, 229)).not.toHaveBeenCalled();
    expect(search().props["aria-activedescendant"]).toBe(active);
    expectValidActiveOption(); expectUnchanged("");
  });

  it("dismisses Escape and outside blur, keeps inside focus transitions, and never commits on Tab", () => {
    props = { ...props, value: "Unknown synthetic finding" };
    open(); change(search(), "skeletal"); key(search(), "ArrowDown");
    const popup = find(node => node.type === "div" && typeof node.props.onKeyDown === "function");
    key(popup, "Escape");
    expect(toggle().props["aria-expanded"]).toBe(false);
    expect(focus).toHaveBeenLastCalledWith(`اختيارات — ${props.label}`);
    expectUnchanged("Unknown synthetic finding");
    open(); expect(search().props.value).toBe("");
    const root = find(node => typeof node.props.onBlur === "function");
    const blur = root.props.onBlur as (event: unknown) => void;
    blur({ currentTarget: { contains: () => true }, relatedTarget: {} });
    expect(toggle().props["aria-expanded"]).toBe(true);
    expect(key(search(), "Tab")).not.toHaveBeenCalled();
    blur({ currentTarget: { contains: () => false }, relatedTarget: null });
    expect(toggle().props["aria-expanded"]).toBe(false);
    expectUnchanged("Unknown synthetic finding");
  });

  it("links the combobox to a bounded scrollable list with grouped, non-tabbable options", () => {
    open();
    const list = find(node => node.props.role === "listbox");
    expect(list.props["aria-label"]).toBe(`اختيارات — ${props.label}`);
    expect(search().props["aria-controls"]).toBe(list.props.id);
    expect(toggle().props["aria-controls"]).toBe(list.props.id);
    expect(String(list.props.className)).toContain("max-h-");
    expect(String(list.props.className)).toContain("overflow-y-auto");
    expect(options().every(node => node.type === "button" && node.props.type === "button" && node.props.tabIndex === -1)).toBe(true);
  });

  it("keeps disabled current handlers inert and masks an open menu when saving starts", () => {
    props = { ...props, value: "Existing synthetic finding", disabled: true };
    expect(canonical().props.disabled).toBe(true); expect(toggle().props.disabled).toBe(true);
    change(canonical(), "Unexpected synthetic replacement"); click(toggle()); key(canonical(), "ArrowDown");
    expect(toggle().props["aria-expanded"]).toBe(false); expectUnchanged("Existing synthetic finding");
    props = { ...props, disabled: false }; open(); key(search(), "ArrowDown");
    props = { ...props, disabled: true };
    expect(toggle().props["aria-expanded"]).toBe(false);
    expect(nodes(render()).some(node => node.props.role === "combobox" || node.props.role === "option")).toBe(false);
    change(canonical(), "Another unexpected replacement"); click(toggle());
    expectUnchanged("Existing synthetic finding");
  });
});

describe("bounded diagnosis vocabulary", () => {
  it("offers only the reviewed field descriptions, with no Overjet menu or inferred normal values", () => {
    expect(Object.keys(DIAGNOSIS_CHOICE_GROUPS).sort()).toEqual(["bite", "crowding", "dental", "skeletal"]);
    const values = Object.fromEntries(Object.entries(DIAGNOSIS_CHOICE_GROUPS)
      .map(([field, groups]) => [field, groups.flatMap(group => group.options.map(option => option.value))]));
    expect(values).toEqual({
      skeletal: ["Class I", "Class II", "Class III"],
      dental: ["Class I", "Class II", "Class II Div 1", "Class II Div 2", "Class III"],
      crowding: ["ازدحام أمامي", "ازدحام خفيف", "ازدحام متوسط", "فراغات سنية"],
      bite: ["عضة عميقة", "عضة معكوسة أمامية", "عضة معكوسة خلفية", "عضة مقصية"],
    });
  });

  it.each(["skeletal", "dental", "crowding", "bite"] as const)("never preselects a value from the real %s vocabulary", field => {
    props = { ...props, groups: DIAGNOSIS_CHOICE_GROUPS[field] };
    open();
    expect(options().length).toBeGreaterThan(0);
    expect(options().every(node => node.props["aria-selected"] === false)).toBe(true);
    key(search(), "Enter");
    expectUnchanged("");
  });
});

