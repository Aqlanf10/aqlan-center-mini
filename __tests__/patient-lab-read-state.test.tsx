import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientLabOrders } from "../components/PatientLabOrders";
import { LabDeliveryAppointmentModal } from "../components/LabDeliveryAppointmentModal";
import { LabPrescriptionModal } from "../components/LabPrescriptionModal";
import type { SessionInfo } from "../components/SessionProvider";
import type { LabOrder } from "../lib/lab";

// Deterministic component/effect tests, not a React renderer or browser claim.
// Requests deliberately ignore abort so stale-continuation guards are tested.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false, writes: 0,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  layout: [] as Array<() => void>, passive: [] as Array<() => void>,
  session: { username: "synthetic-admin", role: "admin" } as SessionInfo | null,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return index;
  };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined), previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory();
    hooks.memos.set(index, { deps, value });
    return value;
  };
  const effect = (queue: Array<() => void>, run: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined), previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    queue.push(() => {
      previous?.cleanup?.();
      const cleanup = run();
      hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined });
    });
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = slot(typeof initial === "function" ? initial() : initial);
      return [hooks.values[index], (value: unknown) => {
        ++hooks.writes;
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useLayoutEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => effect(hooks.layout, run, deps),
    useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => effect(hooks.passive, run, deps),
  };
});
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic", useSetting: () => "" }));
vi.mock("../components/LabDentalChart", () => ({ LabDentalChart: () => null }));
vi.mock("../components/LabPrescriptionModal", () => ({ LabPrescriptionModal: () => null }));
vi.mock("../components/LabDeliveryAppointmentModal", () => ({ LabDeliveryAppointmentModal: () => null }));

type Element = ReactElement<Record<string, unknown>>;
const A = 82001, B = 82002;
const heading = "أعمال وتركيبات المعمل";
const readError = "تعذّر تحميل طلبات المعمل. أعد المحاولة.";
const empty = "لا توجد طلبات معمل مسجلة لهذا المريض";
let patientId = A, mounted = true, autoLaboratories = true;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function contents(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(contents).join("");
  return node && typeof node === "object" && "props" in node
    ? contents((node as Element).props.children as ReactNode) : "";
}
function draw() {
  hooks.cursor = 0;
  hooks.changed = false;
  return PatientLabOrders({ patientId, patientName: `Synthetic patient ${patientId}` });
}
function commit() {
  hooks.layout.splice(0).forEach((run) => run());
  hooks.passive.splice(0).forEach((run) => run());
}
function render() {
  let tree: ReturnType<typeof PatientLabOrders>, rounds = 0;
  do {
    if (++rounds > 20) throw new Error("Read-state harness did not settle");
    tree = draw();
    commit();
  } while (hooks.changed);
  return tree;
}
async function flush() {
  for (let pass = 0; pass < 5; ++pass) {
    for (let tick = 0; tick < 12; ++tick) await Promise.resolve();
    if (mounted) render();
  }
}
function unmount() {
  hooks.effects.forEach((effect) => effect.cleanup?.());
  mounted = false;
}
function node(predicate: (item: Element) => boolean) {
  const found = elements(render()).find(predicate);
  if (!found) throw new Error("Missing synthetic control");
  return found;
}
function button(label: string) { return node((item) => item.type === "button" && contents(item).trim() === label); }
function click(label: string) { (button(label).props.onClick as () => void)(); }
function modal() { return elements(render()).find((item) => item.type === LabDeliveryAppointmentModal); }
function alerts() { return elements(render()).filter((item) => item.props.role === "alert").map(contents); }
function assertPending(tree = render()) {
  expect(contents(elements(tree).find((item) => item.type === "h3"))).toBe(heading);
  expect(contents(tree)).toContain("جارٍ التحميل…");
  expect(contents(tree)).not.toContain(empty);
  expect(elements(tree).filter((item) => item.key?.startsWith("81"))).toHaveLength(0);
}
function assertReadError() {
  const tree = render();
  expect(contents(elements(tree).find((item) => item.type === "h3"))).toBe(heading);
  expect(alerts()).toContain(readError);
  expect(contents(tree)).not.toContain(empty);
  expect(contents(tree)).not.toContain("جارٍ التحميل…");
  expect(elements(tree).filter((item) => item.key?.startsWith("81"))).toHaveLength(0);
  expect(button("إعادة تحميل طلبات المعمل").props.disabled).toBe(false);
}
function assertSuccess(label: string) {
  const tree = render();
  expect(contents(elements(tree).find((item) => item.type === "h3"))).toBe(`${heading} (1)`);
  expect(contents(tree)).toContain(label);
  expect(alerts()).not.toContain(readError);
  expect(contents(tree)).not.toContain(empty);
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function request(url: string, init?: RequestInit) {
  const headers = deferred<Response>(), body = deferred<unknown>();
  const json = vi.fn(() => body.promise);
  return { url, init, headers, body, json };
}
type PendingRequest = ReturnType<typeof request>;
const reads: PendingRequest[] = [], writes: PendingRequest[] = [], laboratories: PendingRequest[] = [];
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
function headers(item: PendingRequest, status = 200) {
  item.headers.resolve({ status, ok: status >= 200 && status < 300, json: item.json } as unknown as Response);
}
async function finish(item: PendingRequest, status: number, payload: unknown) {
  headers(item, status);
  item.body.resolve(payload);
  await flush();
}
function order(id: number, label: string, status: LabOrder["status"] = "received"): LabOrder {
  return {
    id: 81000 + (id - 82000), patientId: id, patientName: `Synthetic patient ${id}`, status,
    patientNumber: `SYN-${id}`, patientPhone: null, labName: `Lab ${label}`, labPhone: null,
    partyId: null, labServiceId: null, workType: label, details: null, toothNumbers: null,
    shade: null, stumpShade: null, priority: "normal", impressionType: "physical",
    sentDate: "2026-10-01", dueDate: "2026-10-10", receivedAt: null, deliveredAt: null,
    doctorId: null, visitId: null, qualityCheck: "pending", qualityNotes: null,
    remakeOriginalId: null, remakeReason: null, technicianName: null, note: null,
    createdAt: "2026-10-01T00:00:00Z",
  };
}
function payload(id = patientId, label = `Current ${id}`, status: LabOrder["status"] = "received") {
  return { orders: [order(id, label, status)], labs: [{ labName: `Suggestion ${label}`, labPhone: null }] };
}
async function mountSuccess(status: LabOrder["status"] = "received") {
  render();
  await finish(reads[0], 200, payload(A, "Initial A", status));
}
function refreshCallback() {
  click("📅حجز موعد تسليم");
  const refresh = modal()!.props.onAppointmentBooked as () => void;
  (modal()!.props.onClose as () => void)();
  return refresh;
}
function assertScopedReads() {
  expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/lab" && !init?.method)).toHaveLength(0);
  expect(reads.every((item) => item.url === `/api/lab?patientId=${A}` || item.url === `/api/lab?patientId=${B}`)).toBe(true);
  expect(reads.every((item) => item.init?.cache === "no-store")).toBe(true);
}

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.changed = false; hooks.writes = 0;
  hooks.effects.clear(); hooks.memos.clear(); hooks.layout = []; hooks.passive = [];
  hooks.session = { username: "synthetic-admin", role: "admin" };
  patientId = A; mounted = true; autoLaboratories = true;
  reads.length = 0; writes.length = 0; laboratories.length = 0;
  vi.clearAllMocks();
  fetchMock.mockImplementation((url, init) => {
    const item = request(url, init);
    if (init?.method) writes.push(item);
    else if (url.startsWith("/api/lab?patientId=")) reads.push(item);
    else if (url === "/api/laboratories") {
      laboratories.push(item);
      if (autoLaboratories) {
        headers(item);
        item.body.resolve({ laboratories: [] });
      }
    } else throw new Error(`Unexpected synthetic request: ${url}`);
    return item.headers.promise;
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
});
afterEach(() => { if (mounted) unmount(); vi.unstubAllGlobals(); });

it("withholds the count and empty claim until both accepted headers and body are complete", async () => {
  render(); assertPending();
  headers(reads[0]); await flush(); assertPending();
  expect(reads[0].json).toHaveBeenCalledTimes(1);
  reads[0].body.resolve({ orders: [], labs: [] }); await flush();
  expect(contents(render())).toContain(`${heading} (0)`);
  expect(contents(render())).toContain(empty);
  expect(alerts()).toEqual([]);
  assertScopedReads();
});

it.each([401, 403, 404, 409, 500])("does not broaden a scoped %i refusal or await its body, and recovers by retry", async (status) => {
  render(); headers(reads[0], status); await flush();
  assertReadError(); expect(reads[0].json).not.toHaveBeenCalled();
  expect(reads).toHaveLength(1); assertScopedReads();
  click("إعادة تحميل طلبات المعمل"); assertPending();
  expect(reads).toHaveLength(2);
  await finish(reads[1], 200, payload(A, "Recovered A"));
  assertSuccess("Recovered A"); assertScopedReads();
});

it.each(["headers", "body"])("contains a rejected %s promise and supports a real empty recovery", async (phase) => {
  render();
  if (phase === "headers") reads[0].headers.reject(new Error("Synthetic offline"));
  else { headers(reads[0]); await flush(); reads[0].body.reject(new Error("Synthetic invalid JSON")); }
  await flush(); assertReadError(); assertScopedReads();
  click("إعادة تحميل طلبات المعمل");
  await finish(reads[1], 200, { orders: [], labs: [] });
  expect(contents(render())).toContain(`${heading} (0)`);
  expect(contents(render())).toContain(empty);
});

it.each([
  null, [], {}, { orders: [] }, { orders: {}, labs: [] }, { orders: null, labs: [] },
  { orders: [null], labs: [] }, { orders: [order(B, "Wrong patient")], labs: [] },
  { orders: [order(A, "Duplicate"), order(A, "Duplicate")], labs: [] },
  { orders: [{ ...order(A, "Bad id"), id: "81001" }], labs: [] },
  { orders: [{ ...order(A, "Bad status"), status: "unknown" }], labs: [] },
  { orders: [{ ...order(A, "Bad text"), workType: {} }], labs: [] },
  { orders: [{ ...order(A, "Bad note"), note: {} }], labs: [] },
  { orders: [{ ...order(A, "Bad amount"), baseAmountMinor: {} }], labs: [] },
  { orders: [], labs: {} }, { orders: [], labs: [null] }, { orders: [], labs: [{ labName: {} }] },
])("fails closed on malformed or wrong-patient accepted data %j", async (data) => {
  render(); await finish(reads[0], 200, data);
  assertReadError(); assertScopedReads();
  click("إعادة تحميل طلبات المعمل");
  await finish(reads[1], 200, payload());
  assertSuccess(`Current ${A}`);
});

it("preserves every current API status and optional/null financial fields", async () => {
  render();
  const states = ["needed", "sent", "in_progress", "received", "delivered", "remake", "cancelled"] as const;
  await finish(reads[0], 200, {
    orders: states.map((status, index) => ({ ...order(A, `Valid ${status}`, status), id: 81010 + index,
      costMinor: null, costCurrency: null, baseAmountMinor: null })), labs: [],
  });
  expect(contents(render())).toContain(`${heading} (7)`);
  for (const status of states) expect(contents(render())).toContain(`Valid ${status}`);
  expect(alerts()).toEqual([]);
});

describe.each(["headers", "body"] as const)("obsolete read at %s", (phase) => {
  it.each(["success", "error", "pending"] as const)("cannot replace newer %s, including its suggestions", async (newer) => {
    await mountSuccess();
    const refresh = refreshCallback(); refresh();
    const old = reads[1];
    if (phase === "body") { headers(old); await flush(); expect(old.json).toHaveBeenCalledTimes(1); }
    refresh(); const latest = reads[2];
    expect(old.init?.signal?.aborted).toBe(true);
    if (newer === "success") await finish(latest, 200, payload(A, "Newest A"));
    else if (newer === "error") { headers(latest, 503); await flush(); }
    const stateWrites = hooks.writes;
    await finish(old, 200, payload(A, "Obsolete A"));
    expect(hooks.writes).toBe(stateWrites);
    if (phase === "headers") expect(old.json).not.toHaveBeenCalled();
    if (newer === "success") assertSuccess("Newest A");
    else if (newer === "error") assertReadError();
    else assertPending();
    expect(contents(render())).not.toContain("Obsolete A");
    click("+ طلب معمل جديد");
    const options = elements(render()).filter((item) => item.type === "option").map((item) => item.props.value);
    expect(options).not.toContain("Suggestion Obsolete A");
    expect(options.includes("Suggestion Newest A")).toBe(newer === "success");
    assertScopedReads();
  });

  it("ignores obsolete rejected promises without ending current loading", async () => {
    await mountSuccess(); const refresh = refreshCallback(); refresh(); const old = reads[1];
    if (phase === "body") { headers(old); await flush(); }
    refresh();
    const stateWrites = hooks.writes;
    (phase === "headers" ? old.headers : old.body).reject(new Error("Synthetic obsolete failure"));
    await flush(); expect(hooks.writes).toBe(stateWrites); assertPending();
    await finish(reads[2], 200, payload(A, "Newest A")); assertSuccess("Newest A");
  });

  it("retires A1 through A→B→A rather than treating the repeated patient id as the same owner", async () => {
    render(); const old = reads[0];
    if (phase === "body") { headers(old); await flush(); }
    patientId = B; assertPending(draw()); commit(); render();
    expect(old.init?.signal?.aborted).toBe(true);
    await finish(reads[1], 200, payload(B, "Current B")); assertSuccess("Current B");
    patientId = A; assertPending(draw()); commit(); render();
    await finish(old, 200, payload(A, "Obsolete A1")); assertPending();
    expect(contents(render())).not.toContain("Current B");
    expect(contents(render())).not.toContain("Obsolete A1");
    await finish(reads[2], 200, payload(A, "Current A2")); assertSuccess("Current A2");
    if (phase === "headers") expect(old.json).not.toHaveBeenCalled();
    expect(reads.map((item) => item.url)).toEqual([A, B, A].map((id) => `/api/lab?patientId=${id}`));
  });

  it.each([
    { username: "synthetic-other", role: "admin" },
    { username: "synthetic-admin", role: "doctor" },
    { username: "synthetic-admin", role: "admin", permissions: { canEditPlans: true } },
  ] as Array<SessionInfo | null>)("retires stale principal data for %j", async (session) => {
    await mountSuccess(); const refresh = refreshCallback(); refresh(); const old = reads[1];
    if (phase === "body") { headers(old); await flush(); }
    hooks.session = session; assertPending(draw()); commit(); render();
    await finish(old, 200, payload(A, "Old principal")); assertPending();
    expect(contents(render())).not.toContain("Old principal");
    expect(old.init?.signal?.aborted).toBe(true);
    await finish(reads[2], 200, payload(A, "New principal")); assertSuccess("New principal");
  });

  it("does not read or mutate without a principal, and rejects the retired principal's late result", async () => {
    render(); const old = reads[0];
    if (phase === "body") { headers(old); await flush(); }
    hooks.session = null; render();
    expect(reads).toHaveLength(1); expect(laboratories).toHaveLength(1);
    expect(button("+ طلب معمل جديد").props.disabled).toBe(true);
    expect(button("إعادة تحميل طلبات المعمل").props.disabled).toBe(true);
    expect(alerts()).toEqual(["انتهت الجلسة. سجّل الدخول من جديد."]);
    const stateWrites = hooks.writes;
    await finish(old, 200, payload(A, "Retired principal"));
    expect(hooks.writes).toBe(stateWrites);
    expect(contents(render())).not.toContain("Retired principal");
    expect(contents(render())).not.toContain(empty);
    expect(writes).toHaveLength(0);
    hooks.session = { username: "synthetic-admin", role: "admin" }; render();
    expect(reads).toHaveLength(2); assertPending();
    await finish(reads[1], 200, payload(A, "Restored principal")); assertSuccess("Restored principal");
  });

  it("does not commit state or parse late headers after unmount", async () => {
    render(); const old = reads[0];
    if (phase === "body") { headers(old); await flush(); }
    unmount(); const stateWrites = hooks.writes;
    expect(old.init?.signal?.aborted).toBe(true);
    await finish(old, 200, payload(A, "Unmounted A"));
    expect(hooks.writes).toBe(stateWrites); expect(reads).toHaveLength(1);
    if (phase === "headers") expect(old.json).not.toHaveBeenCalled();
  });
});

it("a same-tick repeated retry supersedes the first attempt without a broadened request", async () => {
  render(); headers(reads[0], 500); await flush();
  const retry = button("إعادة تحميل طلبات المعمل").props.onClick as () => void;
  retry(); retry(); assertPending();
  expect(reads[1].init?.signal?.aborted).toBe(true);
  await finish(reads[2], 200, payload(A, "Latest retry"));
  await finish(reads[1], 200, { orders: [], labs: [] });
  assertSuccess("Latest retry"); assertScopedReads();
});

it.each(["create", "cancel", "status"])("an unrelated read success does not clear a %s refusal", async (command) => {
  await mountSuccess(); const refresh = refreshCallback();
  if (command === "create") {
    click("+ طلب معمل جديد");
    (node((item) => item.type === "input" && item.props.list === "patient-labs-list").props.onChange as (event: unknown) => void)({ target: { value: "Synthetic lab" } });
    const submit = node((item) => item.type === "form").props.onSubmit as (event: unknown) => void;
    refresh(); submit({ preventDefault() {} });
  } else {
    // Cancellation needs a sent row; capture the read callback before replacing it.
    refresh(); await finish(reads[1], 200, payload(A, "Sent A", "sent"));
    const control = button(command === "cancel" ? "✕ إلغاء الإرسالية" : "✓ استلام من المختبر");
    refresh(); (control.props.onClick as () => void)();
  }
  await finish(writes[0], 403, { message: `Synthetic ${command} refusal` });
  expect(alerts()).toContain(`Synthetic ${command} refusal`);
  await finish(reads.at(-1)!, 200, payload(A, "Refreshed A"));
  expect(alerts()).toContain(`Synthetic ${command} refusal`);
  assertSuccess("Refreshed A");
});

it.each(["received", "delivered"] as const)("reports a failed post-%s refresh without repeating the accepted mutation", async (status) => {
  await mountSuccess(status === "received" ? "sent" : "received");
  click(status === "received" ? "✓ استلام من المختبر" : "✓ تسليم وتركيب للمريض");
  await finish(writes[0], 200, null); assertPending();
  headers(reads[1], 500); await flush(); assertReadError();
  expect(writes).toHaveLength(1);
  expect(Boolean(modal())).toBe(status === "received");
  if (status === "received") {
    expect(modal()?.props.order).toEqual({ ...order(A, "Initial A", "sent"), status: "received" });
    (modal()!.props.onClose as () => void)();
  }
  click("إعادة تحميل طلبات المعمل");
  await finish(reads[2], 200, payload(A, "Confirmed A", status));
  assertSuccess("Confirmed A"); expect(writes).toHaveLength(1);
});

it.each(["success", "refusal-body", "network"])("retired mutation %s cannot refresh, open booking or release a new owner's lock", async (outcome) => {
  await mountSuccess("sent"); click("✓ استلام من المختبر"); const old = writes[0];
  if (outcome === "refusal-body") { headers(old, 409); await flush(); }
  patientId = B; render(); await finish(reads[1], 200, payload(B, "Current B", "sent"));
  click("✓ استلام من المختبر"); expect(writes).toHaveLength(2);
  const stateWrites = hooks.writes;
  if (outcome === "network") old.headers.reject(new Error("Synthetic obsolete command"));
  else if (outcome === "refusal-body") old.body.resolve({ message: "Old refusal" });
  else { headers(old); old.body.resolve(null); }
  await flush();
  expect(hooks.writes).toBe(stateWrites);
  expect(reads).toHaveLength(2); expect(modal()).toBeUndefined();
  expect(button("✓ استلام من المختبر").props.disabled).toBe(true);
  expect(alerts()).toEqual([]);
  await finish(writes[1], 403, { message: "Current B refusal" });
  expect(button("✓ استلام من المختبر").props.disabled).toBe(false);
  expect(alerts()).toEqual(["Current B refusal"]);
});

it("retires open modal selections and patient-specific create drafts on a scope change", async () => {
  await mountSuccess();
  click("📋 استمارة المختبر"); click("📅حجز موعد تسليم"); click("+ طلب معمل جديد");
  (node((item) => item.type === "textarea").props.onChange as (event: unknown) => void)({ target: { value: "A-only draft" } });
  const dateInputs = elements(render()).filter((item) => item.type === "input" && item.props.type === "date");
  const initialDates = dateInputs.map((item) => item.props.value);
  for (const item of dateInputs) (item.props.onChange as (event: unknown) => void)({ target: { value: "2040-12-25" } });
  patientId = B;
  const beforeCommit = draw();
  expect(elements(beforeCommit).some((item) => item.type === LabPrescriptionModal || item.type === LabDeliveryAppointmentModal)).toBe(false);
  commit(); render();
  expect(elements(render()).some((item) => item.type === "form")).toBe(false);
  click("+ طلب معمل جديد");
  expect(node((item) => item.type === "textarea").props.value).toBe("");
  expect(elements(render()).filter((item) => item.type === "input" && item.props.type === "date").map((item) => item.props.value)).toEqual(initialDates);
  expect(contents(render())).not.toContain("Initial A");
});

it.each([0, -1, 1.5, NaN, Infinity])("never dispatches an invalid patient scope %s", async (id) => {
  patientId = id; render(); await flush();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(alerts()).toEqual(["تعذّر التحقق من سياق المريض."]);
  expect(contents(render())).not.toContain(empty);
  expect(contents(elements(render()).find((item) => item.type === "h3"))).toBe(heading);
  expect(button("+ طلب معمل جديد").props.disabled).toBe(true);
  expect(button("إعادة تحميل طلبات المعمل").props.disabled).toBe(true);
  patientId = A; render();
  await finish(reads[0], 200, payload(A, "Valid scope")); assertSuccess("Valid scope");
});

it("mounts signed out without dispatching a list or laboratory request", async () => {
  hooks.session = null; render(); await flush();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(alerts()).toEqual(["انتهت الجلسة. سجّل الدخول من جديد."]);
  expect(contents(render())).not.toContain(empty);
});

it("does not refetch for a display-name-only or same-principal object replacement", async () => {
  await mountSuccess();
  hooks.session = { username: "synthetic-admin", role: "admin", displayName: "Updated display name" };
  render(); await flush();
  expect(reads).toHaveLength(1); expect(laboratories).toHaveLength(1); assertSuccess("Initial A");
});

it.each(["headers", "body"] as const)("retires old registered-laboratory suggestions at %s", async (phase) => {
  autoLaboratories = false;
  await mountSuccess(); const old = laboratories[0];
  if (phase === "body") { headers(old); await flush(); }
  patientId = B; render();
  await finish(reads[1], 200, payload(B, "Current B"));
  await finish(laboratories[1], 200, { laboratories: [{ id: 93002, name: "Current registered lab", isActive: true }] });
  const stateWrites = hooks.writes;
  await finish(old, 200, { laboratories: [{ id: 93001, name: "Retired registered lab", isActive: true }] });
  expect(hooks.writes).toBe(stateWrites);
  expect(old.init?.signal?.aborted).toBe(true);
  if (phase === "headers") expect(old.json).not.toHaveBeenCalled();
  click("+ طلب معمل جديد");
  const options = elements(render()).filter((item) => item.type === "option").map((item) => item.props.value);
  expect(options).toContain("Current registered lab");
  expect(options).not.toContain("Retired registered lab");
});
