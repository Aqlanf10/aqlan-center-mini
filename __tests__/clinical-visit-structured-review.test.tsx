import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClinicalVisit } from "../components/ClinicalVisit";

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
const noteLabels = ["① الشكوى الرئيسية", "② الفحص", "② التشخيص", "③ ما نُفّذ", "الخطة القادمة"];
const noteKeys = ["chiefComplaint", "examination", "diagnosis", "treatmentDone", "nextPlan"];
const savedNotes = Object.fromEntries(noteKeys.map((key) => [key, `Synthetic saved ${key}`]));
let stored: Record<string, unknown>;
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
  vi.clearAllMocks(); nextRead = null;
  props = { visitId: 91001, structuredRefreshKey: 0 };
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

describe("saved specialty review and canonical draft containment", () => {
  it("shows exact saved references, stage, original clinicians and coverage without invented procedures", async () => {
    await openReview();
    const text = contents(review());
    expect(text).toContain("سجل #51"); expect(text).toContain("نوبة #71");
    expect(text).toContain("تشكيل القنوات"); expect(text).toContain("سجل #81");
    expect(text).toContain("Recorded Endo clinician"); expect(text).toContain("Recorded Perio clinician");
    expect(text).not.toContain("Visit clinician");
    expect(text).toContain("التعديلات غير المحفوظة داخل التخصص لا تظهر هنا");
    expect(contents(render().tree)).toContain("لا توجد إجراءات في هذه الزيارة");
    expect(contents(render().tree)).not.toContain("ما يلي إجراءاتٌ حرّة");
    expect(JSON.parse(writes()[0][1].body).procedures).toEqual([]);
    expect(signButton().props.disabled).toBe(false);
  });
  it("refreshes after specialty persistence without changing unsaved notes, procedure quantity or price", async () => {
    for (const [index, label] of noteLabels.entries()) (field(label).props.onChange as (value: string) => void)(`Unsaved ${noteKeys[index]}`);
    const add = render().find((node) => node.props.ariaLabel === "أضف إجراءً");
    (add.props.onChange as (id: number, value: typeof service) => void)(service.id, service);
    const quantity = render().find((node) => node.props["aria-label"] === "الكمية");
    (quantity.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "3" } });
    const price = render().find((node) => node.props["aria-label"] === "السعر");
    (price.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "175" } });
    const before = fetchMock.mock.calls.length;
    const pending = deferred<MockResponse>(); nextRead = () => pending.promise;
    props = { ...props, structuredRefreshKey: 1 }; render();
    pending.resolve(response(200, { ...stored, structuredClinical: ready(5) }));
    await Promise.resolve(); await Promise.resolve(); render();
    noteLabels.forEach((label, index) => expect(field(label).props.value).toBe(`Unsaved ${noteKeys[index]}`));
    expect(render().find((node) => node.props["aria-label"] === "الكمية").props.value).toBe(3);
    expect(render().find((node) => node.props["aria-label"] === "السعر").props.value).toBe("175");
    expect(writes()).toHaveLength(0);
    expect(fetchMock.mock.calls.slice(before).map(([url]) => url)).toEqual([clinicalUrl]);
  });
  it("reloads on review-open and disables signing until the saved projection is ready", async () => {
    const pending = deferred<MockResponse>();
    let calls = 0;
    nextRead = async () => ++calls === 1 ? response(200, structuredClone(stored)) : pending.promise;
    await click("مراجعة وإنهاء الزيارة"); render();
    expect(contents(review())).toContain("جارٍ تحديث السجلات المحفوظة");
    expect(signButton().props.disabled).toBe(true);
    pending.resolve(response(200, { ...stored, structuredClinical: ready(7) }));
    await vi.waitFor(() => expect(contents(review())).toContain("إصدار 7"));
    expect(signButton().props.disabled).toBe(false);
  });
  it("replaces a failed or denied summary with unavailable, hides stale content and retries read-only", async () => {
    await openReview();
    const writeCount = writes().length;
    nextRead = async () => response(403, { message: "Synthetic denied" });
    props = { ...props, structuredRefreshKey: 1 }; render();
    await vi.waitFor(() => expect(contents(review())).toContain("تعذّر التحقق"));
    expect(contents(review())).not.toContain("Recorded Endo clinician");
    expect(contents(review())).not.toContain("لا توجد سجلات جذور");
    expect(signButton().props.disabled).toBe(true);
    nextRead = async () => response(200, { ...stored, structuredClinical: ready(9) });
    click("أعد تحميل التوثيق"); render();
    await vi.waitFor(() => expect(contents(review())).toContain("إصدار 9"));
    expect(writes()).toHaveLength(writeCount);
  });
  it("ignores a late old-token response after a newer specialty save is reviewed", async () => {
    await openReview();
    const old = deferred<MockResponse>(); nextRead = () => old.promise;
    props = { ...props, structuredRefreshKey: 1 }; render();
    nextRead = async () => response(200, { ...stored, structuredClinical: ready(11) });
    props = { ...props, structuredRefreshKey: 2 }; render();
    await vi.waitFor(() => expect(contents(review())).toContain("إصدار 11"));
    old.resolve(response(200, { ...stored, structuredClinical: ready(2) }));
    await Promise.resolve(); await Promise.resolve();
    expect(contents(review())).toContain("إصدار 11");
    expect(contents(review())).not.toContain("إصدار 2");
  });
  it("distinguishes a successful empty projection from unavailable and preserves canonical signature ownership", async () => {
    await openReview();
    nextRead = async () => response(200, { ...stored, structuredClinical: { ...ready(), endodontics: [], periodontics: [] } });
    props = { ...props, structuredRefreshKey: 1 }; render();
    await vi.waitFor(() => expect(contents(review())).toContain("لا توجد سجلات جذور أو لثة محفوظة لهذه الزيارة"));
    expect(signButton().props.disabled).toBe(false);
    nextRead = async () => response(200, { ...stored, structuredClinical: { ...ready(), signedAt: "2026-10-03T10:00:00Z", signedBy: "Canonical signer" } });
    props = { ...props, structuredRefreshKey: 2 }; render();
    await vi.waitFor(() => expect(contents(review())).toContain("موقّعة بواسطة Canonical signer"));
    expect(signButton().props.disabled).toBe(true);
  });
  it("uses only the existing sign action for documentation-only work and does not manufacture financial lines", async () => {
    const onSigned = vi.fn(); props = { ...props, onSigned };
    await openReview();
    await (signButton().props.onClick as () => void | Promise<void>)();
    await vi.waitFor(() => expect(onSigned).toHaveBeenCalled());
    expect(onSigned).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: null, invoiceCurrency: null, duesMinor: 0 }));
    const sign = writes().map(([, options]) => JSON.parse(options.body)).find((body) => body.action === "sign");
    expect(sign).not.toHaveProperty("procedures"); expect(sign).not.toHaveProperty("structuredClinical");
    expect((stored.procedures as unknown[])).toEqual([]);
  });
});
