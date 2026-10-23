import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SummaryTab, type WorkflowSummary } from "../components/patient/SummaryTab";

type Slot = { value?: unknown; deps?: unknown[]; cleanup?: () => void };
type Frame = { slots: Slot[]; cursor: number; effects: (() => void)[] };
const runtime = vi.hoisted(() => ({ frame: null as Frame | null }));
// Repository-standard hook harness: invoke real handlers without a browser or a DB.
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const slot = () => { const f = runtime.frame!; const i = f.cursor++; return f.slots[i] ?? (f.slots[i] = {}); };
  return { ...react,
    useState: (initial: unknown) => { const s = slot(); if (!("value" in s)) s.value = typeof initial === "function" ? initial() : initial;
      return [s.value, (next: unknown) => { s.value = typeof next === "function" ? next(s.value) : next; }]; },
    useRef: (initial: unknown) => { const s = slot(); if (!s.value) s.value = { current: initial }; return s.value; },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => { const s = slot();
      if (!s.deps || !deps || deps.some((v, i) => !Object.is(v, s.deps![i]))) { s.deps = deps;
        runtime.frame!.effects.push(() => { s.cleanup?.(); s.cleanup = fn() || undefined; }); } },
  };
});
vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));
vi.mock("../components/ReceiptCorrectionLauncher", () => ({ ReceiptCorrectionLauncher: () => null }));
vi.mock("../components/PortalInviteRow", () => ({ PortalInviteRow: () => null }));
vi.mock("../components/patient/PatientTimeline", () => ({ PatientTimeline: () => null }));
vi.mock("../components/patient/PatientIntakeHistory", () => ({ PatientIntakeHistory: () => null }));
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const e = node as Element; return [e, ...elements(e.props.children as ReactNode)];
}
function words(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(words).join(" ");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return node && typeof node === "object" && "props" in node ? words((node as Element).props.children as ReactNode) : "";
}
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const turns = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const summary = (): WorkflowSummary => ({ today: "2026-10-22", timeZone: "Asia/Aden",
  openVisit: null, lastVisit: null, nextAppointment: null, activePlans: [], financial: null, canSeeFinancial: false, alerts: [],
  counts: { visits: 0, openLabOrders: 0, documents: 0, orthoCase: false },
  plannedVisits: [{ id: 71, planTitle: null, sequence: 1, title: "جلسة اختبار", doctorName: null, durationMinutes: 30,
    status: "scheduled", appointmentId: 101, appointmentStatus: "no_show", appointmentDate: "2026-10-20", appointmentTime: "16:00",
    canRebook: true, rebookBlockedReason: null, rebookGeneration: "a".repeat(32), note: null }],
});
function mount(timeZone = "Asia/Aden") {
  const frame: Frame = { slots: [], cursor: 0, effects: [] };
  const props = { summary: { ...summary(), timeZone }, patientId: 7, patientName: "اصطناعي", patientNumber: "SYNTH-7", patientPhone: null,
    base: "YER" as const, onVisitStarted: vi.fn(), onChanged: vi.fn(), onGoToTab: vi.fn(), workflowIsCurrent: () => true };
  const render = () => { runtime.frame = frame; frame.cursor = 0; const tree = SummaryTab(props);
    frame.effects.splice(0).forEach(fn => fn()); return tree; };
  const find = (type: string, text?: string) => elements(render()).find(e => e.type === type && (!text || words(e.props.children as ReactNode) === text))!;
  const field = (name: string) => elements(render()).find(e => name === "reason" ? e.type === "textarea" : e.type === "input" && e.props.type === name)!;
  const change = (name: string, value: string) => (field(name).props.onChange as (e: unknown) => void)({ target: { value } });
  const click = (text: string) => (find("button", text).props.onClick as () => void)();
  const submit = () => (find("form").props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() });
  render(); click("إعادة حجز");
  return { props, render, find, field, change, click, submit, unmount: () => frame.slots.forEach(s => s.cleanup?.()) };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-22T21:30:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("explicit planned-session rebooking UI", () => {
  it("respects a configured clinic timezone instead of the Aden fallback", () => {
    const f = mount("America/Los_Angeles");
    expect(f.field("date").props.value).toBe("2026-10-23");
    expect(f.field("date").props.min).toBe("2026-10-22");
  });

  it("uses clinic calendar tomorrow and an accessible bounded reason, not the workstation date", () => {
    const f = mount();
    expect(f.field("date").props.value).toBe("2026-10-24");
    expect(f.field("date").props.min).toBe("2026-10-23");
    expect(f.find("form").props.noValidate).toBe(true);
    expect(f.field("reason").props).toMatchObject({ required: true, maxLength: 500, rows: 3 });
    expect(f.field("reason").props.className).toContain("resize-none");
  });
  it("starts a fresh form at the default time after cancelling an unsent edit", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const f = mount();
    f.change("time", "19:30"); f.change("date", "2026-10-30"); f.change("reason", "طلب المريض");
    f.click("إلغاء");
    expect(f.find("form")).toBeUndefined();
    f.click("إعادة حجز");
    expect(f.field("time").props.value).toBe("16:00");
    expect(f.field("date").props.value).toBe("2026-10-24");
    expect(f.field("reason").props.value).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["", " ", "ab", "x".repeat(501)])("blocks missing/oversized reason before sending", reason => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const f = mount(); f.change("reason", reason); f.submit();
    expect(fetch).not.toHaveBeenCalled(); expect(f.field("reason").props["aria-invalid"]).toBe(true);
    expect(f.find("p").props).toBeDefined(); expect(words(f.render())).toContain("بحد أقصى 500 حرف");
  });
  it.each(["2026-02-30", "2026-10-22"])("blocks invalid or clinic-past date %s", date => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const f = mount(); f.change("reason", "طلب المريض"); f.change("date", date); f.submit();
    expect(fetch).not.toHaveBeenCalled(); expect(f.field("date").props["aria-invalid"]).toBe(true);
  });
  it("blocks rapid duplicate submit, then reports success and refreshes without starting a visit", async () => {
    let resolve!: (value: unknown) => void;
    const fetch = vi.fn(() => new Promise(done => { resolve = done; })); vi.stubGlobal("fetch", fetch);
    const f = mount(); f.change("reason", "  طلب المريض  "); f.submit(); f.submit();
    expect(fetch).toHaveBeenCalledTimes(1); expect(f.field("reason").props.disabled).toBe(true);
    expect(f.find("button", "إلغاء").props.disabled).toBe(true);
    const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/planned-visits/71/rebook");
    expect(JSON.parse(request.body as string)).toMatchObject({ expectedAppointmentId: 101, expectedGeneration: "a".repeat(32), date: "2026-10-24", time: "16:00", reason: "طلب المريض", requestId: expect.any(String) });
    resolve(reply({ appointmentId: 102, title: "جلسة اختبار", replayed: false }, 201)); await turns();
    expect(f.props.onChanged).toHaveBeenCalledTimes(1); expect(f.props.onVisitStarted).not.toHaveBeenCalled();
    expect(words(f.render())).toContain("تمت إعادة حجز الجلسة"); expect(f.find("form")).toBeUndefined();
  });
  it.each(["network", "server", "malformed"])("locks edits after %s uncertainty and retries the identical body/key", async failure => {
    const fetch = vi.fn().mockImplementationOnce(() => failure === "network" ? Promise.reject(new Error("lost")) :
      Promise.resolve(reply(failure === "server" ? { message: "unknown" } : {}, failure === "server" ? 500 : 200)))
      .mockResolvedValueOnce(reply({ message: "انتهت الجلسة" }, 401))
      .mockResolvedValueOnce(reply({ appointmentId: 102, title: "جلسة اختبار", replayed: true }));
    vi.stubGlobal("fetch", fetch); const f = mount(); f.change("reason", "طلب المريض"); f.submit(); await turns();
    const body = fetch.mock.calls[0][1].body;
    expect(f.field("reason").props.disabled).toBe(true); expect(f.find("button", "إلغاء").props.disabled).toBe(true);
    f.change("reason", "تعديل ممنوع"); f.change("date", "2026-10-25"); f.click("إلغاء");
    expect(f.field("reason").props.value).toBe("طلب المريض"); expect(f.field("date").props.value).toBe("2026-10-24");
    f.submit(); await turns(); expect(f.field("reason").props.disabled).toBe(true); // A later 401 does not prove the first attempt failed.
    f.submit(); await turns(); expect(fetch.mock.calls.map(call => call[1].body)).toEqual([body, body, body]);
    expect(f.props.onChanged).toHaveBeenCalledTimes(1);
  });
  it("uses a new request identity only after an explicit rejection permits changing the payload", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply({ message: "الوقت ممتلئ" }, 409))
      .mockResolvedValueOnce(reply({ appointmentId: 102, title: "جلسة اختبار", replayed: false }, 201));
    vi.stubGlobal("fetch", fetch); const f = mount(); f.change("reason", "طلب المريض"); f.submit(); await turns();
    expect(f.field("reason").props.disabled).toBe(false); expect(words(f.render())).toContain("الوقت ممتلئ");
    f.change("time", "17:00"); f.submit(); await turns();
    const first = JSON.parse(fetch.mock.calls[0][1].body), second = JSON.parse(fetch.mock.calls[1][1].body);
    expect(second.time).toBe("17:00"); expect(second.requestId).not.toBe(first.requestId);
  });
  it.each(["", "short", "G".repeat(32)])("fails closed on an invalid server generation %s", rebookGeneration => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const f = mount(); f.props.summary.plannedVisits[0].rebookGeneration = rebookGeneration;
    f.change("reason", "طلب المريض"); f.submit();
    expect(fetch).not.toHaveBeenCalled();
    expect(words(f.render())).toContain("حدّث الملف قبل إعادة الحجز");
  });
  it("never substitutes a refreshed generation into an uncertain request or mints another key", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("lost reply"))
      .mockResolvedValueOnce(reply({ message: "تغيّرت نسخة الجلسة" }, 409));
    vi.stubGlobal("fetch", fetch);
    const f = mount(); f.change("reason", "طلب المريض"); f.submit(); await turns();
    const first = JSON.parse(fetch.mock.calls[0][1].body);
    f.props.summary.plannedVisits = [{ ...f.props.summary.plannedVisits[0], rebookGeneration: "b".repeat(32) }];
    f.submit(); await turns();
    expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ expectedGeneration: "a".repeat(32), requestId: first.requestId });
    expect(f.field("reason").props.disabled).toBe(true);
    expect(f.find("button", "إلغاء").props.disabled).toBe(true);
  });
  it("keeps stale callbacks from sending or reporting success, and retires unmounted responses", async () => {
    let resolve!: (value: unknown) => void; const fetch = vi.fn(() => new Promise(done => { resolve = done; })); vi.stubGlobal("fetch", fetch);
    const f = mount(); f.change("reason", "طلب المريض"); f.props.workflowIsCurrent = () => false; f.submit(); expect(fetch).not.toHaveBeenCalled();
    f.props.workflowIsCurrent = () => true; f.submit(); f.unmount(); resolve(reply({ appointmentId: 102 })); await turns();
    expect(f.props.onChanged).not.toHaveBeenCalled();
  });
});
