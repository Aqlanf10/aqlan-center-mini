import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClinicalVisit } from "../components/ClinicalVisit";

// Tests-only, local audit of a fixed, already-linked synthetic visit. No routes,
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
    useId: () => "synthetic-phrase-field",
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
let pendingWrite: ReturnType<typeof deferred<MockResponse>> | null;
let pendingRefresh: ReturnType<typeof deferred<MockResponse>> | null;
let reads: number;

function render() {
  let tree: ReturnType<typeof ClinicalVisit> | null = null;
  let rounds = 0;
  do {
    if (++rounds > 20) throw new Error("Clinical visit UI did not settle");
    hooks.cursor = 0;
    hooks.changed = false;
    tree = ClinicalVisit({ visitId: 91001 });
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return {
    tree,
    find: (predicate: (node: Element) => boolean) => {
      const found = elements(tree).find(predicate);
      if (!found) throw new Error("Missing clinical visit control");
      return found;
    },
  };
}
function field(label: string) {
  return render().find((node) => node.props.label === label);
}
function enter(label: string, value: string) {
  const current = field(label);
  expect(current.props.disabled).toBe(false);
  (current.props.onChange as (value: string) => void)(value);
}
function nativeNoteControls(label: string) {
  const current = field(label);
  // Inspect the actual new field textarea and trigger. Its local hooks are
  // isolated from the parent harness; real combobox behavior has browser coverage.
  const parent = { values: hooks.values, cursor: hooks.cursor, changed: hooks.changed,
    effects: hooks.effects, memos: hooks.memos, pending: hooks.pending };
  hooks.values = []; hooks.cursor = 0; hooks.effects = new Map(); hooks.memos = new Map(); hooks.pending = [];
  let fieldTree: ReactNode;
  try { fieldTree = (current.type as (props: Record<string, unknown>) => ReactNode)(current.props); }
  finally { Object.assign(hooks, parent); }
  return elements(fieldTree).filter((node) => node.type === "textarea" || node.type === "button");
}
function expectNotesLocked(locked: boolean) {
  let textareas = 0;
  let phrases = 0;
  for (const label of noteLabels) {
    for (const control of nativeNoteControls(label)) {
      if (control.type === "textarea") textareas++;
      else phrases++;
      if (locked) expect(control.props.disabled).toBe(true);
      else expect(control.props.disabled).not.toBe(true);
    }
  }
  expect(textareas).toBe(5);
  // Disabling or temporarily hiding phrase buttons are both safe containment.
  if (!locked) expect(phrases).toBe(4);
}
function click(label: string) {
  const control = render().find((node) => node.type === "button" && contents(node.props.children as ReactNode).trim() === label);
  expect(control.props.disabled).not.toBe(true);
  return (control.props.onClick as () => void | Promise<void>)();
}
const writes = () => fetchMock.mock.calls.filter(([url, options]) => url === clinicalUrl && options?.method === "POST");
async function settleSave() {
  await vi.waitFor(() => {
    const control = render().find((node) => node.type === "button" && contents(node.props.children as ReactNode).trim() === "احفظ بلا توقيع");
    expect(control.props.disabled).toBe(false);
  });
}
beforeEach(async () => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  vi.clearAllMocks();
  pendingWrite = null; pendingRefresh = null; reads = 0;
  stored = {
    id: 91001, patientId: 92001, patientName: "Synthetic patient", ...savedNotes,
    addendum: null, doctorId: 94001, status: "open", signedAt: null, signedBy: null,
    invoiceId: null, procedures: [], totalMinor: 0, planItemsMatched: 0,
    planTitle: null, planWarning: null, ortho: null, plannedVisit: null,
    previousVisit: null, outstanding: [], sessionPricing: [], labOrders: [],
    billingCurrency: "YER",
  };
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === clinicalUrl && options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      const result = pendingWrite ? await pendingWrite.promise : response(200, {});
      if (result.ok) stored = { ...stored, ...body };
      return result;
    }
    if (url === clinicalUrl && !options?.method) {
      reads++;
      return reads > 1 && pendingRefresh ? pendingRefresh.promise : response(200, { ...stored });
    }
    if (url === "/api/services" && !options?.method) return response(200, [service]);
    if (url === "/api/parties?kind=doctor" && !options?.method) return response(200, [{ id: 94001, name: "Synthetic doctor" }]);
    if (url === "/api/patients/92001" && !options?.method) return response(200, { medicalAlert: null, phone: null });
    if (url === "/api/visits/91001/billing-preview" && !options?.method) return response(200, { duesByCurrency: {}, mixedCurrencies: false, zeroReason: null });
    throw new Error(`Unexpected isolated mock request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render();
  await vi.waitFor(() => expect(field("② التشخيص").props.value).toBe(savedNotes.diagnosis));
});
afterEach(() => {
  hooks.effects.forEach((effect) => effect.cleanup?.());
  vi.unstubAllGlobals();
});

describe("normal clinical visit draft preservation (isolated acceptance audit)", () => {
  it("control: a successful save persists all notes captured at click", async () => {
    noteLabels.forEach((label, index) => enter(label, `Synthetic submitted ${noteKeys[index]}`));
    click("احفظ بلا توقيع");
    await settleSave();
    expect(writes()).toHaveLength(1);
    const submitted = JSON.parse(writes()[0][1].body);
    noteLabels.forEach((label, index) => {
      expect(submitted[noteKeys[index]]).toBe(`Synthetic submitted ${noteKeys[index]}`);
      expect(field(label).props.value).toBe(`Synthetic submitted ${noteKeys[index]}`);
    });
  });

  it("locks all note editing while the save POST is pending and restores it afterward", async () => {
    pendingWrite = deferred<MockResponse>();
    noteLabels.forEach((label, index) => enter(label, `Synthetic submitted ${noteKeys[index]}`));
    click("احفظ بلا توقيع");
    expect(writes()).toHaveLength(1);
    expectNotesLocked(true);
    expect(JSON.parse(writes()[0][1].body).diagnosis).toBe("Synthetic submitted diagnosis");
    pendingWrite.resolve(response(200, {}));
    await settleSave();
    expect(stored.diagnosis).toBe("Synthetic submitted diagnosis");
    noteLabels.forEach((label, index) => expect(field(label).props.value).toBe(`Synthetic submitted ${noteKeys[index]}`));
    expectNotesLocked(false);
    enter("② التشخيص", "Synthetic accepted after completion");
    expect(field("② التشخيص").props.value).toBe("Synthetic accepted after completion");
  });

  it("keeps all note editing locked throughout the post-save GET refresh", async () => {
    pendingRefresh = deferred<MockResponse>();
    enter("② التشخيص", "Synthetic submitted diagnosis");
    click("احفظ بلا توقيع");
    await vi.waitFor(() => expect(reads).toBe(2));
    expectNotesLocked(true);
    expect(field("② التشخيص").props.value).toBe("Synthetic submitted diagnosis");
    pendingRefresh.resolve(response(200, { ...stored }));
    await settleSave();
    expect(field("② التشخيص").props.value).toBe("Synthetic submitted diagnosis");
    expectNotesLocked(false);
  });

  it("keeps notes locked until the save POST JSON body finishes", async () => {
    pendingWrite = deferred<MockResponse>();
    const body = deferred<unknown>();
    const delivered = { ...response(200, {}), json: vi.fn(() => body.promise) };
    enter("② التشخيص", "Synthetic submitted diagnosis");
    click("احفظ بلا توقيع");
    pendingWrite.resolve(delivered);
    await vi.waitFor(() => expect(delivered.json).toHaveBeenCalledOnce());
    expect(reads).toBe(1);
    expectNotesLocked(true);
    body.resolve({});
    await settleSave();
    expectNotesLocked(false);
    expect(field("② التشخيص").props.value).toBe("Synthetic submitted diagnosis");
  });

  it("keeps notes locked until the post-save refresh JSON body finishes", async () => {
    pendingRefresh = deferred<MockResponse>();
    const body = deferred<unknown>();
    const delivered = { ...response(200, {}), json: vi.fn(() => body.promise) };
    enter("② التشخيص", "Synthetic submitted diagnosis");
    click("احفظ بلا توقيع");
    await vi.waitFor(() => expect(reads).toBe(2));
    pendingRefresh.resolve(delivered);
    await vi.waitFor(() => expect(delivered.json).toHaveBeenCalledOnce());
    expectNotesLocked(true);
    body.resolve({ ...stored });
    await settleSave();
    expectNotesLocked(false);
    expect(field("② التشخيص").props.value).toBe("Synthetic submitted diagnosis");
  });

  it("failed post-save refresh preserves the exact draft, blocks writes, and recovers without accepting stale persisted notes", async () => {
    pendingRefresh = deferred<MockResponse>();
    noteLabels.forEach((label, index) => enter(label, `Synthetic submitted ${noteKeys[index]}`));
    const capturedSave = render().find((node) => node.type === "button" && contents(node.props.children as ReactNode).trim() === "احفظ بلا توقيع");
    click("احفظ بلا توقيع");
    await vi.waitFor(() => expect(reads).toBe(2));
    expectNotesLocked(true);
    pendingRefresh.resolve(response(503, { message: "Private refresh error must stay hidden" }));
    await vi.waitFor(() => expect(contents(render().tree)).toContain("تعذّر تحميل الزيارة الحالية"));
    expect(elements(render().tree).some((node) => node.props.label === "② التشخيص")).toBe(false);
    expect(contents(render().tree)).toContain("احتُفظ بمسودة الزيارة");
    expect(contents(render().tree)).not.toContain("Private refresh error must stay hidden");
    await (capturedSave.props.onClick as () => void | Promise<void>)();
    expect(writes()).toHaveLength(1);

    // A successful read restores authority, not permission to overwrite the
    // local draft with a stale server snapshot after the failed save refresh.
    stored = { ...stored, ...savedNotes };
    pendingRefresh = null;
    click("أعد تحميل الزيارة");
    await settleSave();
    expectNotesLocked(false);
    noteLabels.forEach((label, index) => expect(field(label).props.value).toBe(`Synthetic submitted ${noteKeys[index]}`));
    expect(writes()).toHaveLength(1);
    enter("② التشخيص", "Synthetic correction after recovery");
    click("احفظ بلا توقيع");
    await settleSave();
    expect(writes()).toHaveLength(2);
    expect(JSON.parse(writes()[1][1].body).diagnosis).toBe("Synthetic correction after recovery");
    expect(field("② التشخيص").props.value).toBe("Synthetic correction after recovery");
  });

  it("preserves an explicitly blank treatment note across failed refresh, stale retry and confirmed save with procedures", async () => {
    enter("③ ما نُفّذ", "");
    const add = render().find((node) => node.props.ariaLabel === "أضف إجراءً");
    (add.props.onChange as (id: number, value: typeof service) => void)(service.id, service);
    expect(String(field("③ ما نُفّذ").props.value)).toContain(service.name);
    enter("③ ما نُفّذ", "");
    pendingRefresh = deferred<MockResponse>(); click("احفظ بلا توقيع");
    await vi.waitFor(() => expect(reads).toBe(2));
    pendingRefresh.resolve(response(503, {}));
    await vi.waitFor(() => expect(contents(render().tree)).toContain("تعذّر تحميل الزيارة الحالية"));
    stored = { ...stored, treatmentDone: "Stale nonblank persisted treatment" };
    pendingRefresh = null; click("أعد تحميل الزيارة"); await settleSave();
    expect(field("③ ما نُفّذ").props.value).toBe("");
    expect(elements(render().tree).filter((node) => node.props["aria-label"] === "الكمية")).toHaveLength(1);
    click("احفظ بلا توقيع"); await settleSave();
    expect(JSON.parse(writes()[1][1].body).treatmentDone).toBe("");
    expect(field("③ ما نُفّذ").props.value).toBe("");
    // A later deliberate procedure change still resumes the established auto-fill.
    (render().find((node) => node.props["aria-label"] === "الكمية").props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "2" } });
    expect(String(field("③ ما نُفّذ").props.value)).toContain(service.name);
  });

  it("control: quick phrases work again after the successful save completes", async () => {
    enter("② التشخيص", "Synthetic submitted diagnosis");
    click("احفظ بلا توقيع");
    await settleSave();
    const phrase = nativeNoteControls("② التشخيص").find((node) => node.type === "button")!;
    expect(phrase.props.disabled).not.toBe(true);
    // A pick after the field-local search calls the same guarded narrative callback.
    (field("② التشخيص").props.onPhrase as (value: string) => void)("Synthetic quick phrase");
    expect(field("② التشخيص").props.value).toBe("Synthetic submitted diagnosis، Synthetic quick phrase");
  });

  it("pending note callbacks cannot bypass the disabled note controls", async () => {
    pendingWrite = deferred<MockResponse>();
    enter("② التشخيص", "Synthetic submitted diagnosis");
    click("احفظ بلا توقيع");
    const current = field("② التشخيص");
    (current.props.onChange as (value: string) => void)("Synthetic blocked note");
    (current.props.onPhrase as (value: string) => void)("Synthetic blocked phrase");
    expect(field("② التشخيص").props.value).toBe("Synthetic submitted diagnosis");
    pendingWrite.resolve(response(200, {}));
    await settleSave();
  });

  it("pending procedure controls cannot indirectly rewrite the treatment note", async () => {
    enter("③ ما نُفّذ", "");
    const add = render().find((node) => node.props.ariaLabel === "أضف إجراءً");
    (add.props.onChange as (id: number, value: typeof service) => void)(service.id, service);
    const autoTreatment = field("③ ما نُفّذ").props.value;
    expect(String(autoTreatment)).toContain(service.name);
    pendingWrite = deferred<MockResponse>();
    click("احفظ بلا توقيع");
    const procedureSection = render().find((node) => node.props.id === "visit-procedures");
    const group = elements(procedureSection.props.children as ReactNode).find((node) => node.type === "fieldset")!;
    expect(group.props.disabled).toBe(true);
    const quantity = render().find((node) => node.props["aria-label"] === "الكمية");
    (quantity.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "3" } });
    const picker = render().find((node) => node.props.ariaLabel === "أضف إجراءً");
    (picker.props.onChange as (id: number, value: typeof service) => void)(service.id, service);
    expect(render().find((node) => node.props["aria-label"] === "الكمية").props.value).toBe(1);
    expect(elements(render().tree).filter((node) => node.props["aria-label"] === "الكمية")).toHaveLength(1);
    expect(field("③ ما نُفّذ").props.value).toBe(autoTreatment);
    pendingWrite.resolve(response(200, {}));
    await settleSave();
    const editableQuantity = render().find((node) => node.props["aria-label"] === "الكمية");
    (editableQuantity.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "3" } });
    expect(field("③ ما نُفّذ").props.value).not.toBe(autoTreatment);
    expect(String(field("③ ما نُفّذ").props.value)).toContain(service.name);
  });

  it("planned items stay blocked during POST and reload, then update the generated treatment note", async () => {
    // Supply an existing plan in the next synthetic read. This is an ordinary
    // save/refresh; no plan route or actual plan writer participates.
    stored.outstanding = [{
      planItemId: 95001, serviceId: service.id, planTitle: "Synthetic plan",
      serviceName: service.name, toothCode: 16, billingRule: "per_session",
      sessionCount: 1, doneSessions: 0, unitPriceMinor: 100,
      quantity: 1, status: "planned", planCurrency: "YER",
    }];
    click("احفظ بلا توقيع");
    await settleSave();
    enter("③ ما نُفّذ", "");
    const add = render().find((node) => node.props.ariaLabel === "أضف إجراءً");
    (add.props.onChange as (id: number, value: typeof service) => void)(service.id, service);
    const autoTreatment = field("③ ما نُفّذ").props.value;
    expect(String(autoTreatment)).toContain(service.name);
    const plannedGroup = () => {
      const section = render().find((node) => node.props.id === "visit-procedures");
      return elements(section.props.children as ReactNode).find((node) => node.type === "fieldset")!;
    };
    const attemptPendingPlannedItem = () => {
      expect(plannedGroup().props.disabled).toBe(true);
      const button = render().find((node) => node.type === "button" && contents(node.props.children as ReactNode).trim() === "+ نفّذ اليوم");
      // The native button is disabled by its fieldset. Calling the current
      // handler directly also proves an open picker/callback cannot bypass it.
      (button.props.onClick as () => void)();
      expect(field("③ ما نُفّذ").props.value).toBe(autoTreatment);
      expect(elements(render().tree).filter((node) => node.props["aria-label"] === "الكمية")).toHaveLength(1);
    };
    pendingWrite = deferred<MockResponse>();
    pendingRefresh = deferred<MockResponse>();
    const priorReads = reads;
    click("احفظ بلا توقيع");
    attemptPendingPlannedItem();
    pendingWrite.resolve(response(200, {}));
    await vi.waitFor(() => expect(reads).toBe(priorReads + 1));
    attemptPendingPlannedItem();
    pendingRefresh.resolve(response(200, { ...stored }));
    await settleSave();
    expect(plannedGroup().props.disabled).toBe(false);
    click("+ نفّذ اليوم");
    expect(elements(render().tree).filter((node) => node.props["aria-label"] === "الكمية")).toHaveLength(2);
    expect(field("③ ما نُفّذ").props.value).not.toBe(autoTreatment);
    expect(String(field("③ ما نُفّذ").props.value)).toContain("16");
    expect(writes()).toHaveLength(2);
  });

  it("a signed visit returned by refresh stays read-only after busy clears", async () => {
    noteLabels.forEach((label, index) => enter(label, `Synthetic submitted ${noteKeys[index]}`));
    // The read fixture is already signed. Do not call the sign handler or send
    // a sign action: this test concerns rendering authoritative read state.
    stored.status = "signed";
    click("احفظ بلا توقيع");
    await vi.waitFor(() => expect(contents(render().tree)).toContain("زيارة موقَّعة"));
    // An enabled addendum submit proves busy has actually cleared; signed
    // notes must stay read-only independently of the temporary save lock.
    const addendum = render().find((node) => node.props["aria-label"] === "ملحق");
    (addendum.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "Synthetic local addendum draft" } });
    await vi.waitFor(() => {
      const submit = render().find((node) => node.type === "button" && contents(node.props.children as ReactNode).trim() === "أضف ملحقًا");
      expect(submit.props.disabled).toBe(false);
    });
    expectNotesLocked(true);
    for (const [index, label] of noteLabels.entries()) {
      expect(field(label).props.value).toBe(`Synthetic submitted ${noteKeys[index]}`);
      expect(nativeNoteControls(label).filter((node) => node.type === "button")).toHaveLength(0);
    }
    const buttons = elements(render().tree).filter((node) => node.type === "button").map((node) => contents(node.props.children as ReactNode).trim());
    expect(buttons).not.toContain("احفظ بلا توقيع");
    expect(buttons).not.toContain("مراجعة وإنهاء الزيارة");
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body).action).toBeUndefined();
  });

  it("failed save retains the submitted draft, unlocks editing, and reports the error", async () => {
    pendingWrite = deferred<MockResponse>();
    enter("② التشخيص", "Synthetic submitted diagnosis");
    click("احفظ بلا توقيع");
    expectNotesLocked(true);
    pendingWrite.resolve(response(409, { message: "Synthetic save conflict" }));
    await settleSave();
    expect(field("② التشخيص").props.value).toBe("Synthetic submitted diagnosis");
    expectNotesLocked(false);
    enter("② التشخيص", "Synthetic correction after error");
    expect(field("② التشخيص").props.value).toBe("Synthetic correction after error");
    expect(contents(render().tree)).toContain("Synthetic save conflict");
    expect(reads).toBe(1);
  });

  it("control: adding a free procedure leaves manually written notes intact", () => {
    noteLabels.forEach((label, index) => enter(label, `Synthetic manual ${noteKeys[index]}`));
    const select = render().find((node) => node.props.ariaLabel === "أضف إجراءً");
    (select.props.onChange as (id: number, value: typeof service) => void)(service.id, service);
    noteLabels.forEach((label, index) => expect(field(label).props.value).toBe(`Synthetic manual ${noteKeys[index]}`));
    expect(writes()).toHaveLength(0);
  });

  it("control: returning from review retains saved notes without another write", async () => {
    enter("② التشخيص", "Synthetic review diagnosis");
    await click("مراجعة وإنهاء الزيارة");
    expect(render().find((node) => node.props.role === "dialog")).toBeTruthy();
    click("رجوع — أكمل العمل");
    expect(field("② التشخيص").props.value).toBe("Synthetic review diagnosis");
    expect(writes()).toHaveLength(1);
  });
});

