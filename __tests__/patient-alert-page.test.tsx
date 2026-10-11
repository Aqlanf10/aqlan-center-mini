import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PatientFilePage from "../app/patients/[id]/page";
import { PatientCases } from "../components/PatientCases";
import { PatientEndo } from "../components/PatientEndo";
import { PatientOrtho } from "../components/PatientOrtho";
import { PatientCockpit } from "../components/patient/PatientCockpit";
import { VitalsModal } from "../components/VitalsModal";
import { HistoricalClinicalNote } from "../components/HistoricalClinicalNote";
import { clinicalContextSearch, type ClinicalNavigationContext } from "../lib/patient-navigation";
import { CURRENCY_LABEL, formatMoney } from "../lib/money";

// Exercise the actual page handlers and hook state; leaf workspaces are not
// rendered. Real ENDO draft retention remains covered by the built-app journey.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false, patientId: "91",
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  pending: [] as Array<() => void>,
  username: "synthetic",
  canEditPlans: true,
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
  const effect = (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined); const previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
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
    useLayoutEffect: effect,
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
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ role: "doctor", username: hooks.username, permissions: { canEditPlans: hooks.canEditPlans } }) }));
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
function openMore() {
  const summary = nodes(more()).find(element => element.type === "summary")!;
  const preventDefault = vi.fn();
  (summary.props.onClick as (event: unknown) => void)({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(more().props.open).toBe(true);
}
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
  hooks.username = "synthetic";
  hooks.canEditPlans = true;
  vi.clearAllMocks(); confirm.mockReturnValue(false);
  vi.stubGlobal("window", Object.defineProperties(new EventTarget(), {
    location: { get: () => url }, history: { value: { replaceState } }, confirm: { value: confirm },
  }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const request = new URL(String(input), "http://clinic.test");
    if (request.pathname.endsWith("/clinical-context")) {
      const owner = Number(request.pathname.split("/")[3]);
      const expected = { patientId: owner, clinicalCaseId: 456, orthoCaseId: 123, pillar: "wires" };
      const entries = Object.fromEntries(request.searchParams);
      if (owner !== Number(hooks.patientId) || entries.patientId !== String(owner)
        || entries.clinicalCaseId !== "456" || entries.orthoCaseId !== "123"
        || entries.pillar !== "wires" || Object.keys(entries).length !== 4) return Response.json({ ok: false }, { status: 409 });
      return Response.json({ ok: true, context: expected, specialty: "orthodontics", sub: "ortho" });
    }
    return { ok: true, json: async () => input.endsWith("/workflow") ? {
    patient: { id: Number(hooks.patientId) }, assessmentCases: [], legacyCases: [],
    openVisit: { id: 21, status: "in_chair", chair: 1, arrivedAt: "2026-10-03T00:00:00Z", plannedTitle: null },
    lastVisit: null, nextAppointment: null, activePlans: [], plannedVisits: [], alerts: [], financial: null,
    counts: { visits: 1, openLabOrders: 0, documents: 0, orthoCase: false }, canSeeFinancial: false,
  } : { patient: { id: Number(hooks.patientId), fullName: "مريض تجريبي", patientNumber: `SYNTH-${hooks.patientId}`,
    gender: "unknown", birthYear: null, birthDate: null, medicalAlert: null, flags: [], phone: null }, visits: [], appointments: [] } }; }));
  await mount();
});
afterEach(() => { clearHooks(); vi.unstubAllGlobals(); });

describe("patient disclosure lifecycle", () => {
  it("closes nested More when details hide and restores the full Summary header without reopening More", () => {
    click("patient-details-toggle"); openMore();
    click("patient-details-toggle");
    expect(control("patient-details-panel").props.hidden).toBe(true);
    expect(more().props.open).toBe(false);
    click("patient-tab-summary");
    expect(url.searchParams.get("tab")).toBe("summary");
    expect(control("patient-details-panel").props.hidden).toBe(false);
    expect(render().find((element) => element.type === PatientCockpit)?.props.compact).toBe(false);
    expect(render().find(element => element.props["data-testid"] === "patient-details-toggle")).toBeUndefined();
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

  it("preserves More when programmatic navigation is rejected without an outside interaction", () => {
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

describe("patient page confirmed alert reconciliation", () => {
  const cockpit = () => render().find(node => node.type === PatientCockpit)!;
  const vitals = () => render().find(node => node.type === VitalsModal)!;
  const confirmSave = (value: string | null, node = vitals()) => (node.props.onSaved as (value: string | null) => void)(value);
  const failPatientReload = () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, options) => String(input).endsWith("/workflow") ? original(input, options)
      : Promise.resolve({ ok: false, json: async () => ({ message: "تعذّر تحديث تجريبي" }) } as Response));
  };
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); render(); await Promise.resolve(); render(); };
  const malformed = (status: number) => {
    const response = new Response(null, { status });
    vi.spyOn(response, "json").mockRejectedValue(new Error("malformed synthetic body"));
    return response;
  };

  it.each(["addition", "replacement", "removal"])("keeps confirmed %s and the mounted ENDO owner through failed file reload", async kind => {
    if (kind !== "addition") { confirmSave("تنبيه قديم"); await settle(); }
    const workspace = endo(); failPatientReload();
    confirmSave(kind === "removal" ? null : "تنبيه مؤكد جديد"); await settle();
    expect(cockpit().props.fallbackAlert).toBe(kind === "removal" ? null : "تنبيه مؤكد جديد");
    expect(cockpit().props.confirmedAlert).toMatchObject({ value: kind === "removal" ? null : "تنبيه مؤكد جديد", revision: kind === "addition" ? 1 : 2 });
    expect(control("patient-details-panel").props.hidden).toBe(true);
    expect(endo().type).toBe(workspace.type); expect(endo().key).toBe(workspace.key);
  });
  it("ignores an older GET completing after a confirmed save and a newer failed GET", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    let release!: (value: Response) => void;
    const old = new Promise<Response>(resolve => { release = resolve; });
    vi.mocked(fetch).mockImplementation((input, options) => String(input).endsWith("/workflow") ? original(input, options) : old);
    (cockpit().props.onChanged as () => void)();
    failPatientReload(); confirmSave("تنبيه جديد بعد الطلب"); await settle();
    release({ ok: true, json: async () => ({ patient: { id: 91, medicalAlert: "تنبيه قديم متأخر" }, visits: [], appointments: [] }) } as Response);
    await settle(); expect(cockpit().props.fallbackAlert).toBe("تنبيه جديد بعد الطلب");
  });
  it("retires retained save callbacks and confirmed values across principal A → B → A", async () => {
    const oldVitals = vitals(); confirmSave("تنبيه قديم مؤكد", oldVitals); await settle();
    hooks.username = "other"; render(); await settle();
    expect(cockpit().props.confirmedAlert).toBeUndefined();
    confirmSave("لا يجب قبوله", oldVitals); render();
    expect(cockpit().props.confirmedAlert).toBeUndefined();
    hooks.username = "synthetic"; render(); await settle();
    confirmSave("لا يجب إحياؤه", oldVitals); render();
    expect(cockpit().props.confirmedAlert).toBeUndefined();
    confirmSave("تنبيه الجلسة الحالية"); render();
    expect(cockpit().props.confirmedAlert).toMatchObject({ value: "تنبيه الجلسة الحالية", revision: 1 });
  });
  it.each(["principal", "permission"])("requires a fresh grant and hides all prior patient context across %s A → B → A", async kind => {
    confirmSave("تنبيه سري للجلسة السابقة"); await settle(); const oldVitals = vitals();
    const original = vi.mocked(fetch).getMockImplementation()!;
    let release!: (value: Response) => void;
    const delayed = new Promise<Response>(resolve => { release = resolve; });
    vi.mocked(fetch).mockImplementation((input, options) => String(input).endsWith("/workflow") ? original(input, options) : delayed);
    if (kind === "principal") hooks.username = "other"; else hooks.canEditPlans = false;
    expect(render().some(node => node.type === PatientCockpit || node.type === PatientEndo)).toBe(false);
    confirmSave("لا ينبغي كشفه", oldVitals); render();
    expect(render().some(node => node.type === PatientCockpit)).toBe(false);
    // Even returning to A cannot revive A's earlier accepted file before a new grant.
    hooks.username = "synthetic"; hooks.canEditPlans = true;
    vi.mocked(fetch).mockImplementation((input, options) => String(input).endsWith("/workflow") ? original(input, options)
      : Promise.resolve({ ok: false, status: 403, json: async () => ({ message: "رفض تجريبي" }) } as Response));
    expect(render().some(node => node.type === PatientCockpit)).toBe(false); await settle();
    release({ ok: true, status: 200, json: async () => ({ patient: { id: 91, medicalAlert: "تنبيه سري متأخر" }, visits: [], appointments: [] }) } as Response);
    await settle(); expect(render().some(node => node.type === PatientCockpit || node.type === PatientEndo)).toBe(false);
    expect(render().map(node => text(node.props.children as ReactNode)).join("")).not.toContain("تنبيه سري");
  });
  it("revokes an accepted same-principal file after a hard GET denial", async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, options) => String(input).endsWith("/workflow") ? original(input, options)
      : Promise.resolve({ ok: false, status: 403, json: async () => ({ message: "رفض تجريبي" }) } as Response));
    (cockpit().props.onChanged as () => void)(); await settle();
    expect(render().some(node => node.type === PatientCockpit || node.type === PatientEndo)).toBe(false);
  });
  it.each(["patient", "workflow"])("revokes accepted context before parsing malformed bodies on a %s denial", async source => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, options) => {
      const workflow = String(input).endsWith("/workflow");
      if (source === "patient" && workflow) return original(input, options);
      return Promise.resolve(malformed(source === "workflow" && !workflow ? 200 : 403));
    });
    (cockpit().props.onChanged as () => void)(); await settle();
    expect(render().some(node => node.type === PatientCockpit || node.type === PatientEndo)).toBe(false);
  });
  it.each(["patient", "workflow"])("revokes immediately on %s denial while peer response headers hang", async source => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    let release!: (value: Response) => void;
    const delayed = new Promise<Response>(resolve => { release = resolve; });
    vi.mocked(fetch).mockImplementation(input => {
      const denied = String(input).endsWith("/workflow") === (source === "workflow");
      return denied ? Promise.resolve(malformed(403)) : delayed;
    });
    (cockpit().props.onChanged as () => void)(); await settle();
    expect(render().some(node => node.type === PatientCockpit || node.type === PatientEndo)).toBe(false);
    release(await original(source === "workflow" ? "/api/patients/91" : "/api/patients/91/workflow")); await settle();
    expect(render().some(node => node.type === PatientCockpit || node.type === PatientEndo)).toBe(false);
  });
});


describe("Cases navigation uses the patient-owned guarded destination", () => {
  async function settle() { await vi.waitFor(() => expect(cases()).toBeTruthy()); }
  function cases() { return render().find(node => node.type === PatientCases)!; }
  function register(node: Element, guard: () => boolean) {
    return (node.props.onNavigationGuardChange as (guard: () => boolean) => () => void)(guard);
  }
  const exactCase: ClinicalNavigationContext = { patientId: 91, clinicalCaseId: 456, orthoCaseId: 123, pillar: "wires" };
  function open(node: Element) {
    return (node.props.onOpenOrtho as (context: ClinicalNavigationContext) => boolean | Promise<boolean>)(exactCase);
  }
  it("keeps URL/context on guard refusal, then opens the exact verified case", async () => {
    click("patient-subtab-cases");
    url.searchParams.set("review", "1"); url.searchParams.set("orthoCaseId", "123"); url.hash = "#reference";
    const child = cases(), guard = vi.fn(() => false), cleanup = register(child, guard), before = url.href;
    replaceState.mockClear();
    expect(await open(child)).toBe(false); expect(guard).toHaveBeenCalledOnce();
    expect(url.href).toBe(before); expect(replaceState).not.toHaveBeenCalled();
    expect(cases().props.patientId).toBe(91);
    guard.mockReturnValue(true); expect(await open(child)).toBe(true);
    expect(replaceState).toHaveBeenCalledOnce();
    expect(url.searchParams.get("tab")).toBe("treatment"); expect(url.searchParams.get("sub")).toBe("ortho");
    expect(url.searchParams.get("review")).toBe("1"); expect(url.searchParams.get("orthoCaseId")).toBe("123");
    expect(url.searchParams.get("clinicalCaseId")).toBe("456");
    expect(url.searchParams.get("patientId")).toBe("91");
    expect(url.hash).toBe("#reference"); cleanup();
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it("old guard cleanup cannot remove a newer child guard", async () => {
    click("patient-subtab-cases"); const child = cases();
    const first = vi.fn(() => true), newer = vi.fn(() => false);
    const cleanup = register(child, first); const currentCleanup = register(child, newer); cleanup();
    const before = url.href; expect(await open(child)).toBe(false); expect(url.href).toBe(before);
    expect(newer).toHaveBeenCalledOnce(); expect(first).not.toHaveBeenCalled(); currentCleanup();
  });
  it("blocks ordinary tab and mobile-section requests with the same Cases guard", () => {
    click("patient-subtab-cases"); const guard = vi.fn(() => false); const cleanup = register(cases(), guard);
    const before = url.href;
    click("patient-tab-account"); click("patient-subtab-plans");
    const event = { target: { value: "ortho" }, currentTarget: { value: "ortho" } };
    (control("patient-treatment-section").props.onChange as (event: unknown) => void)(event);
    expect(url.href).toBe(before); expect(event.currentTarget.value).toBe("cases");
    expect(guard).toHaveBeenCalledTimes(3); cleanup();
  });
  it.each(["principal", "permission"])("retires old section/guard callbacks across %s A → B → A", async kind => {
    click("patient-subtab-cases"); const old = cases(); const oldGuard = vi.fn(() => false);
    register(old, oldGuard);
    if (kind === "principal") hooks.username = "other"; else hooks.canEditPlans = false;
    render(); await settle();
    const guard = vi.fn(() => false); const cleanup = register(cases(), guard);
    const before = url.href; expect(await open(old)).toBe(false); expect(url.href).toBe(before);
    const oldCleanup = register(old, vi.fn(() => true)); oldCleanup();
    expect(await open(cases())).toBe(false); expect(guard).toHaveBeenCalledOnce(); cleanup();
    hooks.username = "synthetic"; hooks.canEditPlans = true; render(); await settle();
    expect(await open(old)).toBe(false); expect(url.href).toBe(before);
    expect(oldGuard).not.toHaveBeenCalled();
  });
  it("rejects a malformed resolver DTO before invoking the leave guard", async () => {
    click("patient-subtab-cases"); const child = cases(), guard = vi.fn(() => true);
    const cleanup = register(child, guard), before = url.href;
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, options) => String(input).includes("/clinical-context?")
      ? Promise.resolve(Response.json({ ok: true, context: { ...exactCase, orthoCaseId: "123" }, specialty: "orthodontics", sub: "ortho" }))
      : original(input, options));
    expect(await open(child)).toBe(false); expect(url.href).toBe(before);
    expect(guard).not.toHaveBeenCalled(); cleanup();
  });
  it("retires an in-flight exact resolver read when its principal changes", async () => {
    click("patient-subtab-cases"); const child = cases(), guard = vi.fn(() => true);
    register(child, guard); const before = url.href;
    const original = vi.mocked(fetch).getMockImplementation()!;
    let release!: (response: Response) => void;
    const delayed = new Promise<Response>(resolve => { release = resolve; });
    vi.mocked(fetch).mockImplementation((input, options) => String(input).includes("/clinical-context?") ? delayed : original(input, options));
    const pending = open(child);
    hooks.username = "other"; render(); await settle();
    release(Response.json({ ok: true, context: exactCase, specialty: "orthodontics", sub: "ortho" }));
    expect(await pending).toBe(false); expect(url.href).toBe(before); expect(guard).not.toHaveBeenCalled();
  });
  it("a patient remount never lets the old child move the new patient's section", async () => {
    click("patient-subtab-cases"); const old = cases(); await mount("92");
    const before = url.href; expect(await open(old)).toBe(false); expect(url.href).toBe(before);
    await mount("91"); const returned = url.href; expect(await open(old)).toBe(false); expect(url.href).toBe(returned);
  });
});



describe("verified same-case pillar handoff", () => {
  const exact: ClinicalNavigationContext = { patientId: 91, clinicalCaseId: 456, orthoCaseId: 123,
    planId: 31, planItemId: 32, visitId: 41, pillar: "wires" };
  const reply = (context: ClinicalNavigationContext) => Response.json({ ok: true, context, specialty: "orthodontics", sub: "ortho" });
  const ortho = () => render().find(node => node.type === PatientOrtho)!;
  const change = (node: Element, context: ClinicalNavigationContext) =>
    (node.props.onContextChange as (context: ClinicalNavigationContext) => Promise<boolean>)(context);
  async function enter(allowed: ClinicalNavigationContext[] = []) {
    const original = vi.mocked(fetch).getMockImplementation()!;
    const valid = [exact, ...["prescription", "diagnostics", "retention"].map(pillar => ({ ...exact, pillar } as ClinicalNavigationContext)), ...allowed];
    vi.mocked(fetch).mockImplementation((input, options) => {
      const request = new URL(String(input), "http://clinic.test");
      if (!request.pathname.endsWith("/clinical-context")) return original(input, options);
      const match = request.pathname === "/api/patients/91/clinical-context"
        ? valid.find(context => request.searchParams.toString() === clinicalContextSearch(context)) : undefined;
      return Promise.resolve(match ? reply(match) : Response.json({ ok: false }, { status: 409 }));
    });
    click("patient-subtab-cases");
    const cases = render().find(node => node.type === PatientCases)!;
    expect(await (cases.props.onOpenOrtho as (context: ClinicalNavigationContext) => Promise<boolean>)(exact)).toBe(true);
    await vi.waitFor(() => expect(ortho()).toBeTruthy());
    const guard = vi.fn(() => false);
    const cleanup = (ortho().props.onNavigationGuardChange as (guard: () => boolean) => () => void)(guard);
    return { guard, cleanup };
  }
  it("keeps the owner mounted after one exact read while ordinary departure stays guarded", async () => {
    const { guard, cleanup } = await enter();
    const current = ortho(), original = url.href, before = vi.mocked(fetch).mock.calls.length;
    expect(await change(current, { ...exact, pillar: "prescription" })).toBe(true);
    expect(ortho().type).toBe(current.type); expect(ortho().key).toBe(current.key);
    expect(ortho().props.context).toEqual({ ...exact, pillar: "prescription" });
    expect(render().some(node => node.props["data-testid"] === "clinical-context-state")).toBe(false);
    expect(vi.mocked(fetch).mock.calls.slice(before).filter(([input]) => String(input).includes("/clinical-context?"))).toHaveLength(1);
    expect(guard).not.toHaveBeenCalled();
    const accepted = url.href;
    click("patient-tab-summary"); expect(url.href).toBe(accepted); expect(guard).toHaveBeenCalledOnce();
    // A browser traversal has no one-call grant, even for a previously accepted pillar.
    url = new URL(original); window.dispatchEvent(new Event("popstate"));
    expect(url.href).toBe(accepted); expect(guard).toHaveBeenCalledTimes(2);
    cleanup();
  });
  it.each([
    { ...exact, orthoCaseId: 124, clinicalCaseId: 457, pillar: "prescription" as const },
    { ...exact, planId: 33, planItemId: 34, pillar: "prescription" as const },
    { ...exact, visitId: 42, pillar: "prescription" as const },
    { patientId: 91, orthoCaseId: 123, clinicalCaseId: 456, pillar: "prescription" as const },
  ])("does not use a pillar grant when a clinical edge changes: %j", async target => {
    const { guard, cleanup } = await enter([target]); const before = url.href;
    expect(await change(ortho(), target)).toBe(false);
    expect(url.href).toBe(before); expect(guard).toHaveBeenCalledOnce(); expect(ortho().props.context).toEqual(exact);
    cleanup();
  });
  it("ignores a superseded late pillar reply instead of undoing the newer view", async () => {
    const { guard, cleanup } = await enter(); const current = ortho();
    const original = vi.mocked(fetch).getMockImplementation()!;
    let release!: (response: Response) => void;
    const held = new Promise<Response>(resolve => { release = resolve; });
    vi.mocked(fetch).mockImplementation((input, options) => String(input).includes("pillar=prescription") ? held : original(input, options));
    const old = change(current, { ...exact, pillar: "prescription" });
    expect(await change(current, { ...exact, pillar: "diagnostics" })).toBe(true);
    expect(ortho().props.context).toEqual({ ...exact, pillar: "diagnostics" });
    const latest = url.href; release(reply({ ...exact, pillar: "prescription" }));
    expect(await old).toBe(false); expect(url.href).toBe(latest); expect(guard).not.toHaveBeenCalled(); cleanup();
  });
  it("does not reuse the accepted pillar receipt across a permission change", async () => {
    const { cleanup } = await enter();
    expect(await change(ortho(), { ...exact, pillar: "prescription" })).toBe(true);
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, options) => String(input).includes("/clinical-context?")
      ? Promise.resolve(Response.json({ ok: false }, { status: 403 })) : original(input, options));
    hooks.canEditPlans = false;
    expect(render().some(node => node.type === PatientOrtho)).toBe(false);
    await vi.waitFor(() => expect(render().find(node => node.props["data-testid"] === "clinical-context-state")?.props.role).toBe("alert"));
    expect(render().some(node => node.type === PatientOrtho)).toBe(false);
    hooks.canEditPlans = true;
    expect(render().some(node => node.type === PatientOrtho)).toBe(false);
    await vi.waitFor(() => expect(render().find(node => node.props["data-testid"] === "clinical-context-state")?.props.role).toBe("alert"));
    expect(render().some(node => node.type === PatientOrtho)).toBe(false); cleanup();
  });
});

describe("compact patient account header and Account details", () => {
  it("keeps signed ledger totals compact and moves agreement and historical details to Account", async () => {
    const zero = { balanceMinor: 0, invoicedMinor: 0, paidMinor: 0, openingMinor: 0,
      agreedMinor: 0, treatmentDoneMinor: 0, remainingTreatmentMinor: 0,
      agreementPaidMinor: 0, agreementRemainingMinor: 0 };
    const progress = { historicalItems: 1, knownItems: 0, knownDoneItems: 0, knownDoneMinor: 0, knownRemainingMinor: 0 };
    const financial = { ...zero, byCurrency: {
      YER: { ...zero, agreementRemainingMinor: 900000, clinicalProgress: progress },
      SAR: { ...zero, balanceMinor: 2300, openingMinor: 2300 },
      USD: { ...zero, balanceMinor: -500, paidMinor: 500 },
    } };
    const originalValue = JSON.stringify(financial);
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const response = await originalFetch(input, options);
      if (!String(input).endsWith("/workflow")) return response;
      return Response.json({ ...await response.json(), financial, canSeeFinancial: true });
    });
    await mount();
    await vi.waitFor(() => expect(render().filter(element => element.props["data-testid"] === "patient-account-currency-total")).toHaveLength(3));
    const totals = render().filter(element => element.props["data-testid"] === "patient-account-currency-total");
    expect(totals).toHaveLength(3);
    expect(text(totals.find(element => element.props["data-currency"] === "SAR"))).toContain(`إجمالي المستحق (${CURRENCY_LABEL.SAR}): ${formatMoney(2300, "SAR")}`);
    expect(text(totals.find(element => element.props["data-currency"] === "USD"))).toContain(`رصيد دائن للمريض (${CURRENCY_LABEL.USD}): ${formatMoney(500, "USD")}`);
    expect(text(totals.find(element => element.props["data-currency"] === "YER"))).toContain(`لا مبلغ مستحق (${CURRENCY_LABEL.YER})`);
    expect(text(totals)).not.toContain("المتبقي من الاتفاق");
    expect(text(totals)).not.toContain("باقي علاج");
    expect(render().filter(element => element.props["data-testid"] === "patient-account-currency-banner")).toHaveLength(0);
    click("patient-tab-account");
    await vi.waitFor(() => {
      const banners = render().filter(element => element.props["data-testid"] === "patient-account-currency-banner");
      expect(banners).toHaveLength(3);
    });
    const banners = render().filter(element => element.props["data-testid"] === "patient-account-currency-banner");
    for (const currency of ["YER", "SAR", "USD"] as const) {
      const banner = banners.find(element => element.props["data-currency"] === currency)!;
      expect(text(banner)).toContain(`رصيد الحساب (${CURRENCY_LABEL[currency]}): ${formatMoney(financial.byCurrency[currency].balanceMinor, currency)}`);
      expect(text(banner)).not.toContain("المستحق الحالي مسدّد");
      expect(text(banner).includes("لا مبلغ مستحق بهذه العملة")).toBe(currency === "YER");
    }
    const historical = banners.find(element => element.props["data-currency"] === "YER")!;
    expect(text(historical)).toContain(`المتبقي من الاتفاق: ${formatMoney(900000, "YER")}`);
    expect(nodes(historical).find(element => element.type === HistoricalClinicalNote)?.props)
      .toMatchObject({ progress, currency: "YER" });
    expect(JSON.stringify(financial)).toBe(originalValue);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method)).toBe(true);
    hooks.username = "new-financial-owner";
    expect(render().filter(element => element.props["data-testid"] === "patient-account-currency-total")).toHaveLength(0);
  });

  it("does not invent a zero-balance banner without verified workflow financial data", () => {
    expect(render().filter(element => element.props["data-testid"] === "patient-account-currency-banner")).toHaveLength(0);
    expect(render().filter(element => element.props["data-testid"] === "patient-account-currency-total")).toHaveLength(0);
  });

  it.each(["denied", "malformed"])("fails closed for %s financial data", async kind => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, options) => {
      const response = await originalFetch(input, options);
      if (!String(input).endsWith("/workflow")) return response;
      return Response.json({ ...await response.json(), canSeeFinancial: kind !== "denied",
        financial: { byCurrency: { YER: { balanceMinor: 500 }, SAR: { balanceMinor: 0 }, USD: { balanceMinor: kind === "malformed" ? "0" : 0 } } } });
    });
    await mount();
    expect(render().filter(element => element.props["data-testid"] === "patient-account-currency-total")).toHaveLength(0);
  });
});
