import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoCaseAssessmentV2, type AssessmentLifetimeV2, type OrthoCaseAssessmentV2Props } from "../components/OrthoCaseAssessmentV2";
import OrthoSavedClinicalFindings from "../components/OrthoSavedClinicalFindings";
import type { SessionInfo } from "../components/SessionProvider";
import { makeAssessmentOwnerV2, type AssessmentOwnerV2 } from "../lib/ortho-assessment-owner-v2";
import { assessmentEditorCommandV2, readAssessmentEditorV2 } from "../lib/ortho-assessment-editor-v2";
import { createPersistedAssessmentV2, assessmentJsonHash } from "../lib/ortho-assessment-persisted-v2";
import type { MeasurementEditorDraftV2 } from "../lib/ortho-assessment-measurement-editor-v2";
// Actual component handlers, real editor validators and real mutation owner.
// Hook storage, child widgets, read transport and network are synthetic; this is not browser proof.
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
type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode, visible = false): Element[] => Array.isArray(node) ? node.flatMap(child => nodes(child, visible))
  : node && typeof node === "object" && "props" in node && !(visible && (node as Element).props.hidden)
    ? [node as Element, ...nodes((node as Element).props.children as ReactNode, visible)] : [];
const textOf = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node)
  : Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" && "props" in node ? textOf((node as Element).props.children as ReactNode) : "";
const scope = { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3 };
let owner: AssessmentOwnerV2, outerKey: string | null = null;
let section: OrthoCaseAssessmentV2Props["sectionView"];
const fetchMock = vi.fn();
const ready = { state: "ready", ...scope, clinicalWritable: true, recordingContext: "current",
  history: [], revision: null, sourceStates: [], sources: { imaging: "restricted", truncated: false, items: [] } };
const life = (): AssessmentLifetimeV2 => ({
  identity: owner, active: owner.active, editable: owner.editable, denied: owner.denied,
  busy: owner.busy, uncertain: owner.uncertain, dirty: owner.dirty, readVersion: owner.readVersion,
  values: { document: owner.document }, change: (_field, value) => owner.change(value), settle: (_field, value) => owner.settle(value),
  refresh: owner.refresh, begin: owner.begin, beginRetry: owner.beginRetry,
});
function retireView() {
  hooks.effects.forEach(effect => effect.cleanup?.());
  hooks.values.length = 0; hooks.effects.clear(); hooks.memos.clear(); hooks.pending.length = 0;
  outerKey = null;
}
function render() {
  for (let round = 0; round < 20; round++) {
    hooks.cursor = 0; hooks.changed = false;
    const wrapper = OrthoCaseAssessmentV2({ ...scope, lifetime: life(), sectionView: section });
    if (!wrapper) { retireView(); return null; }
    if (outerKey !== wrapper.key) { retireView(); outerKey = wrapper.key; }
    const tree = (wrapper.type as (input: unknown) => ReactNode)(wrapper.props);
    hooks.pending.splice(0).forEach(effect => effect());
    if (!hooks.changed) return tree;
  }
  throw Error("Assessment did not settle");
}
const button = (label: string) => {
  const found = nodes(render(), true).find(node => node.type === "button" && textOf(node) === label);
  if (!found) throw Error(`Missing button ${label}`); return found;
};
const click = (label: string) => { const found = button(label); expect(found.props.disabled).not.toBe(true); (found.props.onClick as () => void)(); render(); };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); render(); };
const saveLabel = "حفظ مراجعة تقييم جديدة";
const feedback = () => nodes(render(), true).find(node => node.props["data-testid"] === "assessment-save-feedback");
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
const reason = (value: string) => {
  const input = nodes(render()).find(node => node.type === "input" && node.props["aria-label"] === "سبب إنشاء هذه المراجعة")!;
  (input.props.onChange as (event: unknown) => void)({ target: { value } }); render();
};
const findings = (update: (draft: MeasurementEditorDraftV2) => void) => {
  const editor = nodes(render()).find(node => node.type === "findings-editor")!;
  const next = structuredClone(editor.props.draft) as MeasurementEditorDraftV2;
  update(next); (editor.props.onChange as (value: MeasurementEditorDraftV2) => void)(next); render();
};
async function startDraft() { render(); await flush(); click("بدء تقييم غير معبأ"); }
beforeEach(() => {
  retireView(); section = "interview";
  owner = makeAssessmentOwnerV2({ ...scope, authorized: () => true, deny: () => undefined }); owner.activate();
  fetchMock.mockReset(); fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST"
    ? { ok: false, status: 400, redirected: false, json: async () => ({ message: "Synthetic explicit refusal" }) }
    : { ok: true, status: 200, redirected: false, json: async () => ready });
  vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("window", { confirm: vi.fn(() => true) });
});
afterEach(() => { retireView(); owner.retire(); vi.unstubAllGlobals(); });

describe("assessment save feedback across workup sections", () => {
  it("exposes a single explicit save before the fields in every assessment view without submitting on open or navigation", async () => {
    await startDraft();
    for (const view of ["interview", "extraoral", "intraoral", "measurements", "radiographs"] as const) {
      section = view; render(); await flush();
      const tree = nodes(render(), true);
      const controls = tree.find(node => node.props["aria-label"] === "حفظ مسودة التقييم")!;
      expect(textOf(controls)).toContain("بما فيه الأقسام غير المعروضة حاليًا");
      expect(textOf(controls)).toContain("مسودة مفتوحة؛ لم تُحفظ مراجعة جديدة");
      expect(tree.filter(node => node.type === "button" && textOf(node) === saveLabel)).toHaveLength(1);
      const fields = tree.findIndex(node => node.type === "findings-editor" || node.type === "measurement-editor" || node.type === "details");
      expect(tree.indexOf(controls)).toBeLessThan(fields);
      expect(posts()).toHaveLength(0);
    }
    reason("Synthetic change");
    expect(textOf(nodes(render(), true).find(node => node.props["aria-label"] === "حفظ مسودة التقييم"))).toContain("تعديلات غير محفوظة");
  });
  it("places correction before saved details and reuses the saved complaint without another question or write", async () => {
    await startDraft(); reason("Synthetic first review");
    findings(draft => Object.assign(draft.values.clinical_chiefComplaint,{state:"recorded",text:"Exact saved complaint",dateState:"unknown",dateReason:"Synthetic unknown date",method:"direct_examination",methodDescription:"Synthetic interview"}));
    const command=assessmentEditorCommandV2(readAssessmentEditorV2(owner.document)!)!;
    const stored=createPersistedAssessmentV2(command.content);if(!stored.ok)throw Error(stored.code);
    const revision={...scope,schemaVersion:2,id:4,version:1,supersedesRevisionId:null,recordedPatientId:1,recordingContext:"current",createdBy:"Synthetic recorder",createdAt:"2026-11-01T00:00:00.000Z",reason:command.reason,content:stored.value,contentHash:assessmentJsonHash(stored.value)};
    owner.settle("");fetchMock.mockImplementation(async()=>({ok:true,status:200,redirected:false,json:async()=>({...ready,history:[revision],revision})}));
    click("تحديث سجل التقييم");await flush();
    const tree=nodes(render(),true),actionIndex=tree.findIndex(node=>node.type==='button'&&textOf(node)==='فتح مراجعة تصحيحية من النسخة الحالية');
    expect(actionIndex).toBeGreaterThan(-1);expect(actionIndex).toBeLessThan(tree.findIndex(node=>node.type===OrthoSavedClinicalFindings));
    expect(posts()).toHaveLength(0);expect(owner.document).toBe("");
    click("فتح مراجعة تصحيحية من النسخة الحالية");
    expect(readAssessmentEditorV2(owner.document)?.measurements.values.clinical_chiefComplaint.text).toBe("Exact saved complaint");
    expect(posts()).toHaveLength(0);
  });

  it("identifies only the missing reason, preserves untouched fields, and permits correction without filling them", async () => {
    await startDraft(); const before = owner.document;
    expect(feedback()).toBeUndefined(); click(saveLabel); await flush();
    expect(posts()).toHaveLength(0); expect(owner.document).toBe(before); expect(owner.uncertain).toBe(false);
    expect(textOf(feedback())).toContain("سبب إنشاء المراجعة: اكتب سبب توثيق هذه المراجعة.");
    expect(nodes(feedback()).filter(node => node.type === "li")).toHaveLength(1);
    reason("توثيق المقابلة الأولى"); expect(feedback()).toBeUndefined();
    click(saveLabel); await flush(); expect(posts()).toHaveLength(1);
    const sent = JSON.parse(posts()[0][1].body);
    expect(sent.content.observations.observations.every((row: { value: { state: string } }) => row.value.state === "not_recorded")).toBe(true);
  });

  it("keeps exact complaint errors visible outside the interview, updates after each correction and sends no invalid request", async () => {
    await startDraft(); reason("توثيق مقابلة اصطناعية");
    findings(draft => Object.assign(draft.values.clinical_chiefComplaint, { state: "recorded", text: "شكوى اصطناعية" }));
    section = "extraoral"; render(); await flush(); const before = owner.document;
    click(saveLabel); await flush();
    expect(posts()).toHaveLength(0); expect(owner.document).toBe(before);
    expect(textOf(feedback())).toContain("المقابلة والشكوى · الشكوى الرئيسية:");
    expect(textOf(feedback())).toContain("حدد تاريخ الفحص");
    expect(textOf(feedback())).not.toContain("clinical_chiefComplaint");
    section = "interview"; render(); await flush();
    findings(draft => Object.assign(draft.values.clinical_chiefComplaint, { dateState: "known", date: "2026-11-01" }));
    expect(textOf(feedback())).toContain("حدد طريقة التوثيق");
    expect(textOf(feedback())).not.toContain("حدد تاريخ الفحص");
    findings(draft => Object.assign(draft.values.clinical_chiefComplaint, { method: "direct_examination", methodDescription: "مقابلة اصطناعية موثقة" }));
    expect(feedback()).toBeUndefined(); expect(posts()).toHaveLength(0);
    click(saveLabel); await flush(); expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0][1].body).content.observations.observations.find((row: { id: string }) => row.id === "clinical_chiefComplaint").value.text).toBe("شكوى اصطناعية");
  });

  it.each([
    ["", "أدخل قيمة القياس؛ الفراغ ليس صفراً."],
    ["7.", "أكمل كتابة الرقم قبل الحفظ؛ القيمة المدخلة ما زالت غير مكتملة."],
  ])("shows a hidden measurement's readable label for incomplete input %s without rewriting it", async (numberText, hint) => {
    await startDraft(); reason("توثيق قياسات اصطناعية");
    findings(draft => { draft.values.width_11.state = "measured"; draft.values.width_11.numberText = numberText; });
    click(saveLabel); await flush();
    expect(posts()).toHaveLength(0); expect(textOf(feedback())).toContain("القياسات والسجلات");
    expect(textOf(feedback())).toContain(hint);
    expect(textOf(feedback())).not.toContain("width_11");
    expect(readAssessmentEditorV2(owner.document)?.measurements.values.width_11.numberText).toBe(numberText);
  });

  it("explains an aggregate source conflict and preserves both recorded values until the doctor corrects it", async () => {
    await startDraft(); reason("توثيق قياسات اصطناعية");
    findings(draft => {
      for (const [index, id] of ["width_11", "width_12"].entries()) Object.assign(draft.values[id], {
        state: "measured", numberText: "7", dateState: "known", date: "2026-11-01",
        method: "manual_record_measurement", methodDescription: "قياس اصطناعي موثق",
        sources: [{ kind: "document", id: 10, version: `revision-${index + 1}` }],
      });
    });
    const before = owner.document; click(saveLabel); await flush();
    expect(posts()).toHaveLength(0); expect(owner.document).toBe(before);
    expect(textOf(feedback())).toContain("إصدارين مختلفين للمصدر نفسه");
    findings(draft => { draft.values.width_12.sources[0].version = "revision-1"; });
    expect(feedback()).toBeUndefined(); click(saveLabel); await flush();
    expect(posts()).toHaveLength(1);
    const sent = JSON.parse(posts()[0][1].body);
    expect(sent.content.observations.observations.filter((row: { id: string }) => ["width_11", "width_12"].includes(row.id))
      .every((row: { value: { value: number } }) => row.value.value === 7)).toBe(true);
  });

  it("explains the aggregate reference limit without discarding links or measurements", async () => {
    await startDraft(); reason("توثيق قياسات اصطناعية");
    findings(draft => {
      for (const [index, id] of ["width_11", "width_12", "width_13"].entries()) Object.assign(draft.values[id], {
        state: "measured", numberText: "7", dateState: "known", date: "2026-11-01",
        method: "manual_record_measurement", methodDescription: "قياس اصطناعي موثق",
        sources: Array.from({ length: 11 }, (_, offset) => ({ kind: "assessment_revision", id: index * 11 + offset + 1, version: `sha256:${"a".repeat(64)}` })),
      });
    });
    const before = owner.document; click(saveLabel); await flush();
    expect(posts()).toHaveLength(0); expect(owner.document).toBe(before);
    expect(textOf(feedback())).toContain("عدد مراجع المصادر في المسودة يتجاوز الحد المسموح");
    findings(draft => { draft.values.width_13.sources.pop(); });
    expect(feedback()).toBeUndefined(); click(saveLabel); await flush();
    expect(posts()).toHaveLength(1);
  });

  it("retains the existing synchronous double-submit guard and exact lost-response retry after feedback correction", async () => {
    await startDraft(); click(saveLabel); await flush(); reason("توثيق مقابلة اصطناعية");
    let reject!: (error: Error) => void;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => init?.method === "POST"
      ? new Promise((_resolve, rejectPromise) => { reject = rejectPromise; })
      : Promise.resolve({ ok: true, status: 200, redirected: false, json: async () => ready }));
    const save = button(saveLabel).props.onClick as () => void;
    save(); save(); expect(posts()).toHaveLength(1); expect(owner.busy).toBe(true);
    const document = owner.document, body = posts()[0][1].body;
    reject(Error("Synthetic lost response")); await flush();
    expect(owner.uncertain).toBe(true); expect(owner.document).toBe(document); expect(feedback()).toBeUndefined();
    reason("must not replace uncertain draft"); expect(owner.document).toBe(document);
    const command = JSON.parse(body), persisted = createPersistedAssessmentV2(command.content);
    if (!persisted.ok) throw Error(persisted.code);
    const revision = { ...scope, schemaVersion: 2, id: 4, version: 1, supersedesRevisionId: null, recordedPatientId: 1,
      recordingContext: "current", createdBy: "Synthetic recorder", createdAt: "2026-11-01T00:00:00.000Z", reason: command.reason,
      content: persisted.value, contentHash: assessmentJsonHash(persisted.value) };
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? { ok: true, status: 200, redirected: false, json: async () => ({ ok: true, revision, replayed: true }) }
      : { ok: true, status: 200, redirected: false, json: async () => ready });
    click("التحقق بإعادة نفس طلب الحفظ"); await flush(); await flush();
    expect(posts()).toHaveLength(2); expect(posts()[1][1].body).toBe(body);
    expect(owner.uncertain).toBe(false); expect(owner.document).toBe("");
  });
});
