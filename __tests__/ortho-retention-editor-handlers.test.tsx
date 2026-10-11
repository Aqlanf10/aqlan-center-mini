import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoRetentionEventEditor, type RetentionDraftEdit } from "../components/OrthoRetentionEventEditor";
import { initialRetentionEditor, type RetentionEditorDraft } from "../lib/ortho-retention-editor";
import { canonicalJourneyJSON } from "../lib/ortho-case-journey-json";
import { delivery, readFixture, row } from "./fixtures/ortho-retention-ui";
// Runs actual captured component handlers with a synthetic hook clock. This is
// not React reconciliation, native interaction, accessibility or layout proof.
const hooks = vi.hoisted(() => ({ refs: [] as Array<{ current: unknown }>, cursor: 0, cleanup: null as null | (() => void), effect: null as null | (() => void | (() => void)) }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return { ...react, useRef: (value: unknown) => { const index = hooks.cursor++; return hooks.refs[index] ?? (hooks.refs[index] = { current: value }); },
    useLayoutEffect: (effect: () => void | (() => void)) => { hooks.effect = effect; } };
});
type Node = ReactElement<Record<string, unknown>>;
const nodes = (value: ReactNode): Node[] => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === "object" && "props" in value
  ? [value as Node, ...nodes((value as Node).props.children as ReactNode)] : [];
const read = readFixture([row(101, 1, delivery()), row(102, 2, delivery("second device"))]);
let draft: RetentionEditorDraft, writable: boolean, authorized: boolean, ownerKey: string;
const changed = vi.fn<(request: RetentionDraftEdit) => boolean>();
function render(commit = true): ReactNode {
  hooks.cursor = 0;
  const tree = OrthoRetentionEventEditor({ ownerKey, draft, read, writable, isCurrent: () => authorized, onChange: changed });
  if (commit) { hooks.cleanup?.(); const cleanup = hooks.effect?.(); hooks.cleanup = typeof cleanup === "function" ? cleanup : null; }
  return tree;
}
const field = (tree: ReactNode, label: string) => {
  const node = nodes(tree).find(value => value.props["aria-label"] === label); if (!node) throw new Error(`Missing ${label}`);
  return node.props.onChange as (event: { currentTarget: { value: string } }) => void;
};
beforeEach(() => {
  hooks.refs.length = 0; hooks.cleanup = null; hooks.effect = null;
  draft = { ...initialRetentionEditor(read), reason: "original reason" }; writable = true; authorized = true; ownerKey = "actor17:case81:bridge91";
  changed.mockReset(); changed.mockImplementation(request => {
    if (!authorized || request.ownerKey !== ownerKey || request.expectedDraft !== canonicalJourneyJSON(draft)) return false;
    draft = request.draft; return true;
  });
});
afterEach(() => { hooks.cleanup?.(); hooks.refs.length = 0; });
describe("controlled retention handlers", () => {
  it("uses exact local-draft CAS and does not permit a captured old render to overwrite a newer draft", () => {
    const tree = render(), oldReason = field(tree, "سبب حفظ سجل التثبيت");
    oldReason({ currentTarget: { value: "new reason" } }); expect(draft.reason).toBe("new reason");
    // Before the next commit the parent CAS still prevents a second stale update.
    oldReason({ currentTarget: { value: "stale second change" } }); expect(draft.reason).toBe("new reason");
    render(); const count = changed.mock.calls.length;
    oldReason({ currentTarget: { value: "retired render" } }); expect(changed).toHaveBeenCalledTimes(count);
  });
  it("rejects retained callbacks after view unmount, read invalidation or current write loss", () => {
    let callback = field(render(), "سبب حفظ سجل التثبيت"); hooks.cleanup?.(); callback({ currentTarget: { value: "after unmount" } }); expect(changed).not.toHaveBeenCalled();
    callback = field(render(), "سبب حفظ سجل التثبيت"); authorized = false; callback({ currentTarget: { value: "read invalidated" } }); expect(changed).not.toHaveBeenCalled();
    authorized = true; writable = false; callback = field(render(), "سبب حفظ سجل التثبيت"); callback({ currentTarget: { value: "readonly" } }); expect(changed).not.toHaveBeenCalled();
    expect(nodes(render())[0].props.disabled).toBe(true);
  });
  it("keeps the previous committed handler valid during an uncommitted render, then retires it on commit", () => {
    const old = field(render(), "سبب حفظ سجل التثبيت"); render(false);
    old({ currentTarget: { value: "valid committed action" } }); expect(draft.reason).toBe("valid committed action");
    render(); const count = changed.mock.calls.length; old({ currentTarget: { value: "stale" } }); expect(changed).toHaveBeenCalledTimes(count);
  });
  it("selects an exact device and never derives review findings or dates", () => {
    field(render(), "نوع تدوين التثبيت")({ currentTarget: { value: "device_review" } });
    field(render(), "الجهاز الفعلي للتدوين")({ currentTarget: { value: "102" } });
    expect(draft.device).toEqual({ deviceId: 102, expectedDeviceRevisionId: 102 }); expect(draft.occurrence.occurredOn).toBeNull();
    expect(Object.values(draft.findings).every(value => value.state === "not_assessed")).toBe(true);
    field(render(), "حالة الملاءمة")({ currentTarget: { value: "recorded" } });
    expect(draft.findings.fit).toEqual({ state: "recorded", note: "" });
  });
  it("does not treat the owner's display key as authority, or submit any network request", () => {
    const callback = field(render(), "سبب حفظ سجل التثبيت"); ownerKey = "actor18:case81:bridge91";
    callback({ currentTarget: { value: "foreign actor edit" } }); expect(draft.reason).toBe("original reason");
    const tree = render(); expect(nodes(tree).some(node => node.type === "form" || node.type === "button")).toBe(false);
  });
});
