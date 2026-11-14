import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoAssessmentFindingsV2 } from "../components/OrthoAssessmentFindingsV2";
import { newAssessmentEditorV2 } from "../lib/ortho-assessment-editor-v2";
import type { MeasurementEditorDraftV2 } from "../lib/ortho-assessment-measurement-editor-v2";
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useId: () => "synthetic-fields",
  useState(initial: unknown) { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }]; },
  useRef: () => ({ current: null }), useLayoutEffect: () => undefined,
}));
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node && !(node as Element).props.hidden ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
let draft: MeasurementEditorDraftV2, active: boolean, group: "history" | "facial" | "intraoral";
const change = vi.fn((next: MeasurementEditorDraftV2) => { draft = next; });
const confirm = vi.fn(() => true);
function render() { hooks.cursor = 0; return OrthoAssessmentFindingsV2({ draft, sources: [], onChange: change,
  owner: { renderEditable: active, active: () => active, editable: () => active }, focusGroup: group }); }
function click(label: string) { const found = nodes(render()).find(node => node.type === "button" && text(node) === label)!;
  expect(found, label).toBeDefined(); expect(found.props.disabled).not.toBe(true); (found.props.onClick as () => void)(); }
function input(label: string) { const found = nodes(render()).find(node => node.type === "label" && text(node) === label)!;
  expect(found, label).toBeDefined(); return nodes(found).find(node => node.type === "input")!; }
function fill(label: string, value: string) { (input(label).props.onChange as (event: unknown) => void)({ target: { value } }); }
function setupSource() {
  for (const id of ["clinical_chiefComplaint", "clinical_dentalHistory"]) Object.assign(draft.values[id], { state: "recorded", text: `Synthetic ${id}` });
  Object.assign(draft.values.clinical_chiefComplaint, { dateState: "known", date: "2026-11-11", method: "direct_examination", methodDescription: "Synthetic shared interview" });
  click("مصدر وتاريخ الشكوى الرئيسية");
}
beforeEach(() => { hooks.values.length = 0; hooks.cursor = 0; draft = newAssessmentEditorV2("synthetic-ui", null)!.measurements;
  active = true; group = "history"; change.mockClear(); confirm.mockReset(); confirm.mockReturnValue(true); vi.stubGlobal("window", { confirm }); });
afterEach(() => vi.unstubAllGlobals());

describe("actual clinical findings direct-entry handlers", () => {
  it("shows all five history text inputs before their status selector and does not mutate merely from rendering", () => {
    const tree = nodes(render());
    const fields = tree.filter(node => node.type === "fieldset"); expect(fields).toHaveLength(5);
    for (const field of fields) {
      const children = nodes(field); const textInput = children.findIndex(node => node.type === "input" && node.props.type !== "checkbox");
      expect(textInput).toBeGreaterThan(-1); expect(textInput).toBeLessThan(children.findIndex(node => node.type === "select"));
    }
    expect(change).not.toHaveBeenCalled();
    fill("الشكوى الرئيسية — اختيار قابل للبحث أو نص حر", "Explicitly authored complaint");
    expect(draft.values.clinical_chiefComplaint).toMatchObject({ state: "recorded", text: "Explicitly authored complaint", dateState: "", method: "" });
    expect(draft.values.clinical_dentalHistory.state).toBe("not_recorded");
  });
  it("does not let a retired input callback write after a grant is withdrawn", () => {
    const callback = input("الشكوى الرئيسية — اختيار قابل للبحث أو نص حر").props.onChange as (e: unknown) => void;
    active = false; callback({ target: { value: "Must not enter" } }); expect(change).not.toHaveBeenCalled();
  });
  it("collects named current-section targets and previews their provenance while leaving blank fields untouched", () => {
    setupSource(); const before = structuredClone(draft);
    click("اختيار الحقول المدخلة في القسم الحالي (1)");
    const preview = nodes(render()).find(node => node.props["aria-label"] === "مراجعة مصدر حقول الفحص")!;
    expect(text(preview)).toContain("التاريخ السني"); expect(text(preview)).toContain("2026-11-11");
    expect(text(preview)).not.toContain("مرجع التاريخ الطبي"); expect(change).not.toHaveBeenCalled();
    confirm.mockReturnValue(false); click("تطبيق مصدر الجلسة على 1 حقول مختارة"); expect(draft).toEqual(before);
    confirm.mockReturnValue(true); click("تطبيق مصدر الجلسة على 1 حقول مختارة");
    expect(draft.values.clinical_dentalHistory).toMatchObject({ text: before.values.clinical_dentalHistory.text, date: "2026-11-11", methodDescription: "Synthetic shared interview" });
    expect(draft.values.clinical_medicalHistory).toEqual(before.values.clinical_medicalHistory);
    expect(change).toHaveBeenCalledTimes(1);
  });
  it("rechecks authority after confirmation and refuses a same-dialog revocation", () => {
    setupSource(); click("اختيار الحقول المدخلة في القسم الحالي (1)");
    confirm.mockImplementation(() => { active = false; return true; }); click("تطبيق مصدر الجلسة على 1 حقول مختارة");
    expect(change).not.toHaveBeenCalled();
  });
  it("does not expose conflicting named targets in source choices, target selection or an already open metadata editor", () => {
    setupSource();
    draft.payload.observations.observations.find(row => row.id === "clinical_dentalHistory")!.target = { kind: "arch", arch: "upper" };
    let tree = nodes(render());
    expect(text(render())).toContain("هوية حقل التاريخ السني تحتاج مراجعة");
    expect(tree.some(node => node.type === "option" && node.props.value === "clinical_dentalHistory")).toBe(false);
    expect(tree.find(node => node.type === "button" && text(node).startsWith("اختيار الحقول المدخلة"))?.props.disabled).toBe(true);
    draft.payload.observations.observations.find(row => row.id === "clinical_chiefComplaint")!.target = { kind: "arch", arch: "upper" };
    tree = nodes(render());
    expect(tree.some(node => node.props["aria-label"] === "مصدر الشكوى الرئيسية")).toBe(false);
    expect(tree.some(node => node.type === "option" && node.props.value === "clinical_chiefComplaint")).toBe(false);
    expect(change).not.toHaveBeenCalled();
  });
  it("never applies source to historical or newly untouched targets and excludes selections from another section", () => {
    setupSource(); click("اختيار الحقول المدخلة في القسم الحالي (1)");
    group = "facial"; expect(nodes(render()).some(node => node.props["aria-label"] === "مراجعة مصدر حقول الفحص")).toBe(false);
    group = "history"; draft.values.clinical_dentalHistory.copiedFrom = { kind: "observation_v2", revisionId: 1, contentHash: "a".repeat(64), observationId: "old" };
    expect(nodes(render()).some(node => node.props["aria-label"] === "مراجعة مصدر حقول الفحص")).toBe(false);
    draft.values.clinical_dentalHistory.copiedFrom = null; draft.values.clinical_dentalHistory.state = "not_recorded";
    expect(nodes(render()).some(node => node.props["aria-label"] === "مراجعة مصدر حقول الفحص")).toBe(false); expect(change).not.toHaveBeenCalled();
  });
});
