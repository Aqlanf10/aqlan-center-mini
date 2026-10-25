import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppointmentReminder } from "../components/AppointmentReminder";
import type { Appointment } from "../lib/schedule";
import type { ManualAppointmentReminderSnapshot } from "../lib/manual-appointment-reminder";
import { friendlyDateLong, friendlyTime } from "../lib/reminders";

// Rendered component handlers with synthetic hooks. No browser, patient data, or delivery.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, effects: [] as (() => void)[], cleanups: new Map<number, () => void>(),
  session: { username: "synthetic-reception", role: "reception" } as { username: string; role: string; permissions?: object } | null,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = () => hooks.cursor++;
  return { ...react,
    useRef: (initial: unknown) => {
      const index = slot();
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => {
      const index = slot();
      const previous = hooks.values[index] as { value: unknown; deps: unknown[] } | undefined;
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) hooks.values[index] = { value: fn(), deps };
      return (hooks.values[index] as { value: unknown }).value;
    },
    useLayoutEffect: (fn: () => void | (() => void), deps: unknown[]) => {
      const index = slot(); const previous = hooks.values[index] as unknown[] | undefined;
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
vi.mock("@/components/SessionProvider", () => ({ useSession: () => hooks.session }));
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
  return node && typeof node === "object" && "props" in node ? text((node as Element).props.children as ReactNode) : "";
}
const fixture = (): Appointment => ({
  id: 7, patientId: 31, patientName: "Synthetic reminder patient", patientPhone: "770123456",
  scheduledDate: "2026-10-22", scheduledTime: "10:00", durationMinutes: 30, status: "booked", note: null,
});
let item: Appointment;
let busy: boolean;
let clinicTimeZone: string | undefined;
const isCurrent = vi.fn<() => boolean>();
const onConfirmed = vi.fn<(snapshot: ManualAppointmentReminderSnapshot) => Promise<void>>();
const confirmMock = vi.fn<() => boolean>();
function render() {
  hooks.cursor = 0;
  const tree = AppointmentReminder({ item, busy, isCurrent, onConfirmed, clinicTimeZone });
  hooks.effects.splice(0).forEach((effect) => effect());
  return tree;
}
function draft() { return elements(render()).find((node) => node.type === "a")!; }
function confirmHandler() {
  const control = elements(render()).find((node) => node.props["data-action"] === "confirm-manual-reminder")!;
  return control.props.onClick as () => Promise<void>;
}
function openDraft() {
  const event = { preventDefault: vi.fn() };
  (draft().props.onClick as (event: unknown) => void)(event);
  return event;
}
function unmount() { hooks.cleanups.forEach((cleanup) => cleanup()); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.cleanups.clear();
  hooks.session = { username: "synthetic-reception", role: "reception" };
  item = fixture(); busy = false; clinicTimeZone = undefined;
  isCurrent.mockReset().mockReturnValue(true);
  onConfirmed.mockReset().mockResolvedValue(undefined);
  confirmMock.mockReset().mockReturnValue(true);
  vi.stubGlobal("window", { confirm: confirmMock });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-22T06:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("manual appointment reminder confirmation", () => {
  it("restores the compact green draft and adds only the short staff confirmation control", () => {
    const tree = render();
    const all = elements(tree);
    expect(tree!.props.className).toBe("inline-flex max-w-full flex-wrap items-center gap-1.5");
    expect(text(draft())).toBe("💬 تذكير واتساب");
    expect(draft().props.className).toContain("bg-[#25D366] text-white");
    expect(draft().props["aria-label"]).toContain("فتح مسودة");
    const buttons = all.filter(node => node.type === "button");
    expect(buttons).toHaveLength(1);
    expect(text(buttons[0])).toBe("تأكيد الموظف");
    expect(buttons[0].props["aria-label"]).toContain(item.patientName);
    const help = all.find(node => node.props.id === draft().props["aria-describedby"]);
    expect(help!.props.className).toBe("sr-only");
    expect(buttons[0].props["aria-describedby"]).toBe(help!.props.id);
    expect(text(help)).toContain("ليس إثبات تسليم");
    expect(all.some(node => String(node.props.className).split(" ").includes("w-full"))).toBe(false);
  });

  it.each([
    ["2026-10-21T06:00:00Z", "ذُكِّر ✓"],
    ["2026-10-22T05:00:00Z", "إعادة تذكير؟"],
  ])("keeps the original recorded-state label and clinic timestamp for %s", (timestamp, label) => {
    item = { ...item, reminderSentAt: timestamp };
    expect(text(draft())).toBe(label);
    expect(draft().props.className).toContain("border-emerald-300 bg-emerald-50 text-emerald-700");
    expect(draft().props.title).toContain("آخر تذكير مسجّل:");
    expect(draft().props["aria-label"]).toContain("فتح مسودة");
    expect(draft().props["aria-label"]).toContain(label);
    expect(onConfirmed).not.toHaveBeenCalled();
  });
  it("only prepares a WhatsApp draft, with no confirmation, mutation, or success claim", () => {
    const url = new URL(draft().props.href as string);
    expect(url.hostname).toBe("wa.me"); expect(url.pathname).toBe("/967770123456");
    expect(url.searchParams.get("text")).toContain(item.patientName);
    expect(openDraft().preventDefault).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled(); expect(onConfirmed).not.toHaveBeenCalled();
    expect(text(render())).toContain("فتح المسودة لا يسجّل تذكيرًا");
    expect(draft().props.title).not.toContain("آخر تذكير مسجّل");
    // Opening, canceling in WhatsApp, or a blocked popup leaves the same retry link.
    expect(draft().props.href).toBe(url.toString());
    openDraft(); expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("does not stamp when staff cancels the explicit confirmation", async () => {
    openDraft(); confirmMock.mockReturnValue(false);
    await confirmHandler()(); expect(onConfirmed).not.toHaveBeenCalled();
    expect(draft().props.title).not.toContain("آخر تذكير مسجّل");
    expect(draft()).toBeDefined();
  });

  it("records only the explicit staff attestation, identifying patient and appointment", async () => {
    await confirmHandler()();
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(confirmMock.mock.calls[0]).toEqual([expect.stringContaining(item.patientName)]);
    expect(confirmMock.mock.calls[0]).toEqual([expect.stringContaining("ليس إثبات تسليم آلي")]);
    expect(onConfirmed).toHaveBeenCalledExactlyOnceWith({
      patientId: item.patientId, patientName: item.patientName, patientPhone: item.patientPhone,
      scheduledDate: item.scheduledDate, scheduledTime: item.scheduledTime, status: item.status,
    });
    // No optimistic stamp: only a refreshed server value can show it.
    expect(draft().props.title).not.toContain("آخر تذكير مسجّل");
    item = { ...item, reminderSentAt: "2026-10-22T06:00:00Z" };
    expect(draft().props.title).toContain("آخر تذكير مسجّل");
    expect(text(render())).not.toContain("تم التسليم");
  });

  it("permits an explicit actual-contact attestation without a valid WhatsApp number", async () => {
    item = { ...item, patientPhone: null };
    expect(draft()).toBeUndefined();
    expect(text(render())).toContain("بلا رقم");
    expect(elements(render()).some(node => node.props.title === "بلا رقم واتساب صالح")).toBe(true);
    await confirmHandler()(); expect(onConfirmed).toHaveBeenCalledOnce();
  });

  it("does not invent success on failed recording and permits an explicit retry", async () => {
    onConfirmed.mockRejectedValueOnce(new Error("Synthetic failure"));
    await expect(confirmHandler()()).rejects.toThrow("Synthetic failure");
    expect(draft().props.title).not.toContain("آخر تذكير مسجّل");
    await confirmHandler()(); expect(onConfirmed).toHaveBeenCalledTimes(2);
  });

  it("admits one confirmation while recording is pending", async () => {
    const pending = deferred<void>(); onConfirmed.mockReturnValue(pending.promise);
    const confirm = confirmHandler(); const first = confirm(); await confirm();
    expect(onConfirmed).toHaveBeenCalledOnce(); expect(confirmMock).toHaveBeenCalledOnce();
    expect(openDraft().preventDefault).toHaveBeenCalledOnce();
    pending.resolve(); await first;
  });

  it("keeps the 12-hour draft warning separate from staff confirmation", async () => {
    item = { ...item, reminderSentAt: "2026-10-22T05:00:00Z" };
    confirmMock.mockReturnValue(false);
    expect(openDraft().preventDefault).toHaveBeenCalledOnce();
    expect(onConfirmed).not.toHaveBeenCalled();
    confirmMock.mockReturnValue(true);
    expect(openDraft().preventDefault).not.toHaveBeenCalled();
    expect(onConfirmed).not.toHaveBeenCalled();
    await confirmHandler()(); expect(onConfirmed).toHaveBeenCalledOnce();
  });

  it.each(["cancelled", "arrived", "done"])("offers no reminders for %s appointments", (status) => {
    item = { ...item, status: status as Appointment["status"] };
    expect(render()).toBeNull();
  });

  it("supports honest missed-appointment contact without altering the reminder flow", async () => {
    item = { ...item, status: "no_show" };
    expect(new URL(draft().props.href as string).searchParams.get("text")).toContain(item.patientName);
    openDraft(); expect(onConfirmed).not.toHaveBeenCalled();
    await confirmHandler()(); expect(onConfirmed).toHaveBeenCalledOnce();
  });

  it("rejects a retired parent date/request before opening a prompt or draft", async () => {
    const confirm = confirmHandler(); isCurrent.mockReturnValue(false);
    await confirm(); expect(confirmMock).not.toHaveBeenCalled(); expect(onConfirmed).not.toHaveBeenCalled();
    expect(openDraft().preventDefault).toHaveBeenCalledOnce();
  });

  it("rechecks ownership after the native prompt closes", async () => {
    confirmMock.mockImplementation(() => { isCurrent.mockReturnValue(false); return true; });
    await confirmHandler()(); expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("rejects captured handlers after unmount", async () => {
    const confirm = confirmHandler(); const link = draft(); unmount();
    await confirm(); expect(onConfirmed).not.toHaveBeenCalled(); expect(confirmMock).not.toHaveBeenCalled();
    const event = { preventDefault: vi.fn() };
    (link.props.onClick as (e: unknown) => void)(event); expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it.each([
    { id: 8 }, { patientId: 32 }, { scheduledDate: "2026-10-23" }, { scheduledTime: "11:00" },
    { patientName: "Synthetic renamed patient" }, { patientPhone: "771123456" }, { status: "no_show" }, { reminderSentAt: "2026-10-22T06:00:00Z" },
  ])("retires a handler when appointment context changes: %j", async (change) => {
    const old = confirmHandler(); item = { ...item, ...change } as Appointment; render();
    await old(); expect(onConfirmed).not.toHaveBeenCalled(); expect(confirmMock).not.toHaveBeenCalled();
    item = fixture(); render(); await old(); expect(onConfirmed).not.toHaveBeenCalled();
    await confirmHandler()(); expect(onConfirmed).toHaveBeenCalledOnce();
  });

  it.each(["logout", "account", "role", "permissions"])("retires captured confirmation on session %s and after returning", async (kind) => {
    const old = confirmHandler(); const original = hooks.session;
    if (kind === "logout") hooks.session = null;
    else hooks.session = { ...original!, ...(kind === "account" ? { username: "synthetic-other" }
      : kind === "role" ? { role: "doctor" } : { permissions: { canOverrideCapacity: true } }) };
    render(); await old(); expect(onConfirmed).not.toHaveBeenCalled(); expect(confirmMock).not.toHaveBeenCalled();
    hooks.session = original; render(); await old(); expect(onConfirmed).not.toHaveBeenCalled();
    await confirmHandler()(); expect(onConfirmed).toHaveBeenCalledOnce();
  });

  it("disables draft and staff confirmation while busy or logged out", async () => {
    busy = true; expect(draft().props.href).toBeUndefined();
    await confirmHandler()(); expect(onConfirmed).not.toHaveBeenCalled();
    busy = false; hooks.session = null; expect(draft().props.href).toBeUndefined();
    await confirmHandler()(); expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("retires handlers on a same-claims replacement session without an intermediate logout render", async () => {
    const old = confirmHandler(); const link = draft();
    hooks.session = { ...hooks.session! }; render();
    await old(); expect(onConfirmed).not.toHaveBeenCalled(); expect(confirmMock).not.toHaveBeenCalled();
    const event = { preventDefault: vi.fn() };
    (link.props.onClick as (e: unknown) => void)(event); expect(event.preventDefault).toHaveBeenCalledOnce();
    await confirmHandler()(); expect(onConfirmed).toHaveBeenCalledOnce();
  });

  it("rejects a native prompt completed after same-claims session replacement", async () => {
    confirmMock.mockImplementation(() => { hooks.session = { ...hooks.session! }; render(); return true; });
    await confirmHandler()(); expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("renders a stored reminder timestamp in the clinic zone across the UTC date boundary", () => {
    item = { ...item, reminderSentAt: "2026-10-22T22:30:00Z" };
    const stamp = elements(render()).find((node) => typeof node.props.title === "string");
    expect(stamp!.props.title).toBe(`آخر تذكير مسجّل: ${friendlyDateLong("2026-10-23")} · ${friendlyTime("01:30")}`);
  });

  it("uses the supplied canonical clinic zone rather than the fallback or device zone", () => {
    clinicTimeZone = "America/Los_Angeles";
    item = { ...item, reminderSentAt: "2026-10-22T22:30:00Z" };
    const stamp = elements(render()).find((node) => typeof node.props.title === "string");
    expect(stamp!.props.title).toBe(`آخر تذكير مسجّل: ${friendlyDateLong("2026-10-22")} · ${friendlyTime("15:30")}`);
  });

  it("retires captured confirmation when the displayed clinic zone changes", async () => {
    const old = confirmHandler(); clinicTimeZone = "America/Los_Angeles"; render();
    await old(); expect(onConfirmed).not.toHaveBeenCalled();
    clinicTimeZone = undefined; render(); await old(); expect(onConfirmed).not.toHaveBeenCalled();
    await confirmHandler()(); expect(onConfirmed).toHaveBeenCalledOnce();
  });
});
