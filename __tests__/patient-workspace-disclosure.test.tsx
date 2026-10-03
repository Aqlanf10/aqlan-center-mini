import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PatientFilePage from "../app/patients/[id]/page";
import { PatientEndo } from "../components/PatientEndo";

// Exercise the actual page handlers and hook state; leaf workspaces are not
// rendered. Real ENDO draft retention remains covered by the built-app journey.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false, patientId: "91",
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
    const index = slot(undefined); const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  return {
    ...react, use: () => ({ id: hooks.patientId }),
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => {
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined); const previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.(); const cleanup = effect();
        hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ role: "doctor", username: "synthetic", permissions: { canEditPlans: true } }) }));
vi.mock("../components/SettingsProvider", () => ({ useSetting: () => "" }));
vi.mock("../components/PatientLedger", () => ({ PatientLedger: () => null }));
vi.mock("../components/LegacyHistory", () => ({ LegacyHistory: () => null }));
vi.mock("../components/PatientPlans", () => ({ PatientPlans: () => null }));
vi.mock("../components/DentalChart", () => ({ DentalChart: () => null }));
vi.mock("../components/PatientDocuments", () => ({ PatientDocuments: () => null }));
vi.mock("../components/PatientOrtho", () => ({ PatientOrtho: () => null }));
vi.mock("../components/PatientEndo", () => ({ PatientEndo: () => null }));
vi.mock("../components/PatientLabOrders", () => ({ PatientLabOrders: () => null }));
vi.mock("../components/PatientReferrals", () => ({ PatientReferrals: () => null }));
vi.mock("../components/PatientCases", () => ({ PatientCases: () => null }));
vi.mock("../components/PatientMaterials", () => ({ PatientMaterials: () => null }));
vi.mock("../components/QuickAppointmentModal", () => ({ QuickAppointmentModal: () => null }));
vi.mock("../components/PrescriptionModal", () => ({ PrescriptionModal: () => null }));
vi.mock("../components/ConsentModal", () => ({ ConsentModal: () => null }));
vi.mock("../components/PostOpModal", () => ({ PostOpModal: () => null }));
vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));
vi.mock("../components/CaseProfitabilityModal", () => ({ CaseProfitabilityModal: () => null }));
vi.mock("../components/ChairsideTabletView", () => ({ ChairsideTabletView: () => null }));
vi.mock("../components/VitalsModal", () => ({ VitalsModal: () => null }));
vi.mock("../components/MedicalHistoryPanel", () => ({ MedicalHistoryPanel: () => null }));
vi.mock("../components/PatientContactPanel", () => ({ PatientContactPanel: () => null, PatientFlagChips: () => null }));
vi.mock("../components/PatientFamilyPanel", () => ({ PatientFamilyPanel: () => null }));
vi.mock("../components/patient/SummaryTab", () => ({ SummaryTab: () => null }));
vi.mock("../components/patient/TodayVisitTab", () => ({ TodayVisitTab: () => null }));
vi.mock("../components/patient/PatientCockpit", () => ({ PatientCockpit: () => null }));

type Element = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...["children", "secondaryActions"].flatMap((slot) => nodes(element.props[slot] as ReactNode))];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
}
let url: URL;
const confirm = vi.fn(() => false);
const replaceState = vi.fn((_state: unknown, _unused: string, href: string) => { url = new URL(href, url); });
function render() {
  let tree: ReactNode = null; let count = 0;
  do {
    if (++count > 20) throw new Error("Page did not settle");
    hooks.cursor = 0; hooks.changed = false;
    const root = PatientFilePage({ params: Promise.resolve({ id: hooks.patientId }) });
    tree = (root.type as (props: { id: string }) => ReactNode)(root.props);
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return nodes(tree);
}
function control(testId: string) {
  const node = render().find((element) => element.props["data-testid"] === testId);
  if (!node) throw new Error(`Missing ${testId}`);
  return node;
}
function more() { return render().find((element) => element.type === "details" && text(element.props.children as ReactNode).includes("المزيد ⋯"))!; }
function click(testId: string) { (control(testId).props.onClick as () => void)(); }
function openMore() { (more().props.onToggle as (event: unknown) => void)({ currentTarget: { open: true } }); expect(more().props.open).toBe(true); }
function endo() { return render().find((element) => element.type === PatientEndo)!; }
function clearHooks() {
  hooks.effects.forEach((effect) => effect.cleanup?.());
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
}
async function mount(id = "91") {
  clearHooks(); hooks.patientId = id; url = new URL(`http://clinic.test/patients/${id}?tab=treatment&sub=endo`);
  render(); await vi.waitFor(() => expect(control("patient-details-toggle")).toBeTruthy());
}
beforeEach(async () => {
  vi.clearAllMocks(); confirm.mockReturnValue(false);
  vi.stubGlobal("window", { get location() { return url; }, history: { replaceState }, confirm });
  vi.stubGlobal("fetch", vi.fn(async (input: string) => ({ ok: true, json: async () => input.endsWith("/workflow") ? {
    openVisit: { id: 21, status: "in_chair", chair: 1, arrivedAt: "2026-10-03T00:00:00Z", plannedTitle: null },
    lastVisit: null, nextAppointment: null, activePlans: [], plannedVisits: [], alerts: [], financial: null,
    counts: { visits: 1, openLabOrders: 0, documents: 0, orthoCase: false }, canSeeFinancial: false,
  } : { patient: { id: Number(hooks.patientId), fullName: "مريض تجريبي", patientNumber: `SYNTH-${hooks.patientId}`,
    gender: "unknown", birthYear: null, birthDate: null, medicalAlert: null, flags: [], phone: null }, visits: [], appointments: [] } })));
  await mount();
});
afterEach(() => { clearHooks(); vi.unstubAllGlobals(); });

describe("patient disclosure lifecycle", () => {
  it("closes nested More when details hide and does not restore it in full Summary", () => {
    click("patient-details-toggle"); openMore();
    click("patient-details-toggle");
    expect(control("patient-details-panel").props.hidden).toBe(true);
    expect(more().props.open).toBe(false);
    click("patient-tab-summary");
    expect(url.searchParams.get("tab")).toBe("summary");
    expect(control("patient-details-panel").props.hidden).toBe(false);
    expect(more().props.open).toBe(false);
    click("patient-tab-treatment");
    expect(control("patient-details-panel").props.hidden).toBe(true);
    expect(more().props.open).toBe(false);
  });

  it("dismisses More after accepted canonical navigation even while details remain expanded", () => {
    click("patient-details-toggle"); openMore();
    click("patient-tab-summary");
    expect(url.searchParams.get("tab")).toBe("summary");
    expect(more().props.open).toBe(false);
  });

  it("hiding details does not invoke the ENDO leave guard or discard its dirty workspace", () => {
    const workspace = endo();
    (workspace.props.onDraftChange as (dirty: boolean) => void)(true);
    click("patient-details-toggle"); openMore(); click("patient-details-toggle");
    expect(confirm).not.toHaveBeenCalled();
    expect(endo().type).toBe(workspace.type); expect(endo().key).toBe(workspace.key);
    expect(endo().props.patientId).toBe(workspace.props.patientId);
    expect(more().props.open).toBe(false);
    click("patient-tab-summary");
    expect(confirm).toHaveBeenCalledOnce();
    expect(url.searchParams.get("tab")).toBe("treatment");
    expect(endo()).toBeTruthy();
    expect(more().props.open).toBe(false);
  });

  it("preserves the visible menu when dirty ENDO rejects canonical navigation", () => {
    click("patient-details-toggle"); openMore();
    (endo().props.onDraftChange as (dirty: boolean) => void)(true);
    const before = url.href;
    click("patient-tab-summary");
    expect(confirm).toHaveBeenCalledOnce(); expect(url.href).toBe(before);
    expect(control("patient-details-panel").props.hidden).toBe(false);
    expect(more().props.open).toBe(true); expect(endo()).toBeTruthy();
  });

  it("starts with both disclosures closed when the patient-keyed workspace remounts", async () => {
    click("patient-details-toggle"); openMore();
    const previous = PatientFilePage({ params: Promise.resolve({ id: hooks.patientId }) }).key;
    await mount("92");
    expect(PatientFilePage({ params: Promise.resolve({ id: "92" }) }).key).not.toBe(previous);
    expect(control("patient-details-panel").props.hidden).toBe(true);
    expect(more().props.open).toBe(false); expect(endo().props.patientId).toBe(92);
  });
});
