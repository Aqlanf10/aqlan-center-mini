import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientWorkspace } from "../components/patient-workspace/PatientWorkspace";
import { WorkspaceSectionContent } from "../components/patient-workspace/WorkspaceSections";
import { TodayVisitTab } from "../components/patient/TodayVisitTab";
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

describe("saved-specialty refresh plumbing", () => {
  it("increments only for explicit shell refresh or confirmed specialty persistence", () => {
    expect(adapter().props.structuredRefreshKey).toBe(0);
    (adapter().props.onChanged as () => void)();
    expect(fixture.reload).toHaveBeenCalledTimes(1); expect(adapter().props.structuredRefreshKey).toBe(0);
    fixture.summary = { ...fixture.summary };
    expect(adapter().props.structuredRefreshKey).toBe(0);
    const button = elements(shell()).find((node) => node.props["aria-label"] === "تحديث ملف المريض")!;
    (button.props.onClick as () => void)();
    expect(adapter().props.structuredRefreshKey).toBe(1); expect(fixture.reload).toHaveBeenCalledTimes(2);
    (adapter().props.onSpecialtyPersisted as () => void)();
    expect(adapter().props.structuredRefreshKey).toBe(2); expect(fixture.reload).toHaveBeenCalledTimes(3);
    shell(); expect(fixture.reload).toHaveBeenCalledTimes(3);
  });
  it("keeps the mounted section identity and forwards the same token and confirmed callback to canonical adapters", () => {
    const before = adapter(); const onPersisted = before.props.onSpecialtyPersisted as () => void;
    onPersisted(); const after = adapter();
    expect(after.type).toBe(before.type); expect(after.key).toBe(before.key);
    const props = after.props as ComponentProps<typeof WorkspaceSectionContent>;
    expect(named(WorkspaceSectionContent({ ...props, section: "today" }), "TodayVisitTab").props.structuredRefreshKey).toBe(1);
    expect(named(WorkspaceSectionContent({ ...props, section: "endo" }), "PatientEndo").props.onPersisted).toBe(onPersisted);
  });
  it("passes verified plan capability to the same mounted directory when workflow revokes access", () => {
    url = new URL("http://synthetic.invalid/patients/91?tab=specialties");
    const before = adapter(); const oldProps = before.props as ComponentProps<typeof WorkspaceSectionContent>;
    const original = named(WorkspaceSectionContent(oldProps), "PatientSpecialtyDirectory");
    expect(original.props.canViewPlans).toBe(true);
    fixture.summary = { ...fixture.summary, planVisible: false };
    const after = adapter(); const next = named(WorkspaceSectionContent(after.props as ComponentProps<typeof WorkspaceSectionContent>), "PatientSpecialtyDirectory");
    expect(next.props.canViewPlans).toBe(false); expect(next.props.authorityKey).toBe(original.props.authorityKey);
    expect(next.props.openVisitId).toBe(original.props.openVisitId);
    expect(after.key).toBe(before.key); expect(next.key).toBe(original.key); expect(next.type).toBe(original.type);
    expect(next.props.active).toBe(true); expect(after.props.structuredRefreshKey).toBe(0); expect(fixture.reload).not.toHaveBeenCalled();
    fixture.summary = { ...fixture.summary }; expect(adapter().props.canViewPlans).toBe(false);
  });
  it("passes an optional refresh token through Today without changing the clinical visit component identity", () => {
    const first = named(render(() => TodayVisitTab(todayProps())), "ClinicalVisit");
    expect(first.props.visitId).toBe(21); expect(first.props.structuredRefreshKey).toBe(0);
    const next = named(render(() => TodayVisitTab(todayProps(7))), "ClinicalVisit");
    expect(next.props.structuredRefreshKey).toBe(7); expect(next.props.visitId).toBe(21);
    expect(next.type).toBe(first.type); expect(next.key).toBe(first.key);
    expect(fixture.reload).not.toHaveBeenCalled();
  });
  it("uses the separate Perio guard before URL change and unmounts only after accepted leave", () => {
    url = new URL("http://synthetic.invalid/patients/91?tab=treatment&sub=perio");
    const initial = adapter(); expect(initial.props.section).toBe("perio");
    const guard = vi.fn(() => false);
    (initial.props.onPerioDraft as (pending: boolean) => void)(true);
    (initial.props.onPerioGuard as (guard: () => boolean) => void)(guard);
    (initial.props.onNavigate as (target: string) => void)("today");
    expect(guard).toHaveBeenCalledTimes(1); expect(url.searchParams.get("sub")).toBe("perio");
    expect(adapter().props.section).toBe("perio"); expect(window.history.replaceState).not.toHaveBeenCalled();
    guard.mockReturnValue(true);
    (adapter().props.onNavigate as (target: string) => void)("today");
    expect(adapter().props.section).toBe("today");
    expect(elements(shell()).filter((node) => node.props["data-workspace-section"] === "perio")).toHaveLength(0);
    expect(window.history.replaceState).toHaveBeenCalledTimes(1); expect(window.history.pushState).not.toHaveBeenCalled();
    // A no-longer-active Perio guard must not prompt unrelated later navigation.
    (adapter().props.onNavigate as (target: string) => void)("summary");
    expect(guard).toHaveBeenCalledTimes(2);
  });
  it("fails closed when a Perio draft is registered before its leave guard", () => {
    url = new URL("http://synthetic.invalid/patients/91?tab=perio");
    (adapter().props.onPerioDraft as (pending: boolean) => void)(true);
    (adapter().props.onNavigate as (target: string) => void)("today");
    expect(url.searchParams.get("tab")).toBe("perio"); expect(window.history.replaceState).not.toHaveBeenCalled();
  });
  it("passes the same patient, exact summary, authority, write boundary and guard to the dedicated Perio adapter", () => {
    const shellProps = adapter().props as ComponentProps<typeof WorkspaceSectionContent>;
    const perio = named(WorkspaceSectionContent({ ...shellProps, section: "perio" }), "WorkspacePeriodontics");
    expect(perio.props).toMatchObject({ patientId: 91, patientName: "Synthetic patient", authorityKey: shellProps.authorityKey,
      editable: shellProps.canWrite, summary: fixture.summary, structuredRefreshKey: 0,
      onDraftChange: shellProps.onPerioDraft, onNavigationGuardChange: shellProps.onPerioGuard, onPersisted: shellProps.onSpecialtyPersisted });
  });

  it("routes the chart callback through consent guards and retains the chart section on return", () => {
    url = new URL("http://synthetic.invalid/patients/91?tab=chart&caseId=17&planId=5&visitId=999&tooth=36&keep=unchanged#record");
    const section = (name: string) => elements(shell()).find((node) => node.props["data-workspace-section"] === name)!;
    const sectionProps = (name: string) => named(section(name), "WorkspaceSectionContent").props as ComponentProps<typeof WorkspaceSectionContent>;
    const initialContainer = section("chart"); const initialProps = sectionProps("chart");
    const chart = named(WorkspaceSectionContent(initialProps), "DentalChart");
    expect(chart.props.patientId).toBe(91);
    const consent = vi.fn(() => false);
    (named(shell(), "WorkspaceDialogs").props.onConsentGuard as (guard: () => boolean) => void)(consent);
    const before = url.href;
    (chart.props.onOpenPeriodontics as () => void)();
    expect(consent).toHaveBeenCalledTimes(1); expect(url.href).toBe(before); expect(sectionProps("chart").active).toBe(true);
    expect(window.history.replaceState).not.toHaveBeenCalled(); expect(section("perio")).toBeUndefined();

    consent.mockReturnValue(true); (chart.props.onOpenPeriodontics as () => void)();
    expect(url.pathname).toBe("/patients/91"); expect(url.searchParams.get("tab")).toBe("treatment"); expect(url.searchParams.get("sub")).toBe("perio");
    for (const [key, value] of [["caseId", "17"], ["planId", "5"], ["visitId", "999"], ["tooth", "36"], ["keep", "unchanged"]]) expect(url.searchParams.get(key)).toBe(value);
    expect(url.hash).toBe("#record"); expect(section("chart").props.hidden).toBe(true);
    expect(section("chart").key).toBe(initialContainer.key); expect(section("chart").type).toBe(initialContainer.type);
    const retained = named(WorkspaceSectionContent(sectionProps("chart")), "DentalChart");
    expect(retained.type).toBe(chart.type); expect(retained.key).toBe(chart.key); expect(retained.props.patientId).toBe(91);
    const perioProps = sectionProps("perio"); const perio = named(WorkspaceSectionContent(perioProps), "WorkspacePeriodontics");
    expect(perio.props.authorityKey).toBe(initialProps.authorityKey); expect(perio.props.summary).toBe(fixture.summary);
    expect((perio.props.summary as WorkflowSummary).openVisit?.id).toBe(21);
    expect(perio.props).not.toHaveProperty("initialTooth"); expect(perio.props).not.toHaveProperty("visibleToothCodes");
    expect(perio.props).not.toHaveProperty("doctorId"); expect(perio.props).not.toHaveProperty("caseId");

    const perioGuard = vi.fn(() => false); perioProps.onPerioGuard!(perioGuard);
    perioProps.onNavigate("chart"); expect(section("chart").props.hidden).toBe(true); expect(url.searchParams.get("sub")).toBe("perio");
    perioGuard.mockReturnValue(true); perioProps.onNavigate("chart");
    expect(section("chart").props.hidden).toBe(false); expect(section("chart").key).toBe(initialContainer.key);
    expect(section("perio")).toBeUndefined(); expect(sectionProps("chart").authorityKey).toBe(initialProps.authorityKey);
    expect(window.history.replaceState).toHaveBeenCalledTimes(2); expect(window.history.pushState).not.toHaveBeenCalled(); expect(fixture.reload).not.toHaveBeenCalled();
  });

});
