import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoCaseAssessmentV2, type AssessmentLifetimeV2 } from "../components/OrthoCaseAssessmentV2";
import type { SessionInfo } from "../components/SessionProvider";
// Executes the actual component handlers with synthetic hook storage/transport.
// Real React/browser and HTTP/PG proof remain separate required acceptance.
const hooks = vi.hoisted(() => ({
  session: { username: "synthetic-doctor", role: "doctor", permissions: null } as SessionInfo | null,
  values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  pending: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined), previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (update: unknown) => {
        const next = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => { const index = slot({ current: initial }); return hooks.values[index]; },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined), previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.(); const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined), previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.(); const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});



vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("../components/OrthoAssessmentFindingsV2", () => ({ OrthoAssessmentFindingsV2: "findings-editor" }));
vi.mock("../components/OrthoAssessmentMeasurementsV2", () => ({ OrthoAssessmentMeasurementsV2: "measurement-editor" }));
vi.mock("../lib/ortho-assessment-client-v2", () => ({ readAssessmentResponseV2: async (raw: unknown) => raw }));
vi.mock("../lib/ortho-assessment-editor-v2", () => ({
  readAssessmentEditorV2: (raw: string) => raw ? JSON.parse(raw) : null,
  newAssessmentEditorV2: () => ({ reason: "Synthetic reason", measurements: { marker: "original" }, expectedRevisionId: null, previousVersion: 0 }),
  assessmentEditorCommandV2: (value: unknown) => value,
}));
// These tests isolate actual component admission handlers. The mocked reader and
// editor codecs intentionally do not supply DTO, React reconciliation or browser proof.
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const textOf = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" && "props" in node ? textOf((node as Element).props.children as ReactNode) : "";
const parent = { identity: {}, document: "", busy: false, uncertain: false, readVersion: 0, allowed: true };
const change = vi.fn((value: string) => { parent.document = value; });
const settle = vi.fn((value: string) => { parent.document = value; });
const beginLease = vi.fn(() => null);
const fetchMock = vi.fn();
let outerKey: string | null = null;
let ready: Record<string, unknown>;
const life = (): AssessmentLifetimeV2 => ({
  identity: parent.identity, active: () => parent.allowed, editable: () => parent.allowed && !parent.busy && !parent.uncertain,
  denied: () => { parent.allowed = false; }, busy: parent.busy, uncertain: parent.uncertain,
  dirty: !!parent.document, readVersion: parent.readVersion, values: { document: parent.document },
  change: (_field, value) => change(value), settle: (_field, value) => settle(value), refresh: () => { parent.readVersion++; },
  begin: beginLease, beginRetry: beginLease,
});
function retireView() {
  hooks.effects.forEach(effect => effect.cleanup?.());
  hooks.values.length = 0; hooks.effects.clear(); hooks.memos.clear(); hooks.pending.length = 0;
  outerKey = null;
}
function render() {
  for (let round = 0; round < 20; round++) {
    hooks.cursor = 0; hooks.changed = false;
    const wrapper = OrthoCaseAssessmentV2({ patientId: 1, orthoCaseId: 2, lifetime: life() });
    if (outerKey !== wrapper.key) { retireView(); outerKey = wrapper.key; }
    const tree = (wrapper.type as (input: unknown) => ReactNode)(wrapper.props);
    hooks.pending.splice(0).forEach(effect => effect());
    if (!hooks.changed) return tree;
  }
  throw Error("Assessment did not settle");
}
const button = (label: string) => {
  const found = nodes(render()).find(n => n.type === "button" && textOf(n) === label);
  if (!found) throw Error(`Missing button ${label}`); return found;
};
const click = (label: string) => { const found = button(label); expect(found.props.disabled).not.toBe(true); (found.props.onClick as () => void)(); render(); };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); render(); };
const reasonHandler = () => nodes(render()).find(n => n.type === "input" && n.props.maxLength === 500)!.props.onChange as (event: { target: { value: string } }) => void;
const sourceHandler = () => nodes(render()).find(n => n.type === "findings-editor")!.props.onChange as (value: unknown) => void;
const action = (label: string) => button(label).props.onClick as () => void;
const refreshLabel = "تحديث سجل التقييم", beginLabel = "بدء تقييم غير معبأ", discardLabel = "تجاهل المسودة صراحة", saveLabel = "حفظ مراجعة تقييم جديدة";
async function startDraft() { render(); await flush(); click(beginLabel); }
beforeEach(() => {
  retireView(); parent.identity = {}; parent.document = ""; parent.busy = false; parent.uncertain = false; parent.allowed = true; parent.readVersion = 0;
  change.mockClear(); settle.mockClear(); beginLease.mockClear();
  hooks.session = { username: "synthetic-doctor", role: "doctor", permissions: null };
  ready = { state: "ready", patientId: 1, orthoCaseId: 2, clinicalCaseId: 3, clinicalWritable: true, recordingContext: "current",
    history: [], revision: null, sourceStates: [], sources: { imaging: "available", truncated: false, items: [] } };
  fetchMock.mockReset(); fetchMock.mockImplementation(async () => ({ ok: true, status: 200, redirected: false, json: async () => ready }));
  vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("window", { confirm: vi.fn(() => true) });
});
afterEach(() => { retireView(); vi.unstubAllGlobals(); });
describe("actual assessment view handler admission", () => {
  it("renders new draft inputs editable while retained callbacks still require committed document bytes", async () => {
    await startDraft();
    const editors = () => nodes(render()).filter(n => ["findings-editor", "measurement-editor"].includes(String(n.type)));
    const oldOwners = editors().map(node => node.props.owner as { renderEditable: boolean; active(): boolean });
    expect(oldOwners.every(owner => owner.renderEditable)).toBe(true);
    reasonHandler()({ target: { value: "new document bytes" } }); render();
    expect(editors().every(node => (node.props.owner as { renderEditable: boolean }).renderEditable)).toBe(true);
    expect(oldOwners.every(owner => !owner.active())).toBe(true);
  });
  it("retired reason/source/discard/save/refresh callbacks cannot act after the same parent owner remounts", async () => {
    await startDraft();
    const oldReason = reasonHandler(), oldSource = sourceHandler(), oldDiscard = action(discardLabel), oldSave = action(saveLabel), oldRefresh = action(refreshLabel);
    retireView(); render(); await flush();
    const before = parent.document, requests = fetchMock.mock.calls.length, changes = change.mock.calls.length, settlements = settle.mock.calls.length;
    oldReason({ target: { value: "stale" } }); oldSource({ marker: "stale" }); oldDiscard(); oldSave(); oldRefresh(); await flush();
    expect(parent.document).toBe(before); expect(change).toHaveBeenCalledTimes(changes); expect(settle).toHaveBeenCalledTimes(settlements);
    expect(beginLease).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(requests);
    reasonHandler()({ target: { value: "current edit" } }); render(); expect(JSON.parse(parent.document).reason).toBe("current edit");
  });
  it("same-view read-version changes retire edit, save, source and discard callbacks", async () => {
    await startDraft();
    const oldReason = reasonHandler(), oldSource = sourceHandler(), oldDiscard = action(discardLabel), oldSave = action(saveLabel);
    parent.readVersion++; render(); await flush(); const before = parent.document;
    oldReason({ target: { value: "stale generation" } }); oldSource({ marker: "stale generation" }); oldDiscard(); oldSave(); render();
    expect(parent.document).toBe(before); expect(beginLease).not.toHaveBeenCalled();
    click(discardLabel); expect(parent.document).toBe("");
  });
  it("same-generation draft replacement rejects callbacks carrying older document bytes", async () => {
    await startDraft(); const oldReason = reasonHandler(), oldDiscard = action(discardLabel), oldSource = sourceHandler();
    reasonHandler()({ target: { value: "latest authored reason" } }); render(); const before = parent.document;
    oldReason({ target: { value: "overwrite" } }); oldSource({ marker: "overwrite" }); oldDiscard(); render();
    expect(parent.document).toBe(before);
  });
  it("discard rechecks admission after a synchronous confirmation changes read generation", async () => {
    await startDraft(); const discard = action(discardLabel), before = parent.document;
    vi.mocked(window.confirm).mockImplementation(() => { parent.readVersion++; render(); return true; });
    discard(); await flush(); expect(parent.document).toBe(before);
  });
  it("retained begin and refresh are refused after retirement and after reload generation changes", async () => {
    render(); await flush(); const oldBegin = action(beginLabel), oldRefresh = action(refreshLabel);
    click(refreshLabel); await flush(); const requests = fetchMock.mock.calls.length;
    oldBegin(); oldRefresh(); await flush(); expect(parent.document).toBe(""); expect(fetchMock).toHaveBeenCalledTimes(requests);
    const retiredBegin = action(beginLabel); retireView(); render(); await flush(); retiredBegin(); render(); expect(parent.document).toBe("");
    click(beginLabel); expect(parent.document).not.toBe("");
  });
  it("revision selection cannot be revived by an old view callback", async () => {
    ready.history = [{ id: 5, version: 1, createdAt: "2026-01-01", createdBy: "Synthetic" }, { id: 6, version: 2, createdAt: "2026-01-02", createdBy: "Synthetic" }];
    ready.revision = { id: 5, schemaVersion: 2, version: 1, content: {}, createdAt: "2026-01-01", createdBy: "Synthetic", reason: "Fixture", contentHash: "0".repeat(64) };
    render(); await flush();
    const select = nodes(render()).find(n => n.type === "select")!.props.onChange as (event: { target: { value: string } }) => void;
    parent.readVersion++; render(); await flush(); const requests = fetchMock.mock.calls.length;
    select({ target: { value: "6" } }); await flush(); expect(fetchMock).toHaveBeenCalledTimes(requests);
  });
});
