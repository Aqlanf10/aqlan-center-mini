import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OrthoFollowupPage from "../app/ortho/page";
import { QuickAppointmentModal } from "../components/QuickAppointmentModal";
import { BUCKET_LABEL, BUCKET_ORDER, type FollowupBucket, type FollowupRow } from "../lib/ortho-followup";
import { friendlyDate, reminderText, unbookedFollowupText } from "../lib/reminders";

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
const fixture = (changes: Partial<FollowupRow> = {}): FollowupRow => ({
  caseId: 41, patientId: 19, patientName: "مريض & تجريبي", patientPhone: "770123456",
  status: "active", phase: "finishing", startDate: "2025-01-01",
  lastAdjustmentDate: "2026-07-01", nextWeeks: 4, upperWire: null, lowerWire: null,
  nextAppointment: null, lastWasNoShow: false, buckets: ["no_appointment", "lapsed_8"],
  dueDate: "2026-07-29", daysSinceLast: 96, ...changes,
});
const booked = (status = "booked"): FollowupRow => fixture({
  buckets: ["this_week", "lapsed_8"],
  nextAppointment: { id: 31, date: "2026-10-08", time: "10:30", status },
});
const feed = (row: FollowupRow) => ({
  today: TODAY,
  buckets: BUCKET_ORDER.map((bucket) => ({ bucket,
    count: row.buckets.includes(bucket) ? 1 : 0,
    rows: row.buckets.includes(bucket) ? [row] : [],
  })),
});
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
function links() {
  return elements(render()).filter((node) => node.type === "a"
    && typeof node.props.href === "string" && node.props.href.startsWith("https://wa.me/"));
}
function decodedMessage() {
  const matches = links(); expect(matches).toHaveLength(1);
  const url = new URL(matches[0].props.href as string);
  expect(url.pathname).toBe("/967770123456");
  return url.searchParams.get("text");
}
async function openBoard(row: FollowupRow, bucket: FollowupBucket = "no_appointment") {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(feed(row)), { status: 200 }));
  render(); await settle(); render();
  if (bucket !== "no_appointment") selectBucket(bucket);
}

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false;
  hooks.memos.clear(); hooks.effects.clear(); hooks.pending = [];
  fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

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
});
