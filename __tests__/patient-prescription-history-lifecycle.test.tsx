import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";

// Actual GET + real patient-access guard + actual reader/JSX/event handlers.
// Only DB/session/fetch transport and React scheduling are synthetic. No DB,
// app server, browser, printing, editor issuance or visual acceptance is claimed.
const boundary = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn(), owns: vi.fn(), today: vi.fn(), list: vi.fn(), suggestions: vi.fn(), write: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: boundary.session }));
vi.mock("../lib/db", () => ({ findUserByUsername: boundary.user, doctorOwnsPatient: boundary.owns,
  patientHasVisitToday: boundary.today, listPatientPrescriptions: boundary.list, prescribedBefore: boundary.suggestions,
  savePrescription: boundary.write, voidPrescription: boundary.write }));

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(),
  layouts: new Map<number, () => void>(), pending: new Map<number, () => void>() }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = slot(undefined); const previous = hooks.memos.get(index);
    if (previous && same(previous.deps, deps)) return previous.value;
    const value = factory(); hooks.memos.set(index, { deps, value }); return value;
  };
  const effect = (queue: Map<number, () => void>, callback: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = slot(undefined); const previous = hooks.effects.get(index);
    if (previous && same(previous.deps, deps)) return;
    const entry = { deps, cleanup: previous?.cleanup }; hooks.effects.set(index, entry);
    queue.set(index, () => { previous?.cleanup?.(); const cleanup = callback(); entry.cleanup = typeof cleanup === "function" ? cleanup : undefined; });
  };
  return { ...react,
    useState: (initial: unknown) => { const index = slot(typeof initial === "function" ? initial() : initial); return [hooks.values[index], (value: unknown) => {
      hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value;
    }]; },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useLayoutEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(hooks.layouts, callback, deps),
    useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(hooks.pending, callback, deps),
  };
});

import { GET } from "../app/api/patients/[id]/prescriptions/route";
import { PatientPrescriptionHistory, usePatientPrescriptionHistory } from "../components/patient-workspace/PatientPrescriptionHistory";
import type { SavedPrescription } from "../lib/patient-prescription-history";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const item = { name: "Synthetic original medication", dose: "Original dose", form: "Original form", frequency: "Original frequency", duration: "Original duration", instructions: "تعليمات أصلية", instructionsEn: "Original instructions" };
const saved = (id = 311, patientId = 91): SavedPrescription => ({ id, patientId, visitId: null, diagnosis: `Original diagnosis ${patientId}`, notes: "Original notes", instructionsLang: "both", items: [item], status: "active", voidReason: null, voidedBy: null, voidedAt: null, createdBy: "original-issuer", doctorPartyId: 7, createdAt: "2026-10-01T10:20:30.000Z" });
const voided = (): SavedPrescription => ({ ...saved(312), visitId: 201, status: "void", voidReason: "Original cancellation reason", voidedBy: "original-void-actor", voidedAt: "2026-10-02T11:00:00.000Z" });
const session = (role = "doctor"): SessionPayload => ({ userId: 10, username: "current-reader-not-issuer", role, partyId: 7, expiresAt: 0 });
const get = (id = "91") => GET(new Request(`http://synthetic.invalid/api/patients/${id}/prescriptions`), { params: Promise.resolve({ id }) });
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: vi.fn(async () => body) });
const linkedFetch = (url: string) => get(new URL(url, "http://synthetic.invalid").pathname.split("/")[3]);
const fetchMock = vi.fn();
let props: ComponentProps<typeof PatientPrescriptionHistory>;
function flush(queue: Map<number, () => void>) { const effects = [...queue.values()]; queue.clear(); effects.forEach((run) => run()); }
function render<T>(run: () => T, passive = true): T { hooks.cursor = 0; const value = run(); flush(hooks.layouts); if (passive) flush(hooks.pending); return value; }
const read = (passive = true) => render(() => usePatientPrescriptionHistory(props), passive);
const ui = (passive = true) => render(() => PatientPrescriptionHistory(props), passive);
async function readyRead() { read(); await vi.waitFor(() => expect(read().status).toBe("ready")); return read(); }
async function readyUI() { ui(); await vi.waitFor(() => expect(elements(ui()).some((node) => node.props["data-testid"] === "saved-prescription-311")).toBe(true)); return ui(); }
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join(" ").replace(/\s+/g, " ");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  return text((node as Element).props.children as ReactNode);
}
function find(tree: ReactNode, id: string): Element { const rows = elements(tree).filter((node) => node.props["data-testid"] === id); expect(rows).toHaveLength(1); return rows[0]; }
const links = (tree: ReactNode) => elements(tree).filter((node) => node.type === "a");
function click(node: Element, key = "onClick") { const event = { preventDefault: vi.fn() }; (node.props[key] as (event: { preventDefault: () => void }) => void)(event); return event; }
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects.clear(); hooks.memos.clear(); hooks.layouts.clear(); hooks.pending.clear();
  vi.clearAllMocks();
  boundary.session.mockResolvedValue(session());
  boundary.user.mockResolvedValue({ isActive: true, partyId: 7, permissions: { canViewAllPatients: false } });
  boundary.owns.mockResolvedValue(true); boundary.today.mockResolvedValue(true);
  boundary.list.mockImplementation(async (patientId: number) => [saved(311, patientId)]);
  boundary.suggestions.mockResolvedValue([{ ...item, name: "SUGGESTION MUST NEVER RENDER OR BE COPIED" }]);
  fetchMock.mockReset().mockImplementation(linkedFetch); vi.stubGlobal("fetch", fetchMock);
  props = { patientId: 91, authorityKey: "reader:doctor:scoped", canRead: true, active: true, readable: true, readRevision: 1, prescriptionDialogOpen: false };
});
afterEach(() => { hooks.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe("unchanged actual prescription GET admission", () => {
  it.each(["doctor", "admin"])("admits %s and returns canonical originals once", async (role) => {
    boundary.session.mockResolvedValue(session(role));
    const result = await get(); expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ prescriptions: [saved()], suggestions: [{ ...item, name: "SUGGESTION MUST NEVER RENDER OR BE COPIED" }] });
    expect(boundary.list).toHaveBeenCalledExactlyOnceWith(91); expect(boundary.suggestions).toHaveBeenCalledExactlyOnceWith(91);
    expect(boundary.write).not.toHaveBeenCalled();
  });
  it("requires a session before reading history or suggestions", async () => {
    boundary.session.mockResolvedValue(null); expect((await get()).status).toBe(401);
    expect(boundary.list).not.toHaveBeenCalled(); expect(boundary.suggestions).not.toHaveBeenCalled();
  });
  it.each(["reception", "assistant", "cashier", "accountant", "unknown"])("denies %s before patient history access", async (role) => {
    boundary.session.mockResolvedValue(session(role)); expect((await get()).status).toBe(403);
    expect(boundary.list).not.toHaveBeenCalled(); expect(boundary.suggestions).not.toHaveBeenCalled(); expect(boundary.today).not.toHaveBeenCalled();
  });
  it("denies a doctor who does not own this exact patient", async () => {
    boundary.owns.mockResolvedValue(false); expect((await get()).status).toBe(403);
    expect(boundary.owns).toHaveBeenCalledWith(7, 91); expect(boundary.list).not.toHaveBeenCalled(); expect(boundary.suggestions).not.toHaveBeenCalled();
  });
  it.each([null, { isActive: false, partyId: 7 }, { isActive: true, partyId: null }])("denies unavailable clinician identity %j", async (user) => {
    boundary.user.mockResolvedValue(user); expect((await get()).status).toBe(403); expect(boundary.list).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "1.5", "not-an-id"])("rejects invalid patient %s without reading data", async (id) => {
    expect((await get(id)).status).toBe(400); expect(boundary.list).not.toHaveBeenCalled(); expect(boundary.suggestions).not.toHaveBeenCalled();
  });
  it("preserves server errors without inventing an empty list", async () => {
    boundary.list.mockRejectedValue(new Error("Synthetic unavailable DB boundary")); const result = await get();
    expect(result.status).toBe(500); expect(await result.json()).not.toHaveProperty("prescriptions");
  });
});

describe("actual history reader + GET linked lifecycle", () => {
  it("does one canonical GET with no writes or separate suggestion reads", async () => {
    const value = await readyRead(); expect(value.rows).toEqual([saved()]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/patients/91/prescriptions", { cache: "no-store", signal: expect.any(AbortSignal) });
    expect(boundary.list).toHaveBeenCalledTimes(1); expect(boundary.suggestions).toHaveBeenCalledTimes(1); expect(boundary.write).not.toHaveBeenCalled();
  });
  it.each([
    { active: false, status: "inactive" }, { canRead: false, status: "denied" },
    { readable: false, status: "waiting" }, { prescriptionDialogOpen: true, status: "paused" },
  ])("does not request history outside admitted active boundary %j", ({ status, ...change }) => {
    props = { ...props, ...change }; expect(read().status).toBe(status); expect(read().rows).toBeNull(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([{ patientId: 0 }, { patientId: 2147483648 }, { authorityKey: "  " }])("rejects invalid reader context %j before fetching", (change) => {
    props = { ...props, ...change }; read(); expect(read().status).toBe("error"); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("keeps one generation and request through stable rerenders", async () => {
    const first = await readyRead(); props = { ...props }; const next = read();
    expect(next.rows).toBe(first.rows); expect(next.generation).toBe(first.generation); expect(next.reload).toBe(first.reload); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("clears old patient rows before passive reads and does not revive them on A → B → A", async () => {
    const original = await readyRead(); const body = deferred<unknown>(); const slow = response(null); slow.json.mockImplementation(() => body.promise);
    fetchMock.mockResolvedValueOnce(slow); const pending = read().reload(); await vi.waitFor(() => expect(slow.json).toHaveBeenCalled());
    props.patientId = 92; expect(read(false).rows).toBeNull(); expect(original.isCurrent(original.generation)).toBe(false);
    await readyRead(); expect(read().rows?.[0].patientId).toBe(92);
    props.patientId = 91; await readyRead(); const current = read();
    body.resolve({ prescriptions: [{ ...saved(), notes: "OLD A MUST NOT RETURN" }] }); await pending;
    expect(read().rows).toEqual([saved()]); expect(read().generation).toBe(current.generation); expect(original.isCurrent(original.generation)).toBe(false);
    const calls = fetchMock.mock.calls.length; await original.reload(); expect(fetchMock).toHaveBeenCalledTimes(calls);
  });
  it("ignores previous authority JSON through authority A → B → A", async () => {
    const original = await readyRead(); const body = deferred<unknown>(); const slow = response(null); slow.json.mockImplementation(() => body.promise);
    fetchMock.mockResolvedValueOnce(slow); const pending = read().reload(); await vi.waitFor(() => expect(slow.json).toHaveBeenCalled());
    props.authorityKey = "new-reader:doctor:scoped"; expect(read(false).rows).toBeNull(); await readyRead();
    props.authorityKey = "reader:doctor:scoped"; await readyRead();
    body.resolve({ prescriptions: [{ ...saved(), createdBy: "OLD AUTHORITY" }] }); await pending;
    expect(read().rows).toEqual([saved()]); expect(original.isCurrent(original.generation)).toBe(false);
  });
  it("aborts a retired transport and never parses late headers", async () => {
    const old = deferred<ReturnType<typeof response>>(); fetchMock.mockReturnValueOnce(old.promise); read();
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    props.patientId = 92; await readyRead(); expect(signal.aborted).toBe(true);
    const late = response({ prescriptions: [saved()] }); old.resolve(late); await Promise.resolve(); await Promise.resolve();
    expect(late.json).not.toHaveBeenCalled(); expect(read().rows?.[0].patientId).toBe(92);
  });
  it("fences links and reload callbacks immediately while parent readiness is revoked", async () => {
    const original = await readyRead(); props.readable = false; props.readRevision = 2;
    expect(read(false).rows).toBeNull(); expect(read(false).status).toBe("waiting"); expect(original.isCurrent(original.generation)).toBe(false);
    await original.reload(); expect(fetchMock).toHaveBeenCalledTimes(1); read(); expect(fetchMock).toHaveBeenCalledTimes(1);
    props.readable = true; await readyRead(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("retires a read on revision change even when readiness stays true", async () => {
    const original = await readyRead(); props.readRevision = 2; expect(read(false).rows).toBeNull();
    expect(original.isCurrent(original.generation)).toBe(false); await readyRead(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("revokes clinician capability without a network read or callback revival", async () => {
    const original = await readyRead(); props.canRead = false;
    expect(read(false).status).toBe("denied"); expect(read(false).rows).toBeNull(); await original.reload(); read();
    expect(fetchMock).toHaveBeenCalledTimes(1); props.canRead = true; await readyRead(); expect(original.isCurrent(original.generation)).toBe(false);
  });
  it("clears and re-reads on hide/show and dialog open/close without changing save outcome", async () => {
    const original = await readyRead(); props.active = false; expect(ui()).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(1);
    props.active = true; await readyRead(); props.prescriptionDialogOpen = true;
    expect(read(false).rows).toBeNull(); expect(read().status).toBe("paused"); expect(fetchMock).toHaveBeenCalledTimes(2);
    boundary.list.mockResolvedValue([saved(), voided()]); props.prescriptionDialogOpen = false; await readyRead();
    expect(read().rows).toEqual([saved(), voided()]); expect(fetchMock).toHaveBeenCalledTimes(3); expect(original.isCurrent(original.generation)).toBe(false);
    expect(boundary.write).not.toHaveBeenCalled();
  });
  it("ignores delayed JSON after hide/show or dialog open/close", async () => {
    const body = deferred<unknown>(); const slow = response(null); slow.json.mockImplementation(() => body.promise);
    fetchMock.mockResolvedValueOnce(slow); read(); await vi.waitFor(() => expect(slow.json).toHaveBeenCalled());
    props.active = false; read(); props.active = true; props.prescriptionDialogOpen = true; read();
    props.prescriptionDialogOpen = false; await readyRead();
    body.resolve({ prescriptions: [] }); await Promise.resolve(); await Promise.resolve(); expect(read().rows).toEqual([saved()]);
  });
  it.each([401, 403, 404])("denies %s before attempting HTML/delayed JSON", async (status) => {
    await readyRead(); const denial = response(null, status); denial.json.mockImplementation(() => new Promise(() => {}));
    fetchMock.mockResolvedValueOnce(denial); await read().reload(); expect(read().status).toBe("denied"); expect(read().rows).toBeNull(); expect(denial.json).not.toHaveBeenCalled();
  });
  it("links a real patient-scope revocation to cleared UI", async () => {
    await readyRead(); boundary.owns.mockResolvedValue(false); await read().reload();
    expect(read().status).toBe("denied"); expect(links(ui())).toHaveLength(0); expect(text(ui())).not.toContain("Original diagnosis");
  });
  it("does not let a superseded success overwrite the newer denied read", async () => {
    const pending = deferred<ReturnType<typeof response>>(); fetchMock.mockReturnValueOnce(pending.promise); read();
    boundary.owns.mockResolvedValue(false); await read().reload(); expect(read().status).toBe("denied");
    const stale = response({ prescriptions: [saved()] }); pending.resolve(stale); await Promise.resolve(); await Promise.resolve();
    expect(read().status).toBe("denied"); expect(stale.json).not.toHaveBeenCalled();
  });
  it("does not let old denial overwrite a newer success", async () => {
    const pending = deferred<ReturnType<typeof response>>(); fetchMock.mockReturnValueOnce(pending.promise); read();
    await read().reload(); expect(read().status).toBe("ready"); pending.resolve(response({}, 403));
    await Promise.resolve(); await Promise.resolve(); expect(read().rows).toEqual([saved()]);
  });
  it("distinguishes successful empty history from malformed/cross-patient/failed reads", async () => {
    boundary.list.mockResolvedValue([]); await readyRead(); expect(find(ui(), "prescription-history-empty")).toBeTruthy();
    for (const body of [{}, { prescriptions: [saved(311, 92)] }, { prescriptions: [saved(), { ...saved(312), items: null }] }]) {
      fetchMock.mockResolvedValueOnce(response(body)); await read().reload();
      expect(read().status).toBe("error"); expect(read().rows).toBeNull(); expect(text(ui())).not.toContain("لا توجد وصفات محفوظة"); expect(links(ui())).toHaveLength(0);
    }
    boundary.list.mockRejectedValueOnce(new Error("Synthetic failure")); await read().reload(); expect(read().status).toBe("error");
    fetchMock.mockResolvedValueOnce({ ...response(null), json: vi.fn(async () => { throw new Error("Invalid JSON"); }) });
    await read().reload(); expect(read().status).toBe("error");
  });
  it("drops state and callbacks after unmount, including post-JSON completion", async () => {
    const original = await readyRead(); const body = deferred<unknown>(); const slow = response(null); slow.json.mockImplementation(() => body.promise);
    fetchMock.mockResolvedValueOnce(slow); const pending = read().reload(); await vi.waitFor(() => expect(slow.json).toHaveBeenCalled());
    const snapshot = [...hooks.values]; hooks.effects.forEach((effect) => effect.cleanup?.());
    body.resolve({ prescriptions: [] }); await pending;
    expect(hooks.values).toEqual(snapshot); expect(original.isCurrent(original.generation)).toBe(false);
    await original.reload(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("saved original history actual UI handlers", () => {
  it("renders active+void, original issuer/date/context/details and the exact saved print links", async () => {
    boundary.list.mockResolvedValue([saved(), voided()]); const tree = await readyUI(); const copy = text(tree);
    for (const value of ["أحدث ما يصل إلى 50", "غير مبطلة", "مبطلة", "دون ارتباط بزيارة", "الزيارة المحفوظة", "اسم مستخدم المُصدر", "original-issuer", "2026-10-01 10:20:30 UTC", "Original diagnosis 91", "Original cancellation reason", "Original dose", "Original instructions", "original-void-actor"]) expect(copy).toContain(value);
    // This text walker separates JSX children; inspect the original visit value
    // directly rather than requiring adjacent characters in its synthetic text.
    expect(elements(find(tree, "saved-prescription-312")).filter((node) => node.type === "bdi").map((node) => node.props.children)).toContainEqual(["#", 201]);
    expect(copy).not.toContain("current-reader-not-issuer"); expect(copy).not.toContain("SUGGESTION MUST NEVER");
    expect(links(tree).map((link) => link.props.href)).toEqual(["/print/prescription/91?rx=311", "/print/prescription/91?rx=312"]);
    for (const link of links(tree)) {
      expect(link.props.target).toBe("_blank"); expect(link.props.rel).toBe("noopener noreferrer");
      expect(click(link).preventDefault).not.toHaveBeenCalled(); expect(click(link, "onAuxClick").preventDefault).not.toHaveBeenCalled();
    }
    expect(elements(tree).filter((node) => ["form", "input", "select", "textarea"].includes(String(node.type)))).toHaveLength(0);
    expect(boundary.write).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("clears stored links while refresh is pending and blocks saved callbacks immediately", async () => {
    const tree = await readyUI(); const oldLink = find(tree, "prescription-print-311"); const wait = deferred<SavedPrescription[]>();
    boundary.list.mockReturnValueOnce(wait.promise); click(find(tree, "prescription-history-refresh"));
    expect(click(oldLink).preventDefault).toHaveBeenCalledOnce(); expect(click(oldLink, "onAuxClick").preventDefault).toHaveBeenCalledOnce();
    expect(links(ui())).toHaveLength(0); expect(find(ui(), "prescription-history-loading")).toBeTruthy();
    wait.resolve([saved()]); await readyUI(); expect(click(oldLink).preventDefault).toHaveBeenCalledOnce();
    expect(boundary.write).not.toHaveBeenCalled();
  });
  it.each([
    { patientId: 92 }, { authorityKey: "replacement:doctor" }, { canRead: false }, { active: false },
    { readable: false }, { readRevision: 2 }, { prescriptionDialogOpen: true },
  ])("blocks retired print/refresh callbacks before passive effects %j", async (change) => {
    const original = await readyUI(); const oldLink = find(original, "prescription-print-311"); const refresh = find(original, "prescription-history-refresh");
    props = { ...props, ...change }; const next = ui(false); expect(links(next)).toHaveLength(0);
    expect(click(oldLink).preventDefault).toHaveBeenCalledOnce(); click(refresh); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("refreshes through actual button after error without invoking a writer", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Synthetic transport error")); ui(); await vi.waitFor(() => expect(find(ui(), "prescription-history-error")).toBeTruthy());
    click(find(ui(), "prescription-history-refresh")); await readyUI(); expect(fetchMock).toHaveBeenCalledTimes(2); expect(boundary.write).not.toHaveBeenCalled();
  });
});
