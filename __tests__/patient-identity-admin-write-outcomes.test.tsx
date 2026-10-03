/** Synthetic component-handler coverage. No real merge/delete, server or patient data. */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientIdentityEditor } from "../components/patient-workspace/PatientIdentityEditor";
import { PatientAdministration } from "../components/patient-workspace/PatientAdministration";
import type { Patient } from "../lib/patient";

type Driver = { values: unknown[]; cursor: number; effects: Map<number, { deps?: readonly unknown[]; cleanup?: () => void; phase: "layout" | "passive" }>; pending: Array<() => void> };
type Element = ReactElement<Record<string, unknown>>;
const hooks = vi.hoisted(() => ({ current: null as Driver | null, role: "admin", username: "synthetic-admin", push: vi.fn(), refresh: vi.fn() }));
vi.mock("../components/SettingsProvider", () => ({ useSetting: () => "توصية مريض,طبيب" }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ role: hooks.role, username: hooks.username }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: hooks.push, refresh: hooks.refresh }) }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const state = hooks.current!; const index = state.cursor++; if (!(index in state.values)) state.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return { ...react,
    useState: (initial: unknown) => { const state = hooks.current!; const index = slot(typeof initial === "function" ? initial() : initial); return [state.values[index], (value: unknown) => { state.values[index] = typeof value === "function" ? value(state.values[index]) : value; }]; },
    useRef: (initial: unknown) => hooks.current!.values[slot({ current: initial })],
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const state = hooks.current!; const index = slot(undefined); const previous = state.effects.get(index); if (previous && same(previous.deps, deps)) return; state.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); state.effects.set(index, { deps, phase: "passive", cleanup: typeof cleanup === "function" ? cleanup : undefined }); }); },
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const state = hooks.current!; const index = slot(undefined); const previous = state.effects.get(index); if (previous && same(previous.deps, deps)) return; state.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); state.effects.set(index, { deps, phase: "layout", cleanup: typeof cleanup === "function" ? cleanup : undefined }); }); },
  };
});
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : "";
}
const click = (node: Element) => (node.props.onClick as () => void)();
const change = (node: Element, value: string) => (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
const submit = (node: Element) => (node.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
const cleanup = (driver: Driver, phase?: "layout" | "passive") => {
  driver.effects.forEach((effect, index) => { if (!phase || effect.phase === phase) { effect.cleanup?.(); driver.effects.delete(index); } });
};
let drivers: Driver[];
let patient: Patient;
let sequence = 8000;
let fetchMock: ReturnType<typeof vi.fn>;
let confirm: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn<(message: string | null) => void>>;
let onSaved: ReturnType<typeof vi.fn<(patient: Patient) => void>>;
let unloadListeners: Set<(event: BeforeUnloadEvent) => void>;
function owner(kind: "identity" | "admin", data = patient) {
  const driver: Driver = { values: [], cursor: 0, effects: new Map(), pending: [] }; drivers.push(driver);
  const render = () => {
    hooks.current = driver; driver.cursor = 0;
    const wrapper = kind === "identity" ? PatientIdentityEditor({ patient: data, onSaved, onError })
      : PatientAdministration({ file: { patient: data, visits: [], appointments: [] }, onError });
    const tree = wrapper ? (wrapper.type as (props: Record<string, unknown>) => ReactNode)(wrapper.props) : null;
    driver.pending.splice(0).forEach((effect) => effect());
    return { tree, nodes: elements(tree), text: text(tree) };
  };
  const field = (label: string) => {
    const match = render().nodes.find((node) => node.type === "label" && text(node).startsWith(label));
    const control = elements(match).find((node) => ["input", "select", "textarea"].includes(String(node.type)));
    expect(control, label).toBeDefined(); return control!;
  };
  const button = (label: string) => { const result = render().nodes.find((node) => node.type === "button" && text(node) === label); expect(result, label).toBeDefined(); return result!; };
  return { render, field, button, form: () => render().nodes.find((node) => node.type === "form")!, unmount: () => cleanup(driver), commitUnmount: () => cleanup(driver, "layout"), flushPassiveUnmount: () => cleanup(driver, "passive") };
}
type Operation = "merge" | "delete";
function prepareAdmin(mode: Operation, target = owner("admin")) {
  target.render(); click(target.button(mode === "merge" ? "دمج ملف مكرر" : "مراجعة حذف ملف خاطئ"));
  if (mode === "merge") { change(target.field("رقم الملف المكرر"), "DUPLICATE-SYNTHETIC"); change(target.field("أعد كتابة"), "duplicate-synthetic"); }
  else change(target.field("اكتب رقم الملف"), patient.patientNumber);
  change(target.field("السبب"), "synthetic review reason");
  return target;
}
async function settle() { for (let index = 0; index < 25; index += 1) await Promise.resolve(); }
function unknownResponse(kind: string) {
  if (kind === "transport") { fetchMock.mockRejectedValue(new TypeError("lost after dispatch")); return; }
  if (kind === "malformed") { fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError("truncated body"); } }); return; }
  fetchMock.mockResolvedValue(response(kind === "empty" ? null : { message: "not a reliable acknowledgement" }, kind === "empty" ? 204 : Number(kind)));
}
beforeEach(() => {
  drivers = []; unloadListeners = new Set(); ++sequence;
  patient = { id: sequence, patientNumber: `SYNTHETIC-${sequence}`, fullName: "مريض اختباري", phone: null, altPhone: null, gender: "unknown", birthYear: 1990, birthDate: "1990-02-03", address: "saved address", medicalAlert: "saved alert", note: null, createdAt: "2026-10-03" };
  hooks.role = "admin"; hooks.username = "synthetic-admin"; hooks.push.mockReset(); hooks.refresh.mockReset();
  fetchMock = vi.fn(async () => response({ message: "synthetic rejection" }, 409)); confirm = vi.fn(() => true); onError = vi.fn<(message: string | null) => void>(); onSaved = vi.fn<(patient: Patient) => void>();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { confirm,
    addEventListener: vi.fn((type, listener) => { if (type === "beforeunload") unloadListeners.add(listener); }),
    removeEventListener: vi.fn((type, listener) => { if (type === "beforeunload") unloadListeners.delete(listener); }),
  });
});
afterEach(() => { drivers.forEach((driver) => cleanup(driver)); vi.unstubAllGlobals(); });

const unknownKinds = ["408", "499", "500", "302", "transport", "malformed", "empty"] as const;
describe("identity write outcome containment through the actual handlers", () => {
  it.each(unknownKinds)("%s preserves the draft and blocks fresh and stale submit/reset/edit handlers", async (kind) => {
    const target = owner("identity"); target.render(); change(target.field("الاسم الكامل"), "unsaved identity");
    const form = target.form(); const name = target.field("الاسم الكامل"); const reset = target.button("إلغاء التعديلات");
    unknownResponse(kind); submit(form); await settle();
    submit(form); submit(target.form()); click(reset); change(name, "must not replace retained draft");
    expect(fetchMock).toHaveBeenCalledOnce(); expect(onSaved).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    expect(target.field("الاسم الكامل").props.value).toBe("unsaved identity");
    expect(target.render().text).toContain("نتيجة الحفظ غير مؤكّدة"); expect(target.render().text).toContain("لا تؤكد النتيجة");
    expect(target.render().nodes.find((node) => node.type === "fieldset")?.props.disabled).toBe(true);
    const event = { preventDefault: vi.fn(), returnValue: undefined };
    unloadListeners.forEach((listener) => listener(event as unknown as BeforeUnloadEvent)); expect(event.preventDefault).toHaveBeenCalled();
    target.unmount(); const replacement = owner("identity"); replacement.render();
    expect(replacement.render().text).toContain("نتيجة الحفظ غير مؤكّدة");
    change(replacement.field("الاسم الكامل"), "retry after remount"); submit(replacement.form()); expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("holds the pending fence through delayed body parsing and transfers an unknown outcome to a mounted replacement", async () => {
    const body = deferred<unknown>(); fetchMock.mockResolvedValue({ ok: false, status: 408, json: () => body.promise });
    const first = owner("identity"); first.render(); change(first.field("الاسم الكامل"), "pending identity"); const form = first.form();
    submit(form); await settle(); submit(form); click(first.button("إلغاء التعديلات")); change(first.field("الاسم الكامل"), "blocked edit");
    expect(first.field("الاسم الكامل").props.value).toBe("pending identity"); expect(fetchMock).toHaveBeenCalledOnce();
    first.unmount(); onError.mockClear(); const replacement = owner("identity"); replacement.render();
    expect(replacement.render().nodes.find((node) => node.type === "fieldset")?.props.disabled).toBe(true);
    change(replacement.field("الاسم الكامل"), "blocked new owner"); submit(replacement.form());
    body.resolve({ message: "timeout" }); await settle();
    expect(replacement.render().text).toContain("نتيجة الحفظ غير مؤكّدة"); expect(onError).not.toHaveBeenCalled(); expect(onSaved).not.toHaveBeenCalled();
    submit(form); submit(replacement.form()); expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["patient key change", "same-patient reopen"])("commit-time %s retires success publication before passive cleanup", async (replacementKind) => {
    const body = deferred<unknown>(); fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => body.promise });
    const target = owner("identity"); target.render(); change(target.field("الاسم الكامل"), "retired identity");
    const retainedForm = target.form(); const retainedField = target.field("الاسم الكامل"); const retainedReset = target.button("إلغاء التعديلات");
    submit(retainedForm); await settle(); target.commitUnmount(); onError.mockClear();
    const replacementPatient = replacementKind === "same-patient reopen" ? patient : { ...patient, id: ++sequence, patientNumber: "REPLACEMENT-SYNTHETIC" };
    const replacement = owner("identity", replacementPatient); replacement.render();
    body.resolve({ ...patient, fullName: "retired identity" }); await settle();
    expect(onSaved).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    expect(replacement.field("الاسم الكامل").props.value).toBe(replacementPatient.fullName);
    expect(replacement.render().nodes.find((node) => node.type === "fieldset")?.props.disabled).toBe(false);
    submit(retainedForm); click(retainedReset); change(retainedField, "retired edit");
    expect(fetchMock).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    target.flushPassiveUnmount(); expect(onSaved).not.toHaveBeenCalled();
  });

  it("an identity reset creates a new draft token so retained submit/reset handlers cannot revive", async () => {
    const target = owner("identity"); target.render(); change(target.field("الاسم الكامل"), "first draft");
    const retiredForm = target.form(); const retiredReset = target.button("إلغاء التعديلات"); click(retiredReset);
    change(target.field("الاسم الكامل"), "new explicit draft"); confirm.mockClear();
    submit(retiredForm); click(retiredReset); expect(fetchMock).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    expect(target.field("الاسم الكامل").props.value).toBe("new explicit draft");
    submit(target.form()); await settle(); expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ fullName: "new explicit draft" });
  });

  it.each([400, 401, 403, 404, 409, 422, 429])("a definitive %s rejection with an unreadable body retains the editable draft", async (status) => {
    fetchMock.mockResolvedValue({ ok: false, status, json: async () => { throw new SyntaxError("HTML rejection"); } });
    const target = owner("identity"); target.render(); change(target.field("الاسم الكامل"), "retained draft"); submit(target.form()); await settle();
    expect(target.field("الاسم الكامل").props.value).toBe("retained draft"); expect(target.render().text).not.toContain("نتيجة الحفظ غير مؤكّدة");
    expect(target.render().nodes.find((node) => node.type === "fieldset")?.props.disabled).toBe(false);
    submit(target.form()); await settle(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a confirmed save publishes once and an old submit handler cannot replay the saved draft", async () => {
    fetchMock.mockResolvedValue(response({ ...patient, fullName: "saved identity" }));
    const target = owner("identity"); target.render(); change(target.field("الاسم الكامل"), "saved identity"); const form = target.form();
    submit(form); await settle(); submit(form); expect(fetchMock).toHaveBeenCalledOnce(); expect(onSaved).toHaveBeenCalledOnce();
  });

  it("a delayed success after unmount never publishes to the previous identity owner", async () => {
    const body = deferred<unknown>(); fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => body.promise });
    const target = owner("identity"); target.render(); change(target.field("الاسم الكامل"), "delayed identity"); submit(target.form()); await settle();
    target.unmount(); onError.mockClear(); body.resolve({ ...patient, fullName: "delayed identity" }); await settle();
    expect(onError).not.toHaveBeenCalled(); expect(onSaved).not.toHaveBeenCalled();
  });
});

for (const operation of ["merge", "delete"] as const) {
  describe(`administration ${operation} actual write handlers`, () => {
    it.each(unknownKinds)("%s keeps the exact draft and blocks replay across remount", async (kind) => {
      const target = prepareAdmin(operation); const form = target.form(); const cancel = target.button("إلغاء"); const reason = target.field("السبب");
      unknownResponse(kind); submit(form); await settle();
      submit(form); submit(target.form()); click(cancel); change(reason, "must not overwrite");
      expect(fetchMock).toHaveBeenCalledOnce(); expect(confirm).toHaveBeenCalledOnce(); expect(hooks.push).not.toHaveBeenCalled(); expect(hooks.refresh).not.toHaveBeenCalled();
      expect(target.field("السبب").props.value).toBe("synthetic review reason"); expect(target.render().text).toContain("عملية غير مؤكّدة");
      expect(target.render().text).toContain("لا تؤكد النتيجة");
      expect(target.render().nodes.find((node) => node.type === "fieldset")?.props.disabled).toBe(true);
      target.unmount(); const replacement = owner("admin"); replacement.render();
      const open = replacement.button(operation === "merge" ? "دمج ملف مكرر" : "مراجعة حذف ملف خاطئ");
      expect(open.props.disabled).toBe(true); click(open); expect(replacement.form()).toBeUndefined(); expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("locks edits, cancel, duplicate submits and replacement ownership until the response body settles", async () => {
      const body = deferred<unknown>(); fetchMock.mockResolvedValue({ ok: false, status: 499, json: () => body.promise });
      const target = prepareAdmin(operation); const form = target.form(); const cancel = target.button("إلغاء"); const reason = target.field("السبب");
      submit(form); await settle(); submit(form); click(cancel); change(reason, "blocked while pending");
      expect(target.field("السبب").props.value).toBe("synthetic review reason"); expect(fetchMock).toHaveBeenCalledOnce(); expect(confirm).toHaveBeenCalledOnce();
      target.unmount(); onError.mockClear(); const replacement = owner("admin"); replacement.render();
      const open = replacement.button("دمج ملف مكرر"); expect(open.props.disabled).toBe(true); click(open); expect(replacement.form()).toBeUndefined();
      body.resolve({ message: "client disconnected" }); await settle();
      expect(replacement.render().text).toContain("عملية غير مؤكّدة"); expect(onError).not.toHaveBeenCalled(); expect(hooks.push).not.toHaveBeenCalled(); expect(hooks.refresh).not.toHaveBeenCalled();
      click(open); submit(form); expect(fetchMock).toHaveBeenCalledOnce();
      const event = { preventDefault: vi.fn(), returnValue: undefined };
      unloadListeners.forEach((listener) => listener(event as unknown as BeforeUnloadEvent)); expect(event.preventDefault).toHaveBeenCalled();
    });

    it.each(["patient key change", "authority key change"])("commit-time %s prevents delayed navigation before passive cleanup", async (replacementKind) => {
      const body = deferred<unknown>(); fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => body.promise });
      const target = prepareAdmin(operation); const retainedForm = target.form(); const retainedCancel = target.button("إلغاء");
      submit(retainedForm); await settle(); target.commitUnmount(); onError.mockClear();
      if (replacementKind === "authority key change") hooks.username = "replacement-synthetic-admin";
      const replacementPatient = replacementKind === "authority key change" ? patient : { ...patient, id: ++sequence, patientNumber: "REPLACEMENT-SYNTHETIC" };
      const replacement = owner("admin", replacementPatient); replacement.render();
      body.resolve({ message: "synthetic retired success" }); await settle();
      expect(hooks.push).not.toHaveBeenCalled(); expect(hooks.refresh).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
      expect(replacement.button("دمج ملف مكرر").props.disabled).toBe(false);
      submit(retainedForm); click(retainedCancel); expect(fetchMock).toHaveBeenCalledOnce(); expect(confirm).toHaveBeenCalledOnce(); expect(onError).not.toHaveBeenCalled();
      target.flushPassiveUnmount(); expect(hooks.push).not.toHaveBeenCalled(); expect(hooks.refresh).not.toHaveBeenCalled();
    });

    it("a cancel/reopen creates a new draft token and cannot revive retained submit/cancel/edit handlers", async () => {
      const target = prepareAdmin(operation); const retiredForm = target.form(); const retiredCancel = target.button("إلغاء"); const retiredReason = target.field("السبب");
      click(retiredCancel); prepareAdmin(operation, target); change(target.field("السبب"), "new explicit reason");
      submit(retiredForm); click(retiredCancel); change(retiredReason, "retired reason");
      expect(fetchMock).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(target.field("السبب").props.value).toBe("new explicit reason");
      submit(target.form()); await settle(); expect(fetchMock).toHaveBeenCalledOnce();
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).reason).toBe("new explicit reason");
    });

    it.each([400, 401, 403, 404, 409, 422, 429])("a definitive %s rejection preserves the draft and releases its pending owner", async (status) => {
      fetchMock.mockResolvedValue({ ok: false, status, json: async () => { throw new SyntaxError("HTML rejection"); } });
      const target = prepareAdmin(operation); submit(target.form()); await settle();
      expect(target.field("السبب").props.value).toBe("synthetic review reason"); expect(target.render().text).not.toContain("عملية غير مؤكّدة");
      expect(target.render().nodes.find((node) => node.type === "fieldset")?.props.disabled).toBe(false);
      submit(target.form()); await settle(); expect(fetchMock).toHaveBeenCalledTimes(2); expect(confirm).toHaveBeenCalledTimes(2);
      expect(hooks.push).not.toHaveBeenCalled(); expect(hooks.refresh).not.toHaveBeenCalled();
    });

    it("only navigates after the synthetic acknowledgement body and never repeats a completed handler", async () => {
      const body = deferred<unknown>(); fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => body.promise });
      const target = prepareAdmin(operation); const form = target.form(); submit(form); await settle();
      expect(hooks.push).not.toHaveBeenCalled(); expect(hooks.refresh).not.toHaveBeenCalled();
      body.resolve({ message: "synthetic acknowledged operation" }); await settle(); submit(form);
      expect(fetchMock).toHaveBeenCalledOnce(); expect(confirm).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][0]).toBe(`/api/patients/${patient.id}${operation === "merge" ? "/merge" : ""}`);
      expect(fetchMock.mock.calls[0][1].method).toBe(operation === "merge" ? "POST" : "DELETE");
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(operation === "merge"
        ? { duplicatePatientNumber: "DUPLICATE-SYNTHETIC", confirmDuplicateNumber: "duplicate-synthetic", reason: "synthetic review reason" }
        : { confirmPatientNumber: patient.patientNumber, reason: "synthetic review reason" });
      if (operation === "merge") { expect(hooks.refresh).toHaveBeenCalledOnce(); expect(hooks.push).not.toHaveBeenCalled(); }
      else { expect(hooks.push).toHaveBeenCalledExactlyOnceWith("/patients"); expect(hooks.refresh).not.toHaveBeenCalled(); }
    });

    it("a removed owner never redirects or refreshes after a delayed success", async () => {
      const body = deferred<unknown>(); fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => body.promise });
      const target = prepareAdmin(operation); submit(target.form()); await settle(); target.unmount(); onError.mockClear();
      body.resolve({ message: "synthetic acknowledged operation" }); await settle();
      expect(hooks.push).not.toHaveBeenCalled(); expect(hooks.refresh).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    });

    it("declined final confirmation or cancel performs no write", () => {
      const target = prepareAdmin(operation); confirm.mockReturnValue(false); submit(target.form());
      expect(fetchMock).not.toHaveBeenCalled(); expect(target.field("السبب").props.value).toBe("synthetic review reason");
      click(target.button("إلغاء")); expect(target.form()).toBeUndefined(); expect(fetchMock).not.toHaveBeenCalled();
    });
  });
}

describe("administration gating and patient isolation", () => {
  it.each(["doctor", "reception", "cashier", "accountant", "assistant"])("never mounts administration for %s", (role) => {
    hooks.role = role; expect(owner("admin").render().tree).toBeNull(); expect(fetchMock).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });
  it("requires a different duplicate and matching typed confirmation before even prompting", () => {
    const target = owner("admin"); target.render(); click(target.button("دمج ملف مكرر")); submit(target.form());
    change(target.field("رقم الملف المكرر"), patient.patientNumber); change(target.field("أعد كتابة"), patient.patientNumber); submit(target.form());
    change(target.field("رقم الملف المكرر"), "OTHER-SYNTHETIC"); change(target.field("أعد كتابة"), "MISMATCH"); submit(target.form());
    expect(fetchMock).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });
  it("unknown ownership never blocks an unrelated patient", async () => {
    const first = prepareAdmin("merge"); unknownResponse("408"); submit(first.form()); await settle();
    const other = owner("admin", { ...patient, id: ++sequence, patientNumber: "OTHER-SYNTHETIC" }); other.render();
    const open = other.button("دمج ملف مكرر"); expect(open.props.disabled).toBe(false); click(open); expect(other.form()).toBeDefined();
  });
});
