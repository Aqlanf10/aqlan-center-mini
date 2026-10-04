import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientEndo } from "../components/PatientEndo";
import { checkEndoVisitDraft, summarizeEndo } from "../lib/endodontics";
import type { EndoTreatmentView } from "../lib/endodontics-db";
import type { SessionInfo } from "../components/SessionProvider";
// Isolated actual-handler audit: synthetic records, controlled fetch, no browser/database.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  pending: [] as Array<() => void>,
  session: null as SessionInfo | null,
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
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
    useMemo: (factory: () => unknown, deps?: readonly unknown[]) => {
      const index = slot(undefined); const previous = hooks.memos.get(index);
      if (previous && same(previous.deps, deps)) return previous.value;
      const value = factory(); hooks.memos.set(index, { deps, value }); return value;
    },
    useCallback: (callback: unknown, deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.memos.get(index);
      if (previous && same(previous.deps, deps)) return previous.value;
      hooks.memos.set(index, { deps, value: callback });
      return callback;
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  if (typeof element.type === "function") return elements((element.type as (props: Record<string, unknown>) => ReactNode)(element.props));
  return [element, ...elements(element.props.children as ReactNode)];
}
function contents(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(contents).join("");
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return contents((node as Element).props.children as ReactNode);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
type Response = ReturnType<typeof response>;
const fetchMock = vi.fn();
const confirm = vi.fn(() => false);
let props: Parameters<typeof PatientEndo>[0];
let treatments: EndoTreatmentView[];
let cases: Record<string, unknown>[];
let items: Record<string, unknown>[];
let nextWrite: ReturnType<typeof deferred<Response>> | null;
let endoWriteFailure: boolean;
let casesFailure: boolean;
const treatment = (id = 1, toothCode = 36): EndoTreatmentView => ({
  id, patientId: 91, toothCode, caseId: 5, caseTitle: "Synthetic case", toothName: "سن تجريبي", kind: "initial", status: "in_progress",
  completedAt: null, outcome: null, restorativeStatus: "none", crownRequired: true, crownPlanItem: null,
  version: 1, createdBy: "synthetic", createdAt: "2026-10-01T10:00:00Z", visits: [], summary: summarizeEndo([], new Map()),
  crown: "waiting_rct", nextAction: "ابدأ بالتقييم",
});
let workspaceKey: string | null = null;
function render() {
  let tree: ReactNode = null; let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("UI did not settle");
    hooks.cursor = 0; hooks.changed = false;
    const wrapper = PatientEndo(props);
    if (workspaceKey !== wrapper.key) {
      hooks.effects.forEach((effect) => effect.cleanup?.());
      hooks.values = []; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = []; hooks.cursor = 0;
      workspaceKey = wrapper.key;
    }
    tree = (wrapper.type as (p: typeof props) => ReactNode)(wrapper.props);
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return { tree, nodes: elements(tree) };
}
function control(id: string) { const found = render().nodes.find((node) => node.props["data-testid"] === id); if (!found) throw new Error(`Missing ${id}`); return found; }
function click(id: string) { return (control(id).props.onClick as () => Promise<void>)(); }
function change(id: string, value: string) { (control(id).props.onChange as (event: unknown) => void)({ target: { value } }); }
function cancel() { const button = render().nodes.find((node) => node.type === "button" && contents(node.props.children as ReactNode) === "إلغاء")!; (button.props.onClick as () => void)(); }
const writes = () => fetchMock.mock.calls.filter(([, opts]) => opts?.method);
beforeEach(async () => {
  workspaceKey = null;
  hooks.session = { username: "synthetic-a", role: "doctor", permissions: null };
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  vi.clearAllMocks(); confirm.mockReturnValue(false);
  props = { patientId: 91, canWrite: true, canEditPlans: true, openVisitId: 21 };
  treatments = [treatment(), treatment(2, 46)]; cases = []; items = []; nextWrite = null; endoWriteFailure = false; casesFailure = false;
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm });
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    if (opts?.method) {
      if (nextWrite) return nextWrite.promise;
      if (url.endsWith("/cases")) return response(201, { id: 5, title: "Synthetic case", specialty: "endodontics", status: "active" });
      if (endoWriteFailure) return response(503, { message: "فشل تجريبي" });
      return response(200, treatment());
    }
    if (url.endsWith("/cases")) return casesFailure ? response(503, { message: "تعذّر تحميل الحالات" }) : response(200, { cases, items, planVisible: true });
    return response(200, { treatments });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(); await vi.waitFor(() => expect(control("patient-endo")).toBeTruthy());
});
afterEach(() => { hooks.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe("endodontic cockpit integrity", () => {
  it("registers a navigation guard that blocks active saves without prompting or losing the draft", async () => {
    let guard: (() => boolean) | null = null;
    props.onNavigationGuardChange = (next) => { guard = next; };
    render(); expect(guard).toBeTypeOf("function"); expect(guard!()).toBe(true);
    await click("endo-record"); change("endo-note", "Guarded note"); render();
    expect(guard!()).toBe(false); expect(confirm).toHaveBeenCalledTimes(1);
    nextWrite = deferred<Response>(); const saving = click("endo-save"); render();
    confirm.mockClear(); confirm.mockReturnValue(true);
    expect(guard!()).toBe(false); expect(confirm).not.toHaveBeenCalled();
    nextWrite.resolve(response(409, { message: "نسخة قديمة" })); await saving; render();
    expect(control("endo-note").props.value).toBe("Guarded note"); expect(guard!()).toBe(true);
    hooks.effects.forEach((effect) => effect.cleanup?.()); expect(guard).toBeNull();
  });
  it("keeps a new assessment to six primary clinical controls, with extra detail available", async () => {
    await click("endo-record");
    const primary = [...elements(control("endo-primary-fields")), ...elements(control("endo-note-fields"))]
      .filter((node) => ["input", "textarea", "select"].includes(String(node.type)));
    expect(primary).toHaveLength(6);
    expect(control("endo-canal-editor").props.open).toBe(false);
    expect(control("endo-assessment-more").props.open).toBeUndefined();
    expect(control("endo-session-more").props.open).toBeUndefined();
    expect(control("endo-history").props.open).toBe(false);
    expect(control("endo-completion").props.open).toBe(false);
  });
  it("changes the essential fields without erasing measurements, note or advanced findings", async () => {
    await click("endo-record"); change("endo-radiographicFindings", "Keep this radiograph finding");
    change("endo-canal-wl-0", "20.5"); change("endo-canal-ref-0", "cusp_tip"); change("endo-canal-method-0", "both");
    change("endo-note", "Keep today's narrative"); change("endo-stage", "medicament");
    const primary = elements(control("endo-primary-fields")).filter((node) => ["input", "textarea", "select"].includes(String(node.type)));
    expect(primary).toHaveLength(3); expect(control("endo-canal-editor").props.open).toBe(false);
    change("endo-medicament", "Explicit medication"); await click("endo-save");
    expect(JSON.parse(String(writes()[0][1].body))).toMatchObject({ stage: "medicament", note: "Keep today's narrative",
      radiographicFindings: "Keep this radiograph finding", medicament: "Explicit medication",
      canals: [{ label: "MB", workingLengthMm: 20.5, referencePoint: "cusp_tip", measurementMethod: "both" }, {}, {}] });
  });
  it("does not turn a denied plan projection into a missing-plan prompt or navigation", async () => {
    props.onOpenPlans = vi.fn(); const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => !opts?.method && url.endsWith("/cases")
      ? response(200, { cases: [], items: [], planVisible: false }) : normal(url, opts));
    hooks.effects.clear(); render();
    await vi.waitFor(() => expect(render().nodes.some((node) => node.props["data-testid"] === "endo-plan-context")).toBe(false));
    expect(render().nodes.some((node) => node.props["data-testid"] === "endo-open-plans")).toBe(false);
  });
  it("preserves every saved clinical and canal field when editing only the next step", async () => {
    const checked = checkEndoVisitDraft({
      stage: "obturation", chiefComplaint: "Recorded complaint", symptoms: "Recorded symptom",
      pulpalDiagnosis: "pulp_necrosis", apicalDiagnosis: "chronic_apical_abscess",
      vitalityCold: "negative", vitalityHeat: "not_done", vitalityEpt: "positive", percussion: "tender", palpation: "normal",
      mobilityGrade: 0, perioFindings: "Recorded perio", previousTreatment: "Recorded previous treatment",
      radiographicFindings: "Recorded radiographic finding", canalsFound: 1, instrumentation: "Recorded instrument",
      irrigation: "Recorded irrigation", medicament: "Recorded medication", obturationTechnique: "Recorded technique",
      obturationMaterial: "Recorded material", restorationAfter: "temporary", complications: "Recorded complication",
      prognosis: "questionable", nextStep: "Original next step", nextVisitWeeks: 0, note: "Recorded note",
      canals: [{ label: "MB", workingLengthMm: 20.5, referencePoint: "cusp_tip", measurementMethod: "both",
        masterApicalSize: 25, taperPercent: 4, instrumentation: "Recorded canal instrument", obturated: true, note: "Recorded canal note" }],
    });
    if (!checked.ok) throw new Error(checked.message);
    const visit = { ...checked.value, id: 55, treatmentId: 1, visitId: 21, doctorId: 7, doctorName: "Synthetic doctor",
      recordedAt: "2026-10-01T10:00:00Z", signed: false, version: 4, recordedBy: "synthetic", updatedAt: null, addenda: [] };
    treatments = [{ ...treatment(), visits: [visit], summary: summarizeEndo([visit], new Map([[visit.id, visit.canals]])) }];
    hooks.effects.clear(); render(); await vi.waitFor(() => expect(contents(control("endo-record").props.children as ReactNode)).toContain("تعديل"));
    await click("endo-record"); change("endo-next-step", "Updated next step"); await click("endo-save");
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0][1].body))).toEqual({ ...checked.value, nextStep: "Updated next step", visitId: 21, expectedVersion: 4 });
  });
  it("uses prior canal labels as hints without carrying forward measured values or clinical findings", async () => {
    const checked = checkEndoVisitDraft({ stage: "obturation", pulpalDiagnosis: "pulp_necrosis", vitalityCold: "negative",
      restorationAfter: "permanent", canals: [{ label: "MB", workingLengthMm: 20.5, referencePoint: "cusp_tip",
        measurementMethod: "both", masterApicalSize: 25, taperPercent: 4, obturated: true, note: "Prior note" }] });
    if (!checked.ok) throw new Error(checked.message);
    const visit = { ...checked.value, id: 55, treatmentId: 1, visitId: 20, doctorId: 7, doctorName: "Synthetic doctor",
      recordedAt: "2026-10-01T10:00:00Z", signed: true, version: 1, recordedBy: "synthetic", updatedAt: null, addenda: [] };
    treatments = [{ ...treatment(), visits: [visit], summary: summarizeEndo([visit], new Map([[visit.id, visit.canals]])) }];
    hooks.effects.clear(); render(); await vi.waitFor(() => expect(contents(control("endo-strip-wl").props.children as ReactNode)).toContain("20.5"));
    await click("endo-record"); await click("endo-save");
    const payload = JSON.parse(String(writes()[0][1].body));
    expect(payload.pulpalDiagnosis).toBeNull(); expect(payload.vitalityCold).toBeNull(); expect(payload.restorationAfter).toBeNull();
    expect(payload.canals).toEqual([{ label: "MB", workingLengthMm: null, referencePoint: null, measurementMethod: null,
      masterApicalSize: null, taperPercent: null, instrumentation: null, obturated: false, note: null }]);
  });
  it("selecting an obturation stage never records obturation or creates a financial mutation", async () => {
    await click("endo-record");
    change("endo-stage", "obturation");
    expect(writes()).toHaveLength(0); await click("endo-save");
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe("/api/patients/91/endo/1/visits");
    const payload = JSON.parse(String(writes()[0][1].body));
    expect(payload.stage).toBe("obturation"); expect(payload.obturationTechnique).toBeNull(); expect(payload.obturationMaterial).toBeNull();
    expect(payload.canals.every((canal: { obturated: boolean }) => canal.obturated === false)).toBe(true);
  });
  it("locks synchronously before case creation and ignores repeated invocation", async () => {
    await click("endo-new"); change("endo-tooth", "26");
    nextWrite = deferred<Response>();
    const handler = control("endo-open-save").props.onClick as () => Promise<void>;
    const first = handler(); const repeated = handler();
    expect(writes()).toHaveLength(1); expect(control("patient-endo").props.disabled).toBe(true);
    nextWrite.resolve(response(201, { id: 5, specialty: "endodontics", status: "active", title: "Created" }));
    nextWrite = null; await Promise.all([first, repeated]);
    expect(writes().filter(([url]) => url.endsWith("/cases"))).toHaveLength(1);
  });
  it("retains the new case when opening the episode fails, so retry does not create an orphan", async () => {
    await click("endo-new"); change("endo-tooth", "26"); endoWriteFailure = true;
    await click("endo-open-save"); expect(control("endo-case").props.value).toBe("5");
    endoWriteFailure = false; await click("endo-open-save");
    expect(writes().filter(([url]) => url.endsWith("/cases"))).toHaveLength(1);
  });
  it("recovers a committed case whose response was lost without creating another case", async () => {
    const normal = fetchMock.getMockImplementation()!; let dropCase = true;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.endsWith("/cases") && opts?.method === "POST" && dropCase) {
        dropCase = false; cases = [{ id: 5, title: "Committed case", specialty: "endodontics", status: "active" }];
        throw new TypeError("Connection lost after commit");
      }
      return normal(url, opts);
    });
    await click("endo-new"); change("endo-tooth", "26"); await click("endo-open-save");
    expect(control("endo-open-save").props.disabled).toBe(true); await click("endo-open-save");
    expect(writes().filter(([url]) => url.endsWith("/cases"))).toHaveLength(1);
    const reload = render().nodes.find((node) => node.type === "button" && contents(node.props.children as ReactNode) === "إعادة التحميل")!;
    (reload.props.onClick as () => void)();
    await vi.waitFor(() => expect(contents(control("endo-case").props.children as ReactNode)).toContain("Committed case"));
    change("endo-case", "5"); await click("endo-open-save");
    expect(writes().filter(([url]) => url.endsWith("/cases"))).toHaveLength(1); expect(cases).toHaveLength(1);
    expect(JSON.parse(String(writes().at(-1)![1].body)).caseId).toBe(5);
  });
  it("allows a new-case retry after a definite rejected request", async () => {
    const normal = fetchMock.getMockImplementation()!; let reject = true;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.endsWith("/cases") && opts?.method === "POST" && reject) { reject = false; return response(400, { message: "حالة غير صالحة" }); }
      return normal(url, opts);
    });
    await click("endo-new"); change("endo-tooth", "26"); await click("endo-open-save");
    expect(control("endo-open-save").props.disabled).toBe(false); await click("endo-open-save");
    expect(writes().filter(([url]) => url.endsWith("/cases"))).toHaveLength(2);
  });
  it("contains save editing and cancellation until completion, then retains failed drafts", async () => {
    await click("endo-record"); change("endo-next-step", "Synthetic unsaved finding");
    nextWrite = deferred<Response>(); const saving = click("endo-save");
    expect(control("patient-endo").props.disabled).toBe(true); cancel(); expect(control("endo-form")).toBeTruthy();
    nextWrite.resolve(response(409, { message: "نسخة قديمة" })); await saving;
    expect(control("endo-next-step").props.value).toBe("Synthetic unsaved finding");
    expect(control("patient-endo").props.disabled).toBe(false);
  });
  it("does not silently turn invalid numeric input into a saved null", async () => {
    await click("endo-record"); change("endo-canal-wl-0", "not-a-number");
    await click("endo-save");
    expect(writes()).toHaveLength(0); expect(control("endo-canal-wl-0").props.value).toBe("not-a-number");
    expect(contents(control("endo-error").props.children as ReactNode)).toContain("أدخل رقمًا صالحًا");
  });
  it.each([["endo-canal-wl-3", "21"], ["endo-canal-wl-3", "malformed"], ["endo-canal-note-3", "Keep this finding"]])(
    "retains a populated unlabeled canal instead of silently dropping %s", async (fieldId, value) => {
      await click("endo-record");
      const add = render().nodes.find((node) => node.type === "button" && contents(node.props.children as ReactNode) === "+ قناة")!;
      (add.props.onClick as () => void)(); change(fieldId, value); await click("endo-save");
      expect(writes()).toHaveLength(0); expect(control(fieldId).props.value).toBe(value);
      expect(contents(control("endo-error").props.children as ReactNode)).toContain("اكتب اسم القناة");
    });
  it("requires discarding a competing new-tooth draft before starting an existing episode record", async () => {
    await click("endo-new"); change("endo-tooth", "26"); await click("endo-record");
    expect(render().nodes.some((node) => node.props["data-testid"] === "endo-form")).toBe(false);
    expect(control("endo-tooth").props.value).toBe("26");
    confirm.mockReturnValue(true); await click("endo-record"); change("endo-next-step", "Protected existing episode draft");
    expect(render().nodes.some((node) => node.props["data-testid"] === "endo-open-save")).toBe(false);
    await click("endo-save"); expect(writes().at(-1)![0]).toBe("/api/patients/91/endo/1/visits");
  });
  it.each([401, 403])("hides the loaded clinical context after a mutation loses authority (%s)", async (status) => {
    await click("endo-record"); const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => opts?.method ? response(status, { message: "غير مسموح" }) : normal(url, opts));
    await click("endo-save");
    expect(render().nodes.some((node) => node.props["data-testid"] === "patient-endo")).toBe(false);
    expect(contents(render().tree)).toContain("غير مسموح");
  });
  it("requires confirmation before discarding a draft on tooth switch or cancel", async () => {
    await click("endo-record"); change("endo-next-step", "Synthetic protected finding");
    await click("endo-tooth-46"); expect(control("endo-next-step").props.value).toBe("Synthetic protected finding");
    cancel(); expect(control("endo-form")).toBeTruthy();
    confirm.mockReturnValue(true); cancel(); expect(render().nodes.some((node) => node.props["data-testid"] === "endo-form")).toBe(false);
  });
  it("never submits an old draft into a replacement open visit", async () => {
    await click("endo-record"); change("endo-next-step", "For visit21 only"); props.openVisitId = 22;
    expect(control("endo-save").props.disabled).toBe(true); await click("endo-save");
    expect(writes()).toHaveLength(0); expect(control("endo-next-step").props.value).toBe("For visit21 only");
  });
  it("pins a draft to its episode when a newer episode arrives during reload", async () => {
    await click("endo-record"); change("endo-next-step", "Tooth36 episode1 only");
    treatments = [treatment(2, 46), treatment(1, 36)]; hooks.effects.clear(); render();
    await vi.waitFor(() => expect(control("endo-next-step").props.value).toBe("Tooth36 episode1 only"));
    await Promise.resolve(); await click("endo-save");
    expect(writes().at(-1)![0]).toBe("/api/patients/91/endo/1/visits");
    expect(JSON.parse(String(writes().at(-1)![1].body)).visitId).toBe(21);
  });
  it("retains an unavailable episode draft until explicit recovery or discard, without fallback", async () => {
    await click("endo-record"); change("endo-next-step", "Unavailable episode draft");
    treatments = [treatment(2, 46)]; hooks.effects.clear(); render();
    await vi.waitFor(() => expect(control("endo-draft-unavailable")).toBeTruthy());
    expect(render().nodes.some((node) => node.props["data-testid"] === "endo-save")).toBe(false);
    expect(control("endo-retained-draft").props.readOnly).toBe(true);
    expect(control("endo-retained-draft").props.value).toContain("Unavailable episode draft");
    await click("endo-tooth-46"); expect(control("endo-draft-unavailable")).toBeTruthy(); expect(writes()).toHaveLength(0);
    treatments = [treatment(2, 46), treatment(1, 36)]; hooks.effects.clear(); render();
    await vi.waitFor(() => expect(control("endo-next-step").props.value).toBe("Unavailable episode draft"));
    await click("endo-save"); expect(writes().at(-1)![0]).toBe("/api/patients/91/endo/1/visits");
  });
  it("pins a pending completion to its episode and never closes a fallback", async () => {
    await click("endo-complete");
    treatments = [treatment(2, 46)]; hooks.effects.clear(); render();
    await vi.waitFor(() => expect(control("endo-draft-unavailable")).toBeTruthy());
    expect(render().nodes.some((node) => node.props["data-testid"] === "endo-close-confirm")).toBe(false);
    expect(writes()).toHaveLength(0);
  });
  it("requires explicit same-tooth crown and same-case RCT selections", async () => {
    items = [
      { id: 1, category: "rct", toothCode: 36, caseId: 5, status: "pending", serviceName: "RCT" },
      { id: 2, category: "crown", toothCode: 36, caseId: 9, status: "pending", serviceName: "Crown" },
      { id: 3, category: "rct", toothCode: 36, caseId: 6, status: "pending", serviceName: "Old RCT" },
      { id: 4, category: "crown", toothCode: 46, caseId: 5, status: "pending", serviceName: "Other tooth" },
    ];
    // Re-run the initial load effect in the isolated harness.
    hooks.effects.clear(); render(); await vi.waitFor(() => expect(contents(control("endo-crown-item").props.children as ReactNode)).toContain("Crown"));
    expect(contents(control("endo-crown-item").props.children as ReactNode)).not.toContain("RCT");
    expect(contents(control("endo-rct-item").props.children as ReactNode)).not.toContain("Old");
    change("endo-crown-item", "2"); expect(writes()).toHaveLength(0); expect(control("endo-crown-link").props.disabled).toBe(true);
    change("endo-rct-item", "1"); await click("endo-crown-link");
    expect(JSON.parse(String(writes()[0][1].body))).toMatchObject({ crownPlanItemId: 2, rctPlanItemId: 1 });
  });
  it("keeps an addendum request key and submitted body across an uncertain retry", async () => {
    const checked = checkEndoVisitDraft({ symptoms: "Synthetic archived symptom", note: "Synthetic archived note" });
    if (!checked.ok) throw new Error(checked.message);
    treatments = [{ ...treatment(), visits: [{ ...checked.value, id: 55, treatmentId: 1, visitId: 20,
      doctorId: 7, doctorName: "Synthetic doctor", recordedAt: "2026-10-01T10:00:00Z", signed: true,
      version: 1, recordedBy: "synthetic", updatedAt: null, addenda: [] }] }];
    hooks.effects.clear(); render(); await vi.waitFor(() => expect(control("endo-addendum-open-55")).toBeTruthy());
    expect(contents(render().tree)).toContain("Synthetic archived symptom");
    expect(contents(render().tree)).toContain("Synthetic archived note");
    await click("endo-addendum-open-55"); change("endo-addendum-text", "Synthetic correction");
    endoWriteFailure = true; await click("endo-addendum-save");
    expect(control("endo-addendum-text").props.disabled).toBe(true);
    endoWriteFailure = false; await click("endo-addendum-save");
    const bodies = writes().map(([, opts]) => JSON.parse(String(opts.body)));
    expect(bodies).toHaveLength(2); expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0].requestKey).toMatch(/^endo-addendum:/);
  });
  it("keeps a draft inert during a slower read and ignores its response after a newer authorized read", async () => {
    await click("endo-record"); change("endo-note", "Captured draft");
    const staleSave = control("endo-save").props.onClick as () => Promise<void>;
    const pendingLoad = deferred<Response>();
    const normalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => !opts?.method && url.endsWith("/endo") ? pendingLoad.promise : normalFetch(url, opts));
    hooks.effects.clear(); render();
    expect(control("endo-read-retained-draft")).toBeTruthy(); await staleSave(); expect(writes()).toHaveLength(0);
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => !opts?.method && url.endsWith("/endo")
      ? response(200, { treatments: [{ ...treatment(), nextAction: "Fresh server result" }] }) : normalFetch(url, opts));
    await click("endo-reload");
    pendingLoad.resolve(response(200, { treatments: [treatment()] }));
    await Promise.resolve(); await Promise.resolve();
    expect(contents(control("endo-next").props.children as ReactNode)).toContain("Fresh server result");
    expect(control("endo-note").props.value).toBe("Captured draft"); expect(writes()).toHaveLength(0);
  });
  it("uses a distinct React identity for patient and permission changes", () => {
    const initial = PatientEndo(props).key;
    expect(PatientEndo({ ...props, authorityKey: "different-doctor" }).key).not.toBe(initial);
    expect(PatientEndo({ ...props, patientId: 92 }).key).not.toBe(initial);
    expect(PatientEndo({ ...props, canWrite: false }).key).not.toBe(initial);
    expect(PatientEndo({ ...props, canEditPlans: false }).key).not.toBe(initial);
  });
  it("does not present a failed case load as permission to create a new case", async () => {
    casesFailure = true; hooks.effects.clear(); render();
    await vi.waitFor(() => expect(contents(render().tree)).toContain("تعذّر تحميل الحالات"));
    expect(render().nodes.some((node) => node.props["data-testid"] === "endo-new")).toBe(false);
  });
  it.each([401, 403, 503])("retires clinical evidence at HTTP %i headers before optional headers or any denied body", async status => {
    await click("endo-record"); change("endo-note", "Same-owner retained note");
    const oldSave = control("endo-save").props.onClick as () => Promise<void>;
    const optional = deferred<Response>(); const body = deferred<unknown>(); const json = vi.fn(() => body.promise);
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => opts?.method ? normal(url, opts)
      : url.endsWith("/cases") ? optional.promise : { ...response(status, null), json });
    hooks.effects.clear(); render();
    await vi.waitFor(() => expect(contents(render().tree)).toContain(status === 503 ? "تعذّر تحميل علاج الجذور" : "غير مصرّح"));
    expect(json).not.toHaveBeenCalled(); expect(control("endo-read-retained-draft")).toBeTruthy();
    for (const id of ["endo-strip", "endo-history", "endo-form", "endo-work-links", "endo-crown-link", "endo-new"]) {
      expect(render().nodes.some(node => node.props["data-testid"] === id)).toBe(false);
    }
    await oldSave(); expect(writes()).toHaveLength(0);
    optional.resolve(response(200, { cases, items, planVisible: true }));
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(control("endo-read-unavailable")).toBeTruthy(); await oldSave(); expect(writes()).toHaveLength(0);
    fetchMock.mockImplementation(normal); await click("endo-reload");
    await vi.waitFor(() => expect(control("endo-note")).toBeTruthy());
    expect(control("endo-note").props.value).toBe("Same-owner retained note");
    await click("endo-save"); expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0][1].body))).toMatchObject({ visitId: 21, note: "Same-owner retained note" });
  });
  it("withdraws pending case/plan evidence while a valid clinical read restores the draft", async () => {
    props.onOpenPlans = vi.fn(); await click("endo-record"); change("endo-radiographicFindings", "Own recorded findings");
    const optionalBody = deferred<unknown>(); const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => !opts?.method && url.endsWith("/cases")
      ? { ...response(200, null), json: () => optionalBody.promise } : normal(url, opts));
    hooks.effects.clear(); render();
    await vi.waitFor(() => expect(control("endo-note")).toBeTruthy());
    expect(control("endo-radiographicFindings").props.value).toBe("Own recorded findings");
    expect(contents(control("endo-case-unavailable").props.children as ReactNode)).toContain("جارٍ التحقق");
    expect(contents(render().tree)).not.toContain("لا يوجد بند جذور");
    for (const id of ["endo-open-plans", "endo-new", "endo-crown-item"]) expect(render().nodes.some(node => node.props["data-testid"] === id)).toBe(false);
    optionalBody.resolve({ cases, items, planVisible: true });
    await vi.waitFor(() => expect(control("endo-open-plans")).toBeTruthy()); expect(writes()).toHaveLength(0);
  });
  it.each(["network", "json", "shape", "foreign-patient"])("retires clinical references on %s failure and preserves a same-owner draft", async failure => {
    await click("endo-record"); change("endo-note", "Draft through failure");
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => !opts?.method && url.endsWith("/endo")
      ? failure === "network" ? Promise.reject(new TypeError("Network failure"))
        : failure === "json" ? { ...response(200, null), json: () => Promise.reject(new SyntaxError("Invalid JSON")) }
          : response(200, failure === "shape" ? {} : { treatments: [{ ...treatment(), patientId: 999 }] }) : normal(url, opts));
    hooks.effects.clear(); render();
    await vi.waitFor(() => expect(contents(render().tree)).toContain("تعذّر"));
    expect(control("endo-read-retained-draft")).toBeTruthy();
    expect(render().nodes.some(node => node.props["data-testid"] === "endo-strip")).toBe(false);
    fetchMock.mockImplementation(normal); await click("endo-reload");
    await vi.waitFor(() => expect(control("endo-note")).toBeTruthy());
    expect(control("endo-note").props.value).toBe("Draft through failure"); expect(writes()).toHaveLength(0);
  });
  it.each(["network", "json", "shape", "unavailable"])("keeps clinical documentation available but withdraws %s case evidence", async failure => {
    props.onOpenPlans = vi.fn(); const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => !opts?.method && url.endsWith("/cases")
      ? failure === "network" ? Promise.reject(new TypeError("Network failure"))
        : failure === "json" ? { ...response(200, null), json: () => Promise.reject(new SyntaxError("Invalid JSON")) }
          : response(failure === "unavailable" ? 503 : 200, failure === "shape" ? { cases: [] } : {}) : normal(url, opts));
    hooks.effects.clear(); render(); await vi.waitFor(() => expect(control("endo-case-unavailable").props.role).toBe("alert"));
    expect(control("endo-strip")).toBeTruthy(); expect(control("endo-record")).toBeTruthy();
    expect(contents(render().tree)).not.toContain("لا يوجد بند جذور");
    for (const id of ["endo-open-plans", "endo-new", "endo-crown-item"]) expect(render().nodes.some(node => node.props["data-testid"] === id)).toBe(false);
    expect(writes()).toHaveLength(0);
    await click("endo-record"); change("endo-note", "Clinical note despite optional failure"); await click("endo-save");
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0][1].body))).toMatchObject({ visitId: 21, note: "Clinical note despite optional failure" });
  });
  it.each([401, 403, 404])("latches case HTTP %i denial at headers against pending clinical headers or body", async status => {
    await click("endo-record"); change("endo-note", "Draft after patient denial");
    const oldSave = control("endo-save").props.onClick as () => Promise<void>;
    const normal = fetchMock.getMockImplementation()!;
    for (const peerPhase of ["headers", "body"]) {
      const peer = deferred<unknown>(); const deniedBody = deferred<unknown>();
      const json = vi.fn(() => deniedBody.promise);
      fetchMock.mockImplementation((url: string, opts?: RequestInit) => opts?.method ? normal(url, opts)
        : url.endsWith("/cases") ? { ...response(status, null), json }
          : peerPhase === "headers" ? peer.promise : { ...response(200, null), json: () => peer.promise });
      hooks.effects.clear(); render();
      await vi.waitFor(() => expect(contents(render().tree)).toContain("غير مصرّح"));
      expect(json).not.toHaveBeenCalled(); expect(control("endo-read-retained-draft")).toBeTruthy();
      for (const id of ["endo-strip", "endo-history", "endo-form", "endo-work-links", "endo-crown-link", "endo-new"]) {
        expect(render().nodes.some(node => node.props["data-testid"] === id)).toBe(false);
      }
      await oldSave(); expect(writes()).toHaveLength(0);
      const signal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
      expect(signal.aborted).toBe(true);
      peer.resolve(peerPhase === "headers" ? response(200, { treatments: [treatment()] }) : { treatments: [treatment()] });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(control("endo-read-unavailable")).toBeTruthy();
      await oldSave(); expect(writes()).toHaveLength(0);
      fetchMock.mockImplementation(normal); await click("endo-reload");
      await vi.waitFor(() => expect(control("endo-note")).toBeTruthy());
      expect(control("endo-note").props.value).toBe("Draft after patient denial");
    }
    await click("endo-save"); expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0][1].body))).toMatchObject({ visitId: 21, note: "Draft after patient denial" });
  });
  it("withdraws an already restored clinical draft as soon as deferred case denial headers arrive", async () => {
    await click("endo-record"); change("endo-note", "Opaque again after late case denial");
    const oldSave = control("endo-save").props.onClick as () => Promise<void>;
    const optional = deferred<Response>(); const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => !opts?.method && url.endsWith("/cases") ? optional.promise : normal(url, opts));
    hooks.effects.clear(); render(); await vi.waitFor(() => expect(control("endo-note")).toBeTruthy());
    const json = vi.fn(() => new Promise(() => {})); optional.resolve({ ...response(403, null), json });
    await vi.waitFor(() => expect(control("endo-read-unavailable")).toBeTruthy());
    expect(json).not.toHaveBeenCalled(); expect(contents(render().tree)).not.toContain("Opaque again after late case denial");
    await oldSave(); expect(writes()).toHaveLength(0);
  });
  it.each(["patient", "principal", "permission"])("rejects late A headers and case bodies after %s A→B→A replacement", async changed => {
    const oldClinical = deferred<Response>(); const oldCases = deferred<unknown>();
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => opts?.method ? normal(url, opts)
      : url.endsWith("/endo") ? oldClinical.promise : { ...response(200, null), json: () => oldCases.promise });
    hooks.effects.clear(); render(); const oldSignal = fetchMock.mock.calls.at(-1)![1].signal as AbortSignal;
    const original = { ...props }; const originalSession = hooks.session;
    if (changed === "patient") props = { ...props, patientId: 92 };
    else hooks.session = changed === "principal" ? { username: "synthetic-b", role: "doctor", permissions: null }
      : { username: "synthetic-a", role: "doctor", permissions: { canViewPlans: false } as NonNullable<SessionInfo["permissions"]> };
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => !opts?.method && url.endsWith("/endo")
      ? response(200, { treatments: [{ ...treatment(2, 46), patientId: props.patientId }] }) : normal(url, opts));
    render(); await vi.waitFor(() => expect(contents(control("endo-strip").props.children as ReactNode)).toContain("46"));
    props = original; hooks.session = originalSession; fetchMock.mockImplementation(normal); render();
    await vi.waitFor(() => expect(contents(control("endo-strip").props.children as ReactNode)).toContain("36"));
    expect(oldSignal.aborted).toBe(true);
    oldClinical.resolve(response(403, {})); oldCases.resolve({ cases, items, planVisible: true });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(control("endo-strip")).toBeTruthy(); expect(render().nodes.some(node => node.props["data-testid"] === "endo-case-unavailable")).toBe(false);
    expect(writes()).toHaveLength(0);
  });
  it.each(["patient", "principal", "permission", "logout"])("cannot invoke a retired owner's captured save after %s replacement", async changed => {
    await click("endo-record"); change("endo-note", "Old owner draft");
    const oldSave = control("endo-save").props.onClick as () => Promise<void>;
    const original = { ...props }; const originalSession = hooks.session;
    const pending = deferred<Response>();
    fetchMock.mockImplementation(() => pending.promise);
    if (changed === "patient") props = { ...props, patientId: 92 };
    else hooks.session = changed === "logout" ? null : changed === "principal" ? { username: "synthetic-b", role: "doctor" }
      : { username: "synthetic-a", role: "doctor", permissions: { canViewPlans: false } as NonNullable<SessionInfo["permissions"]> };
    render(); await oldSave(); expect(writes()).toHaveLength(0);
    props = original; hooks.session = originalSession; render(); await oldSave(); expect(writes()).toHaveLength(0);
    pending.resolve(response(200, { treatments: [treatment()] }));
  });
  it("ignores a pending mutation response after unmount", async () => {
    await click("endo-record"); nextWrite = deferred<Response>(); const saving = click("endo-save");
    hooks.effects.forEach((effect) => effect.cleanup?.());
    nextWrite.resolve(response(200, treatment(88, 11))); await saving;
    expect(render().nodes.some((node) => node.props["data-testid"] === "endo-tooth-11")).toBe(false);
  });
});
