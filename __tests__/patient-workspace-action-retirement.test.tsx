/** Synthetic handler/lifecycle tests, not browser acceptance. Real modal owners run;
 * only React hook scheduling, unrelated dialogs and network transport are replaced. */
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrescriptionModal } from "../components/PrescriptionModal";
import { VitalsModal } from "../components/VitalsModal";
import { WorkspaceDialogs } from "../components/patient-workspace/WorkspaceDialogs";
import type { Patient } from "../lib/patient";
import { checkPrescriptionDraft } from "../lib/prescription";
import { buildSafetyAcknowledgementToken, verifySafetyAcknowledgementToken } from "../lib/prescription-safety-ack";

type Hooks = { values: unknown[]; cursor: number; changed: boolean; mounted: boolean; lateUpdates: number;
  effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void; layout: boolean }>;
  memos: Map<number, { deps?: readonly unknown[]; value: unknown }>; pending: Array<() => void>; layout: Array<() => void> };
const runtime = vi.hoisted(() => ({ current: null as Hooks | null }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const current = () => { if (!runtime.current) throw new Error("Missing synthetic hook owner"); return runtime.current; };
  const slot = (hooks: Hooks, initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const memo = (compute: () => unknown, deps?: readonly unknown[]) => { const hooks = current(); const index = slot(hooks, undefined); const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = compute(); hooks.memos.set(index, { deps, value }); return value; };
  const effect = (layout: boolean) => (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const hooks = current(); const index = slot(hooks, undefined); const previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    (layout ? hooks.layout : hooks.pending).push(() => { previous?.cleanup?.(); if (previous) previous.cleanup = undefined;
      const cleanup = run(); hooks.effects.set(index, { deps, layout, cleanup: typeof cleanup === "function" ? cleanup : undefined }); });
  };
  return { ...react,
    useState: (initial: unknown) => { const hooks = current(); const index = slot(hooks, typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => { if (!hooks.mounted) hooks.lateUpdates++;
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true; hooks.values[index] = next; }]; },
    useRef: (initial: unknown) => { const hooks = current(); return hooks.values[slot(hooks, { current: initial })]; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: effect(false), useLayoutEffect: effect(true),
  };
});
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic" }));
vi.mock("../components/Icon", () => ({ Icon: () => null }));
vi.mock("../components/ConsentModal", () => ({ ConsentModal: () => null }));
vi.mock("../components/QuickAppointmentModal", () => ({ QuickAppointmentModal: () => null }));
vi.mock("../components/PostOpModal", () => ({ PostOpModal: () => null }));
vi.mock("../components/CaseProfitabilityModal", () => ({ CaseProfitabilityModal: () => null }));
vi.mock("../lib/schedule", () => ({ clinicDateString: () => "2026-10-03" }));

type Element = ReactElement<Record<string, unknown>>;
type WorkspaceProps = Parameters<typeof WorkspaceDialogs>[0];
const instances: Hooks[] = [];
function instance(): Hooks { const hooks: Hooks = { values: [], cursor: 0, changed: false, mounted: true, lateUpdates: 0, effects: new Map(), memos: new Map(), pending: [], layout: [] }; instances.push(hooks); return hooks; }
function commitUnmount(hooks: Hooks, flushPassive = true) {
  hooks.effects.forEach((effect) => { if (effect.layout || flushPassive) { effect.cleanup?.(); effect.cleanup = undefined; } }); hooks.mounted = false;
}
function unmount(hooks: Hooks) { commitUnmount(hooks); }
function evaluate(hooks: Hooks, component: (props: never) => ReactNode, props: unknown, flushPassive = true) {
  let tree: ReactNode; let rounds = 0;
  do { if (++rounds > 15) throw new Error("Synthetic component did not settle"); hooks.cursor = 0; hooks.changed = false; runtime.current = hooks;
    tree = component(props as never); runtime.current = null; hooks.layout.splice(0).forEach((effect) => effect());
    if (flushPassive) hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
function nodes(tree: ReactNode): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const node = tree as Element; return [node, ...nodes(node.props.children as ReactNode)];
}
function contents(tree: ReactNode): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(contents).join("");
  return tree && typeof tree === "object" && "props" in tree ? contents((tree as Element).props.children as ReactNode) : "";
}
const response = (payload: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fetchMock = vi.fn(); const printMock = vi.fn();
let props: WorkspaceProps; let root: Hooks;
// Clinical launchers may pass this direct-owner context; WorkspaceDialogs itself
// remains patient-only and is independently asserted to omit visitId.
let directRxContext: Partial<Parameters<typeof PrescriptionModal>[0]>;
let children: Map<unknown, { key: string | null; hooks: Hooks; props: Record<string, unknown>; tree: ReactNode }>;
let mutation: (url: string, init: RequestInit) => unknown;
let sequence = 0;
const savedVitals = (id: number) => response({ id, patientId: props.patient.id, bpSystolic: 120, bpDiastolic: 80, pulse: null, glucose: null }, 201);
const canonicalMutation = (url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  if (url.endsWith("/vitals")) return response({ id: 82000, patientId: Number(url.split("/")[3]), ...body }, 201);
  if (init.method === "PATCH") return response({ id: Number(url.split("/")[3]), medicalAlert: body.medicalAlert });
  return response({ id: 81001 }, 201);
};
function render(change: Partial<WorkspaceProps> = {}, flushPassive = true) {
  props = { ...props, ...change };
  const tree = evaluate(root, WorkspaceDialogs, props, flushPassive); const keep = new Set<unknown>();
  for (const child of nodes(tree).filter((node) => node.type === PrescriptionModal || node.type === VitalsModal)) {
    keep.add(child.type); let previous = children.get(child.type);
    if (!previous || previous.key !== child.key) { if (previous) commitUnmount(previous.hooks, flushPassive); previous = { key: child.key, hooks: instance(), props: child.props, tree: null }; children.set(child.type, previous); }
    previous.props = child.type === PrescriptionModal ? { ...child.props, ...directRxContext } : child.props;
    previous.tree = evaluate(previous.hooks, child.type as (value: never) => ReactNode, previous.props, flushPassive);
  }
  for (const [type, child] of children) if (!keep.has(type)) { commitUnmount(child.hooks, flushPassive); children.delete(type); }
  return tree;
}
function dialog(type: unknown) { render(); const child = children.get(type); if (!child) throw new Error("Missing actual modal"); return child; }
function control(type: unknown, predicate: (node: Element) => boolean) { const found = nodes(dialog(type).tree).find(predicate); if (!found) throw new Error("Missing actual modal control"); return found; }
function button(type: unknown, label: string) { return control(type, (node) => node.type === "button" && contents(node) === label); }
function click(type: unknown, label: string) { (button(type, label).props.onClick as () => void)(); }
function change(type: unknown, placeholder: string, value: string) { (control(type, (node) => node.props.placeholder === placeholder).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); }
function draftRx() { render({ action: "prescription" }); click(PrescriptionModal, "إضافة دواء جديد"); change(PrescriptionModal, "Drug name (e.g. Augmentin / Brufen)", "SyntheticDrug"); }
function draftVitals() { render({ action: "vitals" }); change(VitalsModal, "الانقباضي (120)", "120"); change(VitalsModal, "الانبساطي (80)", "80"); }
function submitVitals() { const form = control(VitalsModal, (node) => node.type === "form"); return (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault() {} }); }
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method);
const text = (type: unknown) => contents(dialog(type).tree);
const submitDisabled = () => control(VitalsModal, (node) => node.type === "button" && node.props.type === "submit").props.disabled;
async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
beforeEach(() => {
  instances.length = 0; root = instance(); children = new Map(); directRxContext = {};
  const patient: Patient = { id: 71000 + ++sequence, patientNumber: "SYN-ONLY", fullName: "Synthetic patient", phone: null, altPhone: null, gender: "unknown", birthYear: null, address: null, medicalAlert: "Synthetic initial alert", note: null, createdAt: "2026-10-03" };
  props = { authorityKey: "synthetic:doctor:A", action: null, patient, openVisitId: null, canWrite: true, canEditPatient: true, canViewProfitability: false,
    onClose: vi.fn(() => { props = { ...props, action: null }; }), onChanged: vi.fn(), onMedicalSaved: vi.fn() };
  printMock.mockReset(); fetchMock.mockReset(); mutation = canonicalMutation;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => init?.method ? Promise.resolve(mutation(url, init)) : Promise.resolve(response({ prescriptions: [], suggestions: [] })));
  vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("window", { open: printMock });
  vi.stubGlobal("HTMLElement", class {}); vi.stubGlobal("document", { activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => { instances.forEach(unmount); await settle(); vi.unstubAllGlobals(); });

describe("actual prescription action owner retirement", () => {
  it("keeps the canonical POST and official saved-document print and serializes same-frame clicks", async () => {
    draftRx(); const handler = button(PrescriptionModal, "طباعة الروشتة (A5)").props.onClick as () => void;
    handler(); handler(); await settle();
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe("/api/prescriptions");
    expect(JSON.parse(writes()[0][1].body)).toMatchObject({ patientId: props.patient.id, items: [{ name: "SyntheticDrug" }] });
    expect(JSON.parse(writes()[0][1].body)).not.toHaveProperty("visitId");
    expect(writes()[0][1]).not.toHaveProperty("signal");
    expect(printMock).toHaveBeenCalledWith(`/print/prescription/${props.patient.id}?rx=81001`, "_blank");
  });
  it("passes only the launcher's exact linked visit in the normal save", async () => {
    directRxContext = { visitId: 73001 }; draftRx(); click(PrescriptionModal, "طباعة الروشتة (A5)"); await settle();
    expect(writes()).toHaveLength(1); expect(JSON.parse(writes()[0][1].body)).toMatchObject({ patientId: props.patient.id, visitId: 73001 });
    expect(printMock).toHaveBeenCalledWith(`/print/prescription/${props.patient.id}?rx=81001`, "_blank");
  });
  it("binds both the safety preview and acknowledged save to the same exact visit", async () => {
    directRxContext = { visitId: 73002 };
    mutation = (_url, init) => {
      const body = JSON.parse(String(init.body)); const checked = checkPrescriptionDraft(body);
      if (!checked.ok) throw new Error("Invalid synthetic prescription");
      const input = { username: "synthetic-clinician", draft: checked.value, warnings: [], now: 1_800_000_000_000 };
      if (!body.acknowledgedSafetyToken) return response({ requiresAcknowledgement: true, safetyWarnings: [], acknowledgementToken: buildSafetyAcknowledgementToken(input) });
      expect(verifySafetyAcknowledgementToken(body.acknowledgedSafetyToken, input).ok).toBe(true);
      expect(verifySafetyAcknowledgementToken(body.acknowledgedSafetyToken, { ...input, draft: { ...checked.value, visitId: 73003 } }).ok).toBe(false);
      return response({ id: 81011 }, 201);
    };
    draftRx(); click(PrescriptionModal, "طباعة الروشتة (A5)"); await settle();
    click(PrescriptionModal, "أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا"); await settle();
    expect(writes()).toHaveLength(2); for (const [, init] of writes()) expect(JSON.parse(init.body)).toMatchObject({ patientId: props.patient.id, visitId: 73002 });
    expect(JSON.parse(writes()[1][1].body).acknowledgedSafetyToken).toEqual(expect.any(String));
    expect(printMock).toHaveBeenCalledWith(`/print/prescription/${props.patient.id}?rx=81011`, "_blank");
  });
  it.each(["normal", "acknowledged"])("retires a %s linked-visit save across visit A → B → A", async (kind) => {
    directRxContext = { visitId: 73004 }; draftRx();
    if (kind === "acknowledged") { mutation = () => response({ requiresAcknowledgement: true, acknowledgementToken: "synthetic-visit-token", safetyWarnings: [] }); click(PrescriptionModal, "طباعة الروشتة (A5)"); await settle(); }
    const pending = deferred<ReturnType<typeof response>>(); mutation = () => pending.promise;
    click(PrescriptionModal, kind === "normal" ? "طباعة الروشتة (A5)" : "أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا");
    const count = writes().length; directRxContext = { visitId: 73005 }; render(); directRxContext = { visitId: 73004 }; render();
    pending.resolve(response({ id: 81012 }, 201)); await settle();
    expect(printMock).not.toHaveBeenCalled(); expect(writes()).toHaveLength(count); expect(text(PrescriptionModal)).not.toContain("أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا");
    expect(nodes(dialog(PrescriptionModal).tree).some((node) => node.props.placeholder === "Drug name (e.g. Augmentin / Brufen)")).toBe(false);
  });
  it("does not revive retained pre-submit handlers after exact visit replacement", async () => {
    directRxContext = { visitId: 73006 }; draftRx(); const retired = button(PrescriptionModal, "طباعة الروشتة (A5)").props.onClick as () => void;
    directRxContext = { visitId: 73007 }; render(); directRxContext = { visitId: 73006 }; render(); retired(); await settle();
    expect(writes()).toHaveLength(0); expect(printMock).not.toHaveBeenCalled();
  });
  it("keeps an unlinked patient draft-only even if a caller supplies a visit", async () => {
    directRxContext = { patientId: null, visitId: 73008, patientName: "Synthetic unlinked visit" }; draftRx(); click(PrescriptionModal, "طباعة الروشتة (A5)"); await settle();
    expect(writes()).toHaveLength(0); expect(printMock).toHaveBeenCalledOnce(); expect(printMock.mock.calls[0][0]).toContain("draft=1"); expect(printMock.mock.calls[0][0]).not.toContain("rx=");
  });
  it.each([0, -1, 1.5, Number.NaN])("does not silently downgrade invalid supplied visit %s to patient-only saving", async (visitId) => {
    directRxContext = { visitId }; draftRx(); click(PrescriptionModal, "طباعة الروشتة (A5)"); await settle();
    expect(writes()).toHaveLength(0); expect(printMock).not.toHaveBeenCalled(); expect(text(PrescriptionModal)).toContain("سياق الزيارة غير صالح");
  });
  it("retires Close immediately even when the parent's next render has not occurred", async () => {
    const pending = deferred<ReturnType<typeof response>>(); mutation = () => pending.promise;
    draftRx(); click(PrescriptionModal, "طباعة الروشتة (A5)"); click(PrescriptionModal, "إلغاء");
    pending.resolve(response({ id: 81002 }, 201)); await settle();
    expect(printMock).not.toHaveBeenCalled(); expect(props.onClose).toHaveBeenCalledOnce(); expect(writes()).toHaveLength(1);
  });
  it("cannot revive a save on Close/reopen, blocks duplicate in-flight writes and enables a new explicit action after settlement", async () => {
    const pending = deferred<ReturnType<typeof response>>(); mutation = () => pending.promise;
    draftRx(); click(PrescriptionModal, "طباعة الروشتة (A5)"); click(PrescriptionModal, "إلغاء"); render(); render({ action: "prescription" });
    const busy = button(PrescriptionModal, "جارٍ حفظ الوصفة…"); expect(busy.props.disabled).toBe(true); (busy.props.onClick as () => void)(); expect(writes()).toHaveLength(1);
    pending.resolve(response({ id: 81003 }, 201)); await settle(); expect(printMock).not.toHaveBeenCalled();
    expect(text(PrescriptionModal)).toContain("الإغلاق لا يلغي الطلب");
    mutation = () => response({ id: 81004 }, 201); click(PrescriptionModal, "طباعة الروشتة (A5)"); await settle();
    expect(writes()).toHaveLength(2); expect(printMock).toHaveBeenCalledTimes(1); expect(printMock.mock.calls[0][0]).toContain("rx=81004");
  });
  it.each(["authority", "patient", "medical-alert"])("fences delayed save completion after %s changes and returns to the old context", async (field) => {
    const pending = deferred<ReturnType<typeof response>>(); mutation = () => pending.promise; draftRx(); const original = { ...props };
    click(PrescriptionModal, "طباعة الروشتة (A5)");
    if (field === "authority") render({ authorityKey: "synthetic:doctor:B" });
    else render({ patient: { ...props.patient, ...(field === "patient" ? { id: props.patient.id + 1000 } : { medicalAlert: "Synthetic newer warning" }) } });
    render(original); pending.resolve(response({ id: 81005 }, 201)); await settle();
    expect(printMock).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1); expect(instances.every((one) => one.lateUpdates === 0)).toBe(true);
  });
  it("keeps the shared request latch across a keyed authority remount", async () => {
    const pending = deferred<ReturnType<typeof response>>(); mutation = () => pending.promise; draftRx(); click(PrescriptionModal, "طباعة الروشتة (A5)");
    render({ authorityKey: "synthetic:doctor:B" }); draftRx();
    const busy = button(PrescriptionModal, "جارٍ حفظ الوصفة…"); expect(busy.props.disabled).toBe(true); (busy.props.onClick as () => void)(); expect(writes()).toHaveLength(1);
    pending.resolve(response({ id: 81006 }, 201)); await settle(); expect(printMock).not.toHaveBeenCalled();
    expect(button(PrescriptionModal, "طباعة الروشتة (A5)").props.disabled).toBe(false);
  });
  it.each(["close-reopen", "unmount"])("retires the actual safety acknowledgement handler on %s", async (retirement) => {
    mutation = () => response({ requiresAcknowledgement: true, acknowledgementToken: "synthetic-token", safetyWarnings: [] }); draftRx();
    click(PrescriptionModal, "طباعة الروشتة (A5)"); await settle(); const pending = deferred<ReturnType<typeof response>>(); mutation = () => pending.promise;
    const acknowledge = button(PrescriptionModal, "أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا").props.onClick as () => void;
    acknowledge(); acknowledge(); expect(writes()).toHaveLength(2); expect(JSON.parse(writes()[1][1].body).acknowledgedSafetyToken).toBe("synthetic-token");
    if (retirement === "unmount") { instances.forEach(unmount); }
    else { click(PrescriptionModal, "إلغاء"); render(); render({ action: "prescription" }); }
    pending.resolve(response({ id: 81007 }, 201)); await settle(); expect(printMock).not.toHaveBeenCalled();
    expect(instances.every((one) => one.lateUpdates === 0)).toBe(true);
    if (retirement === "close-reopen") expect(text(PrescriptionModal)).not.toContain("أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا");
  });
  it("fences success body parsing and never opens a stale fallback for delayed failures", async () => {
    const body = deferred<unknown>(); mutation = () => ({ ok: true, status: 201, json: () => body.promise });
    draftRx(); click(PrescriptionModal, "طباعة الروشتة (A5)"); await settle(); click(PrescriptionModal, "إلغاء"); render({ action: "vitals" });
    body.resolve({ id: 81008 }); await settle(); expect(printMock).not.toHaveBeenCalled(); expect(props.action).toBe("vitals");
    render({ action: "prescription" }); const failed = deferred<ReturnType<typeof response>>(); mutation = () => failed.promise;
    click(PrescriptionModal, "طباعة الروشتة (A5)"); click(PrescriptionModal, "إلغاء"); render({ action: "vitals" });
    failed.resolve(response({ message: "Synthetic temporary failure" }, 503)); await settle(); expect(printMock).not.toHaveBeenCalled();
  });
  it.each([408, 499, 500, 503, "malformed-201", "malformed-200", "foreign-patient", "transport"])("retains an unknown Rx %s outcome across dismissal and authority remount without replay", async (status) => {
    const pending = deferred<ReturnType<typeof response>>(); mutation = () => pending.promise; draftRx(); click(PrescriptionModal, "طباعة الروشتة (A5)");
    click(PrescriptionModal, "إلغاء"); render(); render({ action: "prescription", authorityKey: "synthetic:doctor:B" });
    if (status === "transport") pending.reject(new Error("Synthetic lost connection"));
    else if (status === "foreign-patient") pending.resolve(response({ id: 81009, patientId: props.patient.id + 1 }, 201));
    else pending.resolve(response({}, typeof status === "number" ? status : status === "malformed-201" ? 201 : 200));
    await settle(); expect(printMock).not.toHaveBeenCalled(); expect(text(PrescriptionModal)).toContain("الحفظ الجديد متوقف");
    const print = button(PrescriptionModal, "طباعة الروشتة (A5)"); expect(print.props.disabled).toBe(true);
    (print.props.onClick as () => void)(); expect(writes()).toHaveLength(1);
    render({ authorityKey: "synthetic:doctor:A" }); draftRx(); click(PrescriptionModal, "طباعة الروشتة (A5)"); expect(writes()).toHaveLength(1);
  });
  it.each(["action", "authority", "unmount"])("blocks retired Rx completion during the committed %s boundary before passive cleanup", async (boundary) => {
    const pending = deferred<ReturnType<typeof response>>(); mutation = () => pending.promise; draftRx(); click(PrescriptionModal, "طباعة الروشتة (A5)"); await settle();
    if (boundary === "unmount") instances.forEach((one) => commitUnmount(one, false));
    else render(boundary === "action" ? { action: "vitals" } : { authorityKey: "synthetic:doctor:B" }, false);
    pending.resolve(response({ id: 81010 }, 201)); await settle();
    expect(printMock).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled(); expect(instances.every((one) => one.lateUpdates === 0)).toBe(true);
  });
  it("keeps a retained uninvoked print handler retired across Close/reopen", async () => {
    draftRx(); const retired = button(PrescriptionModal, "طباعة الروشتة (A5)").props.onClick as () => void;
    click(PrescriptionModal, "إلغاء"); render(); render({ action: "prescription" }); retired(); await settle();
    expect(writes()).toHaveLength(0); expect(printMock).not.toHaveBeenCalled();
    click(PrescriptionModal, "طباعة الروشتة (A5)"); await settle(); expect(writes()).toHaveLength(1); expect(printMock).toHaveBeenCalledOnce();
  });
  it("keeps a retained uninvoked acknowledgement handler retired across Close/reopen", async () => {
    mutation = () => response({ requiresAcknowledgement: true, acknowledgementToken: "synthetic-old-token", safetyWarnings: [] });
    draftRx(); click(PrescriptionModal, "طباعة الروشتة (A5)"); await settle();
    const retired = button(PrescriptionModal, "أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا").props.onClick as () => void;
    click(PrescriptionModal, "إلغاء"); render(); render({ action: "prescription" }); retired(); await settle();
    expect(writes()).toHaveLength(1); expect(printMock).not.toHaveBeenCalled(); expect(text(PrescriptionModal)).not.toContain("أقرّ قراءة التحذيرات — حفظ الوصفة وطباعتها رسميًا");
  });
  it("reports an unknown transport result without claiming cancellation or silently printing/retrying", async () => {
    mutation = () => Promise.reject(new Error("Synthetic lost transport")); draftRx(); click(PrescriptionModal, "طباعة الروشتة (A5)"); await settle();
    expect(writes()).toHaveLength(1); expect(printMock).not.toHaveBeenCalled(); expect(text(PrescriptionModal)).toContain("قد تكون محفوظة بالفعل");
  });
});

describe("actual vitals action owner and workspace callback retirement", () => {
  it("keeps canonical readings and note-only endpoints and blocks same-frame submit duplicates", async () => {
    draftVitals(); const first = submitVitals(); const second = submitVitals(); await Promise.all([first, second]);
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toBe(`/api/patients/${props.patient.id}/vitals`);
    expect(JSON.parse(writes()[0][1].body)).toMatchObject({ bpSystolic: 120, recordedAt: "2026-10-03" });
    expect(writes()[0][1]).not.toHaveProperty("signal"); expect(props.onMedicalSaved).toHaveBeenCalledOnce(); expect(props.onChanged).toHaveBeenCalledOnce(); expect(props.onClose).toHaveBeenCalledOnce();
    render(); render({ action: "vitals" }); await submitVitals();
    expect(writes()[1][0]).toBe(`/api/patients/${props.patient.id}`); expect(writes()[1][1].method).toBe("PATCH");
  });
  it("cannot update the old alert or close a newer dialog after a pending POST is dismissed", async () => {
    const pending = deferred<ReturnType<typeof response>>(); mutation = () => pending.promise; draftVitals(); const saving = submitVitals();
    click(VitalsModal, "إلغاء"); render(); render({ action: "prescription" }); pending.resolve(savedVitals(82001)); await saving;
    expect(props.action).toBe("prescription"); expect(props.onMedicalSaved).not.toHaveBeenCalled(); expect(props.onChanged).not.toHaveBeenCalled(); expect(props.onClose).toHaveBeenCalledOnce();
  });
  it("retires Close synchronously and keeps late errors out of a replacement dialog", async () => {
    const pending = deferred<ReturnType<typeof response>>(); mutation = () => pending.promise; draftVitals(); const saving = submitVitals(); click(VitalsModal, "إلغاء");
    pending.reject(new Error("Synthetic old save failed")); await saving;
    expect(props.onMedicalSaved).not.toHaveBeenCalled(); render({ action: "vitals" }); expect(text(VitalsModal)).not.toContain("Synthetic old save failed");
  });
  it("retains the latch across repeated open and only a new explicit save publishes after settlement", async () => {
    const pending = deferred<ReturnType<typeof response>>(); mutation = () => pending.promise; draftVitals(); const saving = submitVitals();
    click(VitalsModal, "إلغاء"); render(); render({ action: "vitals" }); expect(submitDisabled()).toBe(true); await submitVitals(); expect(writes()).toHaveLength(1);
    pending.resolve(savedVitals(82002)); await saving; expect(submitDisabled()).toBe(false); expect(props.onMedicalSaved).not.toHaveBeenCalled();
    mutation = canonicalMutation; await submitVitals(); expect(writes()).toHaveLength(2); expect(props.onMedicalSaved).toHaveBeenCalledOnce();
  });
  it.each(["authority", "patient", "medical-alert"])("does not publish old results across %s A → B → A", async (field) => {
    const pending = deferred<ReturnType<typeof response>>(); mutation = () => pending.promise; draftVitals(); const original = { ...props }; const saving = submitVitals();
    if (field === "authority") render({ authorityKey: "synthetic:doctor:B" });
    else render({ patient: { ...props.patient, ...(field === "patient" ? { id: props.patient.id + 1000 } : { medicalAlert: "Synthetic replacement alert" }) } });
    render(original); expect(submitDisabled()).toBe(true); await submitVitals(); expect(writes()).toHaveLength(1);
    pending.resolve(savedVitals(82004)); await saving;
    expect(props.onMedicalSaved).not.toHaveBeenCalled(); expect(props.onChanged).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
    expect(submitDisabled()).toBe(false); expect(instances.every((one) => one.lateUpdates === 0)).toBe(true);
  });
  it("retires an unmounted save without suppressing the canonical write or updating unmounted state", async () => {
    const pending = deferred<ReturnType<typeof response>>(); mutation = () => pending.promise; draftVitals(); const saving = submitVitals(); instances.forEach(unmount);
    pending.resolve(savedVitals(82005)); await saving;
    expect(writes()).toHaveLength(1); expect(props.onMedicalSaved).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled(); expect(instances.every((one) => one.lateUpdates === 0)).toBe(true);
  });
  it.each([408, 499, 500, 503, "malformed-201", "foreign-patient", "transport"])("retains an unknown vitals %s outcome across Close/remount without publishing or replaying", async (status) => {
    const pending = deferred<ReturnType<typeof response>>(); mutation = () => pending.promise; draftVitals(); const saving = submitVitals();
    click(VitalsModal, "إلغاء"); render(); render({ action: "vitals", authorityKey: "synthetic:doctor:B" });
    if (status === "transport") pending.reject(new Error("Synthetic lost connection"));
    else if (status === "foreign-patient") pending.resolve(response({ id: 82006, patientId: props.patient.id + 1, bpSystolic: 120, bpDiastolic: 80, pulse: null, glucose: null }, 201));
    else pending.resolve(response({}, typeof status === "number" ? status : 201));
    await saving; expect(props.onMedicalSaved).not.toHaveBeenCalled(); expect(props.onChanged).not.toHaveBeenCalled(); expect(props.onClose).toHaveBeenCalledOnce();
    expect(submitDisabled()).toBe(true); expect(text(VitalsModal)).toContain("الحفظ الجديد متوقف"); await submitVitals(); expect(writes()).toHaveLength(1);
    render({ authorityKey: "synthetic:doctor:A" }); await submitVitals(); expect(writes()).toHaveLength(1);
  });
  it("keeps definite validation rejection correctable without treating it as an uncertain committed reading", async () => {
    mutation = () => response({ message: "Synthetic validation rejection" }, 400); draftVitals(); await submitVitals();
    expect(submitDisabled()).toBe(false); expect(props.onMedicalSaved).not.toHaveBeenCalled();
    mutation = canonicalMutation; await submitVitals(); expect(writes()).toHaveLength(2); expect(props.onMedicalSaved).toHaveBeenCalledOnce();
  });
  it.each(["action", "authority", "unmount"])("blocks retired vitals and adapter callbacks during committed %s before passive cleanup", async (boundary) => {
    const pending = deferred<ReturnType<typeof response>>(); mutation = () => pending.promise; draftVitals(); const callback = children.get(VitalsModal)!.props; const saving = submitVitals();
    if (boundary === "unmount") instances.forEach((one) => commitUnmount(one, false));
    else render(boundary === "action" ? { action: "prescription" } : { authorityKey: "synthetic:doctor:B" }, false);
    (callback.onSaved as (value: string) => void)("stale committed alert"); (callback.onClose as () => void)();
    pending.resolve(savedVitals(82007)); await saving;
    expect(props.onMedicalSaved).not.toHaveBeenCalled(); expect(props.onChanged).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
    expect(instances.every((one) => one.lateUpdates === 0)).toBe(true);
  });
  it("keeps a retained uninvoked vitals form handler retired across Close/reopen", async () => {
    draftVitals(); const retired = control(VitalsModal, (node) => node.type === "form").props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>;
    click(VitalsModal, "إلغاء"); render(); draftVitals(); await retired({ preventDefault() {} });
    expect(writes()).toHaveLength(0); expect(props.onMedicalSaved).not.toHaveBeenCalled();
    await submitVitals(); expect(writes()).toHaveLength(1); expect(props.onMedicalSaved).toHaveBeenCalledOnce();
  });
  it("also fences adapter callbacks themselves against action, authority and unmount retirement", () => {
    render({ action: "vitals" }); const old = children.get(VitalsModal)!.props;
    render({ action: "prescription" }); render({ action: "vitals" });
    (old.onSaved as (value: string) => void)("stale alert"); (old.onClose as () => void)();
    expect(props.onMedicalSaved).not.toHaveBeenCalled(); expect(props.onChanged).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
    const retired = children.get(VitalsModal)!.props; render({ authorityKey: "synthetic:doctor:B" });
    (retired.onSaved as (value: string) => void)("stale authority"); (retired.onClose as () => void)();
    const unmounted = children.get(VitalsModal)!.props; instances.forEach(unmount);
    (unmounted.onSaved as (value: string) => void)("unmounted alert"); (unmounted.onClose as () => void)();
    expect(props.onMedicalSaved).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
  });
});
