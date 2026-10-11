import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClinicalVisit } from "../components/ClinicalVisit";
import { normalizeSurfaces } from "../lib/dental";
import { DEFAULT_DOCTOR_PERMISSIONS } from "../lib/doctor-permissions";

// SOURCE-ONLY ownership regressions: not executed. Synthetic retained component owner changes. No routes,
// database/bootstrap modules, credentials, browser, or actual network are used.
// All peripheral components are stubbed. Actual ClinicalVisit handlers
// and state/effects run in the reviewed lightweight hook-harness style.
// This exercises the actual component, without changing clinical sign rules.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false, username: "synthetic-doctor", role: "doctor",
  permissions: null as import("../lib/doctor-permissions").DoctorPermissions | null,
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
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ role: hooks.role, username: hooks.username, permissions: hooks.permissions }) }));
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
type Response = ReturnType<typeof response>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const fetchMock = vi.fn();
let currentVisitId: number;
let expectedPatientId: number | undefined;
let navigationGuard: (() => boolean) | null;
const trackGuard = (guard: (() => boolean) | null) => { navigationGuard = guard; };
let extraReads: Map<string, () => Promise<Response>>;
let onSigned = vi.fn<() => void>();
let stored: Map<number, Record<string, unknown>>;
let reads: Map<number, () => Promise<Response>>;
let pendingWrite: ((visitId: number, body: Record<string, unknown>) => Promise<Response>) | null;
function visit(id: number, diagnosis: string): Record<string, unknown> {
  return { id, patientId: 92001, patientName: "Same synthetic patient", chiefComplaint: "", examination: "", diagnosis,
    treatmentDone: "", nextPlan: "", addendum: null, doctorId: 94001, status: "open", signedAt: null, signedBy: null,
    invoiceId: null, procedures: [], totalMinor: 0, planItemsMatched: 0, planTitle: null, planWarning: null,
    ortho: null, outstanding: [], sessionPricing: [], labOrders: [], billingCurrency: "YER", plannedVisit: null,
    previousVisit: null, latestDiagnosis: null, activeCases: [], suggestions: { chiefComplaint: null, nextPlan: null, doctorId: 94001 } };
}
const orthodonticCase = { caseId: 95001, appliance: "fixed_metal", phase: "aligning", slot: "022", upperWire: "014", lowerWire: "012",
      lastAdjustment: null, daysSinceLast: null, lastDone: null, elastics: "none", elasticNote: null,
      suggestedUpper: "016", suggestedLower: "014", visitAdjustmentId: null, legacyBaseline: true, nextWeeks: 4, adjustmentBillingClass: "LEGACY_INCLUDED" };
function render() {
  let tree: ReturnType<typeof ClinicalVisit> | null = null;
  let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("Clinical ownership fixture did not settle");
    hooks.cursor = 0; hooks.changed = false;
    tree = ClinicalVisit({ visitId: currentVisitId, onSigned, expectedPatientId, onNavigationGuardChange: trackGuard });
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
const nodes = () => elements(render());
const find = (predicate: (node: Element) => boolean) => {
  const node = nodes().find(predicate); if (!node) throw new Error("Missing synthetic clinical control"); return node;
};
const field = (label: string) => find((node) => node.props.label === label);
const button = (label: string) => find((node) => node.type === "button" && contents(node).trim() === label);
const invoke = (node: Element) => (node.props.onClick as () => void | Promise<void>)();
const writes = () => fetchMock.mock.calls.filter(([, options]) => options?.method === "POST");
async function flush() {
  for (let pass = 0; pass < 6; pass += 1) {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    render();
  }
}
async function mount() { render(); await flush(); }
function unmount() { hooks.effects.forEach((effect) => effect.cleanup?.()); hooks.effects.clear(); }
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  hooks.role = "doctor"; hooks.username = "synthetic-doctor"; hooks.permissions = null; vi.clearAllMocks(); currentVisitId = 91001; onSigned = vi.fn<() => void>();
  stored = new Map([[91001, visit(91001, "Visit A diagnosis")], [91002, visit(91002, "Visit B diagnosis")]]);
  reads = new Map(); extraReads = new Map(); pendingWrite = null; expectedPatientId = undefined; navigationGuard = null;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (!options?.method && extraReads.has(url)) return extraReads.get(url)!();
    if (url === "/api/visits/91001" && options?.method === "PATCH") {
      stored.set(91001, { ...stored.get(91001), patientId: 92001 });
      return response(200, { patientId: 92001 });
    }
    const match = url.match(/^\/api\/visits\/(\d+)\/clinical$/);
    if (match) {
      const id = Number(match[1]);
      if (options?.method === "POST") {
        const body = JSON.parse(String(options.body)) as Record<string, unknown>;
        if (pendingWrite) return pendingWrite(id, body);
        stored.set(id, { ...stored.get(id), ...body }); return response(200, { ok: true });
      }
      return reads.get(id)?.() ?? response(200, structuredClone(stored.get(id)));
    }
    if (url === "/api/services") return response(200, []);
    if (url === "/api/parties?kind=doctor") return response(200, [{ id: 94001, name: "Synthetic clinician" }]);
    if (url === "/api/patients/92001") return response(200, { patient: { id: 92001, medicalAlert: null, phone: null }, visits: [], appointments: [] });
    if (/^\/api\/visits\/9100[12]\/billing-preview$/.test(url)) return response(200, { duesByCurrency: {}, mixedCurrencies: false, zeroReason: null });
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { confirm: vi.fn(() => false), addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { href: "/visits/91001" } });
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

describe("clinical visit owner retirement", () => {
  it("cannot save A's draft to B while B's first read is pending", async () => {
    await mount(); expect(field("② التشخيص").props.value).toBe("Visit A diagnosis");
    (field("② التشخيص").props.onChange as (value: string) => void)("Edited only for A");
    const deferredB = deferred<Response>(); reads.set(91002, () => deferredB.promise);
    currentVisitId = 91002; render();
    const staleSave = nodes().find((node) => node.type === "button" && contents(node).trim() === "احفظ بلا توقيع");
    // Even an already-held callback must enforce its owner at command time.
    if (staleSave) void invoke(staleSave);
    await Promise.resolve();
    expect(writes()).toHaveLength(0);
    deferredB.resolve(response(200, stored.get(91002))); await flush();
    expect(field("② التشخيص").props.value).toBe("Visit B diagnosis");
  });

  it("ignores A's late initial read after B has loaded", async () => {
    const deferredA = deferred<Response>(); reads.set(91001, () => deferredA.promise);
    render(); currentVisitId = 91002; await mount();
    expect(field("② التشخيص").props.value).toBe("Visit B diagnosis");
    deferredA.resolve(response(200, stored.get(91001))); await flush();
    expect(field("② التشخيص").props.value).toBe("Visit B diagnosis");
  });

  it("does not reload A into B after A's already-dispatched save completes", async () => {
    await mount(); const post = deferred<Response>(); pendingWrite = async () => post.promise;
    const saveA = invoke(button("احفظ بلا توقيع"));
    expect(writes()[0][0]).toBe("/api/visits/91001/clinical");
    currentVisitId = 91002; await flush();
    post.resolve(response(200, { ok: true })); await saveA; await flush();
    expect(field("② التشخيص").props.value).toBe("Visit B diagnosis");
    expect(writes()).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url, options]) => url === "/api/visits/91001/clinical" && !options?.method)).toHaveLength(1);
  });

  it("does not publish A's late sign result through B's checkout callback", async () => {
    await mount(); await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
    const post = deferred<Response>(); pendingWrite = async () => post.promise;
    const signA = invoke(find((node) => node.type === "button" && /وقّع|تأكيد إنهاء/.test(contents(node))));
    currentVisitId = 91002; await flush();
    stored.set(91001, { ...stored.get(91001), status: "signed" });
    post.resolve(response(200, { patientId: 92001, invoiceId: null, invoiceCurrency: null, duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null }));
    await signA; await flush();
    expect(onSigned).not.toHaveBeenCalled();
    expect(field("② التشخيص").props.value).toBe("Visit B diagnosis");
    expect(writes().filter(([url]) => url === "/api/visits/91002/clinical")).toHaveLength(0);
  });
});

describe("owner lifetime, command and navigation contracts", () => {
  it("rejects a response whose visit identity does not match the requested owner", async () => {
    reads.set(91001, async () => response(200, stored.get(91002)));
    await mount();
    expect(contents(render())).toContain("بيانات الزيارة لا تطابق السياق الحالي");
    expect(nodes().some((node) => node.props.label === "② التشخيص")).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  it("rejects a clinical snapshot for another expected patient", async () => {
    expectedPatientId = 92002; await mount();
    expect(contents(render())).toContain("بيانات الزيارة لا تطابق السياق الحالي");
    expect(nodes().some((node) => node.props.label === "② التشخيص")).toBe(false);
  });

  it("does not revive the first A read after A→B→A", async () => {
    const oldA = deferred<Response>();
    let aReads = 0;
    reads.set(91001, () => ++aReads === 1 ? oldA.promise : Promise.resolve(response(200, visit(91001, "Fresh second A"))));
    render(); currentVisitId = 91002; await mount();
    expect(field("② التشخيص").props.value).toBe("Visit B diagnosis");
    currentVisitId = 91001; await flush();
    expect(field("② التشخيص").props.value).toBe("Fresh second A");
    oldA.resolve(response(200, visit(91001, "Retired first A"))); await flush();
    expect(field("② التشخيص").props.value).toBe("Fresh second A");
  });

  it("retains no accepted A draft snapshot through A→B→A", async () => {
    await mount();
    (field("② التشخيص").props.onChange as (value: string) => void)("Old unsaved A");
    currentVisitId = 91002; await flush(); currentVisitId = 91001; await flush();
    expect(field("② التشخيص").props.value).toBe("Visit A diagnosis");
    expect(writes()).toHaveLength(0);
  });

  it("retires loaded drafts and old callbacks on principal change even for the same visit", async () => {
    await mount(); const oldSave = button("احفظ بلا توقيع"); const oldNote = field("② التشخيص");
    const freshRead = deferred<Response>(); reads.set(91001, () => freshRead.promise);
    hooks.username = "new-synthetic-clinician"; render();
    await invoke(oldSave);
    (oldNote.props.onChange as (value: string) => void)("Retired clinician edit");
    expect(writes()).toHaveLength(0);
    expect(nodes().some((node) => node.props.label === "② التشخيص")).toBe(false);
    freshRead.resolve(response(200, visit(91001, "New principal read"))); await flush();
    expect(field("② التشخيص").props.value).toBe("New principal read");
  });

  it("blocks a captured A save and edit after B is already loaded", async () => {
    await mount(); const oldSave = button("احفظ بلا توقيع"); const oldNote = field("② التشخيص");
    currentVisitId = 91002; await flush();
    await invoke(oldSave); (oldNote.props.onChange as (value: string) => void)("Old edit");
    expect(writes()).toHaveLength(0); expect(field("② التشخيص").props.value).toBe("Visit B diagnosis");
  });

  it("ignores a response retired while its JSON body is still pending", async () => {
    const decode = deferred<unknown>();
    reads.set(91001, async () => ({ ...response(200, null), json: () => decode.promise }));
    render(); await Promise.resolve(); currentVisitId = 91002; await mount();
    expect(field("② التشخيص").props.value).toBe("Visit B diagnosis");
    decode.resolve(visit(91001, "Late decoded A")); await flush();
    expect(field("② التشخيص").props.value).toBe("Visit B diagnosis");
  });

  it("takes the command latch before a synchronous second Save and before the leave guard", async () => {
    await mount(); const post = deferred<Response>(); pendingWrite = async () => post.promise;
    const saveButton = button("احفظ بلا توقيع");
    const first = invoke(saveButton); const second = invoke(saveButton);
    expect(writes()).toHaveLength(1);
    expect(navigationGuard?.()).toBe(false);
    expect(window.confirm).not.toHaveBeenCalled();
    post.resolve(response(200, { ok: true })); await first; await second; await flush();
    expect(navigationGuard?.()).toBe(true);
  });

  it("takes the command latch before a synchronous second Sign", async () => {
    await mount(); await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
    const post = deferred<Response>(); pendingWrite = async () => post.promise;
    const signButton = find((node) => node.type === "button" && /وقّع|تأكيد إنهاء/.test(contents(node)));
    const first = invoke(signButton); const second = invoke(signButton);
    expect(writes().filter(([, options]) => JSON.parse(String(options.body)).action === "sign")).toHaveLength(1);
    post.resolve(response(409, { message: "Synthetic sign rejection" })); await first; await second; await flush();
    expect(onSigned).not.toHaveBeenCalled();
  });

  it("does not execute a retired Save→Review continuation after replacement", async () => {
    await mount(); const post = deferred<Response>(); pendingWrite = async () => post.promise;
    const reviewA = invoke(button("مراجعة وإنهاء الزيارة"));
    currentVisitId = 91002; await flush(); post.resolve(response(200, { ok: true })); await reviewA; await flush();
    expect(nodes().some((node) => node.props.role === "dialog" && node.props["aria-label"] === "مراجعة وإنهاء الزيارة")).toBe(false);
    expect(field("② التشخيص").props.value).toBe("Visit B diagnosis");
  });

  it("ignores a late financial preview from A after opening B's review", async () => {
    const previewA = deferred<Response>(); extraReads.set("/api/visits/91001/billing-preview", () => previewA.promise);
    await mount(); await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
    currentVisitId = 91002; await flush(); await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
    previewA.resolve(response(200, { duesByCurrency: {}, mixedCurrencies: false, zeroReason: "Retired A financial reason" })); await flush();
    expect(contents(render())).not.toContain("Retired A financial reason");
  });

  it("does not copy a staged orthodontic session to another visit of the same patient/case", async () => {
    const ortho = { ...orthodonticCase };
    stored.set(91001, { ...stored.get(91001), ortho }); stored.set(91002, { ...stored.get(91002), ortho });
    await mount(); await invoke(button("+ شدّة هذه الزيارة (تُحفظ مع التوقيع)"));
    const oldSession = find((node) => node.props["aria-label"] === "ما نُفّذ في الشدّة");
    (oldSession.props.onChange as (event: unknown) => void)({ target: { value: "Session belongs to A" } });
    currentVisitId = 91002; await flush();
    (oldSession.props.onChange as (event: unknown) => void)({ target: { value: "Retired session edit" } });
    expect(nodes().some((node) => node.props["aria-label"] === "ما نُفّذ في الشدّة")).toBe(false);
    expect(writes()).toHaveLength(0);
  });

  it("fences adjustment edits and explicit wire choices with the synchronous command latch", async () => {
    stored.set(91001, { ...stored.get(91001), ortho: { ...orthodonticCase } });
    await mount();
    const stage = button("+ شدّة هذه الزيارة (تُحفظ مع التوقيع)");
    await invoke(stage);
    // No render between staging and guard evaluation: the draft already belongs to A.
    expect(navigationGuard?.()).toBe(false);
    expect(window.confirm).toHaveBeenCalledOnce();
    const upperChoice = find((node) => node.props["aria-label"] === "استخدام السلك العلوي المقترح");
    const lowerChoice = find((node) => node.props["aria-label"] === "استخدام السلك السفلي المقترح");
    const done = find((node) => node.props["aria-label"] === "ما نُفّذ في الشدّة");
    const cancel = button("إلغاء");
    const post = deferred<Response>(); pendingWrite = async () => post.promise;
    const saving = invoke(button("احفظ بلا توقيع"));
    // Captured handlers still see busy=false; the ref must stop them immediately.
    await invoke(upperChoice); await invoke(lowerChoice); await invoke(cancel); await invoke(stage);
    (done.props.onChange as (event: unknown) => void)({ target: { value: "Must not edit during save" } });
    expect(navigationGuard?.()).toBe(false);
    expect(find((node) => node.props["aria-label"] === "السلك العلوي لهذه الشدّة").props.value).toBe("014");
    expect(find((node) => node.props["aria-label"] === "السلك السفلي لهذه الشدّة").props.value).toBe("012");
    expect(find((node) => node.props["aria-label"] === "ما نُفّذ في الشدّة").props.value).toBe("");
    expect(writes()).toHaveLength(1);
    post.resolve(response(200, { ok: true })); await saving; await flush();
  });

  it("cannot mutate B's session through A's relocated controls, wire choices or reference link", async () => {
    for (const id of [91001, 91002]) stored.set(id, { ...stored.get(id), ortho: { ...orthodonticCase } });
    await mount(); const stageA = button("+ شدّة هذه الزيارة (تُحفظ مع التوقيع)"); await invoke(stageA);
    const upperA = find((node) => node.props["aria-label"] === "استخدام السلك العلوي المقترح");
    const lowerA = find((node) => node.props["aria-label"] === "استخدام السلك السفلي المقترح");
    const cancelA = button("إلغاء");
    const referenceA = find((node) => node.type === "a" && typeof node.props.href === "string"
      && new URL(node.props.href, "http://synthetic.test").pathname === "/patients/92001"
      && new URL(node.props.href, "http://synthetic.test").searchParams.get("orthoCaseId") === "95001");
    const referenceUrl = new URL(String(referenceA.props.href), "http://synthetic.test");
    expect(Object.fromEntries(referenceUrl.searchParams)).toEqual({ patientId: "92001", orthoCaseId: "95001",
      pillar: "wires", tab: "treatment", sub: "ortho" });
    currentVisitId = 91002; await flush();
    await invoke(button("+ شدّة هذه الزيارة (تُحفظ مع التوقيع)"));
    const doneB = find((node) => node.props["aria-label"] === "ما نُفّذ في الشدّة");
    (doneB.props.onChange as (event: unknown) => void)({ target: { value: "B actual work" } });
    await invoke(stageA); await invoke(upperA); await invoke(lowerA); await invoke(cancelA);
    const preventDefault = vi.fn();
    (referenceA.props.onClick as (event: unknown) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(find((node) => node.props["aria-label"] === "السلك العلوي لهذه الشدّة").props.value).toBe("014");
    expect(find((node) => node.props["aria-label"] === "السلك السفلي لهذه الشدّة").props.value).toBe("012");
    expect(find((node) => node.props["aria-label"] === "ما نُفّذ في الشدّة").props.value).toBe("B actual work");
    expect(writes()).toHaveLength(0);
  });

  it("preserves an existing visit adjustment reference and retires its link after owner change", async () => {
    stored.set(91001, { ...stored.get(91001), ortho: { ...orthodonticCase, visitAdjustmentId: 96001 } });
    await mount();
    const reference = find(node => node.type === "a" && typeof node.props.href === "string"
      && new URL(node.props.href, "http://synthetic.test").searchParams.get("orthoCaseId") === "95001");
    const url = new URL(String(reference.props.href), "http://synthetic.test");
    expect(url.pathname).toBe("/patients/92001");
    expect(Object.fromEntries(url.searchParams)).toEqual({ patientId: "92001", orthoCaseId: "95001",
      visitId: "91001", pillar: "wires", tab: "treatment", sub: "ortho" });
    currentVisitId = 91002; await flush();
    const preventDefault = vi.fn();
    (reference.props.onClick as (event: unknown) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce(); expect(writes()).toHaveLength(0);
  });

  it("does not publish a sign result or reload after unmount", async () => {
    await mount(); await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
    const post = deferred<Response>(); pendingWrite = async () => post.promise;
    const signA = invoke(find((node) => node.type === "button" && /وقّع|تأكيد إنهاء/.test(contents(node))));
    const readsBefore = fetchMock.mock.calls.filter(([, options]) => !options?.method).length;
    unmount(); post.resolve(response(200, { invoiceId: null, duesMinor: 0 })); await signA;
    expect(onSigned).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, options]) => !options?.method)).toHaveLength(readsBefore);
  });

  it("preserves a normal walk-in's same-visit open-file flow", async () => {
    stored.set(91001, { ...stored.get(91001), patientId: null }); await mount();
    const linker = find((node) => typeof node.props.onOpenFile === "function");
    await (linker.props.onOpenFile as () => Promise<void>)(); await flush();
    expect(fetchMock.mock.calls.filter(([url, options]) => url === "/api/visits/91001" && options?.method === "PATCH")).toHaveLength(1);
    expect(window.location.href).toBe("/patients/92001?tab=today");
  });

  it("does not run a captured A open-file chain after visit replacement", async () => {
    stored.set(91001, { ...stored.get(91001), patientId: null }); await mount();
    const linker = find((node) => typeof node.props.onOpenFile === "function");
    currentVisitId = 91002; await flush();
    await (linker.props.onOpenFile as () => Promise<void>)();
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method)).toHaveLength(0);
    expect(window.location.href).toBe("/visits/91001");
  });

  it("keeps a current draft when Stay is chosen and allows explicit discard via the shell guard", async () => {
    await mount(); expect(navigationGuard?.()).toBe(true);
    (field("② التشخيص").props.onChange as (value: string) => void)("Unsaved current diagnosis"); render();
    expect(navigationGuard?.()).toBe(false);
    expect(field("② التشخيص").props.value).toBe("Unsaved current diagnosis");
    vi.mocked(window.confirm).mockReturnValueOnce(true);
    expect(navigationGuard?.()).toBe(true);
    expect(writes()).toHaveLength(0);
    expect(field("② التشخيص").props.value).toBe("Unsaved current diagnosis");
  });

  it("clears ordinary-note dirtiness only after a successful save and current reload", async () => {
    await mount(); (field("② التشخيص").props.onChange as (value: string) => void)("Current saved diagnosis"); render();
    expect(navigationGuard?.()).toBe(false);
    await invoke(button("احفظ بلا توقيع")); await flush();
    expect(navigationGuard?.()).toBe(true);
  });
});

describe("review findings", () => {
  it("cannot change B currency via a captured A planned-item handler", async () => {
    stored.set(91001, { ...stored.get(91001), outstanding: [{ planItemId: 95001, serviceId: 96001, planTitle: "A plan", serviceName: "A planned procedure", toothCode: 11, billingRule: "per_session", sessionCount: 1, doneSessions: 0, unitPriceMinor: 1500, quantity: 1, status: "planned", planCurrency: "SAR" }] });
    await mount(); const plannedA = button("+ نفّذ اليوم");
    currentVisitId = 91002; await flush(); await invoke(plannedA);
    await invoke(button("احفظ بلا توقيع")); await flush();
    const body = JSON.parse(String(writes()[0][1].body));
    expect(writes()[0][0]).toBe("/api/visits/91002/clinical");
    expect(body.billingCurrency).toBe("YER"); expect(body.procedures).toEqual([]);
  });

  it("preserves a successful live signature and checkout callback when the follow-up read fails", async () => {
    await mount(); await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
    reads.set(91001, async () => response(503, { message: "Synthetic signed reload failure" }));
    pendingWrite = async () => response(200, { patientId: 92001, invoiceId: null, invoiceCurrency: null, duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null });
    const capturedSign = find((node) => node.type === "button" && /وقّع|تأكيد إنهاء/.test(contents(node)));
    await invoke(capturedSign); await flush();
    expect(onSigned).toHaveBeenCalledOnce();
    expect(nodes().some((node) => node.props.label === "② التشخيص")).toBe(false);
    expect(find((node) => node.props["data-testid"] === "clinical-sign-confirmed")).toBeDefined();
    expect(contents(render())).not.toContain("Synthetic signed reload failure");
    expect(nodes().some((node) => node.type === "button" && contents(node).trim() === "احفظ بلا توقيع")).toBe(false);
    const completedWrites = writes().length;
    await invoke(capturedSign); await flush(); expect(writes()).toHaveLength(completedWrites);
    reads.delete(91001); stored.set(91001, { ...stored.get(91001), status: "signed" });
    await invoke(button("أعد تحميل الزيارة")); await flush();
    expect(field("② التشخيص").props.disabled).toBe(true);
    await invoke(capturedSign); await flush(); expect(writes()).toHaveLength(completedWrites);
    expect(onSigned).toHaveBeenCalledOnce();
  });
});

describe("atomic clinical snapshots", () => {
  it.each([null, undefined, [null], [{ serviceId: 96001 }]])("never exposes B with A procedure drafts when B procedures are malformed: %j", async (procedures) => {
    stored.set(91001, { ...stored.get(91001), procedures: [{ serviceId: 96001, serviceName: "A free work", category: "filling", toothCode: 11, quantity: 1, unitPriceMinor: 100, doctorId: 94001, planItemId: null }] });
    await mount();
    expect(nodes().filter((node) => node.props["aria-label"] === "الكمية")).toHaveLength(1);
    reads.set(91002, async () => response(200, { ...stored.get(91002), procedures }));
    currentVisitId = 91002; await flush();
    expect(nodes().some((node) => node.props.label === "② التشخيص")).toBe(false);
    expect(nodes().some((node) => node.type === "button" && contents(node).trim() === "احفظ بلا توقيع")).toBe(false);
    expect(writes()).toHaveLength(0);
    expect(contents(render())).toContain("غير مكتملة");
  });
});

it("does not thaw an accepted signature when its follow-up read unexpectedly says open", async () => {
  await mount(); await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
  pendingWrite = async () => response(200, { patientId: 92001, invoiceId: null, invoiceCurrency: null, duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null });
  await invoke(find((node) => node.type === "button" && /وقّع|تأكيد إنهاء/.test(contents(node)))); await flush();
  expect(onSigned).toHaveBeenCalledOnce();
  expect(nodes().some((node) => node.props.label === "② التشخيص")).toBe(false);
  expect(find((node) => node.props["data-testid"] === "clinical-sign-confirmed")).toBeDefined();
  expect(contents(render())).toContain("تعذّر تأكيد حالة الزيارة");
  const completedWrites = writes().length;
  await invoke(button("أعد تحميل الزيارة")); await flush();
  expect(nodes().some((node) => node.props.label === "② التشخيص")).toBe(false);
  expect(contents(render())).toContain("تعذّر تأكيد حالة الزيارة");
  expect(writes()).toHaveLength(completedWrites);
  stored.set(91001, { ...stored.get(91001), status: "signed" });
  await invoke(button("أعد تحميل الزيارة")); await flush();
  expect(field("② التشخيص").props.disabled).toBe(true);
  expect(onSigned).toHaveBeenCalledOnce();
});

it("does not show a retired owner's error while the new owner read is pending", async () => {
  reads.set(91001, async () => response(503, { message: "Private retired A error" })); await mount();
  expect(contents(render())).toContain("تعذّر تحميل الزيارة الحالية");
  expect(contents(render())).not.toContain("Private retired A error");
  const b = deferred<Response>(); reads.set(91002, () => b.promise); currentVisitId = 91002; render();
  expect(contents(render())).not.toContain("Private retired A error");
  expect(contents(render())).not.toContain("تعذّر تحميل الزيارة الحالية");
  b.resolve(response(200, stored.get(91002))); await flush();
  expect(field("② التشخيص").props.value).toBe("Visit B diagnosis");
});

it("does not warn about a pending or unsaved command during live successful-sign navigation", async () => {
  let allowedAtSuccess = false;
  const prevented = vi.fn();
  onSigned = vi.fn(() => {
    allowedAtSuccess = navigationGuard?.() ?? false;
    const calls = vi.mocked(window.addEventListener).mock.calls.filter(([type]) => type === "beforeunload");
    const warn = calls.at(-1)?.[1] as (event: BeforeUnloadEvent) => void;
    warn({ preventDefault: prevented, returnValue: "" } as unknown as BeforeUnloadEvent);
  });
  await mount(); await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
  pendingWrite = async () => {
    stored.set(91001, { ...stored.get(91001), status: "signed" });
    return response(200, { patientId: 92001, invoiceId: null, invoiceCurrency: null, duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null });
  };
  await invoke(find((node) => node.type === "button" && /وقّع|تأكيد إنهاء/.test(contents(node)))); await flush();
  expect(onSigned).toHaveBeenCalledOnce(); expect(allowedAtSuccess).toBe(true); expect(prevented).not.toHaveBeenCalled();
});

it("retires accepted snapshots and commands when permissions change under the same principal", async () => {
  hooks.permissions = { ...DEFAULT_DOCTOR_PERMISSIONS }; await mount();
  const oldSave = button("احفظ بلا توقيع");
  const newer = deferred<Response>(); reads.set(91001, () => newer.promise);
  hooks.permissions = { ...DEFAULT_DOCTOR_PERMISSIONS, canEditPlans: !DEFAULT_DOCTOR_PERMISSIONS.canEditPlans };
  render(); await invoke(oldSave);
  expect(writes()).toHaveLength(0);
  expect(nodes().some((node) => node.props.label === "② التشخيص")).toBe(false);
  newer.resolve(response(200, visit(91001, "Permission-scoped fresh read"))); await flush();
  expect(field("② التشخيص").props.value).toBe("Permission-scoped fresh read");
});

it("does not apply A's delayed patient context after B's current context", async () => {
  const oldContext = deferred<Response>(); let contexts = 0;
  extraReads.set("/api/patients/92001", () => ++contexts === 1 ? oldContext.promise
    : Promise.resolve(response(200, { patient: { id: 92001, medicalAlert: "Current context B", phone: "777000002" }, visits: [], appointments: [] })));
  await mount();
  await invoke(find((node) => node.type === "button" && contents(node).includes("روشتة طبية (℞)"))); await flush();
  currentVisitId = 91002; await flush();
  await invoke(find((node) => node.type === "button" && contents(node).includes("روشتة طبية (℞)"))); await flush();
  expect(find((node) => Object.hasOwn(node.props, "medicalAlert")).props.medicalAlert).toBe("Current context B");
  oldContext.resolve(response(200, { patient: { id: 92001, medicalAlert: "Retired context A", phone: "777000001" }, visits: [], appointments: [] })); await flush();
  expect(find((node) => Object.hasOwn(node.props, "medicalAlert")).props.medicalAlert).toBe("Current context B");
  expect(find((node) => Object.hasOwn(node.props, "patientPhone")).props.patientPhone).toBe("777000002");
});



it.each([401, 403, 404])("hides the confirmed signature receipt after authoritative %s and keeps captured writes retired", async (status) => {
  await mount(); await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
  reads.set(91001, async () => response(status, { message: "Private denial detail" }));
  pendingWrite = async () => response(200, { patientId: 92001, invoiceId: null, invoiceCurrency: null, duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null });
  const sign = find((node) => node.type === "button" && /وقّع|تأكيد إنهاء/.test(contents(node)));
  await invoke(sign); await flush();
  expect(onSigned).toHaveBeenCalledOnce();
  expect(nodes().some((node) => node.props["data-testid"] === "clinical-sign-confirmed")).toBe(false);
  expect(nodes().some((node) => node.props.label === "② التشخيص")).toBe(false);
  expect(contents(render())).not.toContain("Private denial detail");
  const completedWrites = writes().length;
  await invoke(sign); await flush(); expect(writes()).toHaveLength(completedWrites);
});

it("does not carry a confirmed signature receipt into another visit's pending owner", async () => {
  await mount(); await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
  reads.set(91001, async () => response(503, {}));
  pendingWrite = async () => response(200, { patientId: 92001, invoiceId: null, invoiceCurrency: null, duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null });
  await invoke(find((node) => node.type === "button" && /وقّع|تأكيد إنهاء/.test(contents(node)))); await flush();
  expect(find((node) => node.props["data-testid"] === "clinical-sign-confirmed")).toBeDefined();
  const b = deferred<Response>(); reads.set(91002, () => b.promise); currentVisitId = 91002; render();
  expect(nodes().some((node) => node.props["data-testid"] === "clinical-sign-confirmed")).toBe(false);
  b.resolve(response(200, stored.get(91002))); await flush();
  expect(field("② التشخيص").props.value).toBe("Visit B diagnosis");
});

it.each([null, {}, { patientId: 92001, invoiceId: null, invoiceCurrency: "BAD", duesMinor: 0, sessionsCompleted: 0, nextPlannedVisit: null }])("treats malformed successful-sign DTO %j as unknown until a fresh canonical read", async (payload) => {
  await mount(); const oldSave = button("احفظ بلا توقيع");
  await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
  pendingWrite = async () => response(200, payload);
  const sign = find((node) => node.type === "button" && /وقّع|تأكيد إنهاء/.test(contents(node)));
  await invoke(sign); await flush();
  expect(onSigned).not.toHaveBeenCalled();
  expect(contents(render())).toContain("تعذّر تأكيد نتيجة التوقيع");
  expect(nodes().some((node) => node.props["data-testid"] === "clinical-sign-confirmed")).toBe(false);
  expect(nodes().some((node) => node.props.label === "② التشخيص")).toBe(false);
  const count = writes().length;
  await invoke(sign); await invoke(oldSave); await flush(); expect(writes()).toHaveLength(count);
  stored.set(91001, { ...stored.get(91001), status: "signed" });
  await invoke(button("أعد تحميل الزيارة")); await flush();
  expect(field("② التشخيص").props.disabled).toBe(true);
  await invoke(sign); await invoke(oldSave); await flush(); expect(writes()).toHaveLength(count);
  expect(onSigned).not.toHaveBeenCalled();
});

it("keeps a newer same-owner local edit when the saved snapshot is confirmed, and does not open review", async () => {
  await mount();
  const doctor = find((node) => node.type === "select" && node.props.value === 94001);
  const write = deferred<Response>(); pendingWrite = async (_id, body) => {
    const result = await write.promise; stored.set(91001, { ...stored.get(91001), ...body }); return result;
  };
  const review = invoke(button("مراجعة وإنهاء الزيارة"));
  // A closure captured before busy rendered cannot make the later snapshot
  // look like the one that the pending POST actually submitted.
  (doctor.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "" } }); render();
  write.resolve(response(200, {})); await review; await flush();
  expect(find((node) => node.type === "select" && node.props.value === "")).toBeDefined();
  expect(contents(render())).toContain("احتُفظ بتعديلات أحدث");
  expect(nodes().some((node) => node.props.role === "dialog")).toBe(false);
  expect(navigationGuard?.()).toBe(false);
});

it.each(["mo", "OM"])("accepts the route's canonical free-line normalization for surfaces %s and fractional quantity", async (surfaces) => {
  stored.set(91001, { ...stored.get(91001), procedures: [{ serviceId: 96001, toothCode: 16, surfaces: null,
    quantity: 1, unitPriceMinor: 100, doctorId: 94001, planItemId: null }] });
  await mount();
  (find((node) => node.props["aria-label"] === "الأسطح").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: surfaces } }); render();
  (find((node) => node.props["aria-label"] === "الكمية").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "1.6" } }); render();
  (field("② التشخيص").props.onChange as (value: string) => void)("  Canonically trimmed diagnosis  "); render();
  pendingWrite = async (id, body) => {
    const procedures = (body.procedures as Array<Record<string, unknown>>).map((row) => ({ ...row,
      surfaces: normalizeSurfaces(row.surfaces as string | null), quantity: Math.max(1, Math.round(Number(row.quantity))),
      unitPriceMinor: Math.max(0, Math.round(Number(row.unitPriceMinor))) }));
    stored.set(id, { ...stored.get(id), ...body, diagnosis: String(body.diagnosis).trim(), procedures });
    return response(200, {});
  };
  await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
  expect(find((node) => node.props["aria-label"] === "الأسطح").props.value).toBe(normalizeSurfaces(surfaces));
  expect(find((node) => node.props["aria-label"] === "الكمية").props.value).toBe(2);
  expect(field("② التشخيص").props.value).toBe("Canonically trimmed diagnosis");
  expect(contents(render())).not.toContain("تعذّر تأكيد حفظ المسودة");
  expect(nodes().some((node) => node.props.role === "dialog")).toBe(true);
  expect(navigationGuard?.()).toBe(true);
});

it.each(["matching", "notes", "provider", "currency"])("adopts server-owned linked session quantity/price only with matching clinician-owned data: %s", async (caseKind) => {
  stored.set(91001, { ...stored.get(91001), procedures: [{ serviceId: 96001, toothCode: 16, surfaces: "MO",
    quantity: 1, unitPriceMinor: 100, doctorId: 94001, planItemId: 95001 }] });
  await mount();
  (find((node) => node.props["aria-label"] === "الكمية").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "4.4" } }); render();
  (field("② التشخيص").props.onChange as (value: string) => void)("Current clinician-owned diagnosis"); render();
  pendingWrite = async (id, body) => {
    const procedures = (body.procedures as Array<Record<string, unknown>>).map((row) => ({ ...row, quantity: 1, unitPriceMinor: 375 }));
    stored.set(id, { ...stored.get(id), ...body, procedures,
      ...(caseKind === "notes" ? { diagnosis: "Stale persisted diagnosis" } : {}),
      ...(caseKind === "provider" ? { doctorId: null } : {}),
      ...(caseKind === "currency" ? { billingCurrency: "USD" } : {}) });
    return response(200, {});
  };
  await invoke(button("احفظ بلا توقيع")); await flush();
  expect(field("② التشخيص").props.value).toBe("Current clinician-owned diagnosis");
  if (caseKind === "matching") {
    expect(find((node) => node.props["aria-label"] === "الكمية").props.value).toBe(1);
    expect(find((node) => node.props["aria-label"] === "السعر").props.value).toBe("375");
    expect(contents(render())).not.toContain("تعذّر تأكيد حفظ المسودة");
    expect(navigationGuard?.()).toBe(true);
  } else {
    expect(find((node) => node.props["aria-label"] === "الكمية").props.value).toBe(4.4);
    expect(find((node) => node.props["aria-label"] === "السعر").props.value).toBe("100");
    expect(contents(render())).toContain("تعذّر تأكيد حفظ المسودة");
    expect(navigationGuard?.()).toBe(false);
  }
});

it("invalidates an in-flight read when a sign response has an unknown outcome", async () => {
  reads.set(91001, async () => response(503, {})); await mount();
  const capturedRetry = button("أعد تحميل الزيارة"); reads.delete(91001);
  await invoke(capturedRetry); await flush();
  await invoke(button("مراجعة وإنهاء الزيارة")); await flush();
  const post = deferred<Response>(); pendingWrite = async () => post.promise;
  const signing = invoke(find((node) => node.type === "button" && /وقّع|تأكيد إنهاء/.test(contents(node))));
  const stale = deferred<Response>(); reads.set(91001, () => stale.promise);
  const refreshing = invoke(capturedRetry);
  post.resolve(response(200, {})); await signing; await flush();
  expect(contents(render())).toContain("تعذّر تأكيد نتيجة التوقيع");
  stale.resolve(response(200, stored.get(91001))); await refreshing; await flush();
  expect(nodes().some((node) => node.props.label === "② التشخيص")).toBe(false);
  expect(contents(render())).toContain("تعذّر تأكيد نتيجة التوقيع");
  expect(onSigned).not.toHaveBeenCalled();
});
