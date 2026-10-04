import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClinicalVisit } from "../components/ClinicalVisit";
import { PatientDiagnosis } from "../components/PatientDiagnosis";

// Orthodontic chairside entry regressions on a fixed, already-linked synthetic visit. No routes,
// database/bootstrap modules, credentials, browser, or actual network are used.
// All peripheral components are stubbed. Actual ClinicalVisit handlers
// and state/effects run in the reviewed lightweight hook-harness style.
// This exercises the actual component, without changing clinical sign rules.
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
const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const clinicalUrl = "/api/visits/91001/clinical";
const fetchMock = vi.fn();
const emptyNotes = { chiefComplaint: "", examination: "", diagnosis: "", treatmentDone: "", nextPlan: "" };
const orthodontics = {
  caseId: 95001, appliance: "fixed_metal", phase: "aligning", slot: "022", upperWire: "014 NiTi", lowerWire: "012 NiTi",
  lastAdjustment: "2026-09-01", daysSinceLast: 28, lastDone: "Previous adjustment, not today's work",
  elastics: "none", elasticNote: null, suggestedUpper: "016 NiTi", suggestedLower: "014 NiTi",
  visitAdjustmentId: null, legacyBaseline: true, nextWeeks: 4, adjustmentBillingClass: "LEGACY_INCLUDED",
};
let stored: Record<string, unknown>;
let renderedVisitId = 91001;
let nextPost: ((body: Record<string, unknown>) => Promise<ReturnType<typeof response>>) | null;
let nextRead: (() => Promise<ReturnType<typeof response>>) | null;
let onSigned = vi.fn<() => void>();
function render() {
  let tree: ReturnType<typeof ClinicalVisit> | null = null;
  let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("Clinical orthodontic entry did not settle");
    hooks.cursor = 0; hooks.changed = false;
    tree = ClinicalVisit({ visitId: renderedVisitId, onSigned });
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
const nodes = () => elements(render());
const find = (predicate: (node: Element) => boolean) => {
  const node = nodes().find(predicate);
  if (!node) throw new Error("Missing orthodontic entry control");
  return node;
};
const button = (label: string) => find((node) => node.type === "button" && contents(node).trim() === label);
const field = (label: string) => find((node) => node.props.label === label);
const input = (label: string) => find((node) => node.props["aria-label"] === label);
const invoke = (node: Element) => (node.props.onClick as () => void | Promise<void>)();
const edit = (label: string, value: string) => (input(label).props.onChange as (event: unknown) => void)({ target: { value } });
const setNote = (label: string, value: string) => (field(label).props.onChange as (value: string) => void)(value);
const writes = () => fetchMock.mock.calls.filter(([, options]) => options?.method === "POST");
const bodies = () => writes().map(([, options]) => JSON.parse(String(options.body)) as Record<string, unknown>);
const start = () => invoke(button("+ شدّة هذه الزيارة (تُحفظ مع التوقيع)"));
const save = () => invoke(button("احفظ بلا توقيع"));
const review = () => invoke(button("مراجعة وإنهاء الزيارة"));
const sign = () => invoke(find((node) => node.type === "button" && /وقّع|تأكيد إنهاء/.test(contents(node))));
async function flush() {
  for (let pass = 0; pass < 6; pass += 1) {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    render();
  }
}
async function mount() { render(); await flush(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  hooks.role = "doctor"; hooks.username = "synthetic-doctor";
  renderedVisitId = 91001; vi.clearAllMocks(); nextPost = null; nextRead = null; onSigned = vi.fn<() => void>();
  stored = {
    id: 91001, patientId: 92001, patientName: "Synthetic orthodontic patient", ...emptyNotes,
    addendum: null, doctorId: 94001, status: "open", signedAt: null, signedBy: null, invoiceId: null,
    procedures: [], totalMinor: 0, planItemsMatched: 0, planTitle: null, planWarning: null,
    ortho: { ...orthodontics }, outstanding: [], sessionPricing: [], labOrders: [], billingCurrency: "YER",
    plannedVisit: { id: 96001, title: "Planned adjustment", sequence: 3, planTitle: "Baseline plan", doctorId: 94001, durationMinutes: 30 },
    previousVisit: { id: 91000, date: "2026-09-01", treatmentDone: "Previous visit work", nextPlan: "Previous next plan", proceduresSummary: null },
    latestDiagnosis: { text: "Previous diagnosis is reference only", date: "2026-08-01" },
    activeCases: [{ id: 99001, kind: "specialty", title: "Other active case", specialty: "endo", status: "active", responsibleName: "Responsible clinician", doneSteps: 1, totalSteps: 3, nextStep: "Case next step" }],
    suggestions: { chiefComplaint: "Scheduled adjustment reason", nextPlan: null, doctorId: 94001 },
  };
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === clinicalUrl && options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      if (nextPost) return nextPost(body);
      if (body.action === "sign") {
        stored = { ...stored, status: "signed", signedAt: "2026-10-04T10:00:00Z", signedBy: "Synthetic signer",
          ortho: { ...(stored.ortho as object), visitAdjustmentId: 95002 } };
        return response(200, { invoiceId: null, invoiceCurrency: "YER", duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null });
      }
      stored = { ...stored, ...body };
      return response(200, { ok: true });
    }
    if (/^\/api\/visits\/\d+\/clinical$/.test(url)) return nextRead ? nextRead() : response(200, structuredClone(stored));
    if (url === "/api/services") return response(200, []);
    if (url === "/api/parties?kind=doctor") return response(200, [{ id: 94001, name: "Synthetic clinician" }]);
    if (url === "/api/patients/92001") return response(200, { medicalAlert: null, phone: null });
    if (url === "/api/visits/91001/billing-preview") return response(200, { duesByCurrency: {}, mixedCurrencies: false, zeroReason: "Included adjustment" });
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { confirm: vi.fn(() => false), addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { hooks.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe("orthodontic chairside entry", () => {
  it("does not classify an unrelated visit as orthodontic merely because a case is active", async () => {
    stored.suggestions = { chiefComplaint: "Restorative appointment", nextPlan: null, doctorId: 94001 };
    await mount();
    expect(field("① الشكوى الرئيسية").props.value).toBe("Restorative appointment");
    expect(field("② الفحص")).toBeTruthy(); expect(field("② التشخيص")).toBeTruthy();
    expect(nodes().some((node) => node.props["aria-label"] === "جلسة التقويم اليوم")).toBe(false);
    expect(nodes().some((node) => node.props["data-testid"] === "ortho-visit-reference")).toBe(false);
    expect(nodes().some((node) => node.props["aria-label"] === "ما نُفّذ في الشدّة")).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  it.each(["saved", "edited"] as const)("retains %s findings through entering and cancelling adjustment mode, even if complaint equals suggestion", async (source) => {
    if (source === "saved") stored = { ...stored, chiefComplaint: "Scheduled adjustment reason", examination: "Current exam", diagnosis: "Current diagnosis" };
    await mount();
    if (source === "edited") {
      setNote("① الشكوى الرئيسية", "Scheduled adjustment reason");
      setNote("② الفحص", "Current exam"); setNote("② التشخيص", "Current diagnosis");
    }
    await start();
    expect(field("شكوى جديدة أو تغيّر اليوم (إن وجد)").props.value).toBe("Scheduled adjustment reason");
    expect(field("فحص اليوم (إن أُجري)").props.value).toBe("Current exam");
    expect(field("تشخيص جديد أو محدّث (إن وجد)").props.value).toBe("Current diagnosis");
    await invoke(button("إلغاء"));
    expect(field("① الشكوى الرئيسية").props.value).toBe("Scheduled adjustment reason");
    expect(field("② الفحص").props.value).toBe("Current exam"); expect(field("② التشخيص").props.value).toBe("Current diagnosis");
    expect(writes()).toHaveLength(0);
  });

  it("puts today's adjustment before notes and procedures, without turning history into current findings", async () => {
    await mount(); await start();
    const all = nodes();
    const index = (id: string) => all.findIndex((node) => node.props.id === id);
    expect(index("visit-ortho-session")).toBeGreaterThan(-1);
    expect(index("visit-ortho-session")).toBeLessThan(index("visit-notes"));
    expect(index("visit-notes")).toBeLessThan(index("visit-procedures"));
    expect(field("شكوى جديدة أو تغيّر اليوم (إن وجد)").props.value).toBe("");
    expect(field("فحص اليوم (إن أُجري)").props.value).toBe("");
    expect(field("تشخيص جديد أو محدّث (إن وجد)").props.value).toBe("");
    const reference = find((node) => node.props["data-testid"] === "ortho-visit-reference");
    expect(contents(reference)).toContain("Baseline plan");
    expect(contents(reference)).toContain("Previous diagnosis is reference only");
    expect(contents(reference)).toContain("Previous adjustment, not today's work");
    expect(contents(reference)).toContain("Responsible clinician");
    expect(elements(reference).some((node) => ["input", "textarea", "select", "button"].includes(String(node.type)))).toBe(false);
    expect(nodes().find((node) => Array.isArray(node.props.steps))?.props.steps).toEqual([
      { id: "visit-ortho-session", label: "جلسة اليوم", done: false },
      { id: "visit-notes", label: "تغيّرات اليوم", done: false },
      { id: "visit-procedures", label: "إجراءات إضافية", done: false },
      { id: "visit-sign", label: "المراجعة والتوقيع", done: false },
    ]);
    expect(writes()).toHaveLength(0);
  });

  it("starts only on request, retains current wires and never copies the previous procedure as today's work", async () => {
    await mount(); expect(nodes().some((node) => node.props["aria-label"] === "ما نُفّذ في الشدّة")).toBe(false);
    await start();
    expect(input("السلك العلوي لهذه الشدّة").props.value).toBe("014 NiTi");
    expect(input("السلك السفلي لهذه الشدّة").props.value).toBe("012 NiTi");
    expect(input("ما نُفّذ في الشدّة").props.value).toBe("");
    expect(contents(find((node) => node.props.id === "visit-ortho-session"))).toContain("تُحفظ الشدّة مع التوقيع فقط");
    expect(writes()).toHaveLength(0);
  });

  it("advances only the explicitly chosen arch and retains direct editing", async () => {
    await mount(); await start();
    await invoke(find((node) => node.props["aria-label"] === "استخدام السلك العلوي المقترح"));
    expect(input("السلك العلوي لهذه الشدّة").props.value).toBe("016 NiTi");
    expect(input("السلك السفلي لهذه الشدّة").props.value).toBe("012 NiTi");
    edit("السلك السفلي لهذه الشدّة", "Custom lower wire");
    edit("ما نُفّذ في الشدّة", "Explicit wire changes today");
    await review(); await flush(); await sign(); await flush();
    expect(bodies().at(-1)?.orthoSession).toMatchObject({ upperWire: "016 NiTi", lowerWire: "Custom lower wire", done: "Explicit wire changes today" });
  });

  it("saves today's optional notes, retains the adjustment draft, and reviews it before an explicit sign", async () => {
    await mount(); await start(); edit("ما نُفّذ في الشدّة", "Reviewed current appliances today");
    setNote("شكوى جديدة أو تغيّر اليوم (إن وجد)", "New discomfort today");
    setNote("الخطوة القادمة", "Recheck in four weeks");
    await save(); await flush();
    expect(bodies()[0]).toMatchObject({ chiefComplaint: "New discomfort today", examination: "", diagnosis: "", treatmentDone: "", nextPlan: "Recheck in four weeks", procedures: [] });
    expect(bodies()[0]).not.toHaveProperty("orthoSession");
    expect(input("ما نُفّذ في الشدّة").props.value).toBe("Reviewed current appliances today");
    await review(); await flush();
    expect(bodies().some((body) => body.action === "sign")).toBe(false);
    expect(contents(find((node) => node.props["data-testid"] === "ortho-session-review"))).toContain("Reviewed current appliances today");
    await invoke(button("رجوع — أكمل العمل"));
    expect(input("ما نُفّذ في الشدّة").props.value).toBe("Reviewed current appliances today");
    await review(); await flush(); await sign(); await flush();
    expect(bodies().filter((body) => body.action === "sign")).toHaveLength(1);
    expect(bodies().at(-1)?.orthoSession).toEqual({ caseId: 95001, upperWire: "014 NiTi", lowerWire: "012 NiTi", elastics: "none", elasticNote: "", done: "Reviewed current appliances today", nextWeeks: 4 });
    expect(onSigned).toHaveBeenCalledOnce();
    expect(nodes().some((node) => node.props.id === "visit-ortho-session")).toBe(false);
    expect(field("② الفحص").props.disabled).toBe(true);
    expect(input("ملحق")).toBeTruthy();
  });

  it("locks session fields and provider through save and reload, and ignores pending handler edits", async () => {
    await mount(); await start(); edit("ما نُفّذ في الشدّة", "Preserved session");
    const post = deferred<ReturnType<typeof response>>();
    const read = deferred<ReturnType<typeof response>>();
    nextPost = async () => post.promise; nextRead = async () => read.promise;
    const pending = save(); render();
    const session = find((node) => node.props.id === "visit-ortho-session");
    expect(elements(session).find((node) => node.type === "fieldset")?.props.disabled).toBe(true);
    expect(field("شكوى جديدة أو تغيّر اليوم (إن وجد)").props.disabled).toBe(true);
    const provider = find((node) => node.type === "select" && node.props.value === 94001);
    expect(provider.props.disabled).toBe(true);
    (provider.props.onChange as (event: unknown) => void)({ target: { value: "99999" } });
    edit("ما نُفّذ في الشدّة", "Must not replace draft"); await invoke(button("إلغاء"));
    expect(input("ما نُفّذ في الشدّة").props.value).toBe("Preserved session");
    post.resolve(response(200, { ok: true })); await flush();
    expect(elements(find((node) => node.props.id === "visit-ortho-session")).find((node) => node.type === "fieldset")?.props.disabled).toBe(true);
    read.resolve(response(200, structuredClone(stored))); await pending; await flush();
    expect(input("ما نُفّذ في الشدّة").props.value).toBe("Preserved session");
    expect(field("شكوى جديدة أو تغيّر اليوم (إن وجد)").props.disabled).toBe(false);
  });

  it("retains current notes and adjustment after rejected save or sign", async () => {
    await mount(); await start(); edit("ما نُفّذ في الشدّة", "Still unsaved adjustment");
    setNote("فحص اليوم (إن أُجري)", "Actual new exam");
    nextPost = async () => response(409, { message: "Synthetic rejection" });
    await save(); await flush();
    expect(field("فحص اليوم (إن أُجري)").props.value).toBe("Actual new exam");
    expect(input("ما نُفّذ في الشدّة").props.value).toBe("Still unsaved adjustment");
    nextPost = null; await review(); await flush();
    nextPost = async () => response(409, { message: "Signing rule still blocks" });
    await sign(); await flush();
    expect(contents(render())).toContain("Signing rule still blocks");
    expect(input("ما نُفّذ في الشدّة").props.value).toBe("Still unsaved adjustment");
    expect(onSigned).not.toHaveBeenCalled();
  });

  it("keeps saved findings visible and does not replace them with baseline context", async () => {
    stored = { ...stored, chiefComplaint: "Saved current complaint", examination: "Saved current exam", diagnosis: "Saved current diagnosis", treatmentDone: "Saved current treatment" };
    await mount(); await start();
    expect(field("شكوى جديدة أو تغيّر اليوم (إن وجد)").props.value).toBe("Saved current complaint");
    expect(field("فحص اليوم (إن أُجري)").props.value).toBe("Saved current exam");
    const details = nodes().find((node) => node.type === "details" && contents(node).includes("فحص أو تشخيص جديد"));
    expect(details?.props.open).toBe(true);
    await save(); await flush(); expect(bodies()[0].diagnosis).toBe("Saved current diagnosis");
  });

  it("never stages a second session when this visit already has a recorded adjustment", async () => {
    stored.ortho = { ...orthodontics, visitAdjustmentId: 95002 };
    await mount();
    expect(contents(render())).toContain("سُجّلت شدّة هذه الزيارة");
    expect(nodes().some((node) => node.type === "button" && contents(node).startsWith("+ شدّة"))).toBe(false);
    await review(); await flush(); await sign(); await flush();
    expect(bodies().at(-1)?.orthoSession).toBe(null);
  });

  it.each(["assistant", "reception"])("keeps adjustment creation restricted for %s", async (role) => {
    hooks.role = role; await mount();
    expect(nodes().some((node) => node.type === "button" && contents(node).startsWith("+ شدّة"))).toBe(false);
    expect(field("① الشكوى الرئيسية")).toBeTruthy();
    expect(nodes().some((node) => node.props.label === "شكوى جديدة أو تغيّر اليوم (إن وجد)")).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  it("preserves the ordinary visit's five fields, suggestions and progress", async () => {
    stored.ortho = null; await mount();
    expect(field("① الشكوى الرئيسية").props.value).toBe("Scheduled adjustment reason");
    expect(field("② الفحص").props.value).toBe("");
    expect(field("② التشخيص").props.value).toBe("");
    expect(field("③ ما نُفّذ")).toBeTruthy(); expect(field("الخطة القادمة")).toBeTruthy();
    expect(nodes().some((node) => node.props["data-testid"] === "ortho-visit-reference")).toBe(false);
    expect((nodes().find((node) => Array.isArray(node.props.steps))?.props.steps as { label: string }[]).map((step) => step.label)).toEqual(["الشكوى", "الفحص والتشخيص", "الإجراءات", "المراجعة والتوقيع"]);
  });

  it("keeps outside-contract billing decisions intact without synthesizing financial work", async () => {
    stored.ortho = { ...orthodontics, adjustmentBillingClass: "OUTSIDE_CONTRACT" };
    await mount(); await start(); edit("ما نُفّذ في الشدّة", "Actual adjustment");
    const checkbox = find((node) => node.type === "input" && node.props.type === "checkbox");
    (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    edit("سبب بلا رسوم للشدّة", "Synthetic approved clinical reason");
    await review(); await flush(); await sign(); await flush();
    expect(bodies().at(-1)?.outsideContractDecision).toEqual({ decision: "no_charge", reason: "Synthetic approved clinical reason" });
    expect(bodies().filter((body) => body.action !== "sign").every((body) => Array.isArray(body.procedures) && body.procedures.length === 0)).toBe(true);
  });
});


describe("baseline-only elastic class confirmation", () => {
  function baseline(description = "صنف ثانٍ 3/16 — ليلًا") {
    stored.ortho = { ...orthodontics, lastAdjustment: null, daysSinceLast: null, lastDone: null,
      elastics: null, elasticNote: description };
  }

  it.each(["صنف ثانٍ 3/16 — ليلًا", "class_iii", "لا توجد مطاطات", "Unknown legacy description"])(
    "does not turn baseline text into a class or save/sign while unresolved: %s", async (description) => {
      baseline(description);
      await mount(); await start();
      expect(input("مطاطات هذه الشدّة").props.value).toBe("");
      expect(input("مطاطات هذه الشدّة").props.required).toBe(true);
      expect(input("وصف مطاطات هذه الشدّة").props.value).toBe(description);
      expect(input("ما نُفّذ في الشدّة").props.value).toBe("");
      const explanation = find((node) => node.props["data-testid"] === "visit-baseline-elastics");
      expect(contents(explanation)).toContain(description);
      expect(explanation.props.role).toBe("status");
      await review(); await flush();
      expect(writes()).toHaveLength(0);
      expect(nodes().some((node) => node.props.role === "dialog")).toBe(false);
      expect(contents(render())).toContain("اختر صنف المطاطات لهذه الجلسة");
      expect(onSigned).not.toHaveBeenCalled();
    },
  );

  it("signs only the explicitly selected class and retains baseline instructions without copying prior work", async () => {
    baseline(); await mount(); await start();
    edit("مطاطات هذه الشدّة", "class_ii");
    edit("ما نُفّذ في الشدّة", "Actual work today");
    await review(); await flush();
    const displayed = contents(find((node) => node.props["data-testid"] === "ortho-session-review"));
    expect(displayed).toContain("صنف ثانٍ");
    expect(displayed).toContain("صنف ثانٍ 3/16 — ليلًا");
    await sign(); await flush();
    expect(bodies().at(-1)?.orthoSession).toEqual({ caseId: 95001, upperWire: "014 NiTi", lowerWire: "012 NiTi",
      elastics: "class_ii", elasticNote: "صنف ثانٍ 3/16 — ليلًا", done: "Actual work today", nextWeeks: 4 });
    expect(onSigned).toHaveBeenCalledOnce();
  });

  it("allows an explicit baseline-first choice of no elastics and clears only its draft instructions", async () => {
    baseline(); const original = structuredClone(stored.ortho);
    await mount(); await start(); edit("مطاطات هذه الشدّة", "none");
    expect(nodes().some((node) => node.props["aria-label"] === "وصف مطاطات هذه الشدّة")).toBe(false);
    expect(stored.ortho).toEqual(original);
    await review(); await flush(); await sign(); await flush();
    expect(bodies().at(-1)?.orthoSession).toMatchObject({ elastics: "none", elasticNote: "", done: "" });
    expect(onSigned).toHaveBeenCalledOnce();
  });

  it("allows save-without-sign while preserving the unresolved choice and description", async () => {
    baseline(); await mount(); await start();
    setNote("فحص اليوم (إن أُجري)", "Actual current examination");
    await save(); await flush();
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]).toMatchObject({ examination: "Actual current examination" });
    expect(bodies()[0]).not.toHaveProperty("orthoSession");
    expect(input("مطاطات هذه الشدّة").props.value).toBe("");
    expect(input("وصف مطاطات هذه الشدّة").props.value).toBe("صنف ثانٍ 3/16 — ليلًا");
    await review(); await flush();
    expect(bodies()).toHaveLength(1);
    expect(nodes().some((node) => node.props.role === "dialog")).toBe(false);
  });

  it("does not block an ordinary visit until a baseline adjustment is explicitly staged", async () => {
    baseline(); await mount();
    await review(); await flush(); await sign(); await flush();
    expect(bodies().at(-1)?.orthoSession).toBe(null);
    expect(onSigned).toHaveBeenCalledOnce();
  });

  it("removes the unresolved-choice block when the adjustment is cancelled", async () => {
    baseline(); await mount(); await start();
    await invoke(button("إلغاء"));
    await review(); await flush(); await sign(); await flush();
    expect(bodies().at(-1)?.orthoSession).toBe(null);
    expect(onSigned).toHaveBeenCalledOnce();
  });

  it("does not block a refreshed visit that already has its recorded adjustment", async () => {
    baseline(); await mount(); await start();
    nextRead = async () => response(200, { ...stored, ortho: { ...(stored.ortho as object), visitAdjustmentId: 95002 } });
    await save(); await flush();
    expect(contents(render())).toContain("سُجّلت شدّة هذه الزيارة");
    await review(); await flush(); await sign(); await flush();
    expect(bodies().at(-1)?.orthoSession).toBe(null);
    expect(onSigned).toHaveBeenCalledOnce();
  });

  it("guards the sign handler itself when an unresolved class reaches an already-open review", async () => {
    baseline(); await mount(); await start(); edit("مطاطات هذه الشدّة", "class_ii");
    await review(); await flush();
    // Exercise the actual handler independently of the review-entry guard.
    edit("مطاطات هذه الشدّة", "");
    const count = writes().length;
    await sign(); await flush();
    // Check dispatch before the fallback label so the original-product negative
    // proves the sign guard itself, not only a presentation difference.
    expect(writes()).toHaveLength(count);
    expect(bodies().some((body) => body.action === "sign")).toBe(false);
    expect(contents(find((node) => node.props["data-testid"] === "ortho-session-review"))).toContain("لم يُحدّد الصنف بعد");
    expect(contents(render())).toContain("اختر صنف المطاطات لهذه الجلسة");
    expect(onSigned).not.toHaveBeenCalled();
  });

  it.each(["class_ii", "vertical", "none"])("retains authoritative historical %s, description and interval without the baseline guard", async (elastics) => {
    stored.ortho = { ...orthodontics, elastics, elasticNote: "Saved historical instructions", nextWeeks: 6 };
    await mount(); await start();
    expect(input("مطاطات هذه الشدّة").props.value).toBe(elastics);
    expect(input("أسابيع حتى الشدّة القادمة").props.value).toBe("6");
    expect(nodes().some((node) => node.props["data-testid"] === "visit-baseline-elastics")).toBe(false);
    expect(input("ما نُفّذ في الشدّة").props.value).toBe("");
    await review(); await flush(); await sign(); await flush();
    expect(bodies().at(-1)?.orthoSession).toMatchObject({ elastics, elasticNote: "Saved historical instructions", nextWeeks: 6, done: "" });
    expect(onSigned).toHaveBeenCalledOnce();
  });

  it.each([null, "", "   "])("leaves no-description first-session defaults unchanged (%s)", async (elasticNote) => {
    stored.ortho = { ...orthodontics, lastAdjustment: null, elastics: null, elasticNote };
    await mount(); await start();
    expect(input("مطاطات هذه الشدّة").props.value).toBe("none");
    expect(nodes().some((node) => node.props["data-testid"] === "visit-baseline-elastics")).toBe(false);
    await review(); await flush(); await sign(); await flush();
    expect(bodies().at(-1)?.orthoSession).toMatchObject({ elastics: "none", elasticNote: elasticNote ?? "", done: "" });
  });

  it("retains the explicit baseline choice after rejected sign and review dismissal", async () => {
    baseline(); await mount(); await start(); edit("مطاطات هذه الشدّة", "class_ii");
    edit("ما نُفّذ في الشدّة", "Current adjustment only");
    await review(); await flush();
    nextPost = async () => response(409, { message: "Synthetic sign refusal" });
    await sign(); await flush();
    expect(onSigned).not.toHaveBeenCalled();
    await invoke(button("رجوع — أكمل العمل"));
    expect(input("مطاطات هذه الشدّة").props.value).toBe("class_ii");
    expect(input("وصف مطاطات هذه الشدّة").props.value).toBe("صنف ثانٍ 3/16 — ليلًا");
    expect(input("ما نُفّذ في الشدّة").props.value).toBe("Current adjustment only");
    nextPost = null; await review(); await flush(); await sign(); await flush();
    const attempts = bodies().filter((body) => body.action === "sign");
    expect(attempts).toHaveLength(2);
    expect(attempts[1].orthoSession).toEqual(attempts[0].orthoSession);
    expect(onSigned).toHaveBeenCalledOnce();
  });
});

describe("lazy case diagnosis reference in explicit orthodontic follow-up", () => {
  const reference = () => find(node => node.props["data-testid"] === "ortho-visit-reference");
  const panels = () => nodes().filter(node => node.type === PatientDiagnosis);
  const toggle = (open: boolean, node = reference(), nested = false) => {
    const currentTarget = { open };
    (node.props.onToggle as ((event: unknown) => void) | undefined)?.({ currentTarget, target: nested ? {} : currentTarget });
    render();
  };

  it("mounts the canonical reader only on reference opening, read-only and scoped to this visit/patient/case", async () => {
    await mount(); expect(panels()).toHaveLength(0);
    await start(); expect(panels()).toHaveLength(0);
    toggle(true); expect(panels()).toHaveLength(1);
    expect(contents(reference())).toContain("آخر تشخيص من زيارة موقّعة للمريض");
    expect(panels()[0].props).toEqual({ patientId: 92001, orthoCaseId: 95001, readOnly: true, referenceVisitId: 91001 });
    toggle(false, reference(), true); expect(panels()).toHaveLength(1); // a nested history toggle must not close the owner
    toggle(false); expect(panels()).toHaveLength(0);
    toggle(true); expect(panels()).toHaveLength(1); expect(writes()).toHaveLength(0);
  });

  it("preserves all today's drafts and the original save/sign payload through opening and collapse", async () => {
    await mount(); await start();
    setNote("شكوى جديدة أو تغيّر اليوم (إن وجد)", "Today's complaint");
    setNote("فحص اليوم (إن أُجري)", "Today's exam");
    setNote("تشخيص جديد أو محدّث (إن وجد)", "Today's diagnosis");
    edit("ما نُفّذ في الشدّة", "Today's adjustment");
    toggle(true); toggle(false); toggle(true);
    expect(field("شكوى جديدة أو تغيّر اليوم (إن وجد)").props.value).toBe("Today's complaint");
    expect(field("فحص اليوم (إن أُجري)").props.value).toBe("Today's exam");
    expect(field("تشخيص جديد أو محدّث (إن وجد)").props.value).toBe("Today's diagnosis");
    expect(input("ما نُفّذ في الشدّة").props.value).toBe("Today's adjustment");
    expect(writes()).toHaveLength(0);
    await review(); await flush(); await sign(); await flush();
    expect(bodies()[0]).toMatchObject({ chiefComplaint: "Today's complaint", examination: "Today's exam", diagnosis: "Today's diagnosis", procedures: [] });
    expect(bodies()[0]).not.toHaveProperty("orthoSession");
    expect(bodies().at(-1)?.orthoSession).toMatchObject({ caseId: 95001, done: "Today's adjustment", upperWire: "014 NiTi", lowerWire: "012 NiTi" });
    expect(panels()).toHaveLength(0); expect(nodes().some(node => node.props["data-testid"] === "ortho-visit-reference")).toBe(false);
    expect(onSigned).toHaveBeenCalledOnce();
  });

  it("does not mount a live diagnosis overlay on an already signed orthodontic visit", async () => {
    stored = { ...stored, status: "signed", signedAt: "2026-10-04T10:00:00Z", signedBy: "Synthetic clinician",
      ortho: { ...orthodontics, visitAdjustmentId: 95002 } };
    await mount(); expect(panels()).toHaveLength(0);
    expect(nodes().some(node => node.props["data-testid"] === "ortho-visit-reference")).toBe(false); expect(writes()).toHaveLength(0);
  });

  it("requires a fresh opening and retires retained handlers across same-visit case A → B → A", async () => {
    stored.ortho = { ...orthodontics, visitAdjustmentId: 95002 };
    await mount(); toggle(true); const oldDisclosure = reference(), oldPanel = panels()[0];
    setNote("شكوى جديدة أو تغيّر اليوم (إن وجد)", "Retained current complaint");
    setNote("فحص اليوم (إن أُجري)", "Retained current exam");
    setNote("تشخيص جديد أو محدّث (إن وجد)", "Retained current diagnosis");
    for (const caseId of [95003, 95001]) {
      nextRead = async () => response(200, { ...stored, ortho: { ...orthodontics, caseId, visitAdjustmentId: 95002 } });
      await save(); await flush();
      expect(panels()).toHaveLength(0); expect(reference().props.open).toBe(false);
      toggle(true, oldDisclosure); expect(panels()).toHaveLength(0);
      toggle(true); expect(panels()[0].props.orthoCaseId).toBe(caseId); expect(panels()[0].key).not.toBe(oldPanel.key);
      expect(field("شكوى جديدة أو تغيّر اليوم (إن وجد)").props.value).toBe("Retained current complaint");
      expect(field("فحص اليوم (إن أُجري)").props.value).toBe("Retained current exam");
      expect(field("تشخيص جديد أو محدّث (إن وجد)").props.value).toBe("Retained current diagnosis");
    }
    expect(bodies()).toHaveLength(2); expect(bodies().every(body => !("orthoSession" in body))).toBe(true);
  });

  it("retires retained disclosure callbacks and case panels across visit A → B → A", async () => {
    stored.ortho = { ...orthodontics, visitAdjustmentId: 95002 };
    await mount(); toggle(true); const oldDisclosure = reference(), oldPanel = panels()[0];
    renderedVisitId = 91002; stored = { ...stored, id: 91002 }; await mount();
    expect(panels()).toHaveLength(0); toggle(true, oldDisclosure); expect(panels()).toHaveLength(0);
    toggle(true); expect(panels()[0].props.referenceVisitId).toBe(91002); expect(panels()[0].key).not.toBe(oldPanel.key);
    renderedVisitId = 91001; stored = { ...stored, id: 91001 }; await mount();
    expect(panels()).toHaveLength(0); toggle(true, oldDisclosure); expect(panels()).toHaveLength(0);
    toggle(true); expect(panels()[0].props.referenceVisitId).toBe(91001); expect(panels()[0].key).not.toBe(oldPanel.key);
    expect(writes()).toHaveLength(0);
  });
});
