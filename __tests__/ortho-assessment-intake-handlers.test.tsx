import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoAssessmentIntake } from "../components/OrthoAssessmentIntake";
import { makeIntakeOwnerSlot, makeIntakeRecoveryLedger, type IntakeOwner, type IntakeOwnerScope } from "../lib/ortho-assessment-intake-owner";
import { blankIntakeEditor, intakeEditorCommand, readIntakeEditor } from "../lib/ortho-assessment-intake-editor";
import { readIntakeResponse } from "../lib/ortho-assessment-intake-client";

// Actual component handlers, editor/parser, WebCrypto reader and owner. The hook
// storage below is a handler harness, not React reconciliation/native proof.
// Transport can return a synthetic GET or a refusal/network failure ONLY; no
// mocked clinical success response or replacement writer/validator is supplied.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, changed: false,
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(), pending: [] as Array<() => void> }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const useEffect = (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = hooks.cursor++, old = hooks.effects.get(index); if (old && same(old.deps, deps)) return;
    hooks.pending.push(() => { old?.cleanup?.(); const cleanup = effect(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true; hooks.values[index] = next;
      }];
    },
    useMemo: (factory: () => unknown, deps?: readonly unknown[]) => {
      const index = hooks.cursor++, old = hooks.memos.get(index); if (old && same(old.deps, deps)) return old.value;
      const value = factory(); hooks.memos.set(index, { deps, value }); return value;
    }, useEffect, useLayoutEffect: useEffect,
  };
});
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const textOf = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" && "props" in node ? textOf((node as Element).props.children as ReactNode) : "";
const scope: IntakeOwnerScope = { patientId: 7, principalId: 17, permissionKey: "synthetic_full_permission_generation", selectedOrthoCaseId: null, selectedClinicalCaseId: null };
const emptyRead = () => ({ ok: true, patientId: 7, writable: true, canLinkPlan: true, openCase: null, history: [], clinicalCases: [], plans: [], choicesTruncated: false });
let owner: IntakeOwner, state: { authorized: boolean; writable: boolean };
let ledger: ReturnType<typeof makeIntakeRecoveryLedger>, slot: ReturnType<typeof makeIntakeOwnerSlot>;
const onSaved = vi.fn(), confirmDiscard = vi.fn(() => true), transport = vi.fn();
const access = () => ({ authorized: () => state.authorized, writable: () => state.writable, deny: () => { state.authorized = false; } });
function unmount() {
  hooks.effects.forEach(effect => effect.cleanup?.()); hooks.values.length = 0; hooks.effects.clear(); hooks.memos.clear(); hooks.pending.length = 0;
}
function render(): ReactNode {
  for (let round = 0; round < 30; round++) {
    hooks.cursor = 0; hooks.changed = false;
    const tree = OrthoAssessmentIntake({ owner, onSaved, confirmDiscard });
    hooks.pending.splice(0).forEach(effect => effect()); if (!hooks.changed) return tree;
  }
  throw new Error("Intake handler render did not settle");
}
async function flush() { for (let i = 0; i < 12; i++) { await new Promise<void>(resolve => setTimeout(resolve, 0)); render(); } }
const field = (label: string) => {
  const node = nodes(render()).find(n => n.props["aria-label"] === label); if (!node) throw new Error(`Missing ${label}`);
  return node.props.onChange as (e: { target: { value: string } }) => void;
};
const button = (label: string) => { const node = nodes(render()).find(n => n.type === "button" && textOf(n) === label); if (!node) throw new Error(`Missing ${label}`); return node; };
const action = (label: string) => button(label).props.onClick as () => void;
const submit = () => nodes(render()).find(n => n.type === "form")!.props.onSubmit as (e: { preventDefault(): void }) => void;
const postBodies = () => transport.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === "POST").map(call => (call[1] as RequestInit).body);
async function ready() { render(); await flush(); expect(owner.read).not.toBeNull(); }
async function authored() { await ready(); field("الحالة السريرية للتقييم")({ target: { value: "new" } }); render(); field("سبب تدوين بداية الحالة")({ target: { value: "Synthetic authored intake reason" } }); render(); }
beforeEach(() => {
  unmount(); state = { authorized: true, writable: true }; ledger = makeIntakeRecoveryLedger(); slot = makeIntakeOwnerSlot(ledger); owner = slot.select(scope, access());
  onSaved.mockReset(); confirmDiscard.mockReset(); confirmDiscard.mockReturnValue(true); transport.mockReset();
  transport.mockImplementation(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === "POST"
    ? { code: "write_unconfirmed", message: "Synthetic transport uncertainty" } : emptyRead()), { status: init?.method === "POST" ? 503 : 200 }));
  vi.stubGlobal("fetch", transport);
});
afterEach(() => { unmount(); slot.retire(); vi.unstubAllGlobals(); });
describe("actual intake handlers without invented clinical successes", () => {
  it("retains authored bytes across panel detachment and rejects callbacks from the old view", async () => {
    await authored(); const reason = field("سبب تدوين بداية الحالة"), source = field("الحالة السريرية للتقييم"), save = submit(), discard = action("تجاهل المسودة صراحةً"), reload = action("تحديث بداية الحالة");
    const before = owner.document; unmount(); await ready(); const count = transport.mock.calls.length;
    reason({ target: { value: "stale" } }); source({ target: { value: "new" } }); save({ preventDefault() {} }); discard(); reload(); await flush();
    expect(owner.document).toBe(before); expect(transport).toHaveBeenCalledTimes(count); expect(postBodies()).toEqual([]); expect(confirmDiscard).not.toHaveBeenCalled();
  });
  it("same-view reread and exact-document replacement invalidate retained reason/source/save/discard", async () => {
    await authored(); const old = { reason: field("سبب تدوين بداية الحالة"), source: field("الحالة السريرية للتقييم"), save: submit(), discard: action("تجاهل المسودة صراحةً") };
    owner.invalidateRead(); await ready(); const before = owner.document;
    old.reason({ target: { value: "stale" } }); old.source({ target: { value: "new" } }); old.save({ preventDefault() {} }); old.discard(); render();
    expect(owner.document).toBe(before); expect(postBodies()).toEqual([]);
    const prior = field("سبب تدوين بداية الحالة"); field("سبب تدوين بداية الحالة")({ target: { value: "new exact document" } }); render();
    prior({ target: { value: "late overwrite" } }); expect(JSON.parse(owner.document).reason).toBe("new exact document");
  });
  it("rechecks discard after its dialog changes the read generation", async () => {
    await authored(); const discard = action("تجاهل المسودة صراحةً"), before = owner.document;
    confirmDiscard.mockImplementation(() => { owner.invalidateRead(); return true; }); discard(); await flush(); expect(owner.document).toBe(before);
  });
  it("network/5xx uncertainty retains the original ID and exact body through reread and retry", async () => {
    await authored(); submit()({ preventDefault() {} }); await flush();
    expect(owner.uncertain).toBe(true); expect(owner.busy).toBe(false); expect(postBodies()).toHaveLength(1);
    const first = postBodies()[0]; expect(typeof first).toBe("string");
    action("تحديث بداية الحالة")(); await flush(); expect(owner.uncertain).toBe(true);
    action("التحقق بإعادة الطلب الأصلي")(); await flush();
    expect(postBodies()).toEqual([first, first]); expect(owner.uncertain).toBe(true); expect(onSaved).not.toHaveBeenCalled();
    expect(nodes(render()).find(n => n.type === "fieldset")?.props.disabled).toBe(true);
  });
  it("local read-only authority disables the form even if a prior GET says writable", async () => {
    slot.retire(); state.writable = false; owner = slot.select({ ...scope, permissionKey: "synthetic_readonly_generation" }, access());
    await ready(); expect(owner.authorized()).toBe(true); expect(owner.writable()).toBe(false);
    // Regression against review-01 line 80: visual admission must use the live owner too.
    expect(nodes(render()).find(n => n.type === "fieldset")?.props.disabled).toBe(true);
    field("سبب تدوين بداية الحالة")({ target: { value: "forbidden" } }); render(); expect(owner.document).toBe(""); expect(postBodies()).toEqual([]);
  });
  it("another current actor cannot view/retry the first actor's uncertain body or use its retained controls", async () => {
    await authored(); submit()({ preventDefault() {} }); await flush(); const retry = action("التحقق بإعادة الطلب الأصلي"), retained = owner;
    unmount(); owner = slot.select({ ...scope, principalId: 18 }, access()); await ready();
    expect(retained.retired).toBe(true); expect(owner.recoveryBlocked).toBe(true); expect(owner.document).toBe("");
    const count = postBodies().length; retry(); await flush(); expect(postBodies()).toHaveLength(count);
    expect(textOf(render())).toContain("لا يمكن استبداله من حساب أو هوية مريض أخرى"); expect(onSaved).not.toHaveBeenCalled();
  });
  it("current permission loss while transport is pending cannot claim success or erase recovery", async () => {
    await authored(); let release!: (response: Response) => void;
    transport.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    submit()({ preventDefault() {} }); expect(owner.busy).toBe(true); state.writable = false;
    release(new Response(JSON.stringify({ code: "clinical_edit_denied", message: "Synthetic revoked request" }), { status: 403 })); await flush();
    expect(owner.retired).toBe(true); expect(ledger.needsUnloadWarning()).toBe(true); expect(onSaved).not.toHaveBeenCalled();
  });
});
describe("actual intake editor explicit unknown semantics", () => {
  it("does not initialize appliance/arch/phase/date/slot/duration or infer transferred treatment", () => {
    const draft = blankIntakeEditor("activate");
    expect(draft).toMatchObject({ appliance: "", arches: "", phase: "", slot: "", startState: "", startDate: "", plannedMonths: "", financialPlan: "" });
    expect(readIntakeEditor("invalid JSON", "activate")).toBeNull();
    expect(readIntakeEditor(JSON.stringify({ ...draft, invoiceAmount: 1 }), "activate")).toBeNull();
  });
  it("builds only an explicit opening and cannot add finance or clinical defaults", async () => {
    const read = await readIntakeResponse(emptyRead(), { patientId: 7 });
    const draft = { ...blankIntakeEditor("open"), bridge: "new", intakeKind: "transferred" as const, reason: "Synthetic transferred context" };
    const result = intakeEditorCommand(draft, read!, "synthetic_open_editor_1");
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual(["bridge", "commandId", "intakeKind", "kind", "patientId", "reason", "schemaVersion"]);
    expect(result.value).toMatchObject({ kind: "open_assessment", intakeKind: "transferred", bridge: { mode: "new" } });
  });
});
