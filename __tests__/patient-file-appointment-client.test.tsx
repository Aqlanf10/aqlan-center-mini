import { readFileSync } from "node:fs";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientReferrals } from "../components/PatientReferrals";
import { readPatientAppointmentVisibility } from "../lib/appointment-read-scope";

// Actual component handlers with synthetic responses only; this source does not
// use a browser, database, real patient, or real referral transition.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, changed: false,
  memos: new Map<number, { value: unknown; deps?: readonly unknown[] }>(),
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(), pending: [] as (() => void)[],
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  return { ...react,
    useState: (initial: unknown) => { const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (update: unknown) => { const value = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(value, hooks.values[index])) hooks.changed = true; hooks.values[index] = value; }]; },
    useCallback: (callback: unknown, deps?: readonly unknown[]) => { const index = slot(undefined); const previous = hooks.memos.get(index);
      if (previous && same(previous.deps, deps)) return previous.value;
      hooks.memos.set(index, { value: callback, deps }); return callback; },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = slot(undefined); const previous = hooks.effects.get(index);
      if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); }); },
  };
});
vi.mock("../lib/schedule", () => ({ clinicDateString: () => "2026-10-03" }));
vi.mock("../lib/reminders", () => ({ friendlyDateLong: (value: string) => value }));

type Element = ReactElement<Record<string, unknown>>;
type Props = Parameters<typeof PatientReferrals>[0];
const appointment = { id: 301, scheduledDate: "2026-10-04", scheduledTime: "09:00", status: "booked" as const, doctorId: 7, doctorName: "Synthetic provider" };
const referral = { id: 41, patientId: 91, kind: "internal", workflowState: "accepted", status: "sent", toPartyId: 7,
  toName: "Synthetic provider", toSpecialty: "oral_surgery", reason: "Synthetic referral", urgency: "routine", createdAt: "2026-10-03T08:00:00Z" };
const fetchMock = vi.fn();
let props: Props;
function reset() { hooks.effects.forEach((effect) => effect.cleanup?.()); hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.memos.clear(); hooks.effects.clear(); hooks.pending = []; }
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element; return [element, ...elements(element.props.children as ReactNode)];
}
function content(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(content).join("");
  return node && typeof node === "object" && "props" in node ? content((node as Element).props.children as ReactNode) : "";
}
function render(change: Partial<Props> = {}) {
  props = { ...props, ...change };
  let tree: ReactNode;
  let count = 0;
  do {
    if (++count > 15) throw new Error("Synthetic referral component did not settle");
    hooks.cursor = 0; hooks.changed = false; tree = PatientReferrals(props);
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return { nodes: elements(tree), text: content(tree) };
}
function button(label: string) { const node = render().nodes.find((one) => one.type === "button" && content(one) === label); if (!node) throw new Error(`Missing ${label}`); return node; }
function picker() { const node = render().nodes.find((one) => one.props["aria-label"] === "موعد الإحالة"); if (!node) throw new Error("Missing appointment picker"); return node; }
function options() { return elements(picker().props.children as ReactNode).filter((node) => node.type === "option").map((node) => node.props.value); }
function choose(value: string) { (picker().props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); }
function status() { return render().nodes.filter((node) => node.props.role === "status").map(content).join(""); }
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
async function click(label: string) { (button(label).props.onClick as () => void)(); await settle(); render(); }
async function openPicker() { render(); await settle(); render(); await click("حجز الإحالة"); }
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

beforeEach(() => {
  reset(); props = { patientId: 91, canIssue: false, appointmentVisibility: "scoped", appointments: [appointment] };
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method) return { ok: false, status: 403, json: async () => ({ message: "Synthetic server transition denial" }) };
    return { ok: true, status: 200, json: async () => url.endsWith("/referrals") ? [referral] : [] };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => { reset(); await settle(); vi.unstubAllGlobals(); });

describe("typed calendar visibility and picker wiring", () => {
  it.each([undefined, null, false, "", "unknown", "future"])("treats legacy or unrecognized %s as unknown", (value) => {
    expect(readPatientAppointmentVisibility(value)).toBe("unknown");
  });
  it("passes the server-derived flag separately from existing write capability", () => {
    const source = readFileSync("components/patient-workspace/WorkspaceSections.tsx", "utf8");
    expect(source).toContain("canIssue={canWrite} appointments={file.appointments} appointmentVisibility={file.appointmentVisibility}");
  });
  it.each(["hidden", undefined] as const)("does not offer appointment rows or imply an empty calendar when %s", async (visibility) => {
    props.appointmentVisibility = visibility; await openPicker();
    expect(options()).toEqual([""]); expect(picker().props.disabled).toBe(true); expect(picker().props.value).toBe("");
    expect(button("تأكيد").props.disabled).toBe(true);
    expect(status()).toContain(visibility === "hidden" ? "محجوبة" : "غير مؤكدة");
    expect(status()).not.toContain("لا يوجد موعد");
    expect(render().text).not.toContain("2026-10-04");
    await click("تأكيد"); expect(posts()).toHaveLength(0);
  });
  it.each(["all", "scoped"] as const)("offers only matching booked rows for %s reads", async (visibility) => {
    props.appointmentVisibility = visibility;
    props.appointments = [appointment, { ...appointment, id: 302, doctorId: 8 }, { ...appointment, id: 303, status: "done" }];
    await openPicker(); expect(options()).toEqual(["", 301]);
    expect(picker().props.disabled).toBe(false); expect(button("تأكيد").props.disabled).toBe(true);
    choose("301"); expect(button("تأكيد").props.disabled).toBe(false);
    expect(render().text).not.toContain("+ إحالة جديدة");
    await click("تأكيد"); expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0][1].body as string)).toMatchObject({ action: "schedule", appointmentId: "301" });
    expect(render().text).toContain("Synthetic server transition denial");
  });
  it.each(["all", "scoped"] as const)("explains an empty %s picker without claiming the patient has no appointments", async (visibility) => {
    props.appointmentVisibility = visibility; props.appointments = [];
    await openPicker(); expect(options()).toEqual([""]);
    expect(status()).toContain(visibility === "scoped" ? "قد توجد مواعيد أخرى غير ظاهرة" : "قد توجد مواعيد خارج هذه الصفحة");
    expect(button("تأكيد").props.disabled).toBe(true);
  });
  it.each(["hidden", undefined] as const)("removes an earlier selection and prevents submission after %s authority", async (visibility) => {
    await openPicker(); choose("301"); expect(picker().props.value).toBe("301");
    render({ appointmentVisibility: visibility });
    expect(options()).toEqual([""]); expect(picker().props.value).toBe(""); expect(button("تأكيد").props.disabled).toBe(true);
    await click("تأكيد"); expect(posts()).toHaveLength(0);
  });
  it("blocks a removed selection and a forged option even while calendar reading remains allowed", async () => {
    await openPicker(); choose("301"); render({ appointments: [] });
    expect(picker().props.value).toBe(""); await click("تأكيد"); expect(posts()).toHaveLength(0);
    render({ appointments: [appointment] }); choose("999");
    expect(picker().props.value).toBe(""); expect(button("تأكيد").props.disabled).toBe(true);
    await click("تأكيد"); expect(posts()).toHaveLength(0);
  });
  it("does not block unrelated referral actions or infer new issuance authority from calendar visibility", async () => {
    props.appointmentVisibility = "hidden"; render(); await settle(); render();
    expect(render().text).not.toContain("+ إحالة جديدة");
    await click("إنهاء الإحالة"); expect(button("تأكيد").props.disabled).toBe(false);
    await click("تأكيد"); expect(JSON.parse(posts()[0][1].body as string).action).toBe("complete");
    expect(render().text).toContain("Synthetic server transition denial");
  });
});

describe("referral-card joined appointment metadata", () => {
  function response(fields: Record<string, unknown>) {
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, status: 200,
      json: async () => url.endsWith("/referrals") ? [{ ...referral, ...fields }] : [],
    }));
  }
  it.each(["hidden", "unknown", undefined] as const)("keeps %s metadata uncertain even when stale joined fields arrive", async (visibility) => {
    response({ appointmentVisibility: visibility, appointmentId: 301, appointmentDate: "2026-10-04 09:00", missedAppointment: "no_show",
      outcomeNote: "Synthetic preserved outcome", procedurePerformed: "Synthetic preserved procedure" });
    render(); await settle(); const view = render();
    expect(view.text).not.toContain("2026-10-04");
    expect(view.text).not.toContain("لم يُحجز موعد بعد");
    expect(view.text).not.toContain("أعد الحجز");
    expect(view.text).toContain(visibility === "hidden" ? "محجوبة" : "غير مؤكدة");
    expect(view.text).toContain("Synthetic referral");
    expect(view.text).toContain("Synthetic preserved outcome");
    expect(view.text).toContain("Synthetic preserved procedure");
    expect(view.text).toContain("قُبلت — بانتظار الحجز");
    expect(button("إنهاء الإحالة")).toBeDefined();
    expect(posts()).toHaveLength(0);
  });
  it("does not translate a scoped empty metadata projection into an unbooked referral", async () => {
    response({ appointmentVisibility: "scoped", appointmentId: null, appointmentDate: null, missedAppointment: null });
    render(); await settle(); const view = render();
    expect(view.text).toContain("قد توجد تفاصيل غير ظاهرة");
    expect(view.text).not.toContain("لم يُحجز موعد بعد");
  });
  it.each(["all", "scoped"] as const)("shows authorized joined metadata for %s independently of the appointment picker page", async (visibility) => {
    props.appointments = [];
    response({ appointmentVisibility: visibility, appointmentId: 301, appointmentDate: "2026-10-04 09:00", missedAppointment: null });
    render(); await settle();
    expect(render().text).toContain("2026-10-04 09:00");
  });
  it("does not infer that a visible missed appointment means no hidden active booking exists", async () => {
    response({ appointmentVisibility: "scoped", appointmentId: null, appointmentDate: null, missedAppointment: "no_show" });
    render(); await settle(); const view = render();
    expect(view.text).toContain("قد توجد تفاصيل مواعيد أخرى غير ظاهرة");
    expect(view.text).not.toContain("أعد الحجز");
    expect(view.text).not.toContain("لم يُحجز موعد بعد");
  });
  it("retains the absence statement for a full-calendar reader with no linked booking", async () => {
    response({ appointmentVisibility: "all", appointmentId: null, appointmentDate: null, missedAppointment: null });
    render(); await settle();
    expect(render().text).toContain("لم يُحجز موعد بعد");
  });
});
