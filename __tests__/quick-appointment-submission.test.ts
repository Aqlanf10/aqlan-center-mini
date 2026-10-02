import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAppointmentModal } from "../components/QuickAppointmentModal";

// Exercise the real component's rendered handlers and state across renders.
// This repository has no DOM unit-test dependency. Effects are intentionally
// excluded here; the built-app browser journey covers actual clicks and dialogs.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  function slot(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  }
  return {
    ...react,
    useId: () => "quick-appointment",
    useEffect: () => {},
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => {
        hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value;
      }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
  };
});

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
const onClose = vi.fn();
const onSuccess = vi.fn();
const fetchMock = vi.fn();
function render(patientId?: number) {
  hooks.cursor = 0;
  const tree = QuickAppointmentModal({ patientId, isOpen: true, onClose, onSuccess });
  const all = elements(tree);
  return {
    tree,
    all,
    find: (predicate: (element: Element) => boolean) => {
      const found = all.find(predicate);
      if (!found) throw new Error("Missing rendered control");
      return found;
    },
    submit: () => (all.find((node) => node.type === "form")!.props.onSubmit as
      (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: vi.fn() }),
  };
}
function enterNewPatient() {
  const field = render().find((node) => node.props.id === "quick-appointment-patient");
  (field.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "مريض تجريبي جديد" } });
  return render();
}
function expectControlGroup(form: ReturnType<typeof render>, busy: boolean) {
  const group = form.find((node) => node.type === "fieldset");
  expect(group.props.disabled).toBe(busy);
  expect(group.props["aria-labelledby"]).toBe("quick-appointment-title");
  const descendants = elements(group.props.children as ReactNode);
  // A disabled fieldset covers native descendants, not links, custom roles or
  // controls in a legend. Keep this structural proof honest as the UI evolves.
  expect(descendants.some((node) => node.type === "legend")).toBe(false);
  const controls = form.all.filter((node) => node.props.onChange || node.props.onClick);
  expect(controls.length).toBeGreaterThan(10);
  for (const control of controls) {
    expect(["input", "select", "textarea", "button"]).toContain(control.type);
    expect(descendants).toContain(control);
  }
}
function changeField(id: string, value: string) {
  const field = render().find((node) => node.props.id === `quick-appointment-${id}`);
  (field.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}
const writes = (url: string) => fetchMock.mock.calls.filter(([target]) => target === url);

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("quick booking owns the complete patient-create and appointment request", () => {
  it("locks before a slow patient create and ignores same-tick or later repeated submission", async () => {
    const patient = deferred<ReturnType<typeof response>>();
    const appointment = deferred<ReturnType<typeof response>>();
    fetchMock.mockImplementation((url) => url === "/api/patients" ? patient.promise : appointment.promise);
    const form = enterNewPatient();
    const first = form.submit();
    const repeated = form.submit(); // Same render, before React commits busy.
    const duringCreate = render();
    const later = duringCreate.submit();
    expect(writes("/api/patients")).toHaveLength(1);
    expect(duringCreate.tree!.props.busy).toBe(true);
    expect(duringCreate.find((node) => node.props.type === "submit").props.disabled).toBe(true);
    expect(duringCreate.find((node) => node.props["aria-label"] === "إغلاق").props.disabled).toBe(true);
    expect(writes("/api/appointments")).toHaveLength(0);
    patient.resolve(response(201, { id: 91001 }));
    await vi.waitFor(() => expect(writes("/api/appointments")).toHaveLength(1));
    expect(render().tree!.props.busy).toBe(true);
    await render().submit();
    expect(writes("/api/appointments")).toHaveLength(1);
    appointment.resolve(response(201, { id: 92001 }));
    await Promise.all([first, repeated, later]);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(render().tree!.props.busy).toBe(false);
    expectControlGroup(render(), false);
  });

  it("ignores two existing-patient submissions from the same render", async () => {
    const appointment = deferred<ReturnType<typeof response>>();
    fetchMock.mockReturnValue(appointment.promise);
    const form = render(91001);
    const first = form.submit();
    const second = form.submit();
    expect(writes("/api/appointments")).toHaveLength(1);
    expect(writes("/api/patients")).toHaveLength(0);
    appointment.resolve(response(201, {}));
    await Promise.all([first, second]);
  });

  it("disables every native control across both pending stages without changing the displayed request", async () => {
    const patient = deferred<ReturnType<typeof response>>();
    const appointment = deferred<ReturnType<typeof response>>();
    fetchMock.mockImplementation((url) => url === "/api/patients" ? patient.promise : appointment.promise);
    enterNewPatient();
    const fields = { phone: "700000001", date: "2030-01-15", time: "17:00", note: "ملاحظة أصلية", doctor: "91002" };
    for (const [id, value] of Object.entries(fields)) changeField(id, value);
    const form = render();
    expectControlGroup(form, false);
    const first = form.submit();
    const duringCreate = render();
    expectControlGroup(duringCreate, true);
    for (const [id, value] of Object.entries(fields)) {
      expect(String(duringCreate.find((node) => node.props.id === `quick-appointment-${id}`).props.value)).toBe(value);
    }
    expect(duringCreate.find((node) => node.props.id === "quick-appointment-patient").props.value).toBe("مريض تجريبي جديد");
    patient.resolve(response(201, { id: 91001 }));
    await vi.waitFor(() => expect(writes("/api/appointments")).toHaveLength(1));
    expectControlGroup(render(), true); // Includes the newly rendered change-patient button.
    expect(JSON.parse(writes("/api/patients")[0][1].body)).toEqual({ fullName: "مريض تجريبي جديد", phone: fields.phone });
    expect(JSON.parse(writes("/api/appointments")[0][1].body)).toMatchObject({
      patientId: 91001, date: fields.date, time: fields.time, note: fields.note, doctorId: 91002, isNewPatient: true,
    });
    appointment.resolve(response(201, {}));
    await first;
    expectControlGroup(render(), false);
    expect(render().find((node) => node.props.id === "quick-appointment-patient").props.value).toBe("");
    expect(render().find((node) => node.props.id === "quick-appointment-note").props.value).toBe("");
  });

  it("also freezes conflict override and open waiting-list preferences outside the form on retry", async () => {
    fetchMock.mockResolvedValueOnce(response(409, { message: "وقت غير متاح", canOverride: true }));
    await render(91001).submit();
    const conflict = render();
    expectControlGroup(conflict, false);
    (conflict.find((node) => node.props["data-action"] === "add-to-waiting-list").props.onClick as () => void)();
    (render().find((node) => node.props["data-waiting-sameday"] === "yes").props.onClick as () => void)();
    changeField("override", "حالة ألم حاد");
    const retry = deferred<ReturnType<typeof response>>();
    fetchMock.mockReturnValueOnce(retry.promise);
    const pending = render().submit();
    const duringRetry = render();
    expectControlGroup(duringRetry, true);
    expect(duringRetry.find((node) => node.props["data-action"] === "save-to-waiting-list")).toBeDefined();
    expect(duringRetry.find((node) => node.props["data-waiting-shift"] === "1")).toBeDefined();
    expect(duringRetry.find((node) => node.props.id === "quick-appointment-override").props.value).toBe("حالة ألم حاد");
    expect(JSON.parse(writes("/api/appointments")[1][1].body).overrideReason).toBe("حالة ألم حاد");
    retry.resolve(response(500, { message: "تعذّر الحجز" }));
    await pending;
    expectControlGroup(render(), false);
    changeField("note", "يمكن تعديل الطلب بعد الفشل");
    expect(render().find((node) => node.props.id === "quick-appointment-note").props.value).toBe("يمكن تعديل الطلب بعد الفشل");
    expect(writes("/api/waiting-list")).toHaveLength(0);
  });

  it.each(["response", "network", "json"])("releases the lock after patient-create %s failure and permits a retry", async (failure) => {
    if (failure === "response") fetchMock.mockResolvedValueOnce(response(400, {}));
    else if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("offline"));
    else fetchMock.mockResolvedValueOnce({ ...response(201, {}), json: async () => { throw new Error("invalid JSON"); } });
    await enterNewPatient().submit();
    expect(render().tree!.props.busy).toBe(false);
    expectControlGroup(render(), false);
    expect(writes("/api/appointments")).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    changeField("patient", "الاسم بعد التصحيح");
    fetchMock.mockResolvedValueOnce(response(201, { id: 91001 })).mockResolvedValueOnce(response(201, {}));
    await render().submit();
    expect(JSON.parse(writes("/api/patients")[1][1].body).fullName).toBe("الاسم بعد التصحيح");
    expect(writes("/api/patients")).toHaveLength(2);
    expect(writes("/api/appointments")).toHaveLength(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([409, 500, "network"] as const)("retains the created patient after booking %s failure and retries without creating another", async (failure) => {
    fetchMock.mockResolvedValueOnce(response(201, { id: 91001 }));
    if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("offline"));
    else fetchMock.mockResolvedValueOnce(response(failure, { message: "وقت غير متاح", canOverride: false }));
    await enterNewPatient().submit();
    expect(render().tree!.props.busy).toBe(false);
    expectControlGroup(render(), false);
    expect(onClose).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response(201, {}));
    await render().submit();
    expect(writes("/api/patients")).toHaveLength(1);
    expect(writes("/api/appointments")).toHaveLength(2);
    for (const [, options] of writes("/api/appointments")) {
      expect(JSON.parse(options.body)).toMatchObject({ patientId: 91001, isNewPatient: true });
    }
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("does not lock an incomplete form and accepts the corrected input", async () => {
    await render().submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(render().tree!.props.busy).toBe(false);
    expectControlGroup(render(), false);
    fetchMock.mockResolvedValueOnce(response(201, { id: 91001 })).mockResolvedValueOnce(response(201, {}));
    await enterNewPatient().submit();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
