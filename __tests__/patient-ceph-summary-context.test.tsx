import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientCeph, type CephAnalysis, type PatientCephProps } from "../components/PatientCeph";

// Execute PatientCeph itself, its memo dependencies and rendered handlers. Only
// hook storage and fetch are synthetic; this does not substitute for DOM/HTTP QA.
const hooks = vi.hoisted(() => ({
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
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
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

type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(nodes)
  : node && typeof node === "object" && "props" in node ? [node as Element, ...nodes((node as Element).props.children as ReactNode)] : [];
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
const PATIENT = 11, CASE_A = 21, CASE_B = 22, DOC = 51;
const ALL_SCOPE = "أحدث دراسة معتمدة للمريض (كافة الحالات)";
const caseScope = (id = CASE_A) => `أحدث دراسة معتمدة للحالة #${id}`;
const study = (extra: Partial<CephAnalysis> = {}): CephAnalysis => ({
  id: 61, patientId: PATIENT, documentId: DOC, status: "completed", orthoCaseId: CASE_A,
  phase: "pretreatment", xrayDate: "2026-01-01", device: null, refSet: "builtin_default",
  calibration: { x1: 0, y1: 0, x2: 100, y2: 0, mm: 100 }, mmPerPixel: 1,
  note: null, createdBy: "synthetic-doctor", createdAt: "2026-01-01T08:00:00.000Z",
  completedBy: "synthetic-doctor", completedAt: "2026-01-01T09:00:00.000Z",
  findings: { anb: 4.2, fma: 25.1, wits: -1.3 }, ...extra,
});
let props: PatientCephProps;
let analyses: CephAnalysis[];
let location: { href: string };
const fetchMock = vi.fn();
function render() {
  let tree: ReturnType<typeof PatientCeph> | null = null, round = 0;
  do {
    if (++round > 20) throw new Error("Ceph component did not settle");
    hooks.cursor = 0; hooks.changed = false; tree = PatientCeph(props);
    hooks.pending.splice(0).forEach(effect => effect());
  } while (hooks.changed);
  return tree;
}
async function ready() {
  render(); for (let i = 0; i < 30; i++) await Promise.resolve(); render();
}
const summary = () => nodes(render()).find(node => node.props["data-testid"] === "patient-ceph-summary");
const button = (label: string) => {
  const found = nodes(render()).find(node => node.type === "button" && text(node) === label);
  if (!found) throw new Error(`Missing ceph button: ${label}`); return found;
};
const click = (label: string) => (button(label).props.onClick as () => unknown)();
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
const summaryHref = () => nodes(summary()).find(node => typeof node.props.href === "string")?.props.href;
const rows = () => nodes(render()).filter(node => node.type === "tbody").flatMap(node => nodes(node).filter(child => child.type === "tr"));
function expectSummary(id: number, scope: string, source: string) {
  expect(summary()).toBeDefined(); expect(summaryHref()).toBe(`/ceph/${id}`);
  expect(text(summary())).toContain(scope); expect(text(summary())).toContain(source);
}
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  props = { patientId: PATIENT, orthoCaseId: CASE_A, embedded: true, currentPhase: "aligning" };
  analyses = [study()]; location = { href: "" }; fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => ({
    ok: true,
    json: async () => init?.method === "POST" ? { id: 71 }
      : url === `/api/patients/${PATIENT}/ceph` ? { analyses }
      : url === `/api/patients/${PATIENT}/documents` ? { documents: [{
        id: DOC, title: "Synthetic ceph image", isImage: true, mimeType: "image/png",
        takenOn: "2026-01-01", uploadedAt: "2026-01-01T08:00:00.000Z", removedAt: null,
      }] }
      : url === `/api/ortho?patientId=${PATIENT}` ? { cases: [{ id: CASE_A }, { id: CASE_B }] }
      : { sets: [] },
  }));
  vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("window", { location });
});
afterEach(() => { hooks.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe("PatientCeph signed summary follows the displayed scope", () => {
  it.each([CASE_B, null])("does not use a newer completed study linked to %s for case A", async orthoCaseId => {
    analyses = [
      study({ id: 64, status: "draft", findings: null }),
      study({ id: 62, orthoCaseId, findings: { anb: 91, fma: 92, wits: 93 } }),
      study(),
    ];
    const before = JSON.stringify(analyses); await ready();
    expectSummary(61, caseScope(), `مرتبطة بالحالة #${CASE_A}`);
    expect(text(summary())).toContain("4.2°"); expect(text(summary())).toContain("25.1°");
    expect(text(summary())).toContain("-1.3 مم"); expect(text(summary())).toContain("1.0 بكسل/مم");
    expect(text(summary())).not.toContain("91°"); expect(rows()).toHaveLength(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/patients/${PATIENT}/ceph`, `/api/patients/${PATIENT}/documents`,
      `/api/ortho?patientId=${PATIENT}`, "/api/ceph-reference-sets",
    ]);
    expect(JSON.stringify(analyses)).toBe(before); expect(writes()).toEqual([]);
  });

  it.each([false, true])("does not fall back across cases when the current case has only drafts: %s", async withDraft => {
    analyses = [study({ id: 62, orthoCaseId: CASE_B }), study({ id: 63, orthoCaseId: null }),
      ...(withDraft ? [study({ status: "draft", findings: null })] : [])];
    await ready(); expect(summary()).toBeUndefined(); expect(rows()).toHaveLength(withDraft ? 1 : 0);
    if (!withDraft) expect(text(render())).toContain("لا توجد دراسات سيفالومترية مسجلة بعد");
  });

  it.each([CASE_B, null])("switches to patient-wide study %s and back without a new fetch or writes", async orthoCaseId => {
    analyses = [study({ id: 62, orthoCaseId }), study()]; await ready();
    expectSummary(61, caseScope(), `مرتبطة بالحالة #${CASE_A}`);
    click(`دراسات الحالة #${CASE_A}`);
    expectSummary(62, ALL_SCOPE, orthoCaseId === null ? "بلا ربط بحالة" : `مرتبطة بالحالة #${CASE_B}`);
    expect(rows()).toHaveLength(2); expect(text(summary())).not.toContain(caseScope());
    click("كافة دراسات المريض");
    expectSummary(61, caseScope(), `مرتبطة بالحالة #${CASE_A}`); expect(rows()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4); expect(writes()).toEqual([]);
  });

  it("recomputes case A → B → A in the same instance rather than retaining a memo from A", async () => {
    analyses = [study({ id: 62, orthoCaseId: CASE_B }), study()]; await ready();
    props = { ...props, orthoCaseId: CASE_B };
    expectSummary(62, caseScope(CASE_B), `مرتبطة بالحالة #${CASE_B}`);
    props = { ...props, orthoCaseId: CASE_A };
    expectSummary(61, caseScope(), `مرتبطة بالحالة #${CASE_A}`);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps server order, completed-only selection and stored findings independent of dates or case phase", async () => {
    analyses = [study({ id: 64, status: "draft" }), study({ id: 65, status: "discarded" }), study(),
      study({ id: 66, phase: "followup", xrayDate: "2026-10-01", completedAt: "2026-10-02T00:00:00.000Z" })];
    props = { ...props, currentPhase: "retention" }; await ready();
    expectSummary(61, caseScope(), `مرتبطة بالحالة #${CASE_A}`);
    expect(text(summary())).toContain("قبل العلاج (T1)");
    expect(text(summary())).not.toContain("المتابعة والاستبقاء (T4)");
  });

  it("does not replace the first completed study with an older study when findings are absent", async () => {
    analyses = [study({ id: 62, findings: null }), study()]; await ready();
    expect(summary()).toBeUndefined(); expect(rows()).toHaveLength(2);
  });

  it.each([false, true])("keeps empty/draft-only histories without a signed summary (draft=%s)", async withDraft => {
    analyses = withDraft ? [study({ status: "draft", findings: null })] : [];
    await ready(); expect(summary()).toBeUndefined();
  });

  it.each([null, undefined])("keeps no-case T1 studies patient-wide with orthoCaseId=%s", async orthoCaseId => {
    props = { patientId: PATIENT, embedded: true, orthoCaseId };
    analyses = [study({ orthoCaseId: null }), study({ id: 62, orthoCaseId: CASE_B })]; await ready();
    expectSummary(61, ALL_SCOPE, "بلا ربط بحالة"); expect(rows()).toHaveLength(2);
    expect(nodes(render()).some(node => node.type === "button" && /دراسات الحالة|كافة دراسات المريض/.test(text(node)))).toBe(false);
    click("+ دراسة سيفالومترية جديدة");
    await click("📐 افتح مساحة التتبع والتحليل");
    await ready(); // The rendered click intentionally discards openDraft's promise.
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toMatchObject({ documentId: DOC, orthoCaseId: null, phase: "pretreatment" });
    expect(location.href).toBe("/ceph/71");
  });

  it("preserves non-embedded all-patient default even when a case is supplied", async () => {
    props = { ...props, embedded: false }; analyses = [study({ id: 62, orthoCaseId: CASE_B }), study()];
    await ready(); expectSummary(62, ALL_SCOPE, `مرتبطة بالحالة #${CASE_B}`); expect(rows()).toHaveLength(2);
  });

  it("keeps duplicate-document warnings and counts patient-wide while the summary is case-scoped", async () => {
    analyses = [study({ id: 62, orthoCaseId: CASE_B }), study({ id: 63, orthoCaseId: null }), study()];
    await ready(); click("+ دراسة سيفالومترية جديدة");
    expectSummary(61, caseScope(), `مرتبطة بالحالة #${CASE_A}`); expect(rows()).toHaveLength(1);
    expect(text(render())).toContain("3 دراسة"); expect(text(render())).toContain("لهذه الشععة 3 دراسة سابقة");
    expect(text(render())).toContain("#62، #63، #61"); expect(writes()).toEqual([]);
  });

  it("preserves explicit same-patient comparison selections across the all-patient toggle", async () => {
    analyses = [study({ id: 62, orthoCaseId: CASE_B }), study()]; await ready();
    const select = (id: number) => {
      const input = nodes(render()).find(node => node.type === "input" && node.props["aria-label"] === `تحديد ${id} للمقارنة`);
      expect(input).toBeDefined(); (input!.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    };
    select(61); click(`دراسات الحالة #${CASE_A}`); select(62);
    click("كافة دراسات المريض"); expectSummary(61, caseScope(), `مرتبطة بالحالة #${CASE_A}`);
    expect(nodes(render()).some(node => node.props.href === `/ceph/compare?first=61&second=62&patient=${PATIENT}`)).toBe(true);
    expect(writes()).toEqual([]);
  });
});
