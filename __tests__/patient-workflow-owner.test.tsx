import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Effect = () => void | (() => void);
type Slot = { value?: unknown; deps?: readonly unknown[]; initialized?: boolean;
  setter?: (next: unknown) => void; cleanup?: () => void };
type Frame = { slots: Slot[]; cursor: number; dirty: boolean; live: boolean;
  layouts: { slot: Slot; effect: Effect }[]; effects: { slot: Slot; effect: Effect }[] };
const runtime = vi.hoisted(() => ({
  frame: null as Frame | null,
  params: { id: "7" },
  session: { username: "doctor-a", role: "doctor", permissions: null } as
    { username: string; role: string; permissions: Record<string, boolean> | null } | null,
}));

// Stub leaf workspaces so this suite exercises the real page owner without
// mounting unrelated clinical readers. The assessment banner remains real.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/SessionProvider", () => ({ useSession: () => runtime.session }));
vi.mock("@/components/SettingsProvider", () => ({ useSetting: () => "" }));
vi.mock("@/components/PatientLedger", () => ({ PatientLedger: "mock-ledger" }));
vi.mock("@/components/LegacyHistory", () => ({ LegacyHistory: "mock-history" }));
vi.mock("@/components/PatientPlans", () => ({ PatientPlans: "mock-plans" }));
vi.mock("@/components/DentalChart", () => ({ DentalChart: "mock-chart" }));
vi.mock("@/components/PatientDocuments", () => ({ PatientDocuments: "mock-documents" }));
vi.mock("@/components/PatientOrtho", () => ({ PatientOrtho: "mock-ortho" }));
vi.mock("@/components/PatientEndo", () => ({ PatientEndo: "mock-endo" }));
vi.mock("@/components/PatientLabOrders", () => ({ PatientLabOrders: "mock-lab" }));
vi.mock("@/components/PatientReferrals", () => ({ PatientReferrals: "mock-referrals" }));
vi.mock("@/components/PatientCases", () => ({ PatientCases: "mock-cases" }));
vi.mock("@/components/PatientMaterials", () => ({ PatientMaterials: "mock-materials" }));
vi.mock("@/components/QuickAppointmentModal", () => ({ QuickAppointmentModal: "mock-booking" }));
vi.mock("@/components/PrescriptionModal", () => ({ PrescriptionModal: "mock-prescription" }));
vi.mock("@/components/ConsentModal", () => ({ ConsentModal: "mock-consent" }));
vi.mock("@/components/PostOpModal", () => ({ PostOpModal: "mock-postop" }));
vi.mock("@/components/CollectPaymentModal", () => ({ CollectPaymentModal: "mock-collect" }));
vi.mock("@/components/CaseProfitabilityModal", () => ({ CaseProfitabilityModal: "mock-profitability" }));
vi.mock("@/components/ChairsideTabletView", () => ({ ChairsideTabletView: "mock-tablet" }));
vi.mock("@/components/VitalsModal", () => ({ VitalsModal: "mock-vitals" }));
vi.mock("@/components/MedicalHistoryPanel", () => ({ MedicalHistoryPanel: "mock-medical-history" }));
vi.mock("@/components/PatientContactPanel", () => ({ PatientContactPanel: "mock-contact", PatientFlagChips: "mock-flags" }));
vi.mock("@/components/PatientFamilyPanel", () => ({ PatientFamilyPanel: "mock-family" }));
vi.mock("@/components/patient/SummaryTab", () => ({ SummaryTab: "mock-summary" }));
vi.mock("@/components/patient/TodayVisitTab", () => ({ TodayVisitTab: "mock-today" }));
vi.mock("@/components/patient/PatientCockpit", () => ({ PatientCockpit: "mock-cockpit" }));
vi.mock("@/lib/patient-navigation", async (original) => ({
  ...await original<typeof import("../lib/patient-navigation")>(),
  // These tests do not navigate tabs; retain the real initial URL parser.
  createPatientNavigation: () => ({ navigate: () => true }),
}));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = () => {
    const frame = runtime.frame!;
    const index = frame.cursor++;
    return frame.slots[index] ?? (frame.slots[index] = {});
  };
  const unchanged = (previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined) =>
    previous !== undefined && next !== undefined && previous.length === next.length
      && previous.every((value, index) => Object.is(value, next[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const entry = slot();
    if (!entry.initialized || !unchanged(entry.deps, deps)) {
      entry.value = factory(); entry.deps = deps; entry.initialized = true;
    }
    return entry.value;
  };
  const effect = (callback: Effect, deps: readonly unknown[] | undefined, layout: boolean) => {
    const entry = slot();
    if (!entry.initialized || !unchanged(entry.deps, deps)) {
      entry.deps = deps; entry.initialized = true;
      runtime.frame![layout ? "layouts" : "effects"].push({ slot: entry, effect: callback });
    }
  };
  return { ...react,
    use: () => runtime.params,
    useState: (initial?: unknown) => {
      const frame = runtime.frame!; const entry = slot();
      if (!entry.initialized) {
        entry.initialized = true;
        entry.value = typeof initial === "function" ? initial() : initial;
        entry.setter = (next: unknown) => {
          if (!frame.live) return;
          const value = typeof next === "function" ? next(entry.value) : next;
          if (!Object.is(entry.value, value)) { entry.value = value; frame.dirty = true; }
        };
      }
      return [entry.value, entry.setter];
    },
    useRef: (initial: unknown) => {
      const entry = slot();
      if (!entry.initialized) { entry.value = { current: initial }; entry.initialized = true; }
      return entry.value;
    },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (callback: Effect, deps?: readonly unknown[]) => effect(callback, deps, false),
    useLayoutEffect: (callback: Effect, deps?: readonly unknown[]) => effect(callback, deps, true),
  };
});

import PatientFilePage from "../app/patients/[id]/page";
import { AssessmentBanner } from "../components/AssessmentBanner";
import { LegacyCaseBanner } from "../components/LegacyCaseBanner";

type Element = ReactElement<Record<string, unknown>>;
type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function words(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(words).join(" ");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node && typeof node === "object" && "props" in node ? words((node as Element).props.children as ReactNode) : "";
}
function child(tree: ReactNode, type: string): Element {
  const found = elements(tree).find((element) => element.type === type);
  if (!found) throw new Error(`Expected rendered ${type}`);
  return found;
}
function bannerWords(tree: ReactNode): string {
  return elements(tree).filter((element) => element.type === AssessmentBanner)
    .map((element) => words(AssessmentBanner(element.props as Parameters<typeof AssessmentBanner>[0]))).join(" ");
}
function legacyBannerWords(tree: ReactNode): string {
  return elements(tree).filter((element) => element.type === LegacyCaseBanner)
    .map((element) => words(LegacyCaseBanner(element.props as Parameters<typeof LegacyCaseBanner>[0]))).join(" ");
}
function hasFile(tree: ReactNode): boolean {
  return elements(tree).some((element) => element.props["data-testid"] === "patient-workspace");
}
const mounted = new Set<{ unmount: () => void }>();
function pageOwner(id: number): Element {
  runtime.params = { id: String(id) };
  return PatientFilePage({ params: Promise.resolve(runtime.params) }) as Element;
}
function mountPage(id = 7, search = "?tab=treatment&sub=endo") {
  window.location.search = search;
  const owner = pageOwner(id);
  const frame: Frame = { slots: [], cursor: 0, dirty: false, live: true, layouts: [], effects: [] };
  const commit = (pending: Frame["effects"]) => {
    // Changed effects retire their prior lease before installing a new one.
    for (const entry of pending) { entry.slot.cleanup?.(); entry.slot.cleanup = undefined; }
    for (const entry of pending) { const cleanup = entry.effect(); if (cleanup) entry.slot.cleanup = cleanup; }
  };
  const render = (): ReactNode => {
    if (!frame.live) throw new Error("Cannot render an unmounted page");
    for (let turn = 0; turn < 25; turn++) {
      runtime.frame = frame; frame.cursor = 0; frame.dirty = false; frame.layouts = []; frame.effects = [];
      const tree = (owner.type as (props: Record<string, unknown>) => ReactNode)(owner.props);
      commit(frame.layouts); commit(frame.effects);
      if (!frame.dirty) return tree;
    }
    throw new Error("Page owner did not settle; inspect dependency handling");
  };
  const view = { owner, render, unmount: () => {
    if (!frame.live) return;
    frame.live = false;
    for (const entry of frame.slots) entry.cleanup?.();
    mounted.delete(view);
  } };
  mounted.add(view); render();
  return view;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let turn = 0; turn < 16; turn++) await Promise.resolve(); };
const reply = (payload: unknown, status = 200): Reply => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const patientFile = (id = 7) => ({ patient: {
  id, fullName: `Synthetic patient ${id}`, patientNumber: `SYN-${id}`, gender: "male",
  phone: null, birthYear: 1990, birthDate: null, medicalAlert: null, flags: [],
}, visits: [], appointments: [] });
const workflow = (patientId = 7, title = "Accepted assessment title") => ({
  patient: { id: patientId }, openVisit: { id: 42, status: "waiting",
    arrivedAt: "2026-10-07T08:00:00Z", chair: null, plannedTitle: null },
  lastVisit: null, nextAppointment: null, activePlans: [], plannedVisits: [],
  counts: { visits: 1, openLabOrders: 0, documents: 0, orthoCase: false },
  financial: null, alerts: [], canSeeFinancial: false,
  assessmentCases: [{ id: 12, patientId, kind: "specialty", orthoCaseId: null,
    specialty: "endodontics", title, needsAssessment: true }], legacyCases: [],
});
function seedFetch(patientId = 7, projection: unknown = workflow(patientId)) {
  const fetcher = vi.fn<(url: string, options?: RequestInit) => Promise<Reply>>()
    .mockRejectedValue(new Error("Unexpected page-owner request"))
    .mockResolvedValueOnce(reply(patientFile(patientId))).mockResolvedValueOnce(reply(projection));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const urls = (fetcher: ReturnType<typeof seedFetch>) => fetcher.mock.calls.map(([url]) => url);

beforeEach(() => {
  runtime.frame = null;
  runtime.session = { username: "doctor-a", role: "doctor", permissions: null };
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: new URL("http://test.invalid/patients/7") }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
});
afterEach(() => {
  for (const view of mounted) view.unmount();
  vi.unstubAllGlobals();
});

describe("real patient page workflow owner", () => {
  it.each([null, 3])("accepts the canonical server visit DTO with chair %s", async (chair) => {
    const projection = { ...workflow(), openVisit: { ...workflow().openVisit, chair,
      status: chair === null ? "waiting" : "in_chair", plannedTitle: chair === null ? null : "Planned care" } };
    seedFetch(7, projection);
    const view = mountPage(); await flush();
    const tree = view.render();
    expect(hasFile(tree)).toBe(true);
    expect((child(tree, "mock-endo").props.workflowIsCurrent as () => boolean)()).toBe(true);
    expect(child(tree, "mock-endo").props.openVisitId).toBe(42);
  });

  it.each([
    { name: "HTTP 500", result: () => reply({}, 500) },
    { name: "null workflow body", result: () => reply(null) },
    { name: "missing assessment array", result: () => reply({ ...workflow(), assessmentCases: undefined }) },
    { name: "foreign patient envelope", result: () => reply({ ...workflow(), patient: { id: 8 } }) },
    { name: "malformed assessment row", result: () => reply({ ...workflow(), assessmentCases: [null] }) },
    { name: "missing counts", result: () => reply({ ...workflow(), counts: undefined }) },
    { name: "zero chair", result: () => reply({ ...workflow(), openVisit: { ...workflow().openVisit, chair: 0 } }) },
    { name: "missing planned title", result: () => reply({ ...workflow(), openVisit: { ...workflow().openVisit, plannedTitle: undefined } }) },
    { name: "invalid visit timestamp", result: () => reply({ ...workflow(), openVisit: { ...workflow().openVisit, arrivedAt: null } }) },
  ])("clears accepted summary/banner on $name while preserving the file and Endo identity", async ({ result }) => {
    const fetcher = seedFetch();
    const view = mountPage(); await flush();
    const accepted = view.render();
    expect(bannerWords(accepted)).toContain("Accepted assessment title");
    const endo = child(accepted, "mock-endo");
    const isCurrent = endo.props.workflowIsCurrent as () => boolean;
    expect(endo.props.workflowReady).toBe(true);
    expect(endo.props.openVisitId).toBe(42);
    expect(isCurrent()).toBe(true);
    const pending = deferred<Reply>();
    fetcher.mockReturnValueOnce(pending.promise);
    (endo.props.onClinicalChange as () => void)();
    expect(isCurrent()).toBe(false); // Command authority is retired synchronously, before rerender.

    const refreshing = view.render();
    expect(hasFile(refreshing)).toBe(true);
    expect(bannerWords(refreshing)).toBe("");
    expect(child(refreshing, "mock-cockpit").props.summary).toBeNull();
    expect(child(refreshing, "mock-endo").props.workflowReady).toBe(false);
    pending.resolve(result()); await flush();
    const unavailable = view.render();
    expect(hasFile(unavailable)).toBe(true);
    expect(words(unavailable)).toContain("Synthetic patient 7");
    expect(bannerWords(unavailable)).toBe("");
    expect(child(unavailable, "mock-cockpit").props.summary).toBeNull();
    const retainedEndo = child(unavailable, "mock-endo");
    expect(retainedEndo.type).toBe(endo.type);
    expect(retainedEndo.key).toBe(endo.key);
    expect(retainedEndo.props.patientId).toBe(endo.props.patientId);
    expect(retainedEndo.props.authorityKey).toBe(endo.props.authorityKey);
    expect(retainedEndo.props.openVisitId).toBe(42);
    expect(retainedEndo.props.workflowReady).toBe(false);
    expect(retainedEndo.props.workflowIsCurrent).toBe(isCurrent);
    expect(isCurrent()).toBe(false);
    // Invoke the actual rendered callback: a refresh fetches only workflow.
    expect(urls(fetcher)).toEqual(["/api/patients/7", "/api/patients/7/workflow", "/api/patients/7/workflow"]);
    expect(fetcher.mock.calls.every(([, options]) => options?.method === undefined || options.method === "GET")).toBe(true);
  });

  it.each([
    { name: "Ortho", search: "?tab=treatment&sub=ortho", leaf: "mock-ortho" },
    { name: "Ledger", search: "?tab=account", leaf: "mock-ledger" },
  ])("reloads shared workflow through the current $name callback without a Cases reader", async ({ search, leaf }) => {
    const fetcher = seedFetch();
    const view = mountPage(7, search); await flush();
    const refresh = child(view.render(), leaf).props.onClinicalChange as () => void;
    fetcher.mockResolvedValueOnce(reply({ ...workflow(), assessmentCases: [] }));
    refresh(); await flush();
    expect(hasFile(view.render())).toBe(true);
    expect(urls(fetcher)).toEqual(["/api/patients/7", "/api/patients/7/workflow", "/api/patients/7/workflow"]);
    expect(urls(fetcher).some((url) => url.endsWith("/cases"))).toBe(false);
  });

  it("retires a nonempty legacy banner on malformed refresh and rejects an older success", async () => {
    const history = { id: 23, patientId: 7, kind: "specialty", orthoCaseId: null,
      specialty: "endodontics", title: "Current historical case", site: "36", status: "active", legacy: true };
    const projection = { ...workflow(), legacyCases: [history] };
    const fetcher = seedFetch(7, projection);
    const view = mountPage(); await flush();
    expect(legacyBannerWords(view.render())).toContain(history.title);
    const refresh = child(view.render(), "mock-endo").props.onClinicalChange as () => void;
    const olderBody = deferred<unknown>();
    fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => olderBody.promise });
    refresh(); await flush();
    expect(legacyBannerWords(view.render())).toBe("");
    fetcher.mockResolvedValueOnce(reply({ ...projection, legacyCases: [{ ...history, patientId: 8 }] }));
    refresh(); await flush();
    olderBody.resolve({ ...projection, legacyCases: [{ ...history, title: "Retired historical title" }] });
    await flush();
    const tree = view.render();
    expect(hasFile(tree)).toBe(true);
    expect(legacyBannerWords(tree)).toBe("");
    expect(bannerWords(tree)).toBe("");
    expect((child(tree, "mock-endo").props.workflowIsCurrent as () => boolean)()).toBe(false);
    expect(urls(fetcher)).toEqual(["/api/patients/7", "/api/patients/7/workflow", "/api/patients/7/workflow", "/api/patients/7/workflow"]);
  });

  it("keeps the accepted visit passed to TodayVisitTab while summary authority is unavailable", async () => {
    const fetcher = seedFetch();
    const view = mountPage(7, "?tab=today"); await flush();
    const accepted = child(view.render(), "mock-today");
    const retained = accepted.props.retainedOpenVisit;
    const isCurrent = accepted.props.workflowIsCurrent as () => boolean;
    expect(retained).toMatchObject({ id: 42 });
    expect(isCurrent()).toBe(true);
    const pending = deferred<Reply>(); fetcher.mockReturnValueOnce(pending.promise);
    window.dispatchEvent(new Event("focus"));
    expect(isCurrent()).toBe(false);
    const refreshing = child(view.render(), "mock-today");
    expect(refreshing.props.summary).toBeNull();
    expect(refreshing.props.retainedOpenVisit).toBe(retained);
    pending.resolve(reply({}, 500)); await flush();
    const unavailable = child(view.render(), "mock-today");
    expect(unavailable.type).toBe(accepted.type);
    expect(unavailable.key).toBe(accepted.key);
    expect(unavailable.props.patientId).toBe(7);
    expect(unavailable.props.summary).toBeNull();
    expect(unavailable.props.retainedOpenVisit).toBe(retained);
    expect(unavailable.props.canCollect).toBe(false);
    expect(unavailable.props.workflowIsCurrent).toBe(isCurrent);
    expect(isCurrent()).toBe(false);
    expect(urls(fetcher)).toEqual(["/api/patients/7", "/api/patients/7/workflow", "/api/patients/7/workflow"]);
  });

  it("retains the summary editor subtree hidden and inert during an ordinary failed refresh", async () => {
    const fetcher = seedFetch();
    const view = mountPage(7, "?tab=summary"); await flush();
    const accepted = child(view.render(), "mock-summary");
    const retained = accepted.props.summary;
    const isCurrent = accepted.props.workflowIsCurrent as () => boolean;
    expect(isCurrent()).toBe(true);
    const pending = deferred<Reply>(); fetcher.mockReturnValueOnce(pending.promise);
    window.dispatchEvent(new Event("focus"));
    expect(isCurrent()).toBe(false);
    const checkRetained = (tree: ReactNode) => {
      expect(hasFile(tree)).toBe(true);
      expect(child(tree, "mock-cockpit").props.summary).toBeNull();
      const summary = child(tree, "mock-summary");
      expect(summary.type).toBe(accepted.type);
      expect(summary.key).toBe(accepted.key);
      expect(summary.props.summary).toBe(retained);
      expect(summary.props.workflowIsCurrent).toBe(isCurrent);
      expect(isCurrent()).toBe(false);
      const wrapper = elements(tree).find((node) => node.type === "div"
        && node.props.hidden === true && node.props.inert === true
        && elements(node.props.children as ReactNode).some((one) => one.type === "mock-summary"));
      expect(wrapper).toBeDefined();
    };
    checkRetained(view.render());
    pending.resolve(reply({}, 500)); await flush();
    checkRetained(view.render());
    expect(urls(fetcher)).toEqual(["/api/patients/7", "/api/patients/7/workflow", "/api/patients/7/workflow"]);
  });

  it("retires the file at current denial headers and cannot restore it from an older successful body", async () => {
    const fetcher = seedFetch();
    const view = mountPage(); await flush();
    const accepted = child(view.render(), "mock-endo");
    const refresh = accepted.props.onClinicalChange as () => void;
    const isCurrent = accepted.props.workflowIsCurrent as () => boolean;
    const olderBody = deferred<unknown>();
    fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => olderBody.promise });
    refresh(); await flush();
    const deniedBody = vi.fn(() => new Promise<unknown>(() => undefined));
    fetcher.mockResolvedValueOnce({ ok: false, status: 403, json: deniedBody });
    refresh(); await flush();
    expect(hasFile(view.render())).toBe(false);
    expect(isCurrent()).toBe(false);
    expect(deniedBody).not.toHaveBeenCalled();
    olderBody.resolve(workflow(7, "Stale success after denial")); await flush();
    const tree = view.render();
    expect(hasFile(tree)).toBe(false);
    expect(words(tree)).not.toContain("Synthetic patient 7");
    expect(bannerWords(tree)).toBe("");
    refresh();
    expect(fetcher).toHaveBeenCalledTimes(4); // Denied ownership also retires retained callbacks.
    expect(urls(fetcher).some((url) => url.endsWith("/cases"))).toBe(false);
  });

  it.each(["principal", "permissions", "signout"] as const)("retires accepted and delayed data after a %s change", async (change) => {
    const fetcher = seedFetch();
    const view = mountPage(); await flush();
    const accepted = child(view.render(), "mock-endo");
    const oldRefresh = accepted.props.onClinicalChange as () => void;
    const oldIsCurrent = accepted.props.workflowIsCurrent as () => boolean;
    const olderBody = deferred<unknown>();
    fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => olderBody.promise });
    oldRefresh(); await flush();
    const nextFile = deferred<Reply>(); const nextWorkflow = deferred<Reply>();
    fetcher.mockReturnValueOnce(nextFile.promise).mockReturnValueOnce(nextWorkflow.promise);
    runtime.session = change === "signout" ? null : { username: change === "principal" ? "doctor-b" : "doctor-a",
      role: "doctor", permissions: change === "permissions" ? { canEditPlans: false } : null };
    const retired = view.render();
    expect(hasFile(retired)).toBe(false);
    expect(oldIsCurrent()).toBe(false);
    expect(bannerWords(retired)).toBe("");
    const count = fetcher.mock.calls.length;
    oldRefresh(); expect(fetcher).toHaveBeenCalledTimes(count);
    olderBody.resolve(workflow(7, "Retired principal title")); await flush();
    expect(hasFile(view.render())).toBe(false);

    nextFile.resolve(reply(patientFile(), change === "signout" ? 401 : 200));
    nextWorkflow.resolve(reply(workflow(7, "Current principal title"), change === "signout" ? 401 : 200));
    await flush();
    const current = view.render();
    expect(oldIsCurrent()).toBe(false);
    expect(bannerWords(current)).not.toContain("Retired principal title");
    expect(hasFile(current)).toBe(change !== "signout");
    if (change !== "signout") {
      expect(bannerWords(current)).toContain("Current principal title");
      expect((child(current, "mock-endo").props.workflowIsCurrent as () => boolean)()).toBe(true);
    }
    else expect(bannerWords(current)).toBe("");
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("uses the actual page's patient key and ignores patient A's completion after B mounts", async () => {
    expect(pageOwner(7).key).not.toBe(pageOwner(8).key);
    const fetcher = seedFetch();
    const a = mountPage(7); await flush();
    const refreshA = child(a.render(), "mock-endo").props.onClinicalChange as () => void;
    const olderBody = deferred<unknown>();
    fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => olderBody.promise });
    refreshA(); await flush(); a.unmount();
    fetcher.mockResolvedValueOnce(reply(patientFile(8))).mockResolvedValueOnce(reply(workflow(8, "Patient B title")));
    const b = mountPage(8); await flush();
    olderBody.resolve(workflow(7, "Patient A late title")); await flush();
    const current = b.render();
    expect(words(current)).toContain("Synthetic patient 8");
    expect(words(current)).not.toContain("Synthetic patient 7");
    expect(bannerWords(current)).toContain("Patient B title");
    expect(bannerWords(current)).not.toContain("Patient A late title");
    refreshA(); expect(fetcher).toHaveBeenCalledTimes(5);
    expect(child(current, "mock-endo").props.patientId).toBe(8);
  });
});
