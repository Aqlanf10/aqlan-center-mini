import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientEndo } from "../components/PatientEndo";
import { checkEndoVisitDraft, summarizeEndo } from "../lib/endodontics";
import type { EndoTreatmentView, EndoVisitView } from "../lib/endodontics-db";
// Source-local component/handler coverage with synthetic records. Not browser or visual acceptance.
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
let nextWrite: ReturnType<typeof deferred<Response>> | null;
const visit = (overrides: Partial<EndoVisitView> = {}): EndoVisitView => {
  const checked = checkEndoVisitDraft({ stage: "shaping", note: "Persisted current note", nextStep: "Persisted next step",
    canals: [{ label: "MB", workingLengthMm: 20.5, referencePoint: "cusp_tip", measurementMethod: "both" }] });
  if (!checked.ok) throw new Error(checked.message);
  return { ...checked.value, id: 55, treatmentId: 1, visitId: 21, doctorId: 7, doctorName: "Recorded provider",
    recordedAt: "2026-10-01T10:00:00Z", signed: false, version: 4, recordedBy: "recording-account",
    updatedAt: null, addenda: [], ...overrides };
};
const treatment = (visits: EndoVisitView[] = [visit()], overrides: Partial<EndoTreatmentView> = {}): EndoTreatmentView => ({
  id: 1, patientId: 91, toothCode: 36, caseId: 5, caseTitle: "Current case", toothName: "سن تجريبي", kind: "initial", status: "in_progress",
  completedAt: null, outcome: null, restorativeStatus: "none", crownRequired: true, crownPlanItem: null,
  version: 1, createdBy: "episode-creator", createdAt: "2026-10-01T10:00:00Z", visits,
  summary: summarizeEndo(visits, new Map(visits.map((record) => [record.id, record.canals]))),
  crown: "waiting_rct", nextAction: "تابع العلاج", ...overrides,
});
function render() {
  let tree: ReactNode = null; let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("UI did not settle");
    hooks.cursor = 0; hooks.changed = false;
    const wrapper = PatientEndo(props);
    tree = (wrapper.type as (p: typeof props) => ReactNode)(wrapper.props);
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return { tree, nodes: elements(tree) };
}
function find(id: string) { return render().nodes.find((node) => node.props["data-testid"] === id); }
function control(id: string) { const found = find(id); if (!found) throw new Error(`Missing ${id}`); return found; }
function text(id: string) { return contents(control(id).props.children as ReactNode); }
function click(id: string) { return (control(id).props.onClick as () => Promise<void>)(); }
function change(id: string, value: string) { (control(id).props.onChange as (event: unknown) => void)({ target: { value } }); }
function cancel() { const button = elements(control("endo-form-actions")).find((node) => node.type === "button" && contents(node.props.children as ReactNode) === "إلغاء")!; (button.props.onClick as () => void)(); }
const writes = () => fetchMock.mock.calls.filter(([, opts]) => opts?.method);
async function reload() {
  hooks.effects.clear(); render();
  await vi.waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("/api/patients/91/cases", { cache: "no-store" }));
  await vi.waitFor(() => expect(control("patient-endo")).toBeTruthy());
}
beforeEach(async () => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  vi.clearAllMocks(); confirm.mockReturnValue(false);
  props = { patientId: 91, canWrite: true, canEditPlans: true, openVisitId: 21 };
  treatments = [treatment()]; nextWrite = null;
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), confirm });
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    if (opts?.method) {
      if (nextWrite) return nextWrite.promise;
      const payload = JSON.parse(String(opts.body));
      return response(200, treatment([visit({ ...payload, version: 5 })]));
    }
    if (url.endsWith("/cases")) return response(200, { cases: [], items: [], planVisible: true });
    return response(200, { treatments });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(); await vi.waitFor(() => expect(control("patient-endo")).toBeTruthy());
});
afterEach(() => { hooks.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe("persisted endodontic current-visit summary", () => {
  it("shows the exact episode, case, tooth, visit and recorded provider with separate saved/signature states", () => {
    expect(text("endo-session-context")).toContain("Current case · #5");
    expect(text("endo-session-context")).toContain("نوبة العلاج: #1");
    expect(text("endo-session-context")).toContain("الزيارة الحالية: #21");
    expect(text("endo-strip")).toContain("سنّ 36");
    expect(text("endo-current-provider")).toBe("Recorded provider · #7");
    expect(text("endo-current-session-summary")).toContain("تشكيل القنوات");
    expect(text("endo-current-saved-state")).toBe("محفوظ");
    expect(text("endo-current-signature-state")).toBe("غير موقّع");
    expect(text("endo-current-note")).toBe("Persisted current note");
    expect(text("endo-current-next-step")).toBe("Persisted next step");
    expect(find("endo-form")).toBeUndefined();
    expect(control("endo-history").props.open).toBe(false);
    expect(writes()).toHaveLength(0);
  });
  it("leaves persisted summary outside the editor while draft changes remain explicitly unsaved", async () => {
    await click("endo-record"); change("endo-note", "Unsaved replacement"); change("endo-next-step", "Unsaved next step"); change("endo-stage", "obturation");
    expect(text("endo-draft-state")).toContain("مسودة غير محفوظة · زيارة #21 · نوبة #1");
    expect(elements(control("endo-form")).some((node) => node.props["data-testid"] === "endo-current-session-summary")).toBe(false);
    expect(text("endo-current-note")).toBe("Persisted current note");
    expect(text("endo-current-next-step")).toBe("Persisted next step");
    expect(text("endo-current-session-summary")).toContain("تشكيل القنوات");
    expect(writes()).toHaveLength(0);
  });
  it("updates the summary only from a successful save response and leaves signing separate", async () => {
    await click("endo-record"); change("endo-note", "Saved replacement"); change("endo-next-step", "Saved next step"); await click("endo-save");
    expect(find("endo-form")).toBeUndefined(); expect(find("endo-draft-state")).toBeUndefined();
    expect(text("endo-current-note")).toBe("Saved replacement"); expect(text("endo-current-next-step")).toBe("Saved next step");
    expect(text("endo-current-signature-state")).toBe("غير موقّع");
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe("/api/patients/91/endo/1/visits");
    expect(JSON.parse(String(writes()[0][1].body))).toMatchObject({ visitId: 21, expectedVersion: 4 });
  });
  it("does not call a first-session draft saved until the save response arrives", async () => {
    treatments = [treatment([])]; await reload();
    await vi.waitFor(() => expect(find("endo-current-session-summary")).toBeUndefined());
    await click("endo-record"); change("endo-note", "First session");
    expect(find("endo-current-saved-state")).toBeUndefined(); expect(control("endo-draft-state")).toBeTruthy();
    await click("endo-save"); expect(text("endo-current-note")).toBe("First session");
    expect(text("endo-current-saved-state")).toBe("محفوظ"); expect(find("endo-current-unsaved")).toBeUndefined();
    expect(JSON.parse(String(writes()[0][1].body))).toMatchObject({ visitId: 21, expectedVersion: null });
  });
  it("keeps the last saved summary and failed draft during pending, rejected and retried saves", async () => {
    await click("endo-record"); change("endo-note", "Retryable draft");
    nextWrite = deferred<Response>(); const saving = click("endo-save");
    expect(control("patient-endo").props.disabled).toBe(true); expect(text("endo-current-note")).toBe("Persisted current note");
    nextWrite.resolve(response(409, { message: "نسخة قديمة" })); await saving;
    expect(control("endo-note").props.value).toBe("Retryable draft"); expect(text("endo-current-note")).toBe("Persisted current note");
    nextWrite = null; await click("endo-save"); expect(text("endo-current-note")).toBe("Retryable draft");
  });
  it("keeps cancelled edits out of the summary and honors discard refusal", async () => {
    await click("endo-record"); change("endo-note", "Discard me"); cancel();
    expect(control("endo-note").props.value).toBe("Discard me"); expect(text("endo-current-note")).toBe("Persisted current note");
    confirm.mockReturnValue(true); cancel(); expect(find("endo-form")).toBeUndefined();
    expect(text("endo-current-note")).toBe("Persisted current note"); expect(writes()).toHaveLength(0);
  });
  it("does not substitute a historical record when the open visit has no record", async () => {
    treatments = [treatment([visit({ visitId: 20, signed: true, note: "Historical finding" })])]; await reload();
    await vi.waitFor(() => expect(find("endo-current-session-summary")).toBeUndefined());
    expect(text("endo-current-unsaved")).toContain("لا يوجد سجلّ جلسة محفوظ");
    expect(text("endo-history")).toContain("Historical finding");
    await click("endo-record"); expect(control("endo-note").props.value).toBe("");
    expect(find("endo-current-session-summary")).toBeUndefined(); expect(text("endo-draft-state")).toContain("مسودة غير محفوظة");
  });
  it("keeps open-visit changes distinct from the old captured draft and blocks its save", async () => {
    await click("endo-record"); change("endo-note", "Visit21 only"); props.openVisitId = 22;
    expect(find("endo-current-session-summary")).toBeUndefined(); expect(text("endo-session-context")).toContain("#22");
    expect(text("endo-draft-state")).toContain("زيارة #21"); expect(control("endo-save").props.disabled).toBe(true);
    await click("endo-save"); expect(writes()).toHaveLength(0); expect(control("endo-note").props.value).toBe("Visit21 only");
  });
  it("never substitutes a different episode's current-visit record", async () => {
    treatments = [treatment(), treatment([visit({ id: 56, treatmentId: 2, note: "Other episode finding", doctorId: 8, doctorName: "Other provider" })],
      { id: 2, toothCode: 46, caseId: 6, caseTitle: "Other case" })]; await reload();
    await vi.waitFor(() => expect(find("endo-tooth-46")).toBeTruthy()); await click("endo-tooth-46");
    expect(text("endo-current-note")).toBe("Other episode finding"); expect(text("endo-current-provider")).toBe("Other provider · #8");
    expect(text("endo-session-context")).toContain("Other case · #6"); expect(text("endo-session-context")).toContain("نوبة العلاج: #2");
    expect(writes()).toHaveLength(0);
  });
  it("shows signed current work read-only and retains the original addendum action", async () => {
    treatments = [treatment([visit({ signed: true })])]; await reload();
    await vi.waitFor(() => expect(text("endo-current-signature-state")).toBe("موقّع · للقراءة فقط"));
    expect(find("endo-record")).toBeUndefined(); expect(find("endo-form")).toBeUndefined();
    expect(control("endo-addendum-open-55")).toBeTruthy(); expect(writes()).toHaveLength(0);
  });
  it("shows saved work for readers and completed episodes without write controls", async () => {
    props.canWrite = false; treatments = [treatment([visit({ signed: true })], { status: "completed" })]; await reload();
    await vi.waitFor(() => expect(text("endo-current-signature-state")).toBe("موقّع · للقراءة فقط"));
    expect(text("endo-current-note")).toBe("Persisted current note"); expect(find("endo-record")).toBeUndefined();
    expect(find("endo-addendum-open-55")).toBeUndefined(); expect(find("endo-complete")).toBeUndefined();
  });
  it.each([
    [{ doctorId: null, doctorName: null }, "غير متاح"],
    [{ doctorId: 7, doctorName: null }, "طبيب · #7"],
    [{ doctorId: null, doctorName: "Preserved name" }, "Preserved name"],
  ])("does not infer provider identity from the recording account when data is missing: %j", async (provider, expected) => {
    treatments = [treatment([visit(provider)])]; await reload();
    await vi.waitFor(() => expect(text("endo-current-provider")).toBe(expected));
    expect(text("endo-current-provider")).not.toContain("recording-account"); expect(text("endo-current-provider")).not.toContain("episode-creator");
  });
  it("shows honest empty fields and does not infer a session note or next step from the episode", async () => {
    treatments = [treatment([visit({ note: null, nextStep: null })])]; await reload();
    await vi.waitFor(() => expect(text("endo-current-note")).toBe("لم تُسجّل ملاحظة للجلسة."));
    expect(text("endo-current-next-step")).toBe("لم تُسجّل خطوة تالية.");
  });
  it("keeps an unscoped no-open-visit view free of a claimed current-session summary", () => {
    props.openVisitId = null;
    expect(find("endo-current-session-summary")).toBeUndefined(); expect(find("endo-current-unsaved")).toBeUndefined();
    expect(text("endo-no-visit")).toContain("لا توجد زيارة مفتوحة"); expect(text("endo-history")).toContain("Persisted current note");
  });
  it("does not retain visible saved-summary data after an Endo read is denied", async () => {
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => !opts?.method && url.endsWith("/endo")
      ? response(403, { message: "غير مصرّح" }) : normal(url, opts));
    hooks.effects.clear(); render();
    await vi.waitFor(() => expect(find("endo-current-session-summary")).toBeUndefined());
    expect(contents(render().tree)).toContain("غير مصرّح"); expect(contents(render().tree)).not.toContain("Persisted current note");
    expect(writes()).toHaveLength(0);
  });
  it("keeps four core canal controls and wrapping in-flow actions with minimum touch height", async () => {
    await click("endo-record");
    for (const id of ["endo-canal-label-0", "endo-canal-wl-0", "endo-canal-ref-0", "endo-canal-method-0"]) {
      expect(control(id).props.className).toContain("min-h-11");
    }
    expect(control("endo-canal-wl-0").props.value).toBe("20.5");
    expect(control("endo-canal-ref-0").props.value).toBe("cusp_tip"); expect(control("endo-canal-method-0").props.value).toBe("both");
    expect(control("endo-canal-more-0").props.open).toBeUndefined();
    expect(control("endo-save").props.className).toContain("min-h-11");
    expect(control("endo-form-actions").props.className).toContain("flex-wrap");
    expect(control("endo-form-actions").props.className).not.toMatch(/fixed|sticky/);
  });
  it("notifies saved-structure refresh once after a confirmed session, never for edits or rejected writes", async () => {
    const onPersisted = vi.fn(); props.onPersisted = onPersisted;
    await click("endo-record"); change("endo-note", "Refresh only after save");
    expect(onPersisted).not.toHaveBeenCalled();
    nextWrite = deferred<Response>(); const pending = click("endo-save");
    expect(onPersisted).not.toHaveBeenCalled();
    nextWrite.resolve(response(409, { message: "نسخة قديمة" })); await pending;
    expect(onPersisted).not.toHaveBeenCalled();
    nextWrite = null; await click("endo-save");
    expect(onPersisted).toHaveBeenCalledTimes(1);
    render(); expect(onPersisted).toHaveBeenCalledTimes(1);
  });
  it("notifies saved-structure refresh once for a confirmed signed-record addendum", async () => {
    const onPersisted = vi.fn(); props.onPersisted = onPersisted;
    treatments = [treatment([visit({ signed: true })])]; await reload();
    await vi.waitFor(() => expect(find("endo-addendum-open-55")).toBeTruthy());
    await click("endo-addendum-open-55"); change("endo-addendum-text", "Append-only clarification");
    expect(onPersisted).not.toHaveBeenCalled();
    nextWrite = deferred<Response>(); const pending = click("endo-addendum-save");
    expect(onPersisted).not.toHaveBeenCalled();
    nextWrite.resolve(response(200, treatment([visit({ signed: true })]))); await pending;
    expect(onPersisted).toHaveBeenCalledTimes(1);
    expect(find("endo-addendum-text")).toBeUndefined();
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe("/api/patients/91/endo/1/visits/55/addenda");
  });
  it("does not notify a former patient workspace when its delayed write finishes after unmount", async () => {
    const onPersisted = vi.fn(); props.onPersisted = onPersisted;
    await click("endo-record"); change("endo-note", "Pending old context");
    nextWrite = deferred<Response>(); const pending = click("endo-save");
    hooks.effects.forEach((effect) => effect.cleanup?.());
    nextWrite.resolve(response(200, treatment())); await pending;
    expect(onPersisted).not.toHaveBeenCalled();
  });

});
