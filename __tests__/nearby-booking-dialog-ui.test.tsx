import { type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, rendering: false,
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(), pending: [] as (() => void)[] }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const memo = (fn: () => unknown, deps?: readonly unknown[]) => { const i = slot(undefined); const old = hooks.memos.get(i);
    if (old && same(old.deps, deps)) return old.value;
    const value = fn(); hooks.memos.set(i, { deps, value }); return value; };
  const effect = (fn: () => void | (() => void), deps?: readonly unknown[]) => { const i = slot(undefined); const old = hooks.effects.get(i);
    if (old && same(old.deps, deps)) return;
    hooks.pending.push(() => { old?.cleanup?.(); hooks.effects.set(i, { deps, cleanup: fn() || undefined }); }); };
  return { ...react,
    useState: (initial: unknown) => { const i = slot(initial); return [hooks.values[i], (value: unknown) => { hooks.values[i] = value; }]; },
    useRef: (initial: unknown) => hooks.values[slot(new Proxy({ current: initial }, {
      get: (target, key) => { if (hooks.rendering && key === "current") throw new Error("Ref read during render"); return Reflect.get(target, key); },
      set: (target, key, value) => { if (hooks.rendering && key === "current") throw new Error("Ref write during render"); return Reflect.set(target, key, value); },
    }))],
    useMemo: memo, useCallback: (fn: unknown, deps?: readonly unknown[]) => memo(() => fn, deps),
    useEffect: effect, useLayoutEffect: effect,
  };
});
import { NearbyBookingDialog, useNearbyBooking } from "../components/useNearbyBooking";
const warning = { kind: "nearby_patient_appointments" as const, confirmationToken: "never-render-token", nearbyAppointments: [{ id: 12, scheduledDate: "2026-10-29", scheduledTime: "16:00", doctorName: "طبيب تجريبي" }] };
const options = { method: "POST", body: JSON.stringify({ patientId: 8, date: "2026-10-28", time: "17:00" }) };
const reply = () => new Response(JSON.stringify(warning), { status: 409 });
function HookHarness({ scope, capture }: { scope: string; capture: (value: ReturnType<typeof useNearbyBooking>) => void }) {
  capture(useNearbyBooking(scope));
  return null;
}
function renderHook(scope: string, commit = true) {
  hooks.cursor = 0;
  const captured: { value?: ReturnType<typeof useNearbyBooking> } = {};
  hooks.rendering = true;
  try { renderToStaticMarkup(<HookHarness scope={scope} capture={value => { captured.value = value; }} />); } finally { hooks.rendering = false; }
  if (commit) hooks.pending.splice(0).forEach(effect => effect());
  if (!captured.value) throw new Error("Nearby booking hook harness did not render");
  return captured.value;
}
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  return [node as Element, ...elements((node as Element).props.children as ReactNode)];
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.memos.clear(); hooks.effects.clear(); hooks.pending = []; vi.unstubAllGlobals(); });
afterEach(() => { hooks.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals(); });
describe("nearby appointment warning dialog", () => {
  it("shows date, time and doctor in the existing RTL modal with explicit neutral cancel and intentional confirm", () => {
    const html = renderToStaticMarkup(<NearbyBookingDialog warning={warning} onDecision={() => {}} />);
    expect(html).toContain('dir="rtl"'); expect(html).toContain('<dialog'); expect(html).toContain('aria-modal="true"');
    expect(html).toContain("طبيب تجريبي"); expect(html).toContain("إلغاء الحجز الجديد"); expect(html).toContain("تأكيد موعد إضافي مقصود");
    expect(html).not.toContain("never-render-token");
    const decision = vi.fn(); const tree = NearbyBookingDialog({ warning, onDecision: decision });
    const controls = elements(tree).filter(node => node.type === "button");
    (controls[0].props.onClick as () => void)(); expect(decision).toHaveBeenLastCalledWith(false);
    (controls[1].props.onClick as () => void)(); expect(decision).toHaveBeenLastCalledWith(true);
  });
  it.each(["patient-9:2026-10-28", "patient-8:2026-10-29"])("invalidates pending confirmation when rendered proposal changes to %s", async scope => {
    const fetcher = vi.fn().mockImplementation(reply); vi.stubGlobal("fetch", fetcher);
    const first = renderHook("patient-8:2026-10-28"); const result = first.bookingFetch("/api/appointments", options);
    await flush(); const pending = renderHook("patient-8:2026-10-28").nearbyBookingDialog as ReactElement<{ onDecision: (value: boolean) => void }>;
    expect(pending).not.toBeNull();
    expect(renderHook(scope).nearbyBookingDialog).toBeNull();
    pending.props.onDecision(true); await result;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("a captured decision from the previous warning cannot confirm a new patient proposal", async () => {
    const fetcher = vi.fn().mockImplementation(reply); vi.stubGlobal("fetch", fetcher);
    const first = renderHook("patient-8"); const oldRequest = first.bookingFetch("/api/appointments", options);
    await flush(); const oldDialog = renderHook("patient-8").nearbyBookingDialog as ReactElement<{ onDecision: (value: boolean) => void }>;
    const next = renderHook("patient-9"); await oldRequest;
    const nextRequest = next.bookingFetch("/api/appointments", { ...options, body: JSON.stringify({ patientId: 9 }) });
    await flush(); const newDialog = renderHook("patient-9").nearbyBookingDialog as ReactElement<{ onDecision: (value: boolean) => void }>;
    oldDialog.props.onDecision(true); await flush(); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(renderHook("patient-9").nearbyBookingDialog).not.toBeNull();
    newDialog.props.onDecision(false); await nextRequest; expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("guards duplicate clicks while a warning awaits a decision", async () => {
    const fetcher = vi.fn().mockImplementation(reply); vi.stubGlobal("fetch", fetcher);
    const first = renderHook("same"); const result = first.bookingFetch("/api/appointments", options);
    await flush(); expect((await first.bookingFetch("/api/appointments", options)).status).toBe(409);
    const pending = renderHook("same").nearbyBookingDialog as ReactElement<{ onDecision: (value: boolean) => void }>;
    pending.props.onDecision(false); await result; expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it("an abandoned proposal render cannot revoke the committed booking or send another request", async () => {
  const fetcher = vi.fn().mockImplementation(reply); vi.stubGlobal("fetch", fetcher);
  const first = renderHook("A"), request = first.bookingFetch("/api/appointments", options);
  await flush(); const pending = renderHook("A").nearbyBookingDialog as ReactElement<{ onDecision: (accepted: boolean) => void }>;
  const saved = { values: hooks.values, memos: hooks.memos, effects: hooks.effects };
  hooks.values = [...hooks.values]; hooks.memos = new Map(hooks.memos); hooks.effects = new Map(hooks.effects);
  const abandoned = renderHook("B", false); expect(abandoned.nearbyBookingDialog).toBeNull();
  expect((await abandoned.bookingFetch("/api/appointments", options)).status).toBe(409);
  Object.assign(hooks, saved); hooks.pending = [];
  pending.props.onDecision(true); await request;
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ nearbyAppointmentConfirmation: "never-render-token" });
});
it("committed A to B to A retires stale callbacks and unmount settles the pending decision", async () => {
  const fetcher = vi.fn().mockImplementation(reply); vi.stubGlobal("fetch", fetcher);
  const first = renderHook("A"), request = first.bookingFetch("/api/appointments", options);
  await flush(); renderHook("B"); await request;
  const next = renderHook("A"); await first.bookingFetch("/api/appointments", options);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const nextRequest = next.bookingFetch("/api/appointments", options); await flush();
  hooks.effects.forEach(effect => effect.cleanup?.()); hooks.effects.clear();
  await nextRequest; await next.bookingFetch("/api/appointments", options);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
