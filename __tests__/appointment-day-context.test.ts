import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppointmentsPage from "../app/appointments/page";
import { AppointmentReminder } from "../components/AppointmentReminder";

// Real rendered handlers with synthetic transport. This is not browser acceptance.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[], cleanups: new Map<number, () => void>() }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => {
        hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value;
      }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown, deps: unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.values[index] as { fn: unknown; deps: unknown[] } | undefined;
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.values[index] = { fn, deps };
      return (hooks.values[index] as { fn: unknown }).fn;
    },
    useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.values[index] as unknown[] | undefined;
      if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) {
        hooks.values[index] = deps;
        hooks.effects.push(() => {
          hooks.cleanups.get(index)?.();
          const cleanup = fn();
          if (cleanup) hooks.cleanups.set(index, cleanup);
        });
      }
    },
    useLayoutEffect: (fn: () => void | (() => void), deps: unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.values[index] as unknown[] | undefined;
      if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) {
        hooks.values[index] = deps;
        hooks.effects.push(() => {
          hooks.cleanups.get(index)?.();
          const cleanup = fn();
          if (cleanup) hooks.cleanups.set(index, cleanup);
        });
      }
    },
  };
});

vi.mock("@/components/ArrivalPanel", () => ({ ArrivalPanel: () => null }));
vi.mock("@/components/QuickAppointmentModal", () => ({ QuickAppointmentModal: () => null }));
vi.mock("@/components/SettingsProvider", () => ({ useChairCount: () => 3, useSetting: () => "09:00" }));
vi.mock("@/components/SessionProvider", () => ({ useSession: () => ({ role: "admin" }) }));
vi.mock("@/components/PageHeader", () => ({ PageHeader: () => null }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return node && typeof node === "object" && "props" in node
    ? text((node as Element).props.children as ReactNode) : "";
}
function render(commit = true) {
  hooks.cursor = 0;
  const all = elements(AppointmentsPage());
  if (commit) commitEffects();
  return all;
}
function commitEffects() { hooks.effects.splice(0).forEach((effect) => effect()); }
function find(predicate: (node: Element) => boolean) {
  const node = render().find(predicate);
  if (!node) throw new Error("Missing rendered control");
  return node;
}
function click(label: string) {
  return (find((node) => node.type === "button" && text(node.props.children as ReactNode).trim() === label).props.onClick as () => Promise<void>)();
}
function changeDate(date: string, commit = true) {
  (find((node) => node.type === "input" && node.props.type === "date").props.onChange as (e: unknown) => void)({ target: { value: date } });
  return render(commit);
}
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
const day = "2026-10-22";
const nextDay = "2026-10-23";
const appointment = { id: 7, patientId: 31, patientName: "Synthetic day A patient", patientPhone: null,
  scheduledDate: day, scheduledTime: "10:00", durationMinutes: 30, status: "booked", doctorId: 9,
  doctorName: "Synthetic doctor", serviceId: 4, appointmentType: "consultation" };
const appointmentB = { ...appointment, id: 8, scheduledDate: nextDay, patientName: "Synthetic day B patient" };
const fetchMock = vi.fn();
let reads: { date: string; pending: ReturnType<typeof deferred<ReturnType<typeof response>>> }[];
const rows = (nodes = render()) => nodes.filter((node) => node.props["data-appointment"]).map((node) => node.props["data-appointment"]);
function refresh() { (find((node) => typeof node.props.onSuccess === "function").props.onSuccess as () => void)(); }
function captureAction() { return find((node) => node.type === "button" && text(node.props.children as ReactNode).trim() === "لم يحضر").props.onClick as () => Promise<void>; }
const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
beforeEach(async () => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanups.clear(); reads = [];
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T21:30:00Z"));
  vi.stubGlobal("window", { location: { search: `?date=${day}` } });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/appointments?")) {
      const pending = deferred<ReturnType<typeof response>>();
      reads.push({ date: url.split("date=")[1], pending }); return pending.promise;
    }
    if (url.startsWith("/api/parties") || url.startsWith("/api/waiting-list?")) return response([]);
    if (init?.method === "PATCH") return response({ ok: true });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(); render();
  reads[0].pending.resolve(response([appointment])); await flush();
  expect(rows()).toEqual([7]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("appointment day result ownership (actual page handlers, synthetic transport)", () => {
  it("hides old actionable rows in the first render of B before its effects run", async () => {
    const beforeEffects = changeDate(nextDay, false);
    expect(rows(beforeEffects)).toEqual([]);
    expect(beforeEffects.some((node) => node.props["data-day-load"] === "ready")).toBe(false);
    expect(beforeEffects.some((node) => node.props["data-day-load"] === "unknown")).toBe(true);
    expect(reads).toHaveLength(1);
    commitEffects();
    expect(rows()).toEqual([]);
    reads[1].pending.resolve(response([appointmentB])); await flush();
    expect(rows()).toEqual([8]);
  });

  it.each(["network", "http", "shape", "row", "wrong-day", "json"])("does not offer A actions or an empty-success message after B %s failure", async (kind) => {
    changeDate(nextDay);
    if (kind === "network") reads[1].pending.reject(new Error("Synthetic outage"));
    else if (kind === "http") reads[1].pending.resolve(response({ message: "Synthetic refusal" }, false));
    else if (kind === "shape") reads[1].pending.resolve(response({ items: [] }));
    else if (kind === "row") reads[1].pending.resolve(response([null]));
    else if (kind === "wrong-day") reads[1].pending.resolve(response([appointment]));
    else reads[1].pending.resolve({ ok: true, json: async () => { throw new Error("Synthetic JSON failure"); } });
    await flush();
    expect(rows()).toEqual([]);
    const content = render().map((node) => text(node.props.children as ReactNode)).join(" ");
    expect(content).toContain("لم تُحمّل مواعيد هذا اليوم");
    expect(content).not.toContain("لا توجد أي مواعيد محجوزة");
    expect(render().some((node) => node.props["data-day-load"] === "ready")).toBe(false);
    expect(content).toContain("استيعاب اليوم غير متاح");
    expect(content).toContain("جميع الحالات (؟)");
    expect(content).toContain("تنتظر التركيبة (؟)");
    click("إعادة المحاولة");
    expect(reads[2].date).toBe(nextDay);
    reads[2].pending.resolve(response([appointmentB])); await flush();
    expect(rows()).toEqual([8]);
  });

  it.each([
    ["missing patient", { patientId: undefined }], ["zero patient", { patientId: 0 }],
    ["negative patient", { patientId: -1 }], ["fractional patient", { patientId: 1.5 }],
    ["string patient", { patientId: "31" }], ["unknown status", { status: "unknown" }],
    ["invalid hour", { scheduledTime: "25:00" }], ["invalid minute", { scheduledTime: "10:80" }],
    ["invalid time", { scheduledTime: "bad" }], ["zero duration", { durationMinutes: 0 }],
    ["negative duration", { durationMinutes: -30 }], ["fractional duration", { durationMinutes: 1.5 }],
  ])("rejects malformed actionable row: %s", async (_label, patch) => {
    changeDate(nextDay);
    reads[1].pending.resolve(response([{ ...appointmentB, ...patch }])); await flush();
    expect(rows()).toEqual([]);
    expect(render().some((node) => node.props["data-load-error"] !== undefined)).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("accepts recognized legacy statuses and single-digit hour representation", async () => {
    changeDate(nextDay);
    reads[1].pending.resolve(response(["booked", "arrived", "done", "cancelled", "no_show"].map((status, index) => ({
      ...appointmentB, id: 20 + index, status, scheduledTime: "9:05", durationMinutes: 5,
    })))); await flush();
    expect(rows()).toEqual([20, 21, 22, 23, 24]);
  });

  it.each(["success", "failure"])("retires delayed A %s after B succeeds", async (result) => {
    refresh(); const old = reads[1];
    changeDate(nextDay);
    reads[2].pending.resolve(response([appointmentB])); await flush();
    if (result === "success") old.pending.resolve(response([appointment]));
    else old.pending.reject(new Error("Late A failure"));
    await flush(); expect(rows()).toEqual([8]);
  });

  it("does not let a delayed A request finish B loading", async () => {
    refresh(); changeDate(nextDay);
    reads[1].pending.resolve(response([appointment])); await flush();
    expect(rows()).toEqual([]);
    expect(render().some((node) => text(node.props.children as ReactNode).includes("جارٍ تحميل المواعيد"))).toBe(true);
    reads[2].pending.resolve(response([])); await flush();
    expect(rows()).toEqual([]);
    expect(render().some((node) => text(node.props.children as ReactNode).includes("لا توجد أي مواعيد محجوزة"))).toBe(true);
    const capacity = find((node) => node.props["data-day-load"] === "ready");
    expect(text(capacity.props.children as ReactNode)).toContain("0 مواعيد");
    expect(render().some((node) => node.type === "button" && text(node.props.children as ReactNode) === "جميع الحالات (0)")).toBe(true);
  });

  it("only allows the latest repeated same-day refresh to supply actionable rows", async () => {
    const oldAction = captureAction();
    refresh(); await oldAction(); expect(writes()).toHaveLength(0);
    expect(rows()).toEqual([]);
    refresh();
    reads[2].pending.resolve(response([{ ...appointment, id: 9 }])); await flush();
    reads[1].pending.resolve(response([appointment])); await flush();
    expect(rows()).toEqual([9]);
    await oldAction(); expect(writes()).toHaveLength(0);
    const pending = captureAction()(); await flush();
    expect(writes().map(([url]) => url)).toEqual(["/api/appointments/9"]);
    reads[3].pending.resolve(response([])); await pending;
  });

  it("keeps same-day rows hidden after a failed refresh and rejects their captured action", async () => {
    const oldAction = captureAction(); refresh();
    reads[1].pending.resolve(response({ message: "Refresh unavailable" }, false)); await flush();
    expect(rows()).toEqual([]);
    await oldAction(); expect(writes()).toHaveLength(0);
    expect(render().some((node) => node.props["data-load-error"] !== undefined)).toBe(true);
  });

  it("still admits only one appointment write before rerender", async () => {
    const action = captureAction();
    const first = action(); const second = action(); await flush();
    expect(writes()).toHaveLength(1);
    reads[1].pending.resolve(response([appointment])); await Promise.all([first, second]);
  });

  it("rejects a captured A action after navigation and only submits B's result", async () => {
    const oldAction = captureAction();
    changeDate(nextDay); await oldAction(); expect(writes()).toHaveLength(0);
    reads[1].pending.resolve(response([appointmentB])); await flush();
    await oldAction(); expect(writes()).toHaveLength(0);
    const pending = captureAction()(); await flush();
    expect(writes().map(([url]) => url)).toEqual(["/api/appointments/8"]);
    expect(reads[2].date).toBe(nextDay);
    reads[2].pending.resolve(response([appointmentB])); await pending;
  });

  it("retires A's old result even after leaving and returning to A", async () => {
    const oldAction = captureAction(); refresh();
    changeDate(nextDay); changeDate(day);
    reads[1].pending.resolve(response([appointment])); await flush();
    expect(rows()).toEqual([]); await oldAction(); expect(writes()).toHaveLength(0);
    reads[3].pending.resolve(response([{ ...appointment, id: 10 }])); await flush();
    expect(rows()).toEqual([10]);
  });

  it("does not reload or write action results after unmount", async () => {
    const write = deferred<ReturnType<typeof response>>();
    fetchMock.mockImplementationOnce(() => write.promise);
    const pending = captureAction()();
    hooks.cleanups.forEach((cleanup) => cleanup());
    const state = [...hooks.values];
    write.resolve(response({ ok: true })); await pending;
    expect(reads).toHaveLength(1);
    expect(hooks.values).toEqual(state);
  });

  it("retires pending loads and captured actions on unmount", async () => {
    const oldAction = captureAction(); refresh();
    hooks.cleanups.forEach((cleanup) => cleanup());
    const state = [...hooks.values];
    reads[1].pending.resolve(response([appointment])); await flush();
    expect(hooks.values).toEqual(state);
    await oldAction(); expect(writes()).toHaveLength(0);
  });
});

describe("manual reminder page wiring (shared control, synthetic transport)", () => {
  function reminder() { return find((node) => node.type === AppointmentReminder); }
  function confirmReminder() { return reminder().props.onConfirmed as () => Promise<void>; }
  function ownsReminder() { return (reminder().props.isCurrent as () => boolean)(); }

  it.each(["list", "chairs"])("records a staff-confirmed reminder through the existing action gate in %s view", async (view) => {
    if (view === "chairs") click("🪑 كراسي (3)");
    expect(ownsReminder()).toBe(true);
    const pending = confirmReminder()(); await flush();
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe("/api/appointments/7");
    expect(JSON.parse(writes()[0][1].body)).toEqual({ action: "reminded" });
    reads[1].pending.resolve(response([{ ...appointment, reminderSentAt: "2026-10-22T06:00:00Z" }]));
    await pending;
    expect((reminder().props.item as { reminderSentAt: string }).reminderSentAt).toBe("2026-10-22T06:00:00Z");
  });

  it.each(["http", "network", "json", "shape"])("does not report success after %s failure and allows a fresh explicit retry", async (kind) => {
    fetchMock.mockImplementationOnce(async () => {
      if (kind === "network") throw new Error("Synthetic network failure");
      if (kind === "json") return { ok: true, json: async () => { throw new Error("Synthetic malformed JSON"); } };
      return kind === "http" ? response({ message: "Synthetic reminder refusal" }, false) : response({});
    });
    const pending = confirmReminder()(); await flush();
    reads[1].pending.resolve(response([appointment])); await pending;
    expect(render().some((node) => node.props["data-action-error"] !== undefined)).toBe(true);
    expect((reminder().props.item as { reminderSentAt?: string }).reminderSentAt).toBeUndefined();
    expect(writes()).toHaveLength(1); // No automatic retry on an uncertain outcome.
    const retry = confirmReminder()(); await flush();
    reads[2].pending.resolve(response([{ ...appointment, reminderSentAt: "2026-10-22T06:00:00Z" }])); await retry;
    expect(writes()).toHaveLength(2);
    expect(render().some((node) => node.props["data-action-error"] !== undefined)).toBe(false);
  });

  it.each(["date", "refresh", "unmount"])("rejects a captured confirmation after parent %s retirement", async (kind) => {
    const control = reminder();
    const old = control.props.onConfirmed as () => Promise<void>;
    const owns = control.props.isCurrent as () => boolean;
    if (kind === "date") changeDate(nextDay);
    else if (kind === "refresh") refresh();
    else hooks.cleanups.forEach((cleanup) => cleanup());
    expect(owns()).toBe(false); await old(); expect(writes()).toHaveLength(0);
  });

  it("does not revive a reminder confirmation after leaving and returning to the same day", async () => {
    const old = confirmReminder(); changeDate(nextDay); changeDate(day);
    reads[2].pending.resolve(response([{ ...appointment, id: 9 }])); await flush();
    await old(); expect(writes()).toHaveLength(0);
    const fresh = confirmReminder()(); await flush();
    expect(writes().map(([url]) => url)).toEqual(["/api/appointments/9"]);
    reads[3].pending.resolve(response([])); await fresh;
  });
});
