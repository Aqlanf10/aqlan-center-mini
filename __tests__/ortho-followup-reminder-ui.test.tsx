import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OrthoFollowupPage from "../app/ortho/page";
import { QuickAppointmentModal } from "../components/QuickAppointmentModal";
import { BUCKET_LABEL, BUCKET_ORDER, type FollowupBucket, type FollowupRow } from "../lib/ortho-followup";
import { friendlyDate, friendlyDateLong, friendlyTime, reminderText, unbookedFollowupText } from "../lib/reminders";

// Actual board output and booking-success callback, with synthetic hook storage.
// Leaf components do not execute. Fetch is mocked; links are inspected, never opened.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false,
  memos: new Map<number, { value: unknown; deps?: readonly unknown[] }>(),
  effects: new Map<number, readonly unknown[] | undefined>(),
  pending: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (compute: () => unknown, deps?: readonly unknown[]) => {
    const index = hooks.cursor++; const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = compute(); hooks.memos.set(index, { value, deps }); return value;
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[index], (update: unknown) => {
        const value = typeof update === "function" ? update(hooks.values[index]) : update;
        if (!Object.is(value, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = value;
      }];
    },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void, deps?: readonly unknown[]) => {
      const index = hooks.cursor++;
      if (hooks.effects.has(index) && same(hooks.effects.get(index), deps)) return;
      hooks.effects.set(index, deps); hooks.pending.push(effect);
    },
  };
});
vi.mock("../components/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("../components/OrthoPendingDecisions", () => ({ OrthoPendingDecisions: () => null }));
vi.mock("../components/QuickAppointmentModal", () => ({ QuickAppointmentModal: () => null }));

type Element = ReactElement<Record<string, unknown>>;
const TODAY = "2026-10-05";
const verifiedContext = (): NonNullable<FollowupRow["bookingContext"]> => ({
  verified: true, pastUnresolvedAppointment: null, reviewAppointments: [], otherAppointments: [],
});
const fixture = (changes: Partial<FollowupRow> = {}): FollowupRow => ({
  caseId: 41, patientId: 19, patientName: "مريض & تجريبي", patientPhone: "770123456",
  status: "active", phase: "finishing", startDate: "2025-01-01",
  lastAdjustmentDate: "2026-07-01", nextWeeks: 4, upperWire: null, lowerWire: null,
  nextAppointment: null, lastWasNoShow: false, buckets: ["no_appointment", "lapsed_8"],
  bookingContext: verifiedContext(),
  dueDate: "2026-07-29", daysSinceLast: 96, ...changes,
});
const booked = (status = "booked"): FollowupRow => fixture({
  buckets: ["this_week", "lapsed_8"],
  nextAppointment: { id: 31, date: "2026-10-08", time: "10:30", status },
});
const feed = (input: FollowupRow | FollowupRow[], today = TODAY) => {
  const rows = Array.isArray(input) ? input : [input];
  return { today, buckets: BUCKET_ORDER.map((bucket) => {
    const matches = rows.filter((row) => row.buckets.includes(bucket));
    return { bucket, count: matches.length, rows: matches };
  }) };
};
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children as ReactNode);
  return "";
}
function render(): ReactNode {
  let tree: ReactNode = null; let rounds = 0;
  do {
    if (++rounds > 12) throw new Error("Synthetic board render did not settle");
    hooks.cursor = 0; hooks.changed = false;
    tree = OrthoFollowupPage();
    hooks.pending.splice(0).forEach((effect) => effect());
  } while (hooks.changed);
  return tree;
}
async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
function selectBucket(bucket: FollowupBucket) {
  const button = elements(render()).find((node) => node.type === "button" && text(node).startsWith(BUCKET_LABEL[bucket]));
  expect(button).toBeDefined();
  (button!.props.onClick as () => void)();
}
function links(tree: ReactNode = render()) {
  return elements(tree).filter((node) => node.type === "a"
    && typeof node.props.href === "string" && node.props.href.startsWith("https://wa.me/"));
}
function decodedMessage() {
  const matches = links(); expect(matches).toHaveLength(1);
  const url = new URL(matches[0].props.href as string);
  expect(url.pathname).toBe("/967770123456");
  return url.searchParams.get("text");
}
function patientRow(patientId: number): Element {
  const row = elements(render()).find((node) => node.type === "li" && elements(node).some(
    (child) => child.type === "a" && child.props.href === `/patients/${patientId}`,
  ));
  expect(row).toBeDefined();
  return row!;
}
function appointmentDayLinks(tree: ReactNode): Element[] {
  return elements(tree).filter((node) => node.type === "a"
    && typeof node.props.href === "string" && node.props.href.startsWith("/appointments?date="));
}
function openBooking(patientId = 19): Element {
  const button = elements(patientRow(patientId)).find((node) => node.type === "button" && text(node).includes("احجز"));
  expect(button).toBeDefined();
  (button!.props.onClick as () => void)();
  const modal = elements(render()).find((node) => node.type === QuickAppointmentModal);
  expect(modal).toBeDefined();
  expect(modal!.props.patientId).toBe(patientId);
  return modal!;
}
function expectReadOnlyFeedRequests(count: number) {
  expect(fetchMock).toHaveBeenCalledTimes(count);
  for (const [url, init] of fetchMock.mock.calls) {
    expect(url).toBe("/api/ortho/followups");
    expect(init).toEqual({ cache: "no-store" });
  }
}
async function openBoard(row: FollowupRow | FollowupRow[], bucket: FollowupBucket = "no_appointment", today = TODAY) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(feed(row, today)), { status: 200 }));
  render(); await settle(); render();
  if (bucket !== "no_appointment") selectBucket(bucket);
}

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.memos.clear(); hooks.effects.clear(); hooks.pending = [];
  fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T09:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("orthodontic board follow-up message", () => {
  it.each(["active", "retention"] as const)("invites an unbooked %s patient without turning a calculated due date into a booking", async (status) => {
    const row = fixture({ status, phase: status === "retention" ? "retention" : "finishing" });
    await openBoard(row);
    const message = decodedMessage();
    expect(message).toBe(unbookedFollowupText(row.patientName));
    for (const fabricated of [row.dueDate, friendlyDate(row.dueDate), "16:00", "4:00", "الساعة", "مكانكم محفوظ", "نذكّركم بموعدكم"]) {
      expect(message).not.toContain(fabricated);
    }
    expect(text(links()[0])).toBe("واتساب لترتيب متابعة");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/ortho/followups", { cache: "no-store" });
  });

  it("also omits a future calculated due date when no appointment is booked", async () => {
    const row = fixture({ dueDate: "2026-11-02", lastAdjustmentDate: TODAY, daysSinceLast: 0, buckets: ["no_appointment"] });
    await openBoard(row);
    expect(decodedMessage()).toBe(unbookedFollowupText(row.patientName));
    expect(decodedMessage()).not.toContain(friendlyDate(row.dueDate));
  });

  it.each(["booked", "arrived"])("preserves the exact existing reminder for an actual %s appointment", async (status) => {
    const row = booked(status); const appointment = row.nextAppointment!;
    await openBoard(row, "this_week");
    expect(decodedMessage()).toBe(reminderText({
      id: appointment.id, patientId: row.patientId, patientName: row.patientName, patientPhone: row.patientPhone,
      scheduledDate: appointment.date, scheduledTime: appointment.time,
      durationMinutes: 15, note: null, status: "booked",
    }, "upcoming"));
    expect(decodedMessage()).toContain("10:30 صباحًا");
    expect(decodedMessage()).not.toContain(friendlyDate(row.dueDate));
    expect(text(links()[0])).toBe("واتساب تذكير");
  });

  it("uses the feed's clinic day for a verified appointment today even when the browser clock is ahead", async () => {
    vi.setSystemTime(new Date("2026-10-10T09:00:00Z"));
    const row = booked();
    await openBoard(row, "this_week", row.nextAppointment!.date);
    expect(decodedMessage()).toContain("نذكّركم بموعدكم");
    expect(decodedMessage()).toContain("10:30 صباحًا");
    expect(text(links()[0])).toBe("واتساب تذكير");
  });

  it("does not promise a future appointment when the feed's clinic day has already passed it", async () => {
    const row = booked();
    await openBoard(row, "this_week", "2026-10-09");
    expect(decodedMessage()).toBe(unbookedFollowupText(row.patientName));
    expect(text(links()[0])).toBe("واتساب لترتيب متابعة");
    expect(text(patientRow(row.patientId))).not.toContain("الموعد المحجوز:");
    expectReadOnlyFeedRequests(1);
  });

  it.each(["cancelled", "done", "no_show"])("does not confirm an inactive %s appointment even if a stale feed puts it in nextAppointment", async (status) => {
    const row = booked(status);
    await openBoard(row, "this_week");
    expect(decodedMessage()).toBe(unbookedFollowupText(row.patientName));
    expect(text(links()[0])).toBe("واتساب لترتيب متابعة");
    expectReadOnlyFeedRequests(1);
  });

  it("shows unrelated and uncertain bookings without representing either as a confirmed periodic follow-up", async () => {
    const other = { id: 81, date: "2026-10-09", time: "09:45", status: "booked",
      serviceName: "تنظيف الأسنان", doctorName: "د. النظافة", appointmentType: "cleaning" };
    const review = { id: 82, date: "2026-10-06", time: "11:20", status: "arrived",
      serviceName: "خدمة غير مصنّفة", doctorName: "د. المراجعة" };
    const row = fixture({ bookingContext: {
      ...verifiedContext(), otherAppointments: [other], reviewAppointments: [review],
    } });
    await openBoard(row);
    const visible = patientRow(row.patientId);
    const description = text(visible);
    expect(description).toContain("لا موعد متابعة تقويم مؤكد");
    expect(description).not.toContain("لا موعد قادم محجوز");
    expect(description).not.toContain("الموعد المحجوز:");
    for (const appointment of [other, review]) {
      for (const detail of [friendlyDateLong(appointment.date), friendlyTime(appointment.time), appointment.serviceName, appointment.doctorName]) {
        expect(description).toContain(detail);
      }
      const dayLink = appointmentDayLinks(visible).find((link) => link.props.href === `/appointments?date=${appointment.date}`);
      expect(dayLink).toBeDefined();
      expect(text(dayLink)).toMatch(/مواعيد|يوم/);
    }
    expect(description).toMatch(/محجوز|booked/);
    expect(description).toMatch(/حضر|وصل|arrived/);
    expect(decodedMessage()).toBe(unbookedFollowupText(row.patientName));
    const actions = elements(visible).filter((node) => node.type === "button" && text(node).includes("احجز")
      || node.type === "a" && typeof node.props.href === "string" && node.props.href.startsWith("/appointments?date="));
    expect(actions[0]?.type).toBe("a");
    expect(actions.some((node) => node.type === "button")).toBe(true);
    expectReadOnlyFeedRequests(1);
  });

  it.each(["booked", "arrived"])("keeps a past unresolved %s visit visible separately and sends only an invitation", async (status) => {
    const past = { id: 83, date: "2026-10-02", time: "14:15", status,
      serviceName: "شد تقويم", doctorName: "د. التقويم", appointmentType: "follow_up" };
    const row = fixture({ buckets: ["overdue", "lapsed_8"], bookingContext: {
      ...verifiedContext(), pastUnresolvedAppointment: past,
    } });
    await openBoard(row, "overdue");
    const visible = patientRow(row.patientId);
    expect(text(visible)).toContain(friendlyDateLong(past.date));
    expect(text(visible)).toContain(friendlyTime(past.time));
    expect(text(visible)).toContain(past.serviceName);
    expect(text(visible)).toContain(past.doctorName);
    expect(text(visible)).toContain("لا موعد متابعة تقويم مؤكد");
    expect(text(visible)).not.toContain("الموعد المحجوز:");
    expect(appointmentDayLinks(visible).some((node) => node.props.href === `/appointments?date=${past.date}`)).toBe(true);
    expect(decodedMessage()).toBe(unbookedFollowupText(row.patientName));
    expect(decodedMessage()).not.toContain(friendlyDate(past.date));
    expect(text(links()[0])).toBe("واتساب لترتيب متابعة");
    expectReadOnlyFeedRequests(1);
  });

  it.each([false, true])("warns rather than asserting appointment absence when context is missing (legacy nextAppointment: %s)", async (hasLegacyAppointment) => {
    const row = hasLegacyAppointment ? booked() : fixture();
    delete row.bookingContext;
    await openBoard(row, hasLegacyAppointment ? "this_week" : "no_appointment");
    const description = text(patientRow(row.patientId));
    expect(description).toContain("تعذّر التحقق من سياق المواعيد");
    expect(description).not.toContain("لا موعد قادم محجوز");
    expect(description).not.toContain("لا موعد متابعة تقويم مؤكد");
    expect(description).not.toContain("الموعد المحجوز:");
    expect(decodedMessage()).toBe(unbookedFollowupText(row.patientName));
    expectReadOnlyFeedRequests(1);
  });

  it("keeps patient details, appointment-day links, and WhatsApp destinations isolated across two rows", async () => {
    const first = fixture({ bookingContext: { ...verifiedContext(), otherAppointments: [
      { id: 84, date: "2026-10-07", time: "08:30", status: "booked", serviceName: "تنظيف المريض الأول" },
    ] } });
    const second = fixture({ caseId: 42, patientId: 20, patientName: "المريض الثاني", patientPhone: "777654321",
      bookingContext: { ...verifiedContext(), reviewAppointments: [
        { id: 85, date: "2026-10-12", time: "13:40", status: "arrived", serviceName: "مراجعة المريض الثاني" },
      ] },
    });
    await openBoard([first, second]);
    for (const [row, otherRow, phone, date, otherDate, service, otherService] of [
      [first, second, "/967770123456", "2026-10-07", "2026-10-12", "تنظيف المريض الأول", "مراجعة المريض الثاني"],
      [second, first, "/967777654321", "2026-10-12", "2026-10-07", "مراجعة المريض الثاني", "تنظيف المريض الأول"],
    ] as const) {
      const visible = patientRow(row.patientId);
      expect(text(visible)).toContain(row.patientName);
      expect(text(visible)).not.toContain(otherRow.patientName);
      expect(text(visible)).toContain(service);
      expect(text(visible)).not.toContain(otherService);
      const hrefs = elements(visible).map((node) => node.props.href).filter(Boolean);
      expect(hrefs).toContain(`/patients/${row.patientId}?tab=treatment`);
      expect(hrefs).not.toContain(`/patients/${otherRow.patientId}?tab=treatment`);
      expect(hrefs).toContain(`/appointments?date=${date}`);
      expect(hrefs).not.toContain(`/appointments?date=${otherDate}`);
      const whatsapp = links(visible); expect(whatsapp).toHaveLength(1);
      const url = new URL(whatsapp[0].props.href as string);
      expect(url.pathname).toBe(phone);
      expect(url.searchParams.get("text")).toBe(unbookedFollowupText(row.patientName));
      const modal = openBooking(row.patientId);
      expect(modal.props.patientName).toBe(row.patientName);
      (modal.props.onClose as () => void)(); render();
    }
    expectReadOnlyFeedRequests(1);
  });

  it.each([null, "", "04253028"])("keeps the message link absent for unusable phone %s", async (patientPhone) => {
    await openBoard(fixture({ patientPhone }));
    expect(links()).toHaveLength(0);
  });

  it("switches to the real appointment after the existing booking modal reports success", async () => {
    await openBoard(fixture());
    expect(decodedMessage()).toBe(unbookedFollowupText(fixture().patientName));
    const book = elements(render()).find((node) => node.type === "button" && text(node).includes("احجز"));
    expect(book).toBeDefined(); (book!.props.onClick as () => void)();
    const modal = elements(render()).find((node) => node.type === QuickAppointmentModal);
    expect(modal).toBeDefined(); expect(modal!.props.patientId).toBe(19);
    const row = booked();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(feed(row)), { status: 200 }));
    (modal!.props.onSuccess as () => void)();
    await settle(); selectBucket("this_week");
    expect(decodedMessage()).toContain("نذكّركم بموعدكم");
    expect(decodedMessage()).toContain("10:30 صباحًا");
    expect(text(links()[0])).toBe("واتساب تذكير");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("/api/ortho/followups");
      expect(init).toEqual({ cache: "no-store" });
    }
  });

  it("does not mutate or duplicate context across repeated modal cancel and read-only reload cycles", async () => {
    const appointment = { id: 86, date: "2026-10-11", time: "15:50", status: "booked", serviceName: "حشوة تجميلية" };
    const row = fixture({ bookingContext: { ...verifiedContext(), otherAppointments: [appointment] } });
    const original = JSON.stringify(row);
    await openBoard(row);
    for (let cycle = 0; cycle < 2; cycle++) {
      const cancelled = openBooking();
      (cancelled.props.onClose as () => void)(); render();
      expect(elements(render()).some((node) => node.type === QuickAppointmentModal)).toBe(false);
      expectReadOnlyFeedRequests(cycle + 1);

      const completed = openBooking();
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(feed(row)), { status: 200 }));
      (completed.props.onSuccess as () => void)();
      await settle(); render();
      expect(elements(render()).some((node) => node.type === QuickAppointmentModal)).toBe(false);
      expect(elements(render()).filter((node) => node.type === "a" && node.props.href === `/patients/${row.patientId}`)).toHaveLength(1);
      expect(decodedMessage()).toBe(unbookedFollowupText(row.patientName));
      expect(text(patientRow(row.patientId)).split(appointment.serviceName)).toHaveLength(2);
      expectReadOnlyFeedRequests(cycle + 2);
    }
    expect(JSON.stringify(row)).toBe(original);
  });
});
