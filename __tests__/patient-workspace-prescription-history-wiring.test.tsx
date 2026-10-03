import { readFileSync } from "node:fs";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Actual shell actions and section adapter, with synthetic state storage. Domain
// editors are inspected as elements, never remounted or executed by this test.
const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, role: "doctor", boundary: { ready: true, revision: 4 }, reload: vi.fn() }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = state.cursor++; if (!(index in state.values)) state.values[index] = initial; return index; };
  return { ...react,
    useState: (initial: unknown) => { const index = slot(typeof initial === "function" ? initial() : initial); return [state.values[index], (value: unknown) => {
      state.values[index] = typeof value === "function" ? value(state.values[index]) : value;
    }]; },
    useRef: (initial: unknown) => state.values[slot({ current: initial })],
    useCallback: (callback: unknown) => callback, useEffect: () => {},
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic", role: state.role, permissions: {} }) }));
vi.mock("../components/patient-workspace/usePatientWorkspace", () => ({ usePatientWorkspace: () => ({
  file: { patient: { id: 91, patientNumber: "SYNTHETIC-91", fullName: "Synthetic patient", phone: null, medicalAlert: null }, visits: [], appointments: [] },
  summary: { planVisible: true, canSeeFinancial: false, activePlans: [], plannedVisits: [], counts: { visits: 0, openLabOrders: 0, documents: 0, orthoCase: false }, openVisit: { id: 201 }, lastVisit: null, alerts: [] },
  loading: false, error: null, summaryError: null, reload: state.reload, updatePatient: vi.fn(), confirmMedicalAlert: vi.fn(), confirmedAlert: undefined, readBoundary: state.boundary,
}) }));
vi.mock("../components/patient-workspace/usePatientReadiness", () => ({ usePatientReadiness: () => ({ visit: null, alerts: [], readinessKnown: false, chairsKnown: false }) }));

import { PatientWorkspace } from "../components/patient-workspace/PatientWorkspace";
import { WorkspaceSectionContent } from "../components/patient-workspace/WorkspaceSections";
import { PatientPrescriptionHistory } from "../components/patient-workspace/PatientPrescriptionHistory";
import { WorkspaceDialogs } from "../components/patient-workspace/WorkspaceDialogs";
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children as ReactNode)];
}
function component(tree: ReactNode, type: unknown): Element { const matches = elements(tree).filter((node) => node.type === type); expect(matches).toHaveLength(1); return matches[0]; }
function shell() {
  state.cursor = 0; const wrapper = PatientWorkspace({ id: "91" });
  return (wrapper.type as (props: Record<string, unknown>) => ReactNode)(wrapper.props);
}
function adapter() { return component(shell(), WorkspaceSectionContent).props as ComponentProps<typeof WorkspaceSectionContent>; }
function history(props = adapter()) { return component(WorkspaceSectionContent(props), PatientPrescriptionHistory); }
beforeEach(() => {
  state.values = []; state.cursor = 0; state.role = "doctor"; state.boundary = { ready: true, revision: 4 }; state.reload.mockReset();
  vi.stubGlobal("window", { location: new URL("http://synthetic.invalid/patients/91?tab=prescriptions") });
});
afterEach(() => vi.unstubAllGlobals());

describe("saved prescription shell/section narrow integration", () => {
  it("passes exact patient/authority/active and existing two-peer read readiness", () => {
    const props = adapter(); const view = history(props);
    expect(view.props).toMatchObject({ patientId: 91, authorityKey: props.authorityKey, canRead: true, active: true, readable: true, readRevision: 4, prescriptionDialogOpen: false });
    expect(view.props).not.toHaveProperty("visitId"); expect(view.props).not.toHaveProperty("defaultDoctorName");
    state.boundary = { ready: false, revision: 5 }; expect(history().props).toMatchObject({ readable: false, readRevision: 5 });
    expect(history({ ...adapter(), active: false }).props.active).toBe(false);
    expect(history({ ...adapter(), timelineReadBoundary: undefined }).props).toMatchObject({ readable: false, readRevision: 0 });
  });
  it.each(["doctor", "admin"])("mounts clinician history only for %s capability", (role) => {
    state.role = role; expect(history().props.canRead).toBe(true);
  });
  it("does not mount or request clinical history for reception", () => {
    state.role = "reception"; const tree = WorkspaceSectionContent(adapter());
    expect(elements(tree).filter((node) => node.type === PatientPrescriptionHistory)).toHaveLength(0);
  });
  it("uses actual shell open/close handlers to pause history without changing dialog ownership", () => {
    const before = component(shell(), WorkspaceDialogs); const props = adapter();
    const prescriptionButton = elements(WorkspaceSectionContent(props)).find((node) => node.type === "button" && String(node.props.className).includes("linkCard"))!;
    expect(prescriptionButton).toBeTruthy(); (prescriptionButton.props.onClick as () => void)();
    const opened = component(shell(), WorkspaceDialogs);
    expect(opened.props.action).toBe("prescription"); expect(history().props.prescriptionDialogOpen).toBe(true);
    expect(opened.type).toBe(before.type); expect(opened.key).toBe(before.key);
    expect(opened.props.authorityKey).toBe(before.props.authorityKey); expect(opened.props.patient).toEqual(before.props.patient);
    (opened.props.onClose as () => void)();
    expect(component(shell(), WorkspaceDialogs).props.action).toBeNull(); expect(history().props.prescriptionDialogOpen).toBe(false);
    expect(state.reload).not.toHaveBeenCalled();
  });
  it("does not pause history for unrelated dialog actions", () => {
    adapter().onAction("consent"); expect(component(shell(), WorkspaceDialogs).props.action).toBe("consent"); expect(history().props.prescriptionDialogOpen).toBe(false);
  });
  it("keeps the existing patient-only prescription editor and no suggestion/save coupling in the reader", () => {
    const dialogs = readFileSync(new URL("../components/patient-workspace/WorkspaceDialogs.tsx", import.meta.url), "utf8");
    const mount = dialogs.match(/<PrescriptionModal\b[^>]*\/>/s)?.[0]; expect(mount).toBeTruthy();
    expect(mount).toContain('key={`rx:${identityKey}`}'); expect(mount).toContain('isOpen={action === "prescription"}');
    expect(mount).not.toContain("visitId="); expect(mount).not.toContain("defaultDoctorName=");
    const reader = readFileSync(new URL("../components/patient-workspace/PatientPrescriptionHistory.tsx", import.meta.url), "utf8");
    expect(reader).not.toMatch(/method:\s*["'](?:POST|PUT|PATCH|DELETE)/); expect(reader).not.toContain("PrescriptionModal");
    expect(reader).not.toContain("pendingPrescriptionSaves"); expect(reader).not.toContain("uncertainPrescriptionSaves");
    expect(reader).not.toContain("prescribedBefore"); expect(reader).not.toContain("payload.suggestions");
  });
});
