import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClinicalVisit } from "../components/ClinicalVisit";
import { PrescriptionModal } from "../components/PrescriptionModal";
import { GET } from "../app/api/patients/[id]/route";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../lib/doctor-permissions";

// Actual ClinicalVisit read ownership, actual patient GET serialization, and
// actual PrescriptionModal display/safety. Database and session boundaries are
// synthetic; no real DB, network, prescription write, or external window runs.
// This lightweight hook harness is not a browser claim. The built-page fixture
// separately covers React effects, user controls, and an isolated real HTTP GET.
type Scope = {
  values: unknown[]; cursor: number; changed: boolean; changes: number;
  effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>;
  memos: Map<number, { deps?: readonly unknown[]; value: unknown }>;
  pending: Array<{ layout: boolean; run: () => void }>;
};
const state = vi.hoisted(() => ({
  active: null as Scope | null,
  username: "synthetic-clinician", role: "doctor",
  permissions: null as import("../lib/doctor-permissions").DoctorPermissions | null,
  getPatientFile: vi.fn(), session: vi.fn(),
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const active = () => { if (!state.active) throw new Error("Missing hook scope"); return state.active; };
  const slot = (scope: Scope, initial: unknown) => {
    const index = scope.cursor++;
    if (!(index in scope.values)) scope.values[index] = initial;
    return index;
  };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const effect = (layout: boolean) => (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const scope = active(); const index = slot(scope, undefined); const previous = scope.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    scope.pending.push({ layout, run: () => {
      previous?.cleanup?.(); const cleanup = run();
      scope.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
    } });
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      const scope = active(); const index = slot(scope, typeof initial === "function" ? initial() : initial);
      return [scope.values[index], (value: unknown) => {
        const next = typeof value === "function" ? value(scope.values[index]) : value;
        if (!Object.is(next, scope.values[index])) { scope.changed = true; scope.changes += 1; }
        scope.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => { const scope = active(); return scope.values[slot(scope, { current: initial })]; },
    useCallback: (callback: unknown, deps?: readonly unknown[]) => {
      const scope = active(); const index = slot(scope, undefined); const previous = scope.memos.get(index);
      if (previous && same(previous.deps, deps)) return previous.value;
      scope.memos.set(index, { deps, value: callback }); return callback;
    },
    useMemo: (compute: () => unknown) => { slot(active(), undefined); return compute(); },
    useLayoutEffect: effect(true), useEffect: effect(false),
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: state.username, role: state.role, permissions: state.permissions }) }));
vi.mock("../components/SettingsProvider", () => ({ useSetting: () => "", useClinicName: () => "Synthetic clinic" }));
vi.mock("../components/ToothPicker", () => ({ ToothField: () => null }));
vi.mock("../components/PostOpModal", () => ({ PostOpModal: () => null }));
vi.mock("../components/PatientDiagnosis", () => ({ PatientDiagnosis: () => null }));
vi.mock("../components/Icon", () => ({ Icon: () => null }));
vi.mock("../components/ServiceSelect", () => ({ ServiceSelect: () => null }));
vi.mock("../components/VisitMaterials", () => ({ VisitMaterials: () => null }));
vi.mock("../components/QuickServicePicker", () => ({ QuickServicePicker: () => null }));
vi.mock("@/lib/session", () => ({ requireSession: state.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", getPatientFile: state.getPatientFile,
  deletePatientCascade: vi.fn(), doctorOwnsPatient: vi.fn(), patientHasVisitToday: vi.fn(),
  findUserByUsername: vi.fn(), getSettings: vi.fn(), recordAudit: vi.fn(), updatePatient: vi.fn(),
}));

type Element = ReactElement<Record<string, unknown>>;
type ModalProps = Parameters<typeof PrescriptionModal>[0];
const scope = (): Scope => ({ values: [], cursor: 0, changed: false, changes: 0, effects: new Map(), memos: new Map(), pending: [] });
let visitScope: Scope; let modalScope: Scope;
function renderScope<T>(store: Scope, render: () => T): T {
  state.active = store;
  for (let round = 0; round < 30; round += 1) {
    store.cursor = 0; store.changed = false; store.pending = [];
    const tree = render();
    // React discards effects from renders interrupted by a render-phase update.
    if (store.changed) continue;
    const pending = store.pending.splice(0);
    pending.filter((one) => one.layout).forEach((one) => one.run());
    pending.filter((one) => !one.layout).forEach((one) => one.run());
    if (!store.changed) return tree;
  }
  throw new Error("Synthetic UI did not settle");
}
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return text((node as Element).props.children as ReactNode);
}
const find = (tree: ReactNode, match: (element: Element) => boolean) => {
  const result = elements(tree).find(match); if (!result) throw new Error("Missing synthetic UI control"); return result;
};
const button = (tree: ReactNode, label: string) => find(tree, (node) => node.type === "button" && text(node).trim() === label);
const click = (node: Element) => (node.props.onClick as () => void | Promise<void>)();
const change = (node: Element, value: string) => (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async (): Promise<unknown> => body });
type ReadResponse = ReturnType<typeof response>;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const patientId = 92001;
const patientFile = (id = patientId, medicalAlert: string | null = "Penicillin allergy", phone: string | null = "777100099") => ({
  patient: { id, medicalAlert, phone }, visits: [], appointments: [],
});
function visit(id: number) {
  return { id, patientId: patientId as number | null, patientName: "Synthetic patient", chiefComplaint: "", examination: "", diagnosis: "Existing diagnosis",
    treatmentDone: "", nextPlan: "", addendum: null, doctorId: 94001, status: "open", signedAt: null, signedBy: null,
    invoiceId: null, procedures: [], totalMinor: 0, planItemsMatched: 0, planTitle: null, planWarning: null,
    ortho: null as Record<string, unknown> | null, outstanding: [], sessionPricing: [], labOrders: [], billingCurrency: "YER", plannedVisit: null,
    previousVisit: null, latestDiagnosis: null, activeCases: [] };
}
let visitId: number; let visits: Map<number, ReturnType<typeof visit>>;
let readPatient: (id: number) => Promise<ReadResponse>;
const fetchMock = vi.fn(); const openMock = vi.fn();
const renderVisit = () => renderScope(visitScope, () => ClinicalVisit({ visitId }));
const modalProps = () => find(renderVisit(), (node) => node.type === PrescriptionModal).props as unknown as ModalProps;
const renderModal = (props = modalProps()) => renderScope(modalScope, () => PrescriptionModal(props));
const readCalls = () => fetchMock.mock.calls.filter(([url]) => /^\/api\/patients\/\d+$/.test(url));
async function tick() { for (let count = 0; count < 20; count += 1) await Promise.resolve(); }
async function flush() { for (let count = 0; count < 5; count += 1) { await tick(); renderVisit(); } }
async function mount() { renderVisit(); await flush(); }
async function open() { click(find(renderVisit(), (node) => node.type === "button" && text(node).includes("روشتة طبية (℞)"))); renderVisit(); await flush(); }
const close = () => { modalProps().onClose(); renderVisit(); renderModal(); };
function unmount(store: Scope) { store.effects.forEach((effect) => effect.cleanup?.()); store.effects.clear(); }
beforeEach(() => {
  visitScope = scope(); modalScope = scope(); vi.clearAllMocks();
  state.username = "synthetic-clinician"; state.role = "doctor"; state.permissions = null;
  visitId = 91001; visits = new Map([[91001, visit(91001)], [91002, visit(91002)]]);
  readPatient = async (id) => response(200, patientFile(id));
  state.session.mockResolvedValue({ role: "admin", username: "synthetic-admin" });
  state.getPatientFile.mockImplementation(async (id: number) => patientFile(id));
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const clinical = url.match(/^\/api\/visits\/(\d+)\/clinical$/);
    if (clinical) return response(200, options?.method === "POST" ? { ok: true } : structuredClone(visits.get(Number(clinical[1]))));
    const patient = url.match(/^\/api\/patients\/(\d+)$/);
    if (patient) return readPatient(Number(patient[1]));
    if (/^\/api\/patients\/\d+\/prescriptions$/.test(url)) return response(200, { prescriptions: [], suggestions: [] });
    if (url === "/api/services") return response(200, []);
    if (url === "/api/parties?kind=doctor") return response(200, [{ id: 94001, name: "Synthetic clinician" }]);
    throw new Error(`Unexpected request blocked: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { open: openMock, confirm: vi.fn(() => false), addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { href: "/visits/91001" } });
});
afterEach(() => { unmount(visitScope); unmount(modalScope); vi.unstubAllGlobals(); });

describe("prescription patient context contract", () => {
  it("consumes the actual GET handler envelope and displays its warning and phone in the real modal", async () => {
    readPatient = async (id) => GET(new Request(`http://test.invalid/api/patients/${id}`), { params: Promise.resolve({ id: String(id) }) });
    await mount(); await open();
    expect(state.getPatientFile).toHaveBeenCalledWith(patientId);
    expect(modalProps()).toMatchObject({ patientContextStatus: "ready", medicalAlert: "Penicillin allergy", patientPhone: "777100099" });
    expect(text(renderModal())).toContain("Penicillin allergy");
    click(button(renderModal(), "إضافة دواء جديد"));
    change(find(renderModal(), (node) => node.props.placeholder === "Drug name (e.g. Augmentin / Brufen)"), "Amoxicillin");
    expect(text(renderModal())).toContain("خطر تحسسي حرج (Penicillin Allergy)");
    click(button(renderModal(), "💬إرسال واتساب"));
    expect(openMock).toHaveBeenCalledWith(expect.stringContaining("https://wa.me/967777100099?"), "_blank");
    expect(readCalls()[0][1]).toMatchObject({ cache: "no-store", signal: expect.any(AbortSignal) });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });

  it.each([null, ""])("distinguishes verified empty %j from unknown context", async (empty) => {
    readPatient = async () => response(200, patientFile(patientId, empty, empty));
    await mount(); await open();
    expect(modalProps()).toMatchObject({ patientContextStatus: "ready", medicalAlert: empty, patientPhone: empty });
    expect(text(renderModal())).not.toContain("تعذّر التحقق");
    expect(text(renderModal())).not.toContain("جارٍ تحميل التنبيهات");
    expect(text(renderModal())).not.toContain("إرسال واتساب");
  });

  it.each([
    null, [], {}, { id: patientId, medicalAlert: "Penicillin allergy", phone: "777100099" },
    { patient: null }, { patient: [] }, { patient: { id: patientId + 1, medicalAlert: "wrong", phone: "777100000" } },
    { patient: { id: String(patientId), medicalAlert: null, phone: null } },
    { patient: { id: patientId, phone: null } }, { patient: { id: patientId, medicalAlert: null } },
    { patient: { id: patientId, medicalAlert: [], phone: null } },
    { patient: { id: patientId, medicalAlert: null, phone: 777100099 } },
  ])("rejects malformed/mismatched payload %j as unavailable", async (payload) => {
    readPatient = async () => response(200, payload); await mount(); await open();
    expect(modalProps()).toMatchObject({ patientContextStatus: "unavailable", medicalAlert: null, patientPhone: null });
    expect(text(renderModal())).toContain("حالة الحساسية والمخاطر غير معروفة هنا");
    expect(text(renderModal())).not.toContain("إرسال واتساب");
  });

  it.each([401, 403, 404, 503])("does not turn HTTP %i into a clear/empty safety context", async (status) => {
    await mount(); await open(); expect(modalProps().medicalAlert).toBe("Penicillin allergy"); close();
    readPatient = async () => response(status, patientFile()); await open();
    expect(modalProps()).toMatchObject({ patientContextStatus: "unavailable", medicalAlert: null, patientPhone: null });
    expect(text(renderModal())).toContain("تعذّر التحقق");
    expect(text(renderModal())).not.toContain("Penicillin allergy");
  });

  it.each(["network", "json"])("exposes %s failure, without invented empty context", async (failure) => {
    readPatient = async () => {
      if (failure === "network") throw new Error("Synthetic read failure");
      return { ...response(200, null), json: async () => { throw new SyntaxError("Synthetic invalid JSON"); } };
    };
    await mount(); await open(); expect(modalProps().patientContextStatus).toBe("unavailable");
  });

  it("reports unknown/loading through body decoding, then distinguishes ready", async () => {
    const body = deferred<unknown>(); readPatient = async () => ({ ...response(200, null), json: () => body.promise });
    await mount(); await open();
    expect(modalProps()).toMatchObject({ patientContextStatus: "loading", medicalAlert: null, patientPhone: null });
    expect(text(renderModal())).toContain("عدم ظهور تنبيه الآن لا يعني عدم وجود حساسية");
    body.resolve(patientFile()); await flush(); expect(modalProps().patientContextStatus).toBe("ready");
  });

  it("keeps the null/unlinked patient's context explicitly unavailable without inventing a read", async () => {
    visits.get(visitId)!.patientId = null; await mount();
    expect(readCalls()).toHaveLength(0);
    expect(modalProps()).toMatchObject({ isOpen: false, patientContextStatus: "unavailable", medicalAlert: null, patientPhone: null });
    expect(text(renderModal({ ...modalProps(), isOpen: true }))).toContain("حالة الحساسية والمخاطر غير معروفة هنا");
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid clinical patient identity %j before mounting prescription controls", async (id) => {
    visits.get(visitId)!.patientId = id; await mount();
    expect(readCalls()).toHaveLength(0);
    expect(elements(renderVisit()).some((node) => node.type === PrescriptionModal)).toBe(false);
    expect(elements(renderVisit()).some((node) => node.type === "button" && text(node).includes("روشتة طبية (℞)"))).toBe(false);
    expect(text(renderVisit())).toContain("بيانات الزيارة غير مكتملة. أعد تحميلها قبل التوثيق.");
    expect(text(button(renderVisit(), "أعد تحميل الزيارة"))).toBe("أعد تحميل الزيارة");
  });

});

describe("prescription context request lifetimes", () => {
  it.each(["headers", "body"])("retires late %s on close/reopen for the same patient", async (stage) => {
    const headers = deferred<ReadResponse>(); const body = deferred<unknown>(); const decode = vi.fn(() => body.promise);
    let reads = 0;
    readPatient = async () => ++reads === 1
      ? stage === "headers" ? headers.promise : { ...response(200, null), json: decode }
      : response(200, patientFile(patientId, "Fresh alert", "777100088"));
    await mount(); await open(); close(); await open();
    expect(modalProps()).toMatchObject({ medicalAlert: "Fresh alert", patientPhone: "777100088" });
    headers.resolve({ ...response(200, null), json: decode }); body.resolve(patientFile(patientId, "Retired alert", "777100077")); await flush();
    expect(modalProps()).toMatchObject({ patientContextStatus: "ready", medicalAlert: "Fresh alert", patientPhone: "777100088" });
    if (stage === "headers") expect(decode).not.toHaveBeenCalled();
    expect(readCalls()).toHaveLength(2);
  });

  it.each(["visit", "principal", "permissions"].flatMap((owner) => ["headers", "body"].map((stage) => [owner, stage])))("retires %s A→B→A context while the first A %s is pending", async (owner, stage) => {
    const oldHeaders = deferred<ReadResponse>(); const oldBody = deferred<unknown>(); let reads = 0;
    const decode = vi.fn(() => oldBody.promise);
    readPatient = async () => ++reads === 1 ? stage === "headers" ? oldHeaders.promise : { ...response(200, null), json: decode }
      : response(200, patientFile(patientId, `Current read ${reads}`, "777100088"));
    await mount(); await open();
    if (owner === "visit") visitId = 91002;
    if (owner === "principal") state.username = "synthetic-other";
    if (owner === "permissions") state.permissions = { ...DEFAULT_DOCTOR_PERMISSIONS, canViewAllPatients: true };
    renderVisit(); await flush(); await open();
    if (owner === "visit") visitId = 91001;
    if (owner === "principal") state.username = "synthetic-clinician";
    if (owner === "permissions") state.permissions = null;
    renderVisit(); await flush(); await open();
    expect(modalProps().medicalAlert).toBe("Current read 3");
    oldHeaders.resolve({ ...response(200, null), json: decode });
    oldBody.resolve(patientFile(patientId, "Retired first A", "777100077")); await flush();
    if (stage === "headers") expect(decode).not.toHaveBeenCalled();
    expect(modalProps()).toMatchObject({ medicalAlert: "Current read 3", patientPhone: "777100088" });
  });

  it.each(["headers", "body"])("retires patient A→B→A with pending %s on a retained same-visit component", async (stage) => {
    const oldHeaders = deferred<ReadResponse>(); const oldBody = deferred<unknown>(); let reads = 0;
    const decode = vi.fn(() => oldBody.promise);
    readPatient = async (id) => ++reads === 1 ? stage === "headers" ? oldHeaders.promise : { ...response(200, null), json: decode }
      : response(200, patientFile(id, `Patient ${id}, read ${reads}`, "777100088"));
    await mount(); await open();
    for (const id of [92002, patientId]) {
      visits.get(visitId)!.patientId = id;
      await click(button(renderVisit(), "احفظ بلا توقيع")); await flush();
      expect(modalProps().medicalAlert).toBe(`Patient ${id}, read ${reads}`);
    }
    oldHeaders.resolve({ ...response(200, null), json: decode });
    oldBody.resolve(patientFile(patientId, "Retired patient A", "777100077")); await flush();
    if (stage === "headers") expect(decode).not.toHaveBeenCalled();
    expect(modalProps().medicalAlert).toBe(`Patient ${patientId}, read 3`);
  });

  it.each(["headers", "body"])("does not update after unmount with pending %s", async (stage) => {
    const headers = deferred<ReadResponse>(); const body = deferred<unknown>();
    readPatient = async () => stage === "headers" ? headers.promise : { ...response(200, null), json: () => body.promise };
    await mount(); await open(); unmount(visitScope); const changes = visitScope.changes;
    headers.resolve(response(200, patientFile())); body.resolve(patientFile()); await tick();
    expect(visitScope.changes).toBe(changes);
  });

  it("keeps signed visit notes immutable while refreshing prescription context", async () => {
    visits.get(visitId)!.status = "signed";
    await mount(); await open();
    expect(modalProps()).toMatchObject({ medicalAlert: "Penicillin allergy", defaultDiagnosis: "Existing diagnosis" });
    const diagnosis = find(renderVisit(), (node) => node.props.label === "② التشخيص");
    expect(diagnosis.props.disabled).toBe(true);
    close(); await open();
    expect(modalProps().defaultDiagnosis).toBe("Existing diagnosis");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });

  it("does not let a retired success erase a newer same-patient denial", async () => {
    const oldBody = deferred<unknown>(); let reads = 0;
    readPatient = async () => ++reads === 1 ? { ...response(200, null), json: () => oldBody.promise }
      : response(403, { message: "Synthetic denied" });
    await mount(); await open(); close(); await open();
    expect(modalProps().patientContextStatus).toBe("unavailable");
    oldBody.resolve(patientFile()); await flush();
    expect(modalProps()).toMatchObject({ patientContextStatus: "unavailable", medicalAlert: null, patientPhone: null });
  });

  it("refreshes only the context while preserving clinical, Ortho, and prescription drafts", async () => {
    visits.get(visitId)!.ortho = { caseId: 95001, appliance: "fixed_metal", phase: "aligning", slot: "022", upperWire: "014", lowerWire: "012",
      lastAdjustment: null, daysSinceLast: null, lastDone: null, elastics: "none", elasticNote: null, suggestedUpper: "016", suggestedLower: "014",
      visitAdjustmentId: null, legacyBaseline: true, nextWeeks: 4, adjustmentBillingClass: "LEGACY_INCLUDED" };
    await mount();
    const note = find(renderVisit(), (node) => node.props.label === "② التشخيص");
    (note.props.onChange as (value: string) => void)("Unsaved visit diagnosis");
    click(button(renderVisit(), "+ شدّة هذه الزيارة (تُحفظ مع التوقيع)"));
    change(find(renderVisit(), (node) => node.props["aria-label"] === "السلك العلوي لهذه الشدّة"), "Custom wire draft");
    await open();
    change(find(renderModal(), (node) => node.props.placeholder === "مثال: Acute Pulpitis / Post-Extraction"), "Explicit Rx diagnosis");
    click(button(renderModal(), "إضافة دواء جديد"));
    change(find(renderModal(), (node) => node.props.placeholder === "Drug name (e.g. Augmentin / Brufen)"), "SyntheticRx");
    const clinicalReads = fetchMock.mock.calls.filter(([url]) => url.endsWith("/clinical")).length;
    close(); readPatient = async () => response(200, patientFile(patientId, "Updated alert", "777100088")); await open();
    expect(modalProps()).toMatchObject({ medicalAlert: "Updated alert", patientPhone: "777100088", defaultDiagnosis: "Unsaved visit diagnosis" });
    expect(find(renderVisit(), (node) => node.props["aria-label"] === "السلك العلوي لهذه الشدّة").props.value).toBe("Custom wire draft");
    expect(find(renderModal(), (node) => node.props.placeholder === "مثال: Acute Pulpitis / Post-Extraction").props.value).toBe("Explicit Rx diagnosis");
    expect(find(renderModal(), (node) => node.props.placeholder === "Drug name (e.g. Augmentin / Brufen)").props.value).toBe("SyntheticRx");
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/clinical"))).toHaveLength(clinicalReads);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });
});

describe("optional PrescriptionModal context status", () => {
  it("preserves existing caller behavior when status is not provided", () => {
    const props = { isOpen: true, onClose: vi.fn(), patientId, patientName: "Synthetic patient", medicalAlert: "Known alert", patientPhone: "777100099" };
    const display = text(renderModal(props));
    expect(display).toContain("Known alert"); expect(display).toContain("إرسال واتساب");
    expect(display).not.toContain("تعذّر التحقق"); expect(display).not.toContain("جارٍ تحميل التنبيهات");
  });
  it.each(["loading", "unavailable"] as const)("renders the explicit %s warning with no fabricated alert", (patientContextStatus) => {
    const display = text(renderModal({ isOpen: true, onClose: vi.fn(), patientId, patientName: "Synthetic patient", patientContextStatus }));
    expect(display).toContain(patientContextStatus === "loading" ? "عدم ظهور تنبيه الآن لا يعني" : "حالة الحساسية والمخاطر غير معروفة هنا");
    expect(display).not.toContain("تنبيه طبي وحساسية للمريض:");
  });
});
