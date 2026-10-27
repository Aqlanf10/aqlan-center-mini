import { type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  return { ...react,
    useState: (initial: unknown) => { const i = slot(initial); return [hooks.values[i], (value: unknown) => { hooks.values[i] = value; }]; },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useEffect: () => {},
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
function renderHook(scope: string) {
  hooks.cursor = 0;
  const captured: { value?: ReturnType<typeof useNearbyBooking> } = {};
  renderToStaticMarkup(<HookHarness scope={scope} capture={value => { captured.value = value; }} />);
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
beforeEach(() => { hooks.values = []; hooks.cursor = 0; vi.unstubAllGlobals(); });
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
