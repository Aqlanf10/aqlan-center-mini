import type { DependencyList, EffectCallback, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAppointmentModal } from "../components/QuickAppointmentModal";

// Tests only. Run the real component's state, effects, cleanup and rendered event
// handlers with manually committed React hooks. No DOM/window, app, API route,
// database, bootstrap, or live fetch is imported/executed.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, effectCursor: 0, dirty: false,
  effects: [] as { deps?: DependencyList; cleanup?: ReturnType<EffectCallback> }[],
  pending: [] as { index: number; deps?: DependencyList; run: EffectCallback }[],
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  function slot(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  }
  return {
    ...react,
    useId: () => "booking-default-audit",
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => {
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.dirty = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useEffect: (run: EffectCallback, deps?: DependencyList) => {
      const index = hooks.effectCursor++;
      const previous = hooks.effects[index];
      if (!previous || !deps || !previous.deps || deps.length !== previous.deps.length ||
        deps.some((value, position) => !Object.is(value, previous.deps![position]))) {
        hooks.pending.push({ index, deps, run });
      }
    },
  };
});
// Modal's native dialog/window effects are outside this isolated hook audit.
vi.mock("../components/Modal", () => ({ Modal: () => null }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status, json: async () => body,
});
const fetchMock = vi.fn();
const onClose = vi.fn();
const onSuccess = vi.fn();
let open = true;
let intent: "ortho_follow_up" | undefined = "ortho_follow_up";
function render() {
  let tree: ReturnType<typeof QuickAppointmentModal>;
  let commits = 0;
  do {
    if (commits++ > 10) throw new Error("Unexpected render loop in hook harness");
    hooks.dirty = false;
    hooks.cursor = 0;
    hooks.effectCursor = 0;
    hooks.pending = [];
    tree = QuickAppointmentModal({ ...{ bookingIntent: intent }, patientId: 91001, patientName: "Synthetic followup patient", isOpen: open, onClose, onSuccess });
    for (const { index, deps, run } of hooks.pending) {
      const oldCleanup = hooks.effects[index]?.cleanup;
      if (typeof oldCleanup === "function") oldCleanup();
      hooks.effects[index] = { deps, cleanup: run() };
    }
  } while (hooks.dirty);
  const all = elements(tree);
  return {
    tree, all,
    find: (predicate: (element: Element) => boolean) => {
      const found = all.find(predicate);
      if (!found) throw new Error("Missing rendered control");
      return found;
    },
    results: () => all.filter((element) => element.type === "li")
      .map((li) => elements(li).find((element) => element.type === "button")!),
    submit: () => (all.find((element) => element.type === "form")!.props.onSubmit as
      (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: vi.fn() }),
  };
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children as ReactNode);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function click(element: Element) { (element.props.onClick as () => void)(); }
function field(id: string) { return render().find((node) => node.props.id === `booking-default-audit-${id}`); }
function change(id: string, value: string) { (field(id).props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); render(); }
const catalog = () => ({ id: 81001, code: "ORTHO_FOLLOW_UP", specialty: "orthodontics", legacyType: "follow_up", nameAr: "متابعة تقويم مسجلة", nameEn: null,
  defaultDurationMinutes: 10, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, requiresChair: true, requiresProvider: true,
  allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, priority: 50, badgeClass: null, isActive: true,
  sortOrder: 1, createdAt: "2026-01-01", createdBy: null, updatedAt: "2026-01-01", updatedBy: null });
let serviceRequest: ReturnType<typeof deferred<ReturnType<typeof response>>>;
const bookings = () => fetchMock.mock.calls.filter(([url, init]) => url === "/api/appointments" && init?.method === "POST");
const payload = () => JSON.parse(bookings().at(-1)![1].body);
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); return render(); }
async function services(rows: ReturnType<typeof catalog>[], status = 200) { serviceRequest.resolve(response(status, { services: rows, chairs: 2 })); await settle(); }
function selected() { return render().all.filter((node) => node.type === "button" && node.props["aria-pressed"] === true).map(text); }
function cleanup() { for (const effect of hooks.effects) if (typeof effect.cleanup === "function") effect.cleanup(); }
function resetHooks() { hooks.values = []; hooks.cursor = 0; hooks.effectCursor = 0; hooks.effects = []; hooks.pending = []; hooks.dirty = false; }
beforeEach(() => {
  resetHooks(); open = true; intent = "ortho_follow_up"; vi.clearAllMocks();
  serviceRequest = deferred(); vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/parties?kind=doctor") return Promise.resolve(response(200, []));
    if (url === "/api/settings/appointment-services") return serviceRequest.promise;
    if (url === "/api/appointments" && init?.method === "POST") return Promise.resolve(response(201, { id: 92001 }));
    throw new Error(`Unexpected mocked fetch: ${url}`);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("explicit board follow-up booking intent", () => {
  it("shows the existing follow_up proposal but refuses an untouched submission before a service is verified", async () => {
    expect(selected()).toEqual([expect.stringContaining("متابعة دورية")]);
    expect(field("duration").props.value).toBe("15");
    expect(render().find((node) => node.props.type === "submit").props.disabled).toBe(true);
    await render().submit();
    expect(bookings()).toEqual([]);
    expect(text(render().tree)).toContain("تعذّر تأكيد خدمة متابعة التقويم");
  });
  it.each(["follow_up", null])("selects the actual eligible catalogue service and its exact duration (legacy %s)", async (legacyType) => {
    render(); const row = { ...catalog(), legacyType } as ReturnType<typeof catalog>;
    await services([row]);
    expect(selected()).toEqual([expect.stringContaining(row.nameAr)]);
    expect(field("duration").props.value).toBe("10");
    expect(elements(field("duration")).some((node) => node.type === "option" && node.props.value === "10")).toBe(true);
    await render().submit();
    expect(payload()).toMatchObject({ patientId: 91001, appointmentType: "follow_up", serviceId: row.id, durationMinutes: 10, bookingIntent: "ortho_follow_up" });
    expect(payload()).not.toHaveProperty("doctorId"); expect(payload()).not.toHaveProperty("caseId");
  });
  it.each(["absent", "inactive", "specialty", "legacy", "duplicate"])("does not invent or auto-select a service when the catalogue is %s", async (kind) => {
    render(); const row = catalog();
    if (kind === "inactive") row.isActive = false;
    if (kind === "specialty") row.specialty = "endodontics";
    if (kind === "legacy") row.legacyType = "consultation";
    await services(kind === "absent" ? [{ ...row, code: "OTHER_SERVICE", legacyType: "consultation" }] : kind === "duplicate" ? [row, { ...row, id: 81002 }] : [row]);
    expect(selected()).toEqual([]);
    expect(text(render().tree)).toContain("نوع الموعد: متابعة دورية / شد تقويم");
    await render().submit();
    expect(bookings()).toEqual([]);
    expect(render().find((node) => node.props.type === "submit").props.disabled).toBe(true);
  });
  it("retains the truthful legacy follow-up choice when the catalogue request fails", async () => {
    render(); await services([], 503);
    expect(selected()).toEqual([expect.stringContaining("متابعة دورية")]);
    await render().submit(); expect(bookings()).toEqual([]);
    serviceRequest = deferred(); click(render().find((node) => node.type === "button" && text(node) === "إعادة تحميل الخدمات"));
    render(); await services([catalog()]); await render().submit();
    expect(payload()).toMatchObject({ serviceId: 81001, bookingIntent: "ortho_follow_up" });
  });
  it("does not replace an explicit type choice with a late catalogue default", async () => {
    const consultation = render().all.find((node) => node.type === "button" && text(node).startsWith("كشف واستشارة"))!;
    click(consultation); await services([catalog()]);
    await render().submit();
    expect(payload().appointmentType).toBe("consultation"); expect(payload()).not.toHaveProperty("serviceId");
    expect(payload()).not.toHaveProperty("bookingIntent");
  });
  it("keeps a deliberate duration while resolving the intended real service", async () => {
    render(); change("duration", "45"); await services([catalog()]);
    expect(field("duration").props.value).toBe("45"); await render().submit();
    expect(payload()).toMatchObject({ serviceId: 81001, appointmentType: "follow_up", durationMinutes: 45, bookingIntent: "ortho_follow_up" });
  });
  it("honors a deliberate different catalogue service without forcing follow_up", async () => {
    render(); const other = { ...catalog(), id: 81002, code: "CONSULTATION", specialty: "consultation", legacyType: "consultation", nameAr: "استشارة مختارة" };
    await services([catalog(), other]); click(render().find((node) => node.props["data-service"] === other.code));
    await render().submit(); expect(payload()).toMatchObject({ serviceId: other.id, appointmentType: "consultation" });
    expect(payload()).not.toHaveProperty("bookingIntent");
  });
  it("cannot change the submitted or displayed request while a catalogue refresh arrives during booking", async () => {
    render(); await services([catalog()]); open = false; render();
    serviceRequest = deferred(); open = true; render();
    const pending = deferred<ReturnType<typeof response>>();
    fetchMock.mockImplementation((url) => url === "/api/appointments" ? pending.promise : serviceRequest.promise);
    const submission = render().submit(); const original = structuredClone(payload());
    await services([{ ...catalog(), id: 81002, defaultDurationMinutes: 20 }]);
    expect(field("duration").props.value).toBe("10");
    expect(payload()).toEqual(original); expect(payload().bookingIntent).toBe("ortho_follow_up");
    await render().submit(); expect(bookings()).toHaveLength(1);
    pending.resolve(response(409, { message: "Synthetic conflict" })); await submission;
    expect(field("duration").props.value).toBe("10");
  });
  it("refreshes a server-rejected stale service without dropping protection or an explicit duration", async () => {
    render(); await services([catalog()]); change("duration", "45");
    fetchMock.mockResolvedValueOnce(response(400, { message: "تعذّر تأكيد خدمة متابعة التقويم. أعد تحميل الخدمات أو اختر نوع الموعد والخدمة بعد المراجعة." }));
    await render().submit();
    expect(render().find((node) => node.props.type === "submit").props.disabled).toBe(true);
    serviceRequest = deferred(); click(render().find((node) => node.type === "button" && text(node) === "إعادة تحميل الخدمات"));
    render(); await services([{ ...catalog(), id: 81002 }]); await render().submit();
    expect(payload()).toMatchObject({ serviceId: 81002, bookingIntent: "ortho_follow_up", durationMinutes: 45 });
  });
  it("ignores closed-session catalogue responses and applies the current reopening default", async () => {
    render(); const stale = serviceRequest; open = false; render();
    serviceRequest = deferred(); open = true; render();
    await services([{ ...catalog(), id: 81002, defaultDurationMinutes: 20 }]);
    stale.resolve(response(200, { services: [catalog()] })); await settle();
    await render().submit(); expect(payload()).toMatchObject({ serviceId: 81002, durationMinutes: 20, appointmentType: "follow_up" });
  });
  it("restores board intent for a new mount after cancellation without carrying another patient's choice", async () => {
    render(); await services([catalog()]); change("duration", "45");
    cleanup(); resetHooks(); serviceRequest = deferred(); render(); await services([catalog()]);
    expect(field("duration").props.value).toBe("10"); await render().submit(); expect(payload().appointmentType).toBe("follow_up");
  });
  it("keeps the existing generic quick-booking default and catalogue behavior", async () => {
    intent = undefined; render(); await services([catalog()]);
    expect(selected()).toEqual([]); expect(field("duration").props.value).toBe("30");
    await render().submit(); expect(payload().appointmentType).toBe("consultation"); expect(payload()).not.toHaveProperty("serviceId");
  });
});
