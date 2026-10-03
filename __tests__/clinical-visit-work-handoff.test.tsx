import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClinicalVisit } from "../components/ClinicalVisit";
import { visitWorkFocus, visitWorkSnapshot } from "./fixtures/patient-visit-work";
import type { VisitWorkSnapshot } from "../lib/patient-visit-work";

// Structured-review UI acceptance on a fixed, already-linked synthetic visit. No routes,
// database/bootstrap modules, credentials, browser, or actual network are used.
// All peripheral components are stubbed. Actual ClinicalVisit handlers and
// state/effects run in this repository's lightweight hook-harness style.
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
    useCallback: (callback: unknown, deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.memos.get(index);
      if (previous && same(previous.deps, deps)) return previous.value;
      hooks.memos.set(index, { deps, value: callback });
      return callback;
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
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ role: "doctor" }) }));
vi.mock("../components/SettingsProvider", () => ({ useSetting: () => "Synthetic quick phrase" }));
vi.mock("../components/ToothPicker", () => ({ ToothField: () => null }));
vi.mock("../components/PrescriptionModal", () => ({ PrescriptionModal: () => null }));
vi.mock("../components/PostOpModal", () => ({ PostOpModal: () => null }));
vi.mock("../components/Icon", () => ({ Icon: () => null }));
vi.mock("../components/ServiceSelect", () => ({ ServiceSelect: () => null }));
vi.mock("../components/VisitMaterials", () => ({ VisitMaterials: () => null }));
vi.mock("../components/QuickServicePicker", () => ({ QuickServicePicker: () => null }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function contents(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(contents).join("");
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return contents((node as Element).props.children as ReactNode);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
type MockResponse = ReturnType<typeof response>;
const clinicalUrl = "/api/visits/91001/clinical";
const fetchMock = vi.fn();
const service = { id: 93001, name: "Synthetic filling", category: "filling", priceMinor: 100, priceConfigured: true };
const noteKeys = ["chiefComplaint", "examination", "diagnosis", "treatmentDone", "nextPlan"];
const savedNotes = Object.fromEntries(noteKeys.map((key) => [key, `Synthetic saved ${key}`]));
let stored: Record<string, unknown>;
let work: VisitWorkSnapshot;
let navigationGuard: (() => boolean) | null;
let props: Parameters<typeof ClinicalVisit>[0];
let nextRead: (() => Promise<MockResponse>) | null;
const ready = (version = 3) => ({
  status: "ready", visitId: 91001, patientId: 92001, visitCaseId: null, signedAt: null, signedBy: null,
  endodontics: [{ id: 51, visitId: 91001, patientId: 92001, caseId: 61, treatmentId: 71,
    toothCode: 16, doctorId: 94002, doctorName: "Recorded Endo clinician", version, stage: "shaping",
    recordedAt: "2026-10-03T09:00:00Z", updatedAt: null, canalCount: 2, measuredCanalCount: 1, obturatedCanalCount: 0 }],
  periodontics: [{ id: 81, visitId: 91001, patientId: 92001, caseId: null, doctorId: 94003,
    doctorName: "Recorded Perio clinician", revision: 4, recordedAt: "2026-10-03T09:00:00Z", updatedAt: null,
    siteCount: 3, toothCount: 1, recordedDepthSites: 1, recordedBleedingSites: 2 }],
});
function render() {
  let tree: ReturnType<typeof ClinicalVisit> | null = null;
  let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("Clinical structured review did not settle");
    hooks.cursor = 0; hooks.changed = false;
    tree = ClinicalVisit(props);
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return { tree, find: (predicate: (node: Element) => boolean) => {
    const node = elements(tree).find(predicate);
    if (!node) throw new Error("Missing structured-review control");
    return node;
  } };
}
const field = (label: string) => render().find((node) => node.props.label === label);
const writes = () => fetchMock.mock.calls.filter(([url, options]) => url === clinicalUrl && options?.method === "POST");
beforeEach(async () => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  vi.clearAllMocks(); nextRead = null;
  navigationGuard = null;
  work = visitWorkSnapshot();
  props = { visitId: 91001, structuredRefreshKey: 0, onNavigationGuardChange: (guard) => { navigationGuard = guard; } };
  stored = { id: 91001, patientId: 92001, patientName: "Synthetic patient", ...savedNotes,
    addendum: null, doctorId: 94001, status: "open", signedAt: null, signedBy: null,
    invoiceId: null, procedures: [], totalMinor: 0, planItemsMatched: 0,
    planTitle: null, planWarning: null, ortho: null, plannedVisit: null, previousVisit: null,
    outstanding: work.visit.outstanding, sessionPricing: [], labOrders: [], billingCurrency: "YER", structuredClinical: ready() };
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === clinicalUrl && options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      if (body.action === "sign") {
        stored = { ...stored, status: "signed", signedAt: "2026-10-03T10:00:00Z", signedBy: "Canonical signer" };
        return response(200, { ...stored, invoiceId: null, invoiceCurrency: null, duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null });
      }
      stored = { ...stored, ...body, procedures: Array.isArray(body.procedures)
        ? body.procedures.map((line: Record<string, unknown>, index: number) => ({ id: 98001 + index,
          serviceName: service.name, category: service.category, planItemId: null, ...line,
          planCurrency: line.planItemId ? "SAR" : null })) : stored.procedures };
      return response(200, stored);
    }
    if (url === clinicalUrl && !options?.method) return nextRead ? nextRead() : response(200, structuredClone(stored));
    if (url === "/api/patients/92001/plans") return response(200, { plans: work.plans });
    if (url === "/api/patients/92001/cases") return response(200, work.cases);
    if (url === "/api/patients/92001/workflow") return response(200, work.workflow);
    if (url === "/api/services") return response(200, [service]);
    if (url === "/api/parties?kind=doctor") return response(200, [{ id: 94001, name: "Visit clinician" }]);
    if (url === "/api/patients/92001") return response(200, { medicalAlert: null, phone: null });
    if (url === "/api/visits/91001/billing-preview") return response(200, { duesByCurrency: {}, mixedCurrencies: false, zeroReason: null });
    throw new Error(`Unexpected isolated mock request: ${url}`);
  });
  vi.stubGlobal("window", { confirm: vi.fn(() => false), addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("fetch", fetchMock);
  render();
  await vi.waitFor(() => expect(field("② التشخيص").props.value).toBe(savedNotes.diagnosis));
});
afterEach(() => { hooks.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });


const byTest = (id: string) => render().find((node) => node.props["data-testid"] === id);
const workReview = () => byTest("visit-work-review");
const stage = () => { const button = byTest("visit-work-stage"); expect(button.props.disabled).not.toBe(true); return (button.props.onClick as () => void)(); };
const drafts = () => elements(render().tree).filter((node) => node.props["data-focused-visit-item"] === String(visitWorkFocus.itemId));
async function openWork() {
  props = { ...props, workFocus: visitWorkFocus }; render();
  await vi.waitFor(() => expect(contents(workReview())).toContain("Assigned plan clinician"));
}

describe("canonical visit work review and explicit staging", () => {
  it("preserves native pg procedure IDs across loaded and fresh work fingerprints", async () => {
    const id = "9007199254740993";
    stored.procedures = [{ id, serviceId: service.id, serviceName: service.name, category: service.category,
      toothCode: 16, surfaces: null, quantity: 1, unitPriceMinor: 400, totalMinor: 400, doctorId: 94001,
      planItemId: 96001, planCurrency: "SAR", note: null }];
    stored.sessionPricing = [{ procedureId: id, planItemId: 96001, sessionIndex: 1, sessionCount: 2,
      priceMinor: 400, note: "Native paired ID" }];
    hooks.effects.forEach((effect) => effect.cleanup?.());
    hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
    render(); await vi.waitFor(() => expect(field("② التشخيص").props.value).toBe(savedNotes.diagnosis));
    await openWork();
    // A lossy/safe-range Number normalization of only the loaded copy would make
    // resolveVisitWork's raw JSON fingerprint differ from this fresh native GET.
    expect(contents(workReview())).toContain("البند موجود"); expect(drafts()).toHaveLength(1);
    const before = writes().length; stage(); render();
    await vi.waitFor(() => expect(byTest("visit-work-stage").props.disabled).toBe(false));
    expect(drafts()).toHaveLength(1); expect(writes()).toHaveLength(before);
  });

  it("navigation reads exact records without staging, saving, copying notes or billing", async () => {
    await openWork();
    expect(writes()).toHaveLength(0); expect(drafts()).toHaveLength(0);
    expect(field("② التشخيص").props.value).toBe(savedNotes.diagnosis);
    expect(contents(workReview())).toContain("خطة #95001");
    expect(contents(workReview())).toContain("بند #96001");
    expect(contents(workReview())).toContain("طبيب الإجراء الحالي: Visit clinician");
    expect(fetchMock.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it("separate human click preserves dirty notes/provider and stages once with canonical item currency", async () => {
    await openWork();
    (field("② التشخيص").props.onChange as (value: string) => void)("Unsaved diagnosis stays"); render();
    const doctor = render().find((node) => node.type === "select" && node.props.value === 94001);
    (doctor.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "94009" } }); render();
    const repeatedClick = byTest("visit-work-stage").props.onClick as () => void;
    repeatedClick(); repeatedClick(); render();
    await vi.waitFor(() => expect(drafts()).toHaveLength(1));
    expect(writes()).toHaveLength(0); expect(field("② التشخيص").props.value).toBe("Unsaved diagnosis stays");
    // Current canonical provider is used despite a different assigned plan doctor.
    const values = elements(drafts()[0]).map((node) => node.props.value);
    expect(render().find((node) => node.type === "select" && node.props.value === 94009)).toBeTruthy();
    expect(values).toContain("4.00");
    expect(contents(workReview())).toContain("البند موجود");
    stage(); render(); expect(drafts()).toHaveLength(1); expect(writes()).toHaveLength(0);
    await vi.waitFor(() => expect(byTest("visit-work-stage").props.disabled).toBe(false));
    const save = render().find((node) => node.type === "button" && contents(node.props.children as ReactNode).trim() === "احفظ بلا توقيع");
    (save.props.onClick as () => void)();
    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(String(writes()[0][1].body)).procedures[0].doctorId).toBe(94009);
  });
  it("included agreements stage zero via the same handler; dependencies remain visible", async () => {
    work.visit.outstanding[0].includedByAgreement = true;
    work.visit.outstanding[0].unmetRequirements = ["Synthetic clearance still required"];
    await openWork(); expect(contents(workReview())).toContain("Synthetic clearance still required");
    stage(); render(); await vi.waitFor(() => expect(drafts()).toHaveLength(1));
    expect(elements(drafts()[0]).map((node) => node.props.value)).toContain("0.00");
    expect(writes()).toHaveLength(0);
  });
  it("existing saved/staged item is highlighted without a duplicate", async () => {
    stored.procedures = [{ id: 98001, serviceId: 93001, serviceName: "Synthetic filling", category: "filling", doctorId: 94008,
      toothCode: 16, surfaces: null, quantity: 1, unitPriceMinor: 400, planItemId: 96001, planCurrency: "SAR", note: null }];
    // Remount reads the already persisted synthetic row without a write.
    hooks.effects.forEach((effect) => effect.cleanup?.()); hooks.values = []; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
    render(); await vi.waitFor(() => expect(field("② التشخيص").props.value).toBe(savedNotes.diagnosis));
    await openWork(); expect(drafts()).toHaveLength(1); const before = writes().length;
    stage(); render(); expect(drafts()).toHaveLength(1); expect(writes()).toHaveLength(before);
  });
  it("removing an unsaved staged row updates the review and explicit re-stage adds only one", async () => {
    await openWork(); stage(); render(); await vi.waitFor(() => expect(drafts()).toHaveLength(1));
    const remove = elements(drafts()[0]).find((node) => node.type === "button" && contents(node.props.children as ReactNode).trim() === "احذف")!;
    (remove.props.onClick as () => void)(); render(); expect(drafts()).toHaveLength(0);
    expect(contents(byTest("visit-work-stage"))).toContain("أضف هذا البند");
    stage(); render(); await vi.waitFor(() => expect(drafts()).toHaveLength(1)); expect(writes()).toHaveLength(0);
  });
  it("identity edits to an existing staged row fail closed on the next explicit review click", async () => {
    await openWork(); stage(); render(); await vi.waitFor(() => expect(drafts()).toHaveLength(1));
    const tooth = elements(drafts()[0]).find((node) => node.props.value === "16" && typeof node.props.onChange === "function")!;
    (tooth.props.onChange as (value: string) => void)("26"); render(); stage(); render();
    await vi.waitFor(() => expect(contents(workReview())).toContain("تغيّر السجل المحفوظ"));
    expect(drafts()).toHaveLength(1); expect(writes()).toHaveLength(0);
  });
  it("suspending a retired current visit blocks a captured stage callback without discarding its notes", async () => {
    await openWork(); (field("② التشخيص").props.onChange as (value: string) => void)("Retained visit draft"); render();
    const captured = byTest("visit-work-stage").props.onClick as () => void;
    props = { ...props, suspended: true }; render(); const reads = fetchMock.mock.calls.length;
    captured(); render(); expect(fetchMock.mock.calls).toHaveLength(reads);
    expect(field("② التشخيص").props.value).toBe("Retained visit draft"); expect(writes()).toHaveLength(0);
  });
  it("fresh plan-provider drift refuses staging and keeps unsaved work", async () => {
    await openWork();
    (field("② التشخيص").props.onChange as (value: string) => void)("Keep local diagnosis"); render();
    work.plans[0].items[0].doctorId = 94100; stage(); render();
    await vi.waitFor(() => expect(contents(workReview())).toContain("تغيّر السجل المحفوظ"));
    expect(drafts()).toHaveLength(0); expect(writes()).toHaveLength(0);
    expect(field("② التشخيص").props.value).toBe("Keep local diagnosis");
  });
  it.each(["signed", "cancelled", "noncurrent", "hidden"])("fails closed when fresh context becomes %s", async (mode) => {
    await openWork();
    if (mode === "signed") { stored.status = "signed"; stored.signedAt = "2026-10-03T11:00:00Z"; }
    if (mode === "cancelled") work.workflow.openVisit!.status = "cancelled";
    if (mode === "noncurrent") work.workflow.openVisit!.id = 99999;
    if (mode === "hidden") work.cases.planVisible = false;
    stage(); render();
    await vi.waitFor(() => expect(elements(workReview()).some((node) => node.props.role === "alert")).toBe(true));
    expect(writes()).toHaveLength(0); expect(drafts()).toHaveLength(0);
  });
  it("pending check blocks canonical writes and navigation synchronously", async () => {
    await openWork(); const gate = deferred<MockResponse>(); nextRead = () => gate.promise;
    const oldStage = byTest("visit-work-stage").props.onClick as () => void;
    oldStage(); oldStage(); render(); expect(navigationGuard?.()).toBe(false);
    const save = render().find((node) => node.type === "button" && contents(node.props.children as ReactNode).trim() === "احفظ بلا توقيع");
    expect(save.props.disabled).toBe(true); expect(writes()).toHaveLength(0);
    nextRead = null; gate.resolve(response(200, structuredClone(stored)));
    await vi.waitFor(() => expect(drafts()).toHaveLength(1));
    expect(writes()).toHaveLength(0);
  });
  it("cancelled dirty navigation preserves fields; confirmed in-file navigation also retains them", async () => {
    await openWork(); (field("② التشخيص").props.onChange as (value: string) => void)("Kept draft"); render();
    expect(navigationGuard?.()).toBe(false); expect(field("② التشخيص").props.value).toBe("Kept draft");
    vi.mocked(window.confirm).mockReturnValue(true); expect(navigationGuard?.()).toBe(true);
    expect(field("② التشخيص").props.value).toBe("Kept draft"); expect(writes()).toHaveLength(0);
  });
  it.each(["save-review", "sign"])("late %s response cannot open review/checkout or overwrite a new visit", async (action) => {
    const signed = vi.fn(); props = { ...props, onSigned: signed }; render();
    if (action === "sign") {
      const reviewButton = render().find((node) => node.type === "button" && contents(node.props.children as ReactNode).trim() === "مراجعة وإنهاء الزيارة");
      await (reviewButton.props.onClick as () => Promise<void>)(); render();
      await vi.waitFor(() => expect(contents(render().tree)).toContain("Recorded Endo clinician"));
    }
    const gate = deferred<MockResponse>(); const original = fetchMock.getMockImplementation()!;
    const alternate = { ...structuredClone(stored), id: 91002, diagnosis: "New context diagnosis",
      structuredClinical: { ...ready(), visitId: 91002, endodontics: [], periodontics: [] } };
    fetchMock.mockImplementation((url: string, options?: RequestInit) => {
      if (url === clinicalUrl && options?.method === "POST") return gate.promise;
      if (url === "/api/visits/91002/clinical") return Promise.resolve(response(200, alternate));
      if (url === "/api/visits/91002/billing-preview") return Promise.resolve(response(200, { duesByCurrency: {}, mixedCurrencies: false, zeroReason: null }));
      return original(url, options);
    });
    const button = render().find((node) => node.type === "button" && (action === "sign"
      ? /وقّع الزيارة|تأكيد إنهاء/.test(contents(node.props.children as ReactNode))
      : contents(node.props.children as ReactNode).trim() === "مراجعة وإنهاء الزيارة"));
    const pending = (button.props.onClick as () => void | Promise<void>)(); render();
    props = { ...props, visitId: 91002, workFocus: null }; render();
    await vi.waitFor(() => expect(field("② التشخيص").props.value).toBe("New context diagnosis"));
    const before = fetchMock.mock.calls.length;
    gate.resolve(response(200, { ...stored, status: action === "sign" ? "signed" : "open", invoiceId: 99101, invoiceCurrency: "SAR", duesMinor: 400 }));
    await pending; await Promise.resolve(); render();
    expect(field("② التشخيص").props.value).toBe("New context diagnosis");
    expect(elements(render().tree).some((node) => node.props.role === "dialog")).toBe(false);
    expect(signed).not.toHaveBeenCalled(); expect(fetchMock.mock.calls).toHaveLength(before);
  });
  it("a late old-scope stage read cannot unlock a new visit save", async () => {
    await openWork(); const oldRead = deferred<MockResponse>(); const newWrite = deferred<MockResponse>();
    const original = fetchMock.getMockImplementation()!;
    const alternate = { ...structuredClone(stored), id: 91002, diagnosis: "New locked draft",
      structuredClinical: { ...ready(), visitId: 91002, endodontics: [], periodontics: [] } };
    fetchMock.mockImplementation((url: string, options?: RequestInit) => {
      if (url === clinicalUrl && !options?.method) return oldRead.promise;
      if (url === "/api/visits/91002/clinical") return options?.method === "POST" ? newWrite.promise : Promise.resolve(response(200, alternate));
      return original(url, options);
    });
    stage(); render(); props = { ...props, visitId: 91002, workFocus: null }; render();
    await vi.waitFor(() => expect(field("② التشخيص").props.value).toBe("New locked draft"));
    const save = () => render().find((node) => node.type === "button" && contents(node.props.children as ReactNode).trim() === "احفظ بلا توقيع");
    (save().props.onClick as () => void)(); render(); expect(save().props.disabled).toBe(true);
    oldRead.resolve(response(200, structuredClone(stored))); await Promise.resolve(); await Promise.resolve(); render();
    expect(save().props.disabled).toBe(true); expect(navigationGuard?.()).toBe(false);
    newWrite.resolve(response(200, alternate)); await vi.waitFor(() => expect(save().props.disabled).toBe(false));
  });
  it("a late prior-focus response cannot select or stage another item", async () => {
    const gate = deferred<MockResponse>(); nextRead = () => gate.promise;
    props = { ...props, workFocus: visitWorkFocus }; render();
    props = { ...props, workFocus: { ...visitWorkFocus, itemId: 99999 } }; render();
    nextRead = null; gate.resolve(response(200, structuredClone(stored)));
    await vi.waitFor(() => expect(contents(workReview())).toContain("لم يُختر بند بديل"));
    expect(contents(workReview())).toContain("بند #99999"); expect(drafts()).toHaveLength(0); expect(writes()).toHaveLength(0);
  });
});
