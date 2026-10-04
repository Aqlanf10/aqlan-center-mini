import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClinicalVisit } from "../components/ClinicalVisit";

// UI-containment regressions on a fixed, already-linked synthetic visit. No routes,
// database/bootstrap modules, credentials, browser, or actual network are used.
// All peripheral components are stubbed. Actual published ClinicalVisit handlers
// and state/effects run in the reviewed lightweight hook-harness style.
// This release does not import or claim local-rebuild decoder, owner-generation,
// linked-parent, suspension, or ambiguous-write guards.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false, username: "synthetic-doctor", role: "doctor",
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
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ role: hooks.role, username: hooks.username }) }));
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
const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
type MockResponse = ReturnType<typeof response>;
const clinicalUrl = "/api/visits/91001/clinical";
const fetchMock = vi.fn();
const crown = { id: 93001, name: "Synthetic crown", category: "crown", priceMinor: 100, priceConfigured: true };
const bridge = { ...crown, id: 93002, name: "Synthetic bridge", category: "bridge" };
const veneer = { ...crown, id: 93003, name: "Synthetic veneer", category: "veneer" };
const misleading = { ...crown, id: 93004, name: "Crown-looking name only", category: "filling" };
const savedNotes = { chiefComplaint: "Synthetic complaint", examination: "Synthetic exam", diagnosis: "Synthetic diagnosis",
  treatmentDone: "Synthetic performed work", nextPlan: "Synthetic next plan" };
const line = (service = crown, extra: Record<string, unknown> = {}) => ({
  id: 98001, serviceId: service.id, serviceName: service.name, category: service.category,
  toothCode: 16, surfaces: null, quantity: 1, unitPriceMinor: 100, doctorId: 94002,
  planItemId: null, planCurrency: null, ...extra,
});
const order = (extra: Record<string, unknown> = {}) => ({ id: 97001, workType: "Synthetic different work",
  toothCode: 16, status: "sent", labName: "Synthetic laboratory", ...extra });
let stored: Record<string, unknown>;
let props: Parameters<typeof ClinicalVisit>[0];
let catalog: typeof crown[];
let catalogStatus: number;
let nextRead: (() => Promise<MockResponse>) | null;
let nextPost: ((body: Record<string, unknown>) => Promise<MockResponse>) | null;
let signedOrders: ReturnType<typeof order>[];

function render() {
  let tree: ReturnType<typeof ClinicalVisit> | null = null;
  let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("Clinical lab containment did not settle");
    hooks.cursor = 0; hooks.changed = false;
    tree = ClinicalVisit(props);
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return { tree, find: (predicate: (node: Element) => boolean) => {
    const node = elements(tree).find(predicate);
    if (!node) throw new Error("Missing clinical lab containment control");
    return node;
  } };
}
async function flush() {
  for (let pass = 0; pass < 6; pass += 1) {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    render();
  }
}
async function mount() { render(); await flush(); }
const byTest = (id: string) => render().find((node) => node.props["data-testid"] === id);
const hasTest = (id: string) => elements(render().tree).some((node) => node.props["data-testid"] === id);
const button = (label: string) => render().find((node) => node.type === "button" && contents(node).trim() === label);
const invoke = (node: Element) => (node.props.onClick as () => void | Promise<void>)();
const writes = () => fetchMock.mock.calls.filter(([, options]) => options?.method === "POST");
const labWrites = () => writes().filter(([url]) => url === "/api/lab");
const procedureSection = () => render().find((node) => node.props.id === "visit-procedures");
const rowCount = () => elements(procedureSection()).filter((node) => node.props["aria-label"] === "الكمية").length;
const pick = (service = crown) => {
  const selector = render().find((node) => node.props.ariaLabel === "أضف إجراءً");
  (selector.props.onChange as (id: number, item: typeof crown) => void)(service.id, service);
  render();
};
const signButton = () => render().find((node) => node.type === "button" && /وقّع|تأكيد إنهاء/.test(contents(node)));
const labNodes = () => elements(render().tree).filter((node) => node.props["data-lab-order-id"] !== undefined);
function assertPassiveLabUi() {
  expect(elements(render().tree).filter((node) => node.type === "button" && contents(node).includes("طلب معمل"))).toHaveLength(0);
  const labSection = byTest("clinical-visit-lab-orders");
  expect(elements(labSection).some((node) => Object.keys(node.props).some((key) => /^on[A-Z]/.test(key)))).toBe(false);
  if (hasTest("clinical-lab-sign-guidance")) {
    expect(elements(byTest("clinical-lab-sign-guidance")).some((node) => Object.keys(node.props).some((key) => /^on[A-Z]/.test(key)))).toBe(false);
  }
  expect(labWrites()).toHaveLength(0);
}
function unmount() {
  hooks.effects.forEach((effect) => effect.cleanup?.());
  hooks.effects.clear();
}
function resetHooks() {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
}

beforeEach(() => {
  resetHooks(); vi.clearAllMocks(); hooks.username = "operator-A"; hooks.role = "doctor";
  catalog = [crown, bridge, veneer, misleading]; catalogStatus = 200;
  nextRead = null; nextPost = null; signedOrders = [];
  props = { visitId: 91001 };
  stored = { id: 91001, patientId: 92001, patientName: "Synthetic patient", ...savedNotes,
    addendum: null, doctorId: 94001, status: "open", signedAt: null, signedBy: null,
    invoiceId: null, procedures: [], totalMinor: 0, planItemsMatched: 0, planTitle: null, planWarning: null,
    ortho: null, plannedVisit: null, previousVisit: null, outstanding: [], sessionPricing: [], labOrders: [],
    billingCurrency: "YER" };
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === clinicalUrl && options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      if (nextPost) return nextPost(body);
      if (body.action === "sign") {
        stored = { ...stored, status: "signed", signedAt: "2026-10-03T10:00:00Z", signedBy: "Canonical signer", labOrders: signedOrders };
        return response(200, { ...stored, invoiceCurrency: null, duesMinor: 0, sessionsCompleted: 0,
          nextPlannedVisit: null, labOrdersCreated: signedOrders.length });
      }
      stored = { ...stored, ...body, procedures: Array.isArray(body.procedures)
        ? body.procedures.map((item: Record<string, unknown>, index: number) => {
          const service = catalog.find((entry) => entry.id === item.serviceId) ?? crown;
          return line(service, { ...item, id: 98001 + index, planCurrency: item.planItemId ? "YER" : null });
        }) : stored.procedures };
      return response(200, structuredClone(stored));
    }
    if (url === clinicalUrl && !options?.method) return nextRead ? nextRead() : response(200, structuredClone(stored));
    if (url === "/api/visits/91002/clinical" && !options?.method) return response(200, { ...stored, id: 91002,
      procedures: [], labOrders: [] });
    if (url === "/api/services") return response(catalogStatus, catalog);
    if (url === "/api/parties?kind=doctor") return response(200, [{ id: 94001, name: "Visit clinician A" }, { id: 94002, name: "Line clinician B" }]);
    if (url === "/api/patients/92001") return response(200, { medicalAlert: null, phone: null });
    if (/^\/api\/visits\/9100[12]\/billing-preview$/.test(url)) return response(200, { duesByCurrency: {}, mixedCurrencies: false, zeroReason: null });
    throw new Error(`Unexpected isolated mock request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { confirm: vi.fn(() => false), addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { expect(labWrites()).toHaveLength(0); unmount(); vi.unstubAllGlobals(); });

describe("contextual lab creation is retired", () => {
  it.each(["operator-A", "line-clinician-B", "unrelated-C", "admin"])("never offers saved-row creation for %s", async (operator) => {
    hooks.username = operator; hooks.role = operator === "admin" ? "admin" : "doctor";
    stored.procedures = [line(), line(bridge, { id: 98002 }), line(veneer, { id: 98003 })];
    await mount();
    assertPassiveLabUi(); expect(writes()).toHaveLength(0);
    expect(elements(render().tree).filter((node) => node.props["data-testid"] === "clinical-lab-sign-guidance")).toHaveLength(1);
    expect(contents(byTest("clinical-lab-sign-guidance"))).toContain("تاج، جسر، قشرة (فينير)");
    expect(contents(byTest("clinical-lab-sign-guidance"))).toContain("لا توقّع الزيارة لمجرد إنشاء طلب مختبر");
    expect(contents(byTest("clinical-lab-sign-guidance"))).toContain("إذا لم يوجد طلب قائم وفق قواعد النظام");
  });

  it.each([crown, bridge, veneer])("new explicit catalog selection $category gives information without saving", async (service) => {
    await mount(); pick(service); pick(service);
    expect(rowCount()).toBe(2); expect(writes()).toHaveLength(0); assertPassiveLabUi();
    expect(hasTest("clinical-lab-sign-guidance")).toBe(true);
    await invoke(button("احفظ بلا توقيع")); await flush();
    expect(writes()).toHaveLength(1);
    const sent = JSON.parse(String(writes()[0][1].body));
    expect(sent.action).toBeUndefined();
    expect(sent.procedures.every((item: Record<string, unknown>) => !("labCategory" in item) && !("category" in item))).toBe(true);
    expect(stored.labOrders).toEqual([]); expect(stored.status).toBe("open");
    expect(hasTest("clinical-lab-sign-guidance")).toBe(true);
  });

  it.each([200, 503])("saved canonical category remains authoritative when catalog status=%s", async (status) => {
    stored.procedures = [line()]; catalog = status === 200 ? [{ ...crown, category: "filling" }] : [];
    catalogStatus = status; await mount();
    expect(hasTest("clinical-lab-sign-guidance")).toBe(true); assertPassiveLabUi();
    expect(writes()).toHaveLength(0);
  });

  it("catalog eligibility and a crown-like name cannot override saved ineligible work", async () => {
    stored.procedures = [line(misleading)]; catalog = [{ ...misleading, category: "crown" }];
    await mount(); expect(hasTest("clinical-lab-sign-guidance")).toBe(false);
    expect(writes()).toHaveLength(0); assertPassiveLabUi();
  });

  it.each([null, "prostho", "constructor", "__proto__", "toString"])("saved category %s is not an eligible mapping", async (category) => {
    stored.procedures = [line(crown, { category })];
    await mount(); expect(hasTest("clinical-lab-sign-guidance")).toBe(false);
    expect(writes()).toHaveLength(0); assertPassiveLabUi();
  });

  it.each(["constructor", "__proto__", "toString", "prostho"])("new selected category %s remains ineligible", async (category) => {
    const service = { ...crown, category }; catalog = [service];
    await mount(); pick(service);
    expect(hasTest("clinical-lab-sign-guidance")).toBe(false); expect(writes()).toHaveLength(0);
  });

  it("ineligible new free work gets no promise even if its name contains crown", async () => {
    await mount(); pick(misleading);
    expect(hasTest("clinical-lab-sign-guidance")).toBe(false); expect(writes()).toHaveLength(0);
  });

  it("a plan row with unavailable catalog/category gets no promise until canonical save/read", async () => {
    catalog = []; catalogStatus = 503;
    stored.outstanding = [{ planItemId: 96001, serviceId: crown.id, planTitle: "Synthetic plan", serviceName: crown.name,
      toothCode: 16, billingRule: "per_session", sessionCount: 2, doneSessions: 0, unitPriceMinor: 100,
      quantity: 1, status: "planned", planCurrency: "YER" }];
    await mount(); await invoke(button("+ نفّذ اليوم")); await flush();
    expect(rowCount()).toBe(1); expect(writes()).toHaveLength(0);
    expect(hasTest("clinical-lab-sign-guidance")).toBe(false);
    catalog = [crown]; catalogStatus = 200;
    await invoke(button("احفظ بلا توقيع")); await flush();
    expect(writes()).toHaveLength(1); expect(hasTest("clinical-lab-sign-guidance")).toBe(true);
  });
});

describe("existing orders remain canonical visit-level information", () => {
  it("shows each unrelated same-tooth/null-tooth/manual order once, outside the rows", async () => {
    stored.procedures = [line(), line(bridge, { id: 98002, toothCode: null }), line(veneer, { id: 98003, toothCode: null })];
    stored.labOrders = [order(), order({ id: 97002, workType: "Unrelated toothless A", toothCode: null, status: "needed" }),
      order({ id: 97003, workType: "Unrelated toothless B", toothCode: null, status: "received" }),
      order({ id: 97004, workType: "Legacy manual same-tooth", status: "cancelled" })];
    await mount();
    expect(labNodes().map((node) => node.props["data-lab-order-id"])).toEqual([97001, 97002, 97003, 97004]);
    const list = contents(byTest("clinical-visit-lab-orders"));
    expect(list).toContain("هذه قائمة الزيارة"); expect(list).toContain("لا تثبت ارتباط الطلب بإجراء محدد أو بطبيبه");
    expect(list).toContain("Synthetic different work · سن 16 · عند المختبر");
    expect(list).toContain("Unrelated toothless A · دون سن محدد · لم يُرسل بعد");
    expect(list).toContain("Unrelated toothless B · دون سن محدد · وصل العيادة");
    expect(list).toContain("Legacy manual same-tooth · سن 16 · ملغى");
    expect(contents(procedureSection())).not.toContain("Synthetic different work");
    expect(contents(procedureSection())).not.toContain("Unrelated toothless");
    expect(list).not.toContain("Line clinician B"); assertPassiveLabUi();
  });

  it.each(["legacy-status", "constructor", "__proto__", "toString"])("preserves unknown accepted status %s as plain text", async (status) => {
    stored.labOrders = [order({ status })]; await mount();
    expect(contents(labNodes()[0])).toContain(status); assertPassiveLabUi();
  });

  it.each([false, true])("zero canonical orders invent no success or replay when signed=%s", async (signed) => {
    stored.procedures = [line()];
    if (signed) Object.assign(stored, { status: "signed", signedAt: "2026-10-03T10:00:00Z", signedBy: "Synthetic signer" });
    await mount();
    expect(labNodes()).toHaveLength(0);
    expect(contents(byTest("clinical-visit-lab-orders"))).toContain("لا توجد طلبات مختبر في القراءة الحالية لهذه الزيارة");
    expect(hasTest("clinical-lab-sign-guidance")).toBe(!signed);
    if (signed) expect(elements(render().tree).some((node) => node.type === "button" && /وقّع|تأكيد إنهاء/.test(contents(node)))).toBe(false);
    expect(writes()).toHaveLength(0); assertPassiveLabUi();
  });
});

describe("new lab display requires the loaded visit to match the current prop", () => {
  it("does not display mismatched loaded lab orders or category guidance", async () => {
    stored.id = 91002; stored.procedures = [line()]; stored.labOrders = [order()];
    await mount();
    expect(hasTest("clinical-visit-lab-orders")).toBe(false);
    expect(hasTest("clinical-lab-sign-guidance")).toBe(false);
    expect(labNodes()).toHaveLength(0); expect(writes()).toHaveLength(0);
  });

  it("hides both additions immediately when the visit prop changes, then shows only the new visit list", async () => {
    stored.procedures = [line()]; stored.labOrders = [order()]; await mount();
    expect(labNodes()).toHaveLength(1); expect(hasTest("clinical-lab-sign-guidance")).toBe(true);
    props = { ...props, visitId: 91002 }; render();
    expect(hasTest("clinical-visit-lab-orders")).toBe(false);
    expect(hasTest("clinical-lab-sign-guidance")).toBe(false);
    await flush();
    expect(hasTest("clinical-visit-lab-orders")).toBe(true); expect(labNodes()).toHaveLength(0);
    expect(hasTest("clinical-lab-sign-guidance")).toBe(false); expect(writes()).toHaveLength(0);
    assertPassiveLabUi();
  });
});

describe("ordinary explicit clinical save and sign keep published contracts", () => {
  it("keeps explicit save, review, then explicit sign without lab metadata in either request", async () => {
    stored.procedures = [line()]; signedOrders = [order({ workType: "تاج", status: "needed" })];
    const onSigned = vi.fn(); props = { ...props, onSigned }; await mount();
    assertPassiveLabUi(); expect(writes()).toHaveLength(0);
    await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
    expect(writes()).toHaveLength(1);
    expect(elements(render().tree).some((node) => node.props.role === "dialog")).toBe(true);
    expect(JSON.parse(String(writes()[0][1].body))).toEqual({ ...savedNotes, doctorId: 94001, billingCurrency: "YER",
      procedures: [{ serviceId: crown.id, toothCode: 16, surfaces: null, quantity: 1, unitPriceMinor: 100,
        priceReason: null, doctorId: 94002, planItemId: null }] });
    expect(stored.status).toBe("open"); expect(stored.labOrders).toEqual([]);
    const confirm = signButton(); expect(confirm.props.disabled).toBe(false);
    await invoke(confirm); await flush();
    expect(writes()).toHaveLength(2);
    expect(JSON.parse(String(writes()[1][1].body))).toEqual({ action: "sign", dependencyOverrideReason: null,
      outsideContractDecision: null, orthoSession: null });
    expect(onSigned).toHaveBeenCalledExactlyOnceWith({ invoiceId: null, invoiceCurrency: null, duesMinor: 0,
      sessionsCompleted: 0, nextPlannedVisit: null, labOrdersCreated: 1, materialsDeducted: 0, patientId: 92001 });
    expect(labNodes()).toHaveLength(1); expect(hasTest("clinical-lab-sign-guidance")).toBe(false);
    assertPassiveLabUi();
  });

  it("returning from review leaves an open visit and does not create a lab order", async () => {
    stored.procedures = [line()]; await mount();
    await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
    expect(writes()).toHaveLength(1);
    await invoke(button("رجوع — أكمل العمل")); await flush();
    expect(elements(render().tree).some((node) => node.props.role === "dialog")).toBe(false);
    expect(writes()).toHaveLength(1); expect(stored.status).toBe("open"); assertPassiveLabUi();
  });

  it.each([403, 500])("an explicit failed save (%s) does not itself open review, sign or create a lab order", async (status) => {
    stored.procedures = [line()]; await mount();
    nextPost = async () => response(status, { message: "Synthetic save failure" });
    await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
    expect(writes()).toHaveLength(1);
    expect(elements(render().tree).some((node) => node.props.role === "dialog")).toBe(false);
    expect(stored.status).toBe("open"); expect(stored.labOrders).toEqual([]); assertPassiveLabUi();
  });
});
