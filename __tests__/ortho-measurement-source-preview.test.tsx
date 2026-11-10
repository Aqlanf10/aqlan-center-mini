import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoAssessmentMeasurementsV2 } from "../components/OrthoAssessmentMeasurementsV2";
import { blankMeasurementEditorV2, type MeasurementEditorDraftV2 } from "../lib/ortho-assessment-measurement-editor-v2";
// Actual component handlers and real editor validation. Hook storage/window
// confirmation are synthetic; browser interaction is a separate acceptance gate.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, dependencies: new Map<number, readonly unknown[]>(), effects: [] as Array<() => void> }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState(initial: unknown) {
  const index = hooks.cursor++;
  if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
  return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }];
}, useRef(initial: unknown) {
  const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = { current: initial }; return hooks.values[index];
}, useLayoutEffect(effect: () => void, dependencies: readonly unknown[]) {
  const index = hooks.cursor++, previous = hooks.dependencies.get(index);
  if (!previous || dependencies.some((value, offset) => !Object.is(value, previous[offset]))) hooks.effects.push(effect);
  hooks.dependencies.set(index, dependencies);
} }));
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
let draft: MeasurementEditorDraftV2, permitted: boolean, active: boolean;
const change = vi.fn(), confirm = vi.fn();
const panelElement = { focus: vi.fn(), scrollIntoView: vi.fn() };
function render() {
  hooks.cursor = 0; const tree = OrthoAssessmentMeasurementsV2({ draft, onChange: change, sources: [],
    owner: { renderEditable: permitted, active: () => active, editable: () => permitted } });
  const panel = nodes(tree).find(node => node.props["aria-label"] === "مصدر القياس وتاريخه");
  if (panel?.props.ref && typeof panel.props.ref === "object") (panel.props.ref as { current: unknown }).current = panelElement;
  hooks.effects.splice(0).forEach(effect => effect()); return tree;
}
function click(label: string) {
  const button = nodes(render()).find(node => node.type === "button" && text(node) === label);
  if (!button) throw Error(`Missing button: ${label}`);
  expect(button.props.disabled).not.toBe(true); (button.props.onClick as () => void)();
}
function select(label: string) {
  const found = nodes(render()).find(node => node.type === "label" && text(node) === label);
  if (!found) throw Error(`Missing choice: ${label}`);
  const checkbox = nodes(found).find(node => node.type === "input")!;
  (checkbox.props.onChange as () => void)();
}
function preview() { return nodes(render()).find(node => node.props["aria-label"] === "مراجعة تطبيق مصدر الجلسة"); }
const apply = () => { const button = nodes(render()).find(node => node.type === "button" && text(node).startsWith("تطبيق مصدر الجلسة على"))!; (button.props.onClick as () => void)(); };
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  hooks.values.length = 0; hooks.dependencies.clear(); hooks.effects.length = 0;
  panelElement.focus.mockReset(); panelElement.scrollIntoView.mockReset();
  permitted = true; active = true; change.mockReset(); confirm.mockReset().mockReturnValue(true);
  vi.stubGlobal("window", { confirm }); draft = blankMeasurementEditorV2();
  for (const [id, date] of [["width_11", "2026-10-01"], ["width_12", "2026-09-01"], ["width_13", "2026-09-02"]]) Object.assign(draft.values[id], {
    state: "measured", numberText: id === "width_11" ? "7.5" : "8.1", dateState: "known", date,
    method: "manual_record_measurement", methodDescription: id === "width_11" ? "Synthetic new method" : "Synthetic existing method",
    performer: "documented", performerAttribution: id === "width_11" ? "Synthetic new operator" : "Synthetic old operator",
    sources: [{ kind: "document", id: id === "width_11" ? 1 : 2, version: "a".repeat(64) }],
  });
});
describe("bulk measurement source replacement review", () => {
  it("focuses and reveals newly opened source details below the sticky header without jumping on each edit", () => {
    render(); expect(panelElement.focus).not.toHaveBeenCalled();
    click("المصدر والتاريخ: السن 11"); render();
    expect(panelElement.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(panelElement.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start", behavior: "instant" });
    const panel = nodes(render()).find(node => node.props["aria-label"] === "مصدر القياس وتاريخه")!;
    expect(panel.props.tabIndex).toBe(-1); expect(panel.props.className).toContain("scroll-mt-24");
    draft = structuredClone(draft); draft.values.width_11.methodDescription = "Synthetic edited method"; render();
    expect(panelElement.focus).toHaveBeenCalledTimes(1); expect(panelElement.scrollIntoView).toHaveBeenCalledTimes(1);
    click("المصدر والتاريخ: السن 11"); render();
    expect(panelElement.focus).toHaveBeenCalledTimes(2); expect(panelElement.scrollIntoView).toHaveBeenCalledTimes(2);
    draft = structuredClone(draft); draft.values.width_11.methodDescription = "Synthetic second edit"; render();
    expect(panelElement.focus).toHaveBeenCalledTimes(2); expect(panelElement.scrollIntoView).toHaveBeenCalledTimes(2);
    active = false; click("المصدر والتاريخ: السن 11"); render();
    expect(panelElement.focus).toHaveBeenCalledTimes(2); expect(panelElement.scrollIntoView).toHaveBeenCalledTimes(2);
    active = true;
    click("المصدر والتاريخ: السن 12"); render(); expect(panelElement.focus).toHaveBeenCalledTimes(3);
    click("إغلاق تفاصيل المصدر"); render(); expect(panelElement.focus).toHaveBeenCalledTimes(3); expect(change).not.toHaveBeenCalled();
  });
  it("clears selected targets on measurement group change while preserving every recorded value and source", () => {
    draft.payload.measurementSets.push({ ...draft.payload.measurementSets[0], id: "second", toothWidthObservationIds: [...draft.payload.measurementSets[0].toothWidthObservationIds] });
    select("اختيار السن 12 لجلسة القياس"); click("المصدر والتاريخ: السن 11");
    const before = structuredClone(draft);
    const group = nodes(render()).find(node => node.type === "select" && node.props.value === "current")!;
    (group.props.onChange as (event: unknown) => void)({ target: { value: "second" } });
    expect(preview()).toBeUndefined(); expect(change).not.toHaveBeenCalled(); expect(draft).toEqual(before);
    expect(text(render())).toContain("أُلغي اختيار المدخلات عند تغيير مجموعة القياسات");
    click("المصدر والتاريخ: السن 11"); expect(preview()).toBeUndefined();
    const target = nodes(render()).find(node => node.type === "label" && text(node) === "اختيار السن 12 لجلسة القياس")!;
    expect(nodes(target).find(node => node.type === "input")?.props.checked).toBe(false);
  });
  it("clears selected targets when adding a group without copying or changing measurement provenance", () => {
    select("اختيار السن 12 لجلسة القياس"); click("المصدر والتاريخ: السن 11"); const before = structuredClone(draft);
    click("إضافة مجموعة قياسات غير معبأة"); expect(change).toHaveBeenCalledTimes(1);
    const next = change.mock.calls[0][0] as MeasurementEditorDraftV2;
    expect(next.values).toEqual(before.values); expect(next.payload.observations).toEqual(before.payload.observations);
    expect(next.payload.measurementSets).toHaveLength(before.payload.measurementSets.length + 1);
    draft = next; expect(preview()).toBeUndefined();
    expect(text(render())).toContain("أُلغي اختيار المدخلات عند تغيير مجموعة القياسات");
    const group = nodes(render()).find(node => node.type === "select" && node.props.value === next.payload.measurementSets.at(-1)!.id)!;
    (group.props.onChange as (event: unknown) => void)({ target: { value: "current" } });
    click("المصدر والتاريخ: السن 11"); expect(preview()).toBeUndefined();
  });
  it("lets the doctor opt out a selected target inside the preview without writing or changing other selections", () => {
    select("اختيار السن 12 لجلسة القياس"); select("اختيار السن 13 لجلسة القياس"); click("المصدر والتاريخ: السن 11");
    const labels = nodes(preview()).filter(node => node.type === "label");
    const omit = nodes(labels[1]).find(node => node.type === "input")!;
    (omit.props.onChange as () => void)(); expect(change).not.toHaveBeenCalled();
    apply(); expect(change).toHaveBeenCalledTimes(1);
    const next = change.mock.calls[0][0] as MeasurementEditorDraftV2;
    expect(next.values.width_12.date).toBe("2026-10-01"); expect(next.values.width_13).toEqual(draft.values.width_13);
  });
  it("refreshes the preview when the source changes and refuses a grant revoked during confirmation", () => {
    select("اختيار السن 12 لجلسة القياس"); click("المصدر والتاريخ: السن 11");
    draft = structuredClone(draft); draft.values.width_11.methodDescription = "Synthetic corrected method";
    expect(text(preview())).toContain("Synthetic corrected method");
    confirm.mockImplementation(() => { permitted = false; return true; }); apply();
    expect(change).not.toHaveBeenCalled();
  });
  it("retains historical and untouched target rejection even when targets were selected earlier", () => {
    select("اختيار السن 12 لجلسة القياس"); click("المصدر والتاريخ: السن 11");
    draft = structuredClone(draft); draft.values.width_12.copiedFrom = { kind: "observation_v2", revisionId: 1, contentHash: "b".repeat(64), observationId: "old" };
    expect(preview()).toBeUndefined(); apply(); expect(change).not.toHaveBeenCalled();
    draft.values.width_12.copiedFrom = null; draft.values.width_12.state = "not_recorded";
    expect(preview()).toBeUndefined(); apply(); expect(change).not.toHaveBeenCalled();
  });

  it("shows named selected targets and exact old/new date, method, performer and source before any write", () => {
    select("اختيار السن 12 لجلسة القياس"); click("المصدر والتاريخ: السن 11");
    const view = preview(); expect(view).toBeDefined();
    const content = text(view); for (const value of ["2026-09-01", "2026-10-01", "Synthetic existing method", "Synthetic new method", "Synthetic old operator", "Synthetic new operator", "#1", "#2"]) expect(content).toContain(value);
    expect(change).not.toHaveBeenCalled();
  });
  it("shows unknown-date reasons, method-category changes and removal of linked sources explicitly", () => {
    Object.assign(draft.values.width_12, { dateState: "unknown", date: "", dateReason: "Synthetic date unavailable", method: "external_report", performer: "unknown", performerAttribution: "" });
    draft.values.width_11.sources = [];
    select("اختيار السن 12 لجلسة القياس"); click("المصدر والتاريخ: السن 11");
    const content = text(preview());
    for (const value of ["حالة تاريخ الفحص", "سبب غياب التاريخ", "Synthetic date unavailable", "تقرير خارجي", "قياس سجل", "حالة منفذ الفحص", "لا مصادر مرتبطة"]) expect(content).toContain(value);
    expect(change).not.toHaveBeenCalled(); apply();
    const next = change.mock.calls[0][0] as MeasurementEditorDraftV2;
    expect(next.values.width_12.sources).toEqual([]); expect(next.values.width_12.dateState).toBe("known");
    expect(next.values.width_12.numberText).toBe(draft.values.width_12.numberText);
  });
  it("cancel preserves values and targets; explicit confirm applies only selected targets without changing numbers", () => {
    select("اختيار السن 12 لجلسة القياس"); click("المصدر والتاريخ: السن 11"); const before = structuredClone(draft);
    confirm.mockReturnValue(false); apply(); expect(change).not.toHaveBeenCalled(); expect(draft).toEqual(before); expect(preview()).toBeDefined();
    confirm.mockReturnValue(true); apply(); expect(change).toHaveBeenCalledTimes(1);
    const next = change.mock.calls[0][0] as MeasurementEditorDraftV2;
    expect(next.values.width_12.date).toBe("2026-10-01"); expect(next.values.width_12.numberText).toBe(before.values.width_12.numberText);
    expect(next.values.width_13).toEqual(before.values.width_13); expect(next.payload).toEqual(before.payload); expect(draft).toEqual(before);
  });
});
