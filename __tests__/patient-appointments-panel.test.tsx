import type { DependencyList, EffectCallback, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientAppointmentsPanel } from "../components/patient/PatientAppointmentsPanel";
import { AppointmentReminder } from "../components/AppointmentReminder";
import { appointment, payload } from "./fixtures/patient-appointments";
import { encodePatientAppointmentsCursor } from "../lib/patient-appointments-contract";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, dirty: false, pending: [] as (() => void)[], cleanup: new Map<number, () => void>(), session: { username: "synthetic", role: "doctor" } as { username: string; role: string; permissions?: object } | null }));
vi.mock("@/components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = () => hooks.cursor++;
  const memo = (fn: () => unknown, deps: DependencyList) => {
    const index = slot(); const previous = hooks.values[index] as { value: unknown; deps: DependencyList } | undefined;
    if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.values[index] = { value: fn(), deps };
    return (hooks.values[index] as { value: unknown }).value;
  };
  const effect = (fn: EffectCallback, deps: DependencyList) => {
    const index = slot(); const previous = hooks.values[index] as DependencyList | undefined;
    if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) { hooks.values[index] = deps; hooks.pending.push(() => { hooks.cleanup.get(index)?.(); const cleanup = fn(); if (cleanup) hooks.cleanup.set(index, cleanup); else hooks.cleanup.delete(index); }); }
  };
  return { ...react, useMemo: memo, useCallback: (fn: unknown, deps: DependencyList) => memo(() => fn, deps), useEffect: effect, useLayoutEffect: effect,
    useRef: (initial: unknown) => { const index = slot(); if (!(index in hooks.values)) hooks.values[index] = { current: initial }; return hooks.values[index]; },
    useState: (initial: unknown) => { const index = slot(); if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[index], (value: unknown) => { const next = typeof value === "function" ? value(hooks.values[index]) : value; if (!Object.is(next, hooks.values[index])) hooks.dirty = true; hooks.values[index] = next; }]; },
  };
});
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children as ReactNode);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const response = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const fetchMock = vi.fn(); const requests: ReturnType<typeof deferred<ReturnType<typeof response>>>[] = [];
let patientId = 31;
function render() {
  let tree: ReturnType<typeof PatientAppointmentsPanel>; let renders = 0;
  do { if (++renders > 30) throw new Error("Too many synthetic renders"); hooks.dirty = false; hooks.cursor = 0; tree = PatientAppointmentsPanel({ patientId }); hooks.pending.splice(0).forEach(run => run()); } while (hooks.dirty);
  return tree;
}
const button = (label: string) => elements(render()).find(node => node.type === "button" && text(node) === label)!;
const click = (label: string) => { (button(label).props.onClick as () => void)(); return render(); };
const reminder = () => elements(render()).find(node => node.type === AppointmentReminder)!;
const snapshot = () => { const item = appointment(); return { patientId: item.patientId, patientName: item.patientName, patientPhone: item.patientPhone, scheduledDate: item.scheduledDate, scheduledTime: item.scheduledTime, status: "booked" as const }; };
const confirm = () => (reminder().props.onConfirmed as (value: ReturnType<typeof snapshot>) => Promise<void>)(snapshot());
async function resolve(index: number, body: unknown, status = 200) { requests[index].resolve(response(status, body)); await vi.advanceTimersByTimeAsync(0); return render(); }
function unmount() { hooks.cleanup.forEach(cleanup => cleanup()); hooks.cleanup.clear(); }
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.dirty = false; hooks.pending = []; hooks.cleanup.clear(); hooks.session = { username: "synthetic", role: "doctor" }; patientId = 31; requests.length = 0;
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-22T06:00:00Z"));
  vi.stubGlobal("window", Object.assign(new EventTarget(), { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval })); vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockImplementation(() => { const pending = deferred<ReturnType<typeof response>>(); requests.push(pending); return pending.promise; });
});
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("patient appointment panel lifecycle", () => {
  it("shows honest loading then canonical date/year, doctor, duration and status", async () => {
    expect(text(render())).toContain("جارٍ التحقق"); expect(text(render())).not.toContain("لا توجد");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/patients/31?projection=appointments&view=upcoming");
    await resolve(0, payload()); const visible = text(render());
    expect(visible).toContain("2026-10-22"); expect(visible).toContain("Synthetic doctor"); expect(visible).toContain("30 دقيقة"); expect(visible).toContain("محجوز"); expect(visible).toContain("آخر تحقق"); expect(reminder().props.clinicTimeZone).toBe("Asia/Aden");
  });
  it("fails closed when an old server returns the full patient file instead of this projection", async () => {
    render(); await resolve(0, { patient: { id: 31 }, visits: [], appointments: [appointment()] });
    expect(text(render())).toContain("تعذّر التحقق من بيانات المواعيد"); expect(text(render())).not.toContain("لا توجد مواعيد"); expect(reminder()).toBeUndefined();
  });
  it("keeps canceled reason and unresolved old booking status honest", async () => {
    render(); click("السابقة والمغلقة");
    const appointments = [{ ...appointment(), status: "cancelled", cancelReason: "Synthetic cancellation" }, { ...appointment(), id: 8, scheduledDate: "2026-10-20" }];
    await resolve(1, { ...payload(), view: "history", appointments });
    expect(text(render())).toContain("Synthetic cancellation"); expect(text(render())).toContain("محجوز سابق لم يُغلق");
    await resolve(0, payload()); expect(text(render())).toContain("Synthetic cancellation");
  });
  it("does not revive A rows after A→B→A, even if old requests return last", async () => {
    render(); patientId = 32; render(); patientId = 31; render();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await resolve(2, { ...payload(), appointments: [{ ...appointment(), doctorName: "Current A" }] });
    await resolve(0, { ...payload(), appointments: [{ ...appointment(), doctorName: "Retired A" }] });
    await resolve(1, { ...payload(), patientId: 32, appointments: [{ ...appointment(), patientId: 32, doctorName: "Retired B" }] });
    expect(text(render())).toContain("Current A"); expect(text(render())).not.toContain("Retired");
  });
  it.each(["logout", "replace", "role", "permissions"])("retires page and captured callbacks on %s", async mode => {
    render(); await resolve(0, payload()); const old = reminder(); const before = hooks.session;
    hooks.session = mode === "logout" ? null : { ...before!, ...(mode === "role" ? { role: "assistant" } : mode === "permissions" ? { permissions: { canViewAllPatients: true } } : {}) };
    render(); expect((old.props.isCurrent as () => boolean)()).toBe(false);
    await (old.props.onConfirmed as (s: ReturnType<typeof snapshot>) => Promise<void>)(snapshot());
    expect(fetchMock.mock.calls.filter(call => call[1].method === "PATCH")).toHaveLength(0);
    if (mode === "logout") { hooks.session = before; render(); expect(text(render())).not.toContain("Synthetic doctor"); }
  });
  it("fences old callbacks after refresh and unmount", async () => {
    render(); await resolve(0, payload()); const old = reminder(); click("تحديث المواعيد");
    await (old.props.onConfirmed as (s: ReturnType<typeof snapshot>) => Promise<void>)(snapshot()); expect((old.props.isCurrent as () => boolean)()).toBe(false);
    await resolve(1, payload()); const current = reminder(); unmount();
    await (current.props.onConfirmed as (s: ReturnType<typeof snapshot>) => Promise<void>)(snapshot()); expect(fetchMock.mock.calls.filter(call => call[1].method === "PATCH")).toHaveLength(0);
  });
  it("requires authorized server capability plus role, preserving assistant read-only", async () => {
    hooks.session = { username: "synthetic", role: "assistant" }; render(); await resolve(0, payload()); expect(reminder()).toBeUndefined();
    hooks.session = { username: "synthetic", role: "doctor" }; render(); await resolve(1, { ...payload(), canRemind: false }); expect(reminder()).toBeUndefined();
    hooks.session = { username: "synthetic", role: "cashier" }; expect(render()).toBeNull();
    hooks.session = { username: "synthetic", role: "accountant" }; expect(render()).toBeNull();
  });
  it("refreshes after confirmation without optimistic state and serializes repeated callbacks", async () => {
    render(); await resolve(0, payload()); const onConfirmed = reminder().props.onConfirmed as (s: ReturnType<typeof snapshot>) => Promise<void>;
    const pending = onConfirmed(snapshot()); await onConfirmed(snapshot()); render();
    expect(requests).toHaveLength(2); expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ action: "reminded", snapshot: snapshot() });
    expect(reminder().props.busy).toBe(true); window.dispatchEvent(new Event("focus")); render(); expect(requests).toHaveLength(2);
    await resolve(1, { ok: true }); expect(requests).toHaveLength(3); expect(reminder()).toBeUndefined(); expect(text(render())).not.toContain("سُجّلت إفادتك");
    await resolve(2, { ...payload(), appointments: [{ ...appointment(), reminderSentAt: "2026-10-22T06:01:00Z" }] }); await pending;
    expect((reminder().props.item as { reminderSentAt: string }).reminderSentAt).toBe("2026-10-22T06:01:00Z"); expect(text(render())).toContain("سُجّلت إفادتك");
  });
  it("does not claim success on write or refresh failure, and allows a fresh retry", async () => {
    render(); await resolve(0, payload()); const pending = confirm();
    await resolve(1, { message: "Snapshot changed" }, 409); await resolve(2, payload()); await pending;
    expect(text(render())).toContain("Snapshot changed"); expect(text(render())).not.toContain("سُجّلت إفادتك");
    const second = confirm(); await resolve(3, { ok: true }); await resolve(4, { message: "Refresh unavailable" }, 500); await second;
    expect(text(render())).toContain("القائمة غير معروفة"); expect(text(render())).not.toContain("لا توجد مواعيد"); expect(reminder()).toBeUndefined();
    click("تحديث المواعيد"); await resolve(5, payload()); expect(reminder()).toBeDefined();
  });
  it("discards a completed old mutation on patient switch", async () => {
    render(); await resolve(0, payload()); const pending = confirm(); patientId = 32; render();
    await resolve(1, { ok: true }); await pending; expect(requests).toHaveLength(3);
    await resolve(2, { ...payload(), patientId: 32, appointments: [{ ...appointment(), patientId: 32, doctorName: "Current B" }] });
    expect(text(render())).toContain("Current B"); expect(text(render())).not.toContain("سُجّلت إفادتك");
  });
  it("paginates with exact cursor and truthful per-page count; focus returns to fresh first page", async () => {
    render(); const appointments = Array.from({ length: 20 }, (_, i) => ({ ...appointment(), id: i + 1 }));
    const nextCursor = encodePatientAppointmentsCursor({ patientId: 31, view: "upcoming", today: "2026-10-22", date: "2026-10-22", time: "10:00:00.000000", id: 20 });
    await resolve(0, { ...payload(), appointments, nextCursor }); expect(text(render())).toContain("20 موعد في هذه الصفحة، توجد مواعيد أخرى");
    click("المزيد من المواعيد"); expect(new URL(fetchMock.mock.calls[1][0], "http://localhost").searchParams.get("cursor")).toBe(nextCursor);
    await resolve(1, { ...payload(), requestCursor: nextCursor, appointments: [{ ...appointment(), id: 21 }] }); expect(button("الصفحة السابقة")).toBeDefined();
    window.dispatchEvent(new Event("focus")); render(); expect(fetchMock.mock.calls[2][0]).toBe("/api/patients/31?projection=appointments&view=upcoming");
  });
  it("resets a patient-bound cursor on patient or same-claims session replacement without reviving old pages", async () => {
    render(); const appointments = Array.from({ length: 20 }, (_, i) => ({ ...appointment(), id: i + 1 }));
    const nextCursor = encodePatientAppointmentsCursor({ patientId: 31, view: "upcoming", today: "2026-10-22", date: "2026-10-22", time: "10:00:00.000000", id: 20 });
    await resolve(0, { ...payload(), appointments, nextCursor }); click("المزيد من المواعيد");
    await resolve(1, { ...payload(), requestCursor: nextCursor, appointments: [{ ...appointment(), id: 21 }] });
    patientId = 32; render(); expect(fetchMock.mock.calls[2][0]).toBe("/api/patients/32?projection=appointments&view=upcoming");
    patientId = 31; render(); expect(fetchMock.mock.calls[3][0]).toBe("/api/patients/31?projection=appointments&view=upcoming");
    await resolve(3, { ...payload(), appointments, nextCursor }); click("المزيد من المواعيد");
    hooks.session = { ...hooks.session! }; render(); expect(fetchMock.mock.calls[5][0]).toBe("/api/patients/31?projection=appointments&view=upcoming");
    await resolve(4, { ...payload(), requestCursor: nextCursor, appointments: [{ ...appointment(), id: 21, doctorName: "Retired page" }] });
    expect(text(render())).not.toContain("Retired page");
  });
  it("refreshes clinic midnight and visibility and rejects a mismatched patient response", async () => {
    render(); await resolve(0, payload()); vi.setSystemTime(new Date("2026-10-22T21:00:01Z")); await vi.advanceTimersByTimeAsync(30_000); render(); expect(requests).toHaveLength(2);
    await resolve(1, { ...payload(), patientId: 32 }); expect(text(render())).toContain("تعذّر التحقق"); expect(reminder()).toBeUndefined();
    document.dispatchEvent(new Event("visibilitychange")); render(); expect(requests).toHaveLength(3);
  });
});
