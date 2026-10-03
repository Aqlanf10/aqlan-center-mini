import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClinicalVisit } from "../components/ClinicalVisit";
import { caseProgress } from "../lib/ortho";

// Source-authored outcome/lifecycle regressions on a fixed, already-linked synthetic visit. No routes,
// database/bootstrap modules, credentials, browser, or actual network are used.
// All peripheral components are stubbed. Actual ClinicalVisit handlers and
// state/effects run in this repository's lightweight hook-harness style.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false, username: "synthetic-doctor",
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void; phase: "layout" | "passive" }>(),
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
        hooks.effects.set(index, { deps, phase: "layout", cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        hooks.effects.set(index, { deps, phase: "passive", cleanup: typeof cleanup === "function" ? cleanup : undefined });
      });
    },
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ role: "doctor", username: hooks.username }) }));
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
let props: Parameters<typeof ClinicalVisit>[0];
let navigationGuard: (() => boolean) | null;
let unload: Set<(event: BeforeUnloadEvent) => void>;
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
const click = (label: string) => {
  const node = render().find((node) => node.type === "button" && contents(node.props.children as ReactNode).trim() === label);
  expect(node.props.disabled).not.toBe(true);
  return (node.props.onClick as () => void | Promise<void>)();
};
const writes = () => fetchMock.mock.calls.filter(([url, options]) => url === clinicalUrl && options?.method === "POST");
const review = () => render().find((node) => node.props["data-testid"] === "saved-specialty-review");
const signButton = () => render().find((node) => node.type === "button" && /وقّع|تأكيد إنهاء/.test(contents(node.props.children as ReactNode)));
async function openReview() {
  await click("مراجعة وإنهاء الزيارة");
  render();
  await vi.waitFor(() => expect(contents(review())).toContain("Recorded Endo clinician"));
}
beforeEach(async () => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  vi.clearAllMocks(); nextRead = null; hooks.username = "synthetic-doctor";
  navigationGuard = null; unload = new Set();
  vi.stubGlobal("window", { confirm: vi.fn(() => false),
    addEventListener: (_kind: string, handler: (event: BeforeUnloadEvent) => void) => unload.add(handler),
    removeEventListener: (_kind: string, handler: (event: BeforeUnloadEvent) => void) => unload.delete(handler) });
  props = { visitId: 91001, structuredRefreshKey: 0, onNavigationGuardChange: (guard) => { navigationGuard = guard; } };
  stored = { id: 91001, patientId: 92001, patientName: "Synthetic patient", ...savedNotes,
    addendum: null, doctorId: 94001, status: "open", signedAt: null, signedBy: null,
    invoiceId: null, procedures: [], totalMinor: 0, planItemsMatched: 0,
    planTitle: null, planWarning: null, ortho: null, plannedVisit: null, previousVisit: null,
    outstanding: [], sessionPricing: [], labOrders: [], billingCurrency: "YER", structuredClinical: ready() };
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
    if (url === "/api/services") return response(200, [service]);
    if (url === "/api/parties?kind=doctor") return response(200, [{ id: 94001, name: "Visit clinician" }]);
    if (url === "/api/patients/92001") return response(200, { medicalAlert: null, phone: null });
    if (url === "/api/visits/91001/billing-preview") return response(200, { duesByCurrency: {}, mixedCurrencies: false, zeroReason: null });
    throw new Error(`Unexpected isolated mock request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render();
  await vi.waitFor(() => expect(field("② التشخيص").props.value).toBe(savedNotes.diagnosis));
});
afterEach(() => { hooks.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });


const byTest = (id: string) => render().find((node) => node.props["data-testid"] === id);
const button = (label: string) => render().find((node) => node.type === "button" && contents(node.props.children as ReactNode).trim() === label);
const invoke = (node: Element) => (node.props.onClick as () => void | Promise<void>)();
const enter = (value: string) => (field("② التشخيص").props.onChange as (text: string) => void)(value);
const hasDialog = () => elements(render().tree).some((node) => node.props.role === "dialog");
async function flush() { for (let pass = 0; pass < 6; pass += 1) { for (let i = 0; i < 20; i += 1) await Promise.resolve(); render(); } }
const signPayload = () => ({ ...structuredClone(stored), status: "signed", signedAt: "2026-10-03T10:00:00Z",
  signedBy: "Synthetic signer", invoiceId: 99101, invoiceCurrency: "SAR", duesMinor: 73450,
  sessionsCompleted: 2, nextPlannedVisit: { id: 99201, title: "Synthetic follow-up", sequence: 3, durationMinutes: 40, afterDays: 14 },
  labOrdersCreated: 1, materialsDeducted: 4 });
function replacePost(handler: () => Promise<MockResponse>) {
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url: string, options?: RequestInit) => url === clinicalUrl && options?.method === "POST"
    ? handler() : original(url, options));
}
function cleanups(phase: "layout" | "passive") {
  hooks.effects.forEach((effect, index) => { if (effect.phase === phase) { effect.cleanup?.(); hooks.effects.delete(index); } });
}

// NEW AUTHORED UNRUN intent regressions on existing linked A/B identities.
describe("already-linked patient-file intent", () => {
  function remountForParent(patientId: number) {
    cleanups("layout"); cleanups("passive");
    hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.memos.clear(); hooks.pending = [];
    props = { ...props, expectedLinkedPatientId: patientId };
    fetchMock.mockClear();
    render();
  }

  it("rejects an initially different linked owner before clinical adoption or auxiliary reads", async () => {
    nextRead = async () => response(200, { ...stored, patientId: 92002,
      patientName: "Different linked owner", diagnosis: "Must not appear under A" });
    remountForParent(92001); await flush();
    expect(contents(render().tree)).toContain("تغيّرت هوية الزيارة أو مريضها");
    expect(contents(render().tree)).not.toContain("Different linked owner");
    expect(contents(render().tree)).not.toContain("Must not appear under A");
    expect(elements(render().tree).some((node) => node.props.label === "② التشخيص")).toBe(false);
    expect(fetchMock.mock.calls.every(([url, options]) => url === clinicalUrl && !options?.method)).toBe(true);
    expect(writes()).toHaveLength(0); expect(hasDialog()).toBe(false);
  });

  it.each([false, true])("binds a linked save to accepted owner A with parent binding=%s", async (parent) => {
    if (parent) { remountForParent(92001); await flush(); }
    enter("Draft belongs to A");
    await click("احفظ بلا توقيع"); await flush();
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0][1].body))).toMatchObject({
      expectedLinkedPatientId: 92001, diagnosis: "Draft belongs to A",
    });
    expect(field("② التشخيص").props.value).toBe("Draft belongs to A");
    expect(button("احفظ بلا توقيع").props.disabled).toBe(false);
  });

  it("retains the entire A draft on the explicit intent denial without refresh, review or replay", async () => {
    remountForParent(92001); await flush();
    const labels = ["① الشكوى الرئيسية", "② الفحص", "② التشخيص", "③ ما نُفّذ", "الخطة القادمة"];
    const currency = render().find((node) => node.props.role === "radio" && contents(node).includes("ريال سعودي"));
    invoke(currency);
    const add = render().find((node) => node.props.ariaLabel === "أضف إجراءً");
    (add.props.onChange as (id: number, value: typeof service) => void)(service.id, service);
    const doctor = render().find((node) => node.type === "select" && node.props.value === 94001);
    (doctor.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "94009" } });
    labels.forEach((label, index) => (field(label).props.onChange as (value: string) => void)(`Retained A ${index}`));
    const readCount = fetchMock.mock.calls.filter(([, options]) => !options?.method).length;
    replacePost(async () => response(409, { code: "visit_patient_changed", message: "Synthetic patient context changed" }));
    await click("مراجعة وإنهاء الزيارة"); await flush();
    const sent = JSON.parse(String(writes()[0][1].body));
    expect(sent).toMatchObject({ expectedLinkedPatientId: 92001, doctorId: 94009, billingCurrency: "SAR" });
    expect(sent.procedures).toHaveLength(1);
    labels.forEach((label, index) => expect(field(label).props.value).toBe(`Retained A ${index}`));
    expect(render().find((node) => node.type === "select" && node.props.value === 94009)).toBeTruthy();
    expect(render().find((node) => node.props.role === "radio" && contents(node).includes("ريال سعودي")).props["aria-checked"]).toBe(true);
    expect(elements(render().tree).filter((node) => node.props["aria-label"] === "الكمية")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([, options]) => !options?.method)).toHaveLength(readCount);
    expect(contents(render().tree)).toContain("Synthetic patient context changed");
    expect(writes()).toHaveLength(1); expect(hasDialog()).toBe(false);
  });

  it("does not adopt or relabel A's held draft when recovery observes linked B", async () => {
    remountForParent(92001); await flush();
    enter("Held A intent");
    nextRead = async () => response(500, { message: "refresh unavailable" });
    await click("مراجعة وإنهاء الزيارة"); await flush();
    nextRead = async () => response(200, { ...stored, patientId: 92002, diagnosis: "Other owner data" });
    await invoke(byTest("clinical-read-recovery")); await flush();
    expect(field("② التشخيص").props.value).toBe("Held A intent");
    expect(contents(render().tree)).not.toContain("Other owner data");
    expect(elements(render().tree).some((node) => node.props["data-testid"] === "clinical-accept-read")).toBe(false);
    expect(JSON.parse(String(writes()[0][1].body)).expectedLinkedPatientId).toBe(92001);
    expect(writes()).toHaveLength(1); expect(hasDialog()).toBe(false);
  });

  it("invalidates same-visit captured A callbacks when parent context changes to B", async () => {
    remountForParent(92001); await flush();
    const oldSave = button("احفظ بلا توقيع");
    const oldNote = field("② التشخيص");
    stored = { ...stored, patientId: 92002, diagnosis: "B's accepted draft" };
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, options?: RequestInit) => url === "/api/patients/92002"
      ? Promise.resolve(response(200, { medicalAlert: null, phone: null })) : original(url, options));
    props = { ...props, expectedLinkedPatientId: 92002 }; render(); await flush();
    await invoke(oldSave);
    (oldNote.props.onChange as (value: string) => void)("Retired A edit");
    expect(field("② التشخيص").props.value).toBe("B's accepted draft");
    expect(writes()).toHaveLength(0);
    await click("احفظ بلا توقيع"); await flush();
    expect(JSON.parse(String(writes()[0][1].body))).toMatchObject({ expectedLinkedPatientId: 92002, diagnosis: "B's accepted draft" });
  });

  it("does not let a late first A read populate a same-visit B parent scope", async () => {
    const pendingA = deferred<MockResponse>();
    nextRead = () => pendingA.promise;
    remountForParent(92001);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, options?: RequestInit) => url === "/api/patients/92002"
      ? Promise.resolve(response(200, { medicalAlert: null, phone: null })) : original(url, options));
    nextRead = async () => response(200, { ...stored, patientId: 92002, diagnosis: "Current B read" });
    props = { ...props, expectedLinkedPatientId: 92002 }; render(); await flush();
    pendingA.resolve(response(200, { ...stored, diagnosis: "Late A read" })); await flush();
    expect(field("② التشخيص").props.value).toBe("Current B read");
    expect(writes()).toHaveLength(0); expect(hasDialog()).toBe(false);
  });

  it("retains unknown-outcome containment if a successful response reports another owner", async () => {
    remountForParent(92001); await flush(); enter("Uncertain A submission");
    replacePost(async () => response(200, { ...stored, patientId: 92002 }));
    await click("مراجعة وإنهاء الزيارة"); await flush();
    expect(JSON.parse(String(writes()[0][1].body)).expectedLinkedPatientId).toBe(92001);
    expect(contents(byTest("clinical-write-hold"))).toContain("نتيجة الطلب غير مؤكدة");
    expect(field("② التشخيص").props.value).toBe("Uncertain A submission");
    expect(field("② التشخيص").props.disabled).toBe(true);
    expect(writes()).toHaveLength(1); expect(hasDialog()).toBe(false);
  });
});

describe("accepted canonical reads own review readiness", () => {
  it.each(["transport", "500", "malformed-json", "malformed-shape", "wrong-visit", "wrong-patient"])(
    "known save followed by %s keeps the submitted draft, prevents review and blocks repeat POST", async (kind) => {
      enter("Submitted diagnosis A");
      const staleReview = button("مراجعة وإنهاء الزيارة");
      nextRead = async () => {
        if (kind === "transport") throw new TypeError("read unavailable");
        if (kind === "malformed-json") return { ok: true, status: 200, json: async () => { throw new SyntaxError("truncated"); } };
        return response(kind === "500" ? 500 : 200, kind === "malformed-shape" ? { id: 91001 }
          : { ...stored, ...(kind === "wrong-visit" ? { id: 99991 } : kind === "wrong-patient" ? { patientId: 99992 } : {}) });
      };
      await invoke(staleReview); await flush();
      expect(hasDialog()).toBe(false); expect(writes()).toHaveLength(1);
      expect(field("② التشخيص").props.value).toBe("Submitted diagnosis A");
      expect(field("② التشخيص").props.disabled).toBe(true);
      expect(contents(byTest("clinical-write-hold"))).toContain("تم قبول الحفظ");
      await invoke(staleReview); await invoke(button("احفظ بلا توقيع"));
      enter("must not replace A"); expect(field("② التشخيص").props.value).toBe("Submitted diagnosis A");
      expect(writes()).toHaveLength(1); expect(navigationGuard?.()).toBe(false);
    });

  it("GET-only recovery shows competing values separately and requires explicit adoption before review", async () => {
    enter("Retained submitted A"); const oldReview = button("مراجعة وإنهاء الزيارة");
    nextRead = async () => response(500, { message: "failed read" });
    await invoke(oldReview); await flush();
    stored = { ...stored, diagnosis: "Competing current B", doctorId: 94009, billingCurrency: "USD" };
    nextRead = async () => response(200, structuredClone(stored));
    const before = fetchMock.mock.calls.length;
    await invoke(byTest("clinical-read-recovery")); await flush();
    expect(fetchMock.mock.calls.slice(before).every(([, options]) => !options?.method)).toBe(true);
    expect(writes()).toHaveLength(1); expect(hasDialog()).toBe(false);
    expect(contents(byTest("clinical-observed-read"))).toContain("Competing current B");
    expect(contents(byTest("clinical-observed-read"))).toContain("94009");
    expect(contents(byTest("clinical-observed-read"))).toContain("USD");
    expect(field("② التشخيص").props.value).toBe("Retained submitted A");
    invoke(byTest("clinical-accept-read")); expect(hasDialog()).toBe(false);
    vi.mocked(window.confirm).mockReturnValue(true);
    invoke(byTest("clinical-accept-read")); await flush();
    expect(field("② التشخيص").props.value).toBe("Competing current B"); expect(hasDialog()).toBe(true);
    expect(writes()).toHaveLength(1);
    await invoke(oldReview); expect(writes()).toHaveLength(1);
  });

  it("denied canonical refresh redacts data even when auxiliary sources fail, then recovers read-only", async () => {
    enter("Private retained diagnosis");
    const original = fetchMock.getMockImplementation()!;
    nextRead = async () => response(403, { message: "permission denied" });
    fetchMock.mockImplementation((url: string, options?: RequestInit) => url === "/api/services"
      ? Promise.reject(new Error("auxiliary unavailable")) : original(url, options));
    await click("مراجعة وإنهاء الزيارة"); await flush();
    expect(contents(render().tree)).not.toContain("Private retained diagnosis"); expect(hasDialog()).toBe(false);
    fetchMock.mockImplementation(original); nextRead = async () => response(200, structuredClone(stored));
    await invoke(byTest("clinical-read-recovery")); await flush();
    expect(field("② التشخيص").props.value).toBe("Private retained diagnosis");
    expect(writes()).toHaveLength(1); expect(field("② التشخيص").props.disabled).toBe(true);
  });

  it.each([400, 409, 422, 429])("definitive %s rejection retains editable draft and the server message", async (status) => {
    enter("Rejected local draft"); replacePost(async () => response(status, { message: "Synthetic definitive rejection" }));
    await click("مراجعة وإنهاء الزيارة"); await flush();
    expect(field("② التشخيص").props.value).toBe("Rejected local draft"); expect(field("② التشخيص").props.disabled).toBe(false);
    expect(contents(render().tree)).toContain("Synthetic definitive rejection"); expect(hasDialog()).toBe(false);
    enter("Corrected new intent"); await click("مراجعة وإنهاء الزيارة"); expect(writes()).toHaveLength(2);
  });
});

describe("unknown mutation outcomes remain held independently of readback", () => {
  it.each(["transport", "500", "408", "malformed-json", "empty", "wrong-visit", "wrong-patient"])(
    "%s after simulated save commit preserves the original draft and never retries", async (kind) => {
      enter("Uncertain submitted A"); const captured = button("مراجعة وإنهاء الزيارة");
      replacePost(async () => {
        stored = { ...stored, diagnosis: "Uncertain submitted A" };
        if (kind === "transport") throw new TypeError("lost after commit");
        if (kind === "malformed-json") return { ok: true, status: 200, json: async () => { throw new SyntaxError("lost body"); } };
        return response(kind === "500" ? 500 : kind === "408" ? 408 : 200,
          kind === "empty" ? null : { ...stored, ...(kind === "wrong-visit" ? { id: 99111 } : kind === "wrong-patient" ? { patientId: 99112 } : {}) });
      });
      await invoke(captured); await flush();
      expect(contents(byTest("clinical-write-hold"))).toContain("غير مؤكدة");
      await invoke(captured); await invoke(button("احفظ بلا توقيع"));
      await invoke(byTest("clinical-read-recovery")); await flush();
      expect(field("② التشخيص").props.value).toBe("Uncertain submitted A"); expect(writes()).toHaveLength(1);
      expect(contents(byTest("clinical-observed-read"))).toContain("Uncertain submitted A");
      expect(elements(render().tree).some((node) => node.props["data-testid"] === "clinical-accept-read")).toBe(false);
      expect(hasDialog()).toBe(false); expect(navigationGuard?.()).toBe(false);
      const event = { preventDefault: vi.fn(), returnValue: undefined };
      unload.forEach((listener) => listener(event as unknown as BeforeUnloadEvent)); expect(event.preventDefault).toHaveBeenCalled();
    });

  it("unchanged GET before a late commit is observation only; later competing state never rebases A silently", async () => {
    enter("Submitted but still running A"); const captured = button("مراجعة وإنهاء الزيارة");
    replacePost(async () => { throw new TypeError("response disconnected; server operation may continue"); });
    await invoke(captured); await flush();
    await invoke(byTest("clinical-read-recovery")); await flush();
    expect(contents(byTest("clinical-observed-read"))).toContain(String(savedNotes.diagnosis));
    await invoke(captured); expect(writes()).toHaveLength(1);
    // Simulate original A finishing later, after the earlier unchanged observation.
    stored = { ...stored, diagnosis: "Submitted but still running A" };
    await invoke(byTest("clinical-read-recovery")); await flush(); await invoke(captured);
    expect(contents(byTest("clinical-observed-read"))).toContain("Submitted but still running A");
    expect(writes()).toHaveLength(1); expect(field("② التشخيص").props.disabled).toBe(true);
    stored = { ...stored, diagnosis: "Other writer B", doctorId: 94009, billingCurrency: "SAR" };
    await invoke(byTest("clinical-read-recovery")); await flush();
    expect(contents(byTest("clinical-observed-read"))).toContain("Other writer B");
    expect(field("② التشخيص").props.value).toBe("Submitted but still running A"); expect(writes()).toHaveLength(1);
    props = { ...props, structuredRefreshKey: 9 }; render(); await flush();
    expect(field("② التشخيص").props.disabled).toBe(true); expect(hasDialog()).toBe(false);
  });

  it("quantity, provider, currency and local notes stay frozen through unknown save and readback", async () => {
    const currency = render().find((node) => node.props.role === "radio" && contents(node).includes("ريال سعودي"));
    invoke(currency);
    const oldCurrency = render().find((node) => node.props.role === "radio" && contents(node).includes("ريال يمني"));
    const add = render().find((node) => node.props.ariaLabel === "أضف إجراءً");
    (add.props.onChange as (id: number, value: typeof service) => void)(service.id, service);
    const quantity = render().find((node) => node.props["aria-label"] === "الكمية");
    (quantity.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "3" } });
    const doctor = render().find((node) => node.type === "select" && node.props.value === 94001);
    (doctor.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "94009" } });
    enter("Exact submission with procedure");
    replacePost(async () => response(500, { message: "post-commit read failed" }));
    await click("مراجعة وإنهاء الزيارة"); await flush();
    const sent = JSON.parse(String(writes()[0][1].body));
    expect(sent).toMatchObject({ diagnosis: "Exact submission with procedure", doctorId: 94009, billingCurrency: "SAR" });
    expect(sent.procedures[0].quantity).toBe(3);
    invoke(oldCurrency);
    (quantity.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "9" } });
    (doctor.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "94001" } });
    await invoke(byTest("clinical-read-recovery")); await flush();
    expect(render().find((node) => node.props["aria-label"] === "الكمية").props.value).toBe(3);
    expect(render().find((node) => node.type === "select" && node.props.value === 94009)).toBeTruthy();
    expect(render().find((node) => node.props.role === "radio" && contents(node).includes("ريال سعودي")).props["aria-checked"]).toBe(true);
    expect(field("② التشخيص").props.value).toBe("Exact submission with procedure"); expect(writes()).toHaveLength(1);
  });
});

describe("signature receipts remain truthful and owner-bound", () => {
  it("known signed success retains nonzero non-base financial result once when GET fails", async () => {
    const onSigned = vi.fn(); props = { ...props, onSigned }; await openReview();
    const confirmed = signPayload(); replacePost(async () => response(200, confirmed));
    nextRead = async () => response(500, { message: "refresh failed" });
    const staleSign = signButton(); await invoke(staleSign); await flush();
    expect(onSigned).toHaveBeenCalledExactlyOnceWith({ invoiceId: 99101, invoiceCurrency: "SAR", duesMinor: 73450,
      sessionsCompleted: 2, nextPlannedVisit: confirmed.nextPlannedVisit, labOrdersCreated: 1, materialsDeducted: 4, patientId: 92001 });
    expect(contents(byTest("clinical-write-hold"))).toContain("تم التوقيع");
    expect(field("② التشخيص").props.disabled).toBe(true); expect(hasDialog()).toBe(false);
    await invoke(staleSign); expect(writes()).toHaveLength(2);
    nextRead = async () => response(200, { ...confirmed });
    await invoke(byTest("clinical-read-recovery")); await flush();
    vi.mocked(window.confirm).mockReturnValue(true); invoke(byTest("clinical-accept-read")); await flush();
    await invoke(staleSign); expect(onSigned).toHaveBeenCalledTimes(1); expect(writes()).toHaveLength(2);
  });

  it("a hard-denied refresh redacts a known signature and suppresses checkout without losing its receipt", async () => {
    const onSigned = vi.fn(); props = { ...props, onSigned }; await openReview();
    const confirmed = signPayload(); replacePost(async () => response(200, confirmed));
    nextRead = async () => response(403, { message: "access retired" });
    await invoke(signButton()); await flush();
    expect(onSigned).not.toHaveBeenCalled();
    expect(elements(render().tree).some((node) => node.props["data-testid"] === "clinical-known-sign-result")).toBe(false);
    expect(contents(render().tree)).not.toContain("Synthetic patient");
    nextRead = async () => response(200, confirmed);
    await invoke(byTest("clinical-read-recovery")); await flush();
    expect(contents(byTest("clinical-known-sign-result"))).toContain("99101");
    expect(onSigned).not.toHaveBeenCalled(); expect(writes()).toHaveLength(2);
  });

  it.each(["visit", "patient"])("a mismatched %s in refreshed identity cannot publish checkout to the captured owner", async (identity) => {
    const onSigned = vi.fn(); props = { ...props, onSigned }; await openReview();
    const confirmed = signPayload(); replacePost(async () => response(200, confirmed));
    nextRead = async () => response(200, { ...confirmed, ...(identity === "visit" ? { id: 91002 } : { patientId: 92002 }) });
    await invoke(signButton()); await flush();
    expect(onSigned).not.toHaveBeenCalled(); expect(contents(byTest("clinical-write-hold"))).toContain("تم التوقيع");
    expect(contents(byTest("clinical-known-sign-result"))).toContain("99101"); expect(writes()).toHaveLength(2);
  });

  it.each(["duesMinor", "invoiceCurrency", "sessionsCompleted", "nextPlannedVisit", "patientId"])(
    "missing %s in a 200 sign response remains unknown, with no fabricated checkout", async (missing) => {
      const onSigned = vi.fn(); props = { ...props, onSigned }; await openReview();
      const malformed: Record<string, unknown> = signPayload(); delete malformed[missing];
      replacePost(async () => response(200, malformed)); const captured = signButton();
      await invoke(captured); await flush();
      stored = { ...stored, status: "signed", signedAt: "2026-10-03T10:00:00Z", invoiceId: 99101 };
      await invoke(byTest("clinical-read-recovery")); await flush(); await invoke(captured);
      expect(onSigned).not.toHaveBeenCalled(); expect(writes()).toHaveLength(2);
      expect(contents(byTest("clinical-observed-read"))).toContain("موقّعة حاليًا");
      expect(contents(byTest("clinical-write-hold"))).toContain("غير مؤكدة");
    });

  it("lost sign response followed by signed GET never recreates operation counters or resends", async () => {
    const onSigned = vi.fn(); props = { ...props, onSigned }; await openReview();
    replacePost(async () => { stored = signPayload(); throw new TypeError("signed response lost"); });
    const captured = signButton(); await invoke(captured); await flush();
    await invoke(byTest("clinical-read-recovery")); await flush(); await invoke(captured);
    expect(onSigned).not.toHaveBeenCalled(); expect(writes()).toHaveLength(2);
    expect(elements(render().tree).some((node) => node.props["data-testid"] === "clinical-known-sign-result")).toBe(false);
  });

  it("known signed response cannot be downgraded by a valid but open read", async () => {
    props = { ...props, onSigned: vi.fn() }; await openReview();
    replacePost(async () => response(200, signPayload()));
    await invoke(signButton()); await flush();
    await invoke(byTest("clinical-read-recovery")); await flush();
    expect(byTest("clinical-accept-read").props.disabled).toBe(true);
    vi.mocked(window.confirm).mockReturnValue(true); invoke(byTest("clinical-accept-read"));
    expect(field("② التشخيص").props.disabled).toBe(true);
  });
});

describe("retired lifecycle continuations cannot publish or unlock another owner", () => {
  it.each(["save", "sign"])("%s completion after suspension stays held and cannot resume a stale callback", async (action) => {
    const onSigned = vi.fn(); props = { ...props, onSigned };
    if (action === "sign") await openReview();
    const gate = deferred<MockResponse>(); replacePost(() => gate.promise);
    const captured = action === "sign" ? signButton() : button("مراجعة وإنهاء الزيارة");
    const pending = invoke(captured); render(); props = { ...props, suspended: true }; render();
    gate.resolve(response(200, action === "sign" ? signPayload() : structuredClone(stored))); await pending; await flush();
    expect(onSigned).not.toHaveBeenCalled(); expect(hasDialog()).toBe(false);
    props = { ...props, suspended: false }; render(); await flush();
    expect(contents(byTest("clinical-write-hold"))).toContain("غير مؤكدة");
    const before = writes().length; await invoke(captured); expect(writes()).toHaveLength(before);
  });

  it.each(["authority", "visit", "visit-aba"])("%s retirement excludes delayed sign callbacks and stale read adoption", async (change) => {
    const onSigned = vi.fn(); props = { ...props, onSigned }; await openReview();
    const gate = deferred<MockResponse>(); const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, options?: RequestInit) => {
      if (url === clinicalUrl && options?.method === "POST") return gate.promise;
      if (url === "/api/visits/91002/clinical") return Promise.resolve(response(200, { ...stored, id: 91002, diagnosis: "Replacement owner" }));
      return original(url, options);
    });
    const old = signButton(); const pending = invoke(old); render();
    if (change === "authority") hooks.username = "replacement-doctor";
    else props = { ...props, visitId: 91002 };
    render(); await flush();
    if (change === "visit-aba") { props = { ...props, visitId: 91001 }; render(); await flush(); }
    const before = fetchMock.mock.calls.length;
    gate.resolve(response(200, signPayload())); await pending; await flush();
    expect(onSigned).not.toHaveBeenCalled(); expect(hasDialog()).toBe(false);
    await invoke(old); expect(fetchMock.mock.calls).toHaveLength(before);
  });

  it("retired recovery GET cannot replace a new visit or release its pending save", async () => {
    nextRead = async () => response(500, { message: "refresh failed" });
    await click("مراجعة وإنهاء الزيارة"); await flush();
    const recovery = deferred<MockResponse>(); nextRead = () => recovery.promise;
    const reading = invoke(byTest("clinical-read-recovery")); render();
    const replacementWrite = deferred<MockResponse>();
    const original = fetchMock.getMockImplementation()!;
    const replacement = { ...stored, id: 91002, diagnosis: "Replacement locked draft" };
    fetchMock.mockImplementation((url: string, options?: RequestInit) => url === "/api/visits/91002/clinical"
      ? options?.method === "POST" ? replacementWrite.promise : Promise.resolve(response(200, replacement)) : original(url, options));
    props = { ...props, visitId: 91002 }; render(); await flush();
    await invoke(button("احفظ بلا توقيع")); render();
    recovery.resolve(response(200, { ...stored, diagnosis: "Late retired recovery" })); await reading; await flush();
    expect(field("② التشخيص").props.value).toBe("Replacement locked draft");
    expect(button("احفظ بلا توقيع").props.disabled).toBe(true); expect(navigationGuard?.()).toBe(false);
    replacementWrite.resolve(response(200, replacement)); await flush();
    expect(button("احفظ بلا توقيع").props.disabled).toBe(false);
  });

  it("suspended recovery read is not accepted after same-scope resume", async () => {
    enter("Held draft before recovery"); replacePost(async () => response(500, { message: "unknown" }));
    await click("مراجعة وإنهاء الزيارة"); await flush();
    const recovery = deferred<MockResponse>(); nextRead = () => recovery.promise;
    const pending = invoke(byTest("clinical-read-recovery")); render();
    props = { ...props, suspended: true }; render(); props = { ...props, suspended: false }; render();
    recovery.resolve(response(200, { ...stored, diagnosis: "Retired observed read" })); await pending; await flush();
    expect(field("② التشخيص").props.value).toBe("Held draft before recovery");
    expect(elements(render().tree).some((node) => node.props["data-testid"] === "clinical-observed-read")).toBe(false);
    expect(byTest("clinical-read-recovery").props.disabled).toBe(false); expect(writes()).toHaveLength(1);
  });

  it("commit-time unmount fences a delayed signature before passive cleanup", async () => {
    const onSigned = vi.fn(); props = { ...props, onSigned }; await openReview();
    const body = deferred<unknown>(); replacePost(async () => ({ ok: true, status: 200, json: () => body.promise }));
    const pending = invoke(signButton()); await Promise.resolve(); cleanups("layout");
    body.resolve(signPayload()); await pending;
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
    expect(onSigned).not.toHaveBeenCalled(); cleanups("passive");
  });

  it("captured note/provider/currency callbacks cannot edit a replacement patient owner", async () => {
    const oldNote = field("② التشخيص");
    const oldDoctor = render().find((node) => node.type === "select" && node.props.value === 94001);
    const oldCurrency = render().find((node) => node.props.role === "radio" && contents(node).includes("ريال سعودي"));
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, options?: RequestInit) => url === "/api/visits/91002/clinical"
      ? Promise.resolve(response(200, { ...stored, id: 91002, diagnosis: "Owned by replacement" })) : original(url, options));
    props = { ...props, visitId: 91002 }; render(); await flush();
    (oldNote.props.onChange as (value: string) => void)("Retired note");
    (oldDoctor.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "94009" } });
    invoke(oldCurrency); render();
    expect(field("② التشخيص").props.value).toBe("Owned by replacement");
    expect(render().find((node) => node.type === "select" && node.props.value === 94001)).toBeTruthy();
    expect(render().find((node) => node.props.role === "radio" && contents(node).includes("ريال يمني")).props["aria-checked"]).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("an explicit departure warning confines an unknown request to its original visit", async () => {
    enter("Original uncertain visit"); replacePost(async () => response(500, { message: "unknown" }));
    await click("مراجعة وإنهاء الزيارة"); await flush();
    expect(navigationGuard?.()).toBe(false); vi.mocked(window.confirm).mockReturnValue(true);
    expect(navigationGuard?.()).toBe(true);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, options?: RequestInit) => url === "/api/visits/91002/clinical"
      ? Promise.resolve(response(200, { ...stored, id: 91002, patientId: 92002, diagnosis: "Different patient draft" }))
      : url === "/api/patients/92002" ? Promise.resolve(response(200, { medicalAlert: null, phone: null })) : original(url, options));
    props = { ...props, visitId: 91002 }; render(); await flush();
    expect(field("② التشخيص").props.value).toBe("Different patient draft"); expect(button("احفظ بلا توقيع").props.disabled).toBe(false);
    expect(elements(render().tree).some((node) => node.props["data-testid"] === "clinical-write-hold")).toBe(false);
    expect(writes()).toHaveLength(1);
  });

  it("documents the mounted-owner limit: confirmed departure/remount drops the latch but never proves or replays the old write", async () => {
    replacePost(async () => response(500, { message: "unknown" }));
    await click("مراجعة وإنهاء الزيارة"); await flush();
    expect(contents(byTest("clinical-write-hold"))).toContain("لا تبقى بعد المغادرة أو إعادة تحميل الصفحة");
    vi.mocked(window.confirm).mockReturnValue(true); expect(navigationGuard?.()).toBe(true);
    cleanups("layout"); cleanups("passive");
    hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.memos.clear(); hooks.pending = [];
    render(); await flush();
    // This is an explicit limitation, not proof that the unknown request failed.
    expect(elements(render().tree).some((node) => node.props["data-testid"] === "clinical-write-hold")).toBe(false);
    expect(button("احفظ بلا توقيع").props.disabled).toBe(false); expect(writes()).toHaveLength(1);
  });

  it("resuming a retired initial read loads its generation without overwriting a retained draft", async () => {
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, options?: RequestInit) => url === "/api/visits/91002/clinical"
      ? Promise.resolve(response(200, { ...stored, id: 91002, diagnosis: "Resumed initial read" })) : original(url, options));
    props = { ...props, visitId: 91002, suspended: true }; render(); await flush();
    props = { ...props, suspended: false }; render(); await flush();
    expect(field("② التشخيص").props.value).toBe("Resumed initial read");
    enter("Retained across suspension"); props = { ...props, suspended: true }; render();
    const before = fetchMock.mock.calls.length; props = { ...props, suspended: false }; render(); await flush();
    expect(field("② التشخيص").props.value).toBe("Retained across suspension"); expect(fetchMock.mock.calls).toHaveLength(before);
  });
});

describe("append-only addendum shares the outcome guard", () => {
  async function signedEditor() {
    await openReview(); await invoke(signButton()); await flush();
    const field = render().find((node) => node.props["aria-label"] === "ملحق");
    (field.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "Exact append-only submission" } });
    return field;
  }
  it("unknown addendum preserves its text and never appends twice", async () => {
    const addendum = await signedEditor(); replacePost(async () => response(500, { message: "audit/read failed after append" }));
    const captured = button("أضف ملحقًا"); await invoke(captured); await flush();
    const count = writes().length; await invoke(captured);
    (addendum.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "must not erase submission" } });
    await invoke(byTest("clinical-read-recovery")); await flush();
    expect(render().find((node) => node.props["aria-label"] === "ملحق").props.value).toBe("Exact append-only submission");
    expect(writes()).toHaveLength(count);
  });
  it("accepted addendum cannot downgrade to editable via stale open GET", async () => {
    await signedEditor(); replacePost(async () => response(200, { ...stored, addendum: "Exact append-only submission" }));
    nextRead = async () => response(200, { ...stored, status: "open", signedAt: null, signedBy: null });
    await invoke(button("أضف ملحقًا")); await flush();
    expect(field("② التشخيص").props.disabled).toBe(true);
    expect(render().find((node) => node.props["aria-label"] === "ملحق").props.value).toBe("Exact append-only submission");
    await invoke(byTest("clinical-read-recovery")); await flush();
    expect(byTest("clinical-accept-read").props.disabled).toBe(true);
  });
});


// Match the actual canonical producer: caseProgress forwards a signed date
// difference. Normal adjustment entry accepts this valid future calendar date;
// no route, DB, clock change, or financial write runs in these linked fixtures.
const futureOrtho = () => ({
  caseId: 99301, appliance: "fixed_metal", phase: "aligning", slot: "022",
  upperWire: "014 NiTi", lowerWire: "012 NiTi", lastAdjustment: "2026-10-05",
  daysSinceLast: caseProgress({ startDate: "2025-10-03", plannedMonths: 18,
    adjustments: 1, lastAdjustmentDate: "2026-10-05", today: "2026-10-03" }).daysSinceLast,
  lastDone: "Synthetic saved adjustment", elastics: "none", elasticNote: null,
  suggestedUpper: "016 NiTi", suggestedLower: "014 NiTi", visitAdjustmentId: null,
  legacyBaseline: false, adjustmentBillingClass: "OUTSIDE_CONTRACT", nextWeeks: 4,
});

describe("canonical signed day-difference compatibility", () => {
  it("accepts a producer-derived negative day difference on initial GET and saved review", async () => {
    stored = { ...stored, ortho: futureOrtho() };
    expect((stored.ortho as ReturnType<typeof futureOrtho>).daysSinceLast).toBe(-2);
    // New mounted instance still uses this same already-linked synthetic visit.
    cleanups("layout"); cleanups("passive");
    hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.memos.clear(); hooks.pending = [];
    render(); await flush();
    expect(field("② التشخيص").props.value).toBe(savedNotes.diagnosis); expect(writes()).toHaveLength(0);
    await click("مراجعة وإنهاء الزيارة"); await flush();
    expect(hasDialog()).toBe(true); expect(writes()).toHaveLength(1);
    expect(elements(render().tree).some((node) => node.props["data-testid"] === "clinical-write-hold")).toBe(false);
  });

  it.each([-1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "-2"])(
    "still rejects non-integer or non-number elapsed days %s", async (daysSinceLast) => {
      stored = { ...stored, ortho: { ...futureOrtho(), daysSinceLast } };
      await click("مراجعة وإنهاء الزيارة"); await flush();
      expect(hasDialog()).toBe(false); expect(contents(byTest("clinical-write-hold"))).toContain("غير مؤكدة");
      expect(writes()).toHaveLength(1);
    });

  it.each(["totalMinor", "planItemsMatched"])("does not relax the nonnegative %s guard", async (key) => {
    stored = { ...stored, ortho: futureOrtho(), [key]: -1 };
    await click("مراجعة وإنهاء الزيارة"); await flush();
    expect(hasDialog()).toBe(false); expect(contents(byTest("clinical-write-hold"))).toContain("غير مؤكدة");
    expect(writes()).toHaveLength(1);
  });
});


const nativeProcedure = (id: unknown) => ({
  id, serviceId: service.id, serviceName: service.name, category: service.category,
  toothCode: 16, surfaces: null, quantity: 1, unitPriceMinor: 400, totalMinor: 400,
  doctorId: 94001, planItemId: 96001, planCurrency: "SAR", note: null,
});
const nativeSessionPrice = (procedureId: unknown) => ({
  procedureId, planItemId: 96001, sessionIndex: 1, sessionCount: 2, priceMinor: 400,
  note: "Synthetic canonical session price",
});

describe("native PostgreSQL-shaped procedure identity compatibility", () => {
  it.each([98001, Number.MAX_SAFE_INTEGER, "98001", "9007199254740993", "9223372036854775807"])(
    "accepts and preserves paired canonical procedure identity %s without conversion", async (id) => {
      stored = { ...stored, procedures: [nativeProcedure(id)], sessionPricing: [nativeSessionPrice(id)], totalMinor: 400 };
      replacePost(async () => response(200, structuredClone(stored)));
      await click("مراجعة وإنهاء الزيارة"); await flush();
      expect(hasDialog()).toBe(true); expect(writes()).toHaveLength(1);
      expect((stored.procedures as Array<{ id: unknown }>)[0].id).toBe(id);
      expect((stored.sessionPricing as Array<{ procedureId: unknown }>)[0].procedureId).toBe(id);
      expect(render().find((node) => node.props["aria-label"] === "الكمية").props.value).toBe(1);
    });

  it.each(["9223372036854775808", Number.MAX_SAFE_INTEGER + 1, "", "0", "01", "+1", "-1", " 1", "1 ", "1e3", "1.0", null])(
    "rejects noncanonical or unsafe procedure identity %s", async (id) => {
      stored = { ...stored, procedures: [nativeProcedure(id)], sessionPricing: [nativeSessionPrice(id)] };
      replacePost(async () => response(200, structuredClone(stored)));
      await click("مراجعة وإنهاء الزيارة"); await flush();
      expect(hasDialog()).toBe(false); expect(contents(byTest("clinical-write-hold"))).toContain("غير مؤكدة");
      expect(writes()).toHaveLength(1);
    });

  it("validates the copied sessionPricing identity separately without weakening other ID or amount fields", async () => {
    stored = { ...stored, procedures: [nativeProcedure("98001")], sessionPricing: [nativeSessionPrice("9223372036854775808")] };
    replacePost(async () => response(200, structuredClone(stored)));
    await click("مراجعة وإنهاء الزيارة"); await flush();
    expect(hasDialog()).toBe(false); expect(contents(byTest("clinical-write-hold"))).toContain("غير مؤكدة");
  });

  it.each(["unitPriceMinor", "quantity", "serviceId", "doctorId", "planItemId"])(
    "does not extend decimal-string acceptance to procedure %s", async (key) => {
      stored = { ...stored, procedures: [{ ...nativeProcedure("98001"), [key]: "1" }], sessionPricing: [] };
      replacePost(async () => response(200, structuredClone(stored)));
      await click("مراجعة وإنهاء الزيارة"); await flush();
      expect(hasDialog()).toBe(false); expect(contents(byTest("clinical-write-hold"))).toContain("غير مؤكدة");
    });
});


const persistedOutstanding = (billingRule: string) => ({
  planItemId: 96001, serviceId: service.id, planTitle: "Synthetic package agreement",
  serviceName: service.name, toothCode: 16, billingRule, sessionCount: 2, doneSessions: 0,
  unitPriceMinor: 73450, quantity: 1, status: "planned", planCurrency: "SAR",
  includedByAgreement: true, unmetRequirements: [],
});

describe("current persisted plan billing-rule compatibility", () => {
  it("accepts the package enum emitted by the current plan-item producer without staging or signing", async () => {
    stored = { ...stored, outstanding: [persistedOutstanding("package")] };
    replacePost(async () => response(200, structuredClone(stored)));
    await click("مراجعة وإنهاء الزيارة"); await flush();
    expect(hasDialog()).toBe(true); expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes()[0][1].body)).procedures).toEqual([]);
    expect(JSON.parse(String(writes()[0][1].body)).action).not.toBe("sign");
    expect((stored.outstanding as Array<{ billingRule: string }>)[0].billingRule).toBe("package");
  });

  it.each(["PACKAGE", "package ", "arbitrary-rule"])("does not accept undocumented billing rule %s", async (billingRule) => {
    stored = { ...stored, outstanding: [persistedOutstanding(billingRule)] };
    replacePost(async () => response(200, structuredClone(stored)));
    await click("مراجعة وإنهاء الزيارة"); await flush();
    expect(hasDialog()).toBe(false); expect(contents(byTest("clinical-write-hold"))).toContain("غير مؤكدة");
  });
});
