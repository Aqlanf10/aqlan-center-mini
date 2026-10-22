import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppointmentsPage from "../app/appointments/page";

// Real rendered handlers with synthetic transport. This is not browser acceptance.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
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
    useEffect: (fn: () => void, deps: unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.values[index] as unknown[] | undefined;
      if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) {
        hooks.values[index] = deps;
        hooks.effects.push(fn);
      }
    },
    useLayoutEffect: (fn: () => void, deps: unknown[]) => {
      const index = slot(undefined);
      const previous = hooks.values[index] as unknown[] | undefined;
      if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) {
        hooks.values[index] = deps;
        hooks.effects.push(fn);
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
function render() {
  hooks.cursor = 0;
  const all = elements(AppointmentsPage());
  const effects = hooks.effects.splice(0);
  effects.forEach((effect) => effect());
  return all;
}
function find(predicate: (node: Element) => boolean) {
  const node = render().find(predicate);
  if (!node) throw new Error("Missing rendered control");
  return node;
}
function click(label: string) {
  return (find((node) => node.type === "button" && text(node.props.children as ReactNode).trim() === label).props.onClick as () => Promise<void>)();
}
function changeDate(date: string) {
  (find((node) => node.type === "input" && node.props.type === "date").props.onChange as (e: unknown) => void)({ target: { value: date } });
  render();
}
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
const day = "2026-10-22";
const nextDay = "2026-10-23";
const appointment = { id: 7, patientId: 31, patientName: "Synthetic booked patient", patientPhone: null,
  scheduledDate: day, scheduledTime: "10:00", durationMinutes: 30, status: "booked", doctorId: 9,
  doctorName: "Synthetic doctor", serviceId: 4, appointmentType: "consultation" };
const slot = { date: day, time: "10:00", durationMinutes: 30, doctorId: 9, serviceId: 4 };
const candidate = { id: 41, patientId: 32, patientName: "Synthetic waiting patient", status: "waiting", urgency: "normal" };
const candidateResponse = () => response({ slot, candidates: [candidate] });
const fetchMock = vi.fn();
let lookup: ReturnType<typeof deferred<ReturnType<typeof response>>>;
let write: ReturnType<typeof deferred<ReturnType<typeof response>>>;
let listReads: string[];
beforeEach(async () => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = [];
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T21:30:00Z")); // Already Oct 22 in Asia/Aden.
  vi.stubGlobal("window", { location: { search: `?date=${day}` } });
  lookup = deferred(); write = deferred(); listReads = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/appointments?")) { listReads.push(url); return response(url.endsWith(day) ? [appointment] : []); }
    if (url.startsWith("/api/parties")) return response([]);
    if (url.startsWith("/api/waiting-list?")) return lookup.promise;
    if (url === "/api/waiting-list/41") return write.promise;
    if (url === "/api/appointments/7" && init?.method === "PATCH") return response({ ok: true });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(); render(); await flush();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function showCandidates() {
  await click("لم يحضر"); lookup.resolve(candidateResponse()); await flush();
  expect(render().some((node) => node.props["data-candidate"] === 41)).toBe(true);
}
describe("freed appointment candidate context", () => {
  it("retires candidate lookups when navigating away and back to the same clinic date", async () => {
    await click("لم يحضر");
    changeDate(nextDay); changeDate(day);
    lookup.resolve(candidateResponse()); await flush();
    expect(render().some((node) => node.props["data-candidate"] === 41)).toBe(false);
  });
  it("removes a visible prior-day slot when changing the displayed date", async () => {
    await showCandidates(); changeDate(nextDay); await flush();
    expect(render().some((node) => node.props["data-candidate"] === 41)).toBe(false);
  });
  it("admits only one candidate action before rerender and preserves slot identity", async () => {
    await showCandidates();
    const button = find((node) => node.props["data-action"] === "book-candidate");
    const submit = button.props.onClick as () => void;
    submit(); submit();
    const writes = fetchMock.mock.calls.filter(([url]) => url === "/api/waiting-list/41");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0][1].body)).toEqual({ action: "book", ...slot });
    write.resolve(response({ ok: true })); await flush();
  });
  it("refreshes the current day rather than the booking's captured day", async () => {
    await showCandidates();
    (find((node) => node.props["data-action"] === "book-candidate").props.onClick as () => void)();
    changeDate(nextDay); await flush(); listReads = [];
    write.resolve(response({ ok: true })); await flush();
    expect(listReads.length).toBeGreaterThan(0);
    expect(listReads.every((url) => url.endsWith(nextDay))).toBe(true);
  });
  it("keeps the newer freed slot when lookups finish out of order", async () => {
    const first = lookup;
    await click("لم يحضر");
    lookup = deferred();
    await click("لم يحضر");
    lookup.resolve(response({ slot: { ...slot, time: "11:00" }, candidates: [candidate] })); await flush();
    first.resolve(candidateResponse()); await flush();
    expect(render().find((node) => node.props["data-freed-slot"])?.props["data-freed-slot"]).toBe("11:00");
  });
  it("does not write an old action's success into a newer slot panel", async () => {
    await showCandidates();
    (find((node) => node.props["data-action"] === "book-candidate").props.onClick as () => void)();
    lookup = deferred();
    await click("لم يحضر");
    lookup.resolve(response({ slot: { ...slot, time: "11:00" }, candidates: [candidate] })); await flush();
    write.resolve(response({ ok: true })); await flush();
    expect(render().some((node) => node.props["data-candidate"] === 41)).toBe(true);
    expect(render().some((node) => node.props.role === "status" && text(node.props.children as ReactNode).includes("حُجز الموعد"))).toBe(false);
  });
  it("keeps a dismissed panel closed after the pending action finishes", async () => {
    await showCandidates();
    (find((node) => node.props["data-action"] === "book-candidate").props.onClick as () => void)();
    (find((node) => node.props["aria-label"] === "إخفاء").props.onClick as () => void)();
    write.resolve(response({ ok: true })); await flush();
    expect(render().some((node) => node.props["data-freed-slot"])).toBe(false);
  });
  it("releases the lock after a refused request and retains the candidate for explicit retry", async () => {
    await showCandidates();
    (find((node) => node.props["data-action"] === "book-candidate").props.onClick as () => void)();
    expect(find((node) => node.props["data-action"] === "candidate-no-answer").props.disabled).toBe(true);
    write.resolve(response({ message: "Synthetic refusal" }, false)); await flush();
    expect(find((node) => node.props["data-action"] === "book-candidate").props.disabled).toBe(false);
    expect(render().some((node) => node.props.role === "status" && text(node.props.children as ReactNode) === "Synthetic refusal")).toBe(true);
    write = deferred();
    (find((node) => node.props["data-action"] === "book-candidate").props.onClick as () => void)();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/waiting-list/41")).toHaveLength(2);
    write.resolve(response({ ok: true })); await flush();
  });

  it.each(["date", "replacement", "dismissal"])("rejects a captured booking handler after %s changes its context", async (change) => {
    await showCandidates();
    const stale = find((node) => node.props["data-action"] === "book-candidate").props.onClick as () => void;
    if (change === "date") changeDate(nextDay);
    else if (change === "replacement") {
      lookup = deferred(); await click("لم يحضر");
      lookup.resolve(response({ slot: { ...slot, time: "11:00" }, candidates: [candidate] })); await flush();
    } else (find((node) => node.props["aria-label"] === "إخفاء").props.onClick as () => void)();
    stale(); await flush();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/waiting-list/41")).toHaveLength(0);
  });

});
