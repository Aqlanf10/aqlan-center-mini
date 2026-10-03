import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientWorkspace } from "../components/patient-workspace/PatientWorkspace";
import { WorkspaceSectionContent } from "../components/patient-workspace/WorkspaceSections";
import { TodayVisitTab } from "../components/patient/TodayVisitTab";
import { writePatientRecordFocus, type PatientVisitWorkFocus } from "../lib/patient-workspace-focus";
import type { WorkflowSummary } from "../components/patient/SummaryTab";
import { CLINIC_BASE_CURRENCY } from "../lib/money";

// Actual shell/adapter handlers with synthetic hook storage. Nested domain editors
// are not executed here; ClinicalVisit's draft-preserving refresh has its own tests.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, changed: false,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(), pending: [] as Array<() => void> }));
const fixture = vi.hoisted(() => ({ reload: vi.fn(), summary: {} as Record<string, unknown> }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined); const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => { const index = slot(typeof initial === "function" ? initial() : initial); return [hooks.values[index], (value: unknown) => {
      const next = typeof value === "function" ? value(hooks.values[index]) : value;
      if (!Object.is(next, hooks.values[index])) hooks.changed = true;
      hooks.values[index] = next;
    }]; },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined); const previous = hooks.effects.get(index); if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
    },
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic", role: "doctor", permissions: {} }) }));
vi.mock("../components/ClinicalVisit", () => ({ ClinicalVisit: function ClinicalVisit() { return null; } }));
vi.mock("../components/patient-workspace/WorkspaceHeader", () => ({ WorkspaceHeader: () => null }));
vi.mock("../components/patient-workspace/WorkspaceDialogs", () => ({ WorkspaceDialogs: () => null }));
vi.mock("../components/patient-workspace/usePatientWorkspace", () => ({ usePatientWorkspace: () => ({
  file: { patient: { id: 91, patientNumber: "SYNTHETIC-91", fullName: "Synthetic patient", phone: null, medicalAlert: null }, visits: [], appointments: [] },
  summary: fixture.summary, loading: false, error: null, summaryError: null, reload: fixture.reload, updatePatient: vi.fn(), confirmMedicalAlert: vi.fn(), confirmedAlert: undefined,
}) }));
vi.mock("../components/patient-workspace/usePatientReadiness", () => ({ usePatientReadiness: () => ({ visit: null, alerts: [], readinessKnown: false, chairsKnown: false }) }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function named(node: ReactNode, name: string) {
  const found = elements(node).filter((element) => typeof element.type === "function" && element.type.name === name);
  expect(found).toHaveLength(1); return found[0];
}
function render(run: () => ReactNode) {
  let tree: ReactNode = null; let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("UI did not settle");
    hooks.cursor = 0; hooks.changed = false; tree = run();
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
function shell() {
  return render(() => {
    const wrapper = PatientWorkspace({ id: "91" });
    return (wrapper.type as (props: Record<string, unknown>) => ReactNode)(wrapper.props);
  });
}
let url: URL;
function adapter() { return named(shell(), "WorkspaceSectionContent"); }
function todayProps(key?: number | string): ComponentProps<typeof TodayVisitTab> {
  return { patientId: 91, patientName: "Synthetic patient", summary: fixture.summary as unknown as WorkflowSummary, base: CLINIC_BASE_CURRENCY,
    visits: [], canCollect: false, onVisitStarted: vi.fn(), onChanged: vi.fn(), structuredRefreshKey: key };
}
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  fixture.reload.mockReset();
  fixture.summary = { planVisible: true, canSeeFinancial: false, today: "2026-10-03", activePlans: [], plannedVisits: [],
    counts: { visits: 1, openLabOrders: 0, documents: 0, orthoCase: false }, openVisit: { id: 21, arrivedAt: "2026-10-03T09:00:00Z", status: "in_chair", chair: 1, plannedTitle: null }, lastVisit: null };
  url = new URL("http://synthetic.invalid/patients/91?tab=today");
  vi.stubGlobal("window", { get location() { return url; }, history: { replaceState: vi.fn((_state, _title, href: string) => { url = new URL(href, url); }), pushState: vi.fn() } });
});
afterEach(() => { hooks.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });


const focus: PatientVisitWorkFocus = { kind: "visit_work", patientId: 91, visitId: 21, planId: 31, itemId: 41, caseId: 51, toothCode: 16 };
const withFocus = () => ({ ...todayProps(), workFocus: focus });
describe("canonical handoff adapters use the existing guarded navigation", () => {
  it("binds the ordinary Today editor to its parent patient even without a work focus", () => {
    const clinical = named(render(() => TodayVisitTab(todayProps())), "ClinicalVisit");
    expect(clinical.props.visitId).toBe(21);
    expect(clinical.props.expectedLinkedPatientId).toBe(91);
    expect(clinical.props.workFocus).toBeNull();
  });
  it("plumbs exact focus and the same guard into Today and exposes existing-item origins", () => {
    const shellProps = adapter().props as ComponentProps<typeof WorkspaceSectionContent>;
    const today = named(WorkspaceSectionContent({ ...shellProps, focus, section: "today" }), "TodayVisitTab");
    expect(today.props.workFocus).toBe(focus); expect(today.props.onNavigationGuardChange).toBe(shellProps.onTodayGuard);
    const plans = named(WorkspaceSectionContent({ ...shellProps, section: "plans" }), "PatientPlans");
    expect(plans.props.onFocus).toBe(shellProps.onFocus); expect(plans.props.openVisitId).toBe(21);
    const endo = named(WorkspaceSectionContent({ ...shellProps, section: "endo" }), "PatientEndo");
    expect(endo.props.onReviewWork).toBe(shellProps.onFocus);
  });
  it("same-section changed work focus obeys current Today guard once and keeps URL if cancelled", () => {
    const params = new URLSearchParams("tab=today"); writePatientRecordFocus(params, focus);
    url = new URL(`http://synthetic.invalid/patients/91?${params}`);
    const current = adapter(); const guard = vi.fn(() => false);
    (current.props.onTodayGuard as (guard: () => boolean) => void)(guard);
    const next = { ...focus, itemId: 42 };
    (current.props.onFocus as (value: PatientVisitWorkFocus) => void)(next);
    expect(guard).toHaveBeenCalledTimes(1); expect(url.searchParams.get("focusItem")).toBe("41");
    expect(window.history.replaceState).not.toHaveBeenCalled();
    guard.mockReturnValue(true); (adapter().props.onFocus as (value: PatientVisitWorkFocus) => void)(next);
    expect(guard).toHaveBeenCalledTimes(2); expect(url.searchParams.get("focusItem")).toBe("42");
    expect(window.history.replaceState).toHaveBeenCalledTimes(1); expect(window.history.pushState).not.toHaveBeenCalled();
  });
  it("exact current visit is forwarded without mounting any other encounter", () => {
    const tree = render(() => TodayVisitTab(withFocus())); const clinical = named(tree, "ClinicalVisit");
    expect(clinical.props.visitId).toBe(21); expect(clinical.props.workFocus).toBe(focus); expect(clinical.props.suspended).toBe(false);
    expect(clinical.props.expectedLinkedPatientId).toBe(91);
  });
  it.each([null, { id: 21, arrivedAt: "2026-10-03T10:00:00Z", status: "cancelled", chair: null, plannedTitle: null }, { id: 22, arrivedAt: "2026-10-03T10:00:00Z", status: "in_chair", chair: 1, plannedTitle: null }])("incoming noncurrent focus shows unavailable instead of a fallback/start editor", (openVisit) => {
    fixture.summary = { ...fixture.summary, openVisit };
    const tree = render(() => TodayVisitTab(withFocus()));
    expect(elements(tree).some((node) => node.props["data-testid"] === "visit-work-unavailable")).toBe(true);
    expect(elements(tree).filter((node) => typeof node.type === "function" && node.type.name === "ClinicalVisit")).toHaveLength(0);
    expect(fixture.reload).not.toHaveBeenCalled();
  });
  it("later retirement retains only the previously mounted editor, suspended, without replacing its draft", () => {
    const first = named(render(() => TodayVisitTab(withFocus())), "ClinicalVisit");
    fixture.summary = { ...fixture.summary, openVisit: { id: 22, arrivedAt: "2026-10-03T10:00:00Z", status: "in_chair", chair: 2, plannedTitle: null } };
    const nextTree = render(() => TodayVisitTab(withFocus())); const next = named(nextTree, "ClinicalVisit");
    expect(next.props.visitId).toBe(21); expect(next.props.suspended).toBe(true);
    expect(next.props.expectedLinkedPatientId).toBe(91);
    expect(next.props.expectedLinkedPatientId).toBe(first.props.expectedLinkedPatientId);
    expect(next.type).toBe(first.type); expect(next.key).toBe(first.key);
    expect(elements(nextTree).some((node) => node.props.hidden === true)).toBe(true);
    expect(elements(nextTree).some((node) => node.props["data-testid"] === "visit-work-unavailable")).toBe(true);
  });
});
