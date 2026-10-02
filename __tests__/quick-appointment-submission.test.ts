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

  it("keeps the original request snapshot if editable draft fields change during patient creation", async () => {
    const patient = deferred<ReturnType<typeof response>>();
    fetchMock.mockImplementation((url) => url === "/api/patients" ? patient.promise : Promise.resolve(response(201, {})));
    const form = enterNewPatient();
    const originalDate = form.find((node) => node.props.id === "quick-appointment-date").props.value;
    const first = form.submit();
    // Freezing editable fields is separate follow-up work. These changes must
    // never retarget or alter the already submitted booking's captured payload.
    for (const [id, value] of [["patient", "اسم آخر"], ["date", "2030-01-15"], ["time", "19:00"], ["note", "ملاحظة أخرى"]]) {
      const field = render().find((node) => node.props.id === `quick-appointment-${id}`);
      (field.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
    }
    patient.resolve(response(201, { id: 91001 }));
    await first;
    expect(JSON.parse(writes("/api/patients")[0][1].body)).toEqual({ fullName: "مريض تجريبي جديد", phone: "" });
    const booking = JSON.parse(writes("/api/appointments")[0][1].body);
    expect(booking).toMatchObject({ patientId: 91001, date: originalDate, time: "16:00", isNewPatient: true });
    expect(booking).not.toHaveProperty("note");
  });

  it.each(["response", "network", "json"])("releases the lock after patient-create %s failure and permits a retry", async (failure) => {
    if (failure === "response") fetchMock.mockResolvedValueOnce(response(400, {}));
    else if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("offline"));
    else fetchMock.mockResolvedValueOnce({ ...response(201, {}), json: async () => { throw new Error("invalid JSON"); } });
    await enterNewPatient().submit();
    expect(render().tree!.props.busy).toBe(false);
    expect(writes("/api/appointments")).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response(201, { id: 91001 })).mockResolvedValueOnce(response(201, {}));
    await render().submit();
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
    fetchMock.mockResolvedValueOnce(response(201, { id: 91001 })).mockResolvedValueOnce(response(201, {}));
    await enterNewPatient().submit();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});
