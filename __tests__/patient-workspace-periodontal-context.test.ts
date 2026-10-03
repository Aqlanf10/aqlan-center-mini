import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { periodontalVisitId, readPeriodontalContext } from "../lib/patient-periodontal-context";
import { usePeriodontalContext } from "../components/patient-workspace/usePeriodontalContext";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(), pending: [] as Array<() => void> }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return { ...react,
    useState: (initial: unknown) => { const index = slot(typeof initial === "function" ? initial() : initial); return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }]; },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useCallback: (callback: unknown, deps?: readonly unknown[]) => { const index = slot(undefined); const previous = hooks.memos.get(index); if (previous && same(previous.deps, deps)) return previous.value; hooks.memos.set(index, { deps, value: callback }); return callback; },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = slot(undefined); const previous = hooks.effects.get(index); if (previous && same(previous.deps, deps)) return;
      hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); }); },
  };
});
const doctors = [{ id: 7, kind: "doctor", name: "Actual treating option", commissionPercent: 40 }];
const clinicalCase = { id: 5, kind: "specialty", orthoCaseId: null, patientId: 91, specialty: "periodontics", title: "Recorded case", site: null, problem: null,
  responsibleName: "Case owner", status: "active", startedOn: "2026-10-03", outcome: null };
const cases = { cases: [clinicalCase], problems: [], items: [], dependencies: [], planVisible: false };
const visit = (id = 21, caseId: number | null = 5) => ({ id, patientId: 91, arrivedAt: "2026-10-03T09:00:00Z", signedAt: null,
  totalMinor: 999, doctorId: 9, diagnosis: "Not part of context", structuredClinical: {
    status: "ready", visitId: id, patientId: 91, visitCaseId: caseId, signedAt: null, signedBy: null, endodontics: [], periodontics: [],
  } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: vi.fn(async () => body) });
type Response = ReturnType<typeof response>;
let props: Parameters<typeof usePeriodontalContext>[0];
const fetchMock = vi.fn();
function PeriodontalContextProbe() { return usePeriodontalContext(props); }
function render() { hooks.cursor = 0; const result = PeriodontalContextProbe(); hooks.pending.splice(0).forEach((effect) => effect()); return result; }
async function ready() { render(); await vi.waitFor(() => expect(render().status).toBe("ready")); return render(); }
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  props = { patientId: 91, authorityKey: "synthetic:doctor", visitId: 21, refreshKey: 0 };
  fetchMock.mockReset().mockImplementation(async (url: string) => response(url.includes("/clinical") ? visit(Number(url.split("/")[3])) : url.includes("/parties") ? doctors : cases));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { hooks.effects.forEach((effect) => effect.cleanup?.()); vi.unstubAllGlobals(); });

describe("exact periodontal context projection", () => {
  it.each([null, {}, { openVisit: undefined }, { openVisit: false }, { openVisit: { id: 0 } }])("keeps missing/malformed visit context unknown: %j", (summary) => {
    expect(periodontalVisitId(summary)).toBeUndefined();
  });
  it("distinguishes an explicit no-open-visit result from an exact selected visit", () => {
    expect(periodontalVisitId({ openVisit: null })).toBeNull(); expect(periodontalVisitId({ openVisit: { id: 21 } })).toBe(21);
  });
  it("projects the actual visit case and doctor options without inferring a selected provider or disclosing money/narrative", () => {
    const value = readPeriodontalContext(91, 21, visit(), doctors, cases);
    expect(value.currentVisit).toEqual({ id: 21, patientId: 91, date: "2026-10-03T09:00:00Z", signedAt: null, caseId: 5 });
    expect(value.doctors).toEqual([{ id: 7, name: "Actual treating option" }]);
    expect(value.cases).toEqual([{ id: 5, patientId: 91, title: "Recorded case", specialty: "periodontics", status: "active" }]);
    expect(JSON.stringify(value)).not.toMatch(/commission|diagnosis|totalMinor|Case owner/);
    expect(value.currentVisit).not.toHaveProperty("doctorId");
  });
  it("accepts explicit canonical null case but never omission", () => {
    expect(readPeriodontalContext(91, 21, visit(21, null), doctors, cases).currentVisit?.caseId).toBeNull();
    const missing = visit(); Reflect.deleteProperty(missing.structuredClinical, "visitCaseId");
    expect(() => readPeriodontalContext(91, 21, missing, doctors, cases)).toThrow();
  });
  it.each([
    { ...visit(), id: 22 }, { ...visit(), patientId: 92 }, { ...visit(), arrivedAt: "invalid" },
    { ...visit(), structuredClinical: { ...visit().structuredClinical, patientId: 92 } },
    { ...visit(), structuredClinical: { status: "unavailable", visitId: 21, patientId: 91 } },
    { ...visit(), signedAt: "2026-10-03T09:30:00Z" },
  ])("rejects foreign, incomplete or snapshot-disagreeing clinical reads", (payload) => {
    expect(() => readPeriodontalContext(91, 21, payload, doctors, cases)).toThrow();
  });
  it.each([
    [{ ...doctors[0], kind: "supplier" }], [{ ...doctors[0], id: 0 }], [{ ...doctors[0], name: "" }], [...doctors, ...doctors],
  ])("rejects malformed/duplicate provider options", (payload) => {
    expect(() => readPeriodontalContext(91, 21, visit(), payload, cases)).toThrow();
  });
  it.each([
    { ...cases, cases: [] }, { ...cases, cases: [{ ...clinicalCase, patientId: 92 }] },
    { ...cases, cases: [clinicalCase, clinicalCase] }, { ...cases, cases: [{ ...clinicalCase, specialty: "endodontics" }] },
    { ...cases, cases: [{ ...clinicalCase, status: "completed" }] },
  ])("rejects missing, foreign, duplicate or incompatible linked case context", (payload) => {
    expect(() => readPeriodontalContext(91, 21, visit(), doctors, payload)).toThrow();
  });
  it("allows signed read-only history with a now-completed actual case", () => {
    const signedAt = "2026-10-03T09:30:00Z";
    const signed = { ...visit(), signedAt, structuredClinical: { ...visit().structuredClinical, signedAt } };
    expect(readPeriodontalContext(91, 21, signed, doctors, { ...cases, cases: [{ ...clinicalCase, status: "completed" }] }).currentVisit?.signedAt).toBe(signedAt);
  });
  it("does not select a historical visit for an explicit no-current-visit response", () => {
    expect(readPeriodontalContext(91, null, null, doctors, cases).currentVisit).toBeNull();
    expect(() => readPeriodontalContext(91, null, visit(), doctors, cases)).toThrow();
  });
});

describe("cancel-safe periodontal context reads", () => {
  it("reads only the three canonical endpoints and returns an exact ready context without writes", async () => {
    expect((await ready()).value?.currentVisit?.caseId).toBe(5);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/visits/21/clinical", "/api/parties?kind=doctor", "/api/patients/91/cases"]);
    expect(fetchMock.mock.calls.every(([, options]) => options.method === undefined)).toBe(true);
  });
  it("does not call a visit endpoint for known no-visit or invent readiness from unknown summary", async () => {
    props.visitId = null; expect((await ready()).value?.currentVisit).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(2);
    props.visitId = undefined; expect(render().status).toBe("loading"); expect(render().status).toBe("error");
    expect(render().value).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("invalidates old ready context synchronously on authority or selected visit change", async () => {
    await ready(); props.authorityKey = "synthetic:changed-permission";
    expect(render().status).toBe("loading"); expect(render().value).toBeNull(); await ready();
    props.visitId = 22; expect(render().value).toBeNull(); expect((await ready()).value?.currentVisit?.id).toBe(22);
  });
  it("cannot let an earlier deferred visit read overwrite the newly selected visit", async () => {
    const old = deferred<Response>(); const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string) => url.includes("/visits/21/") ? old.promise : normal(url));
    render(); props.visitId = 22; await ready();
    old.resolve(response(visit())); await Promise.resolve(); await Promise.resolve();
    expect(render().value?.currentVisit?.id).toBe(22);
  });
  it("revokes readiness on a failed refresh rather than presenting cached data as current", async () => {
    await ready(); fetchMock.mockResolvedValue(response({}, 503));
    await render().reload(); expect(render().status).toBe("error"); expect(render().value).toBeNull(); expect(render().denied).toBe(false);
  });
  it("contains an HTML denial immediately even while another context read remains pending", async () => {
    await ready(); const waiting = deferred<Response>(); const denied = response(null, 403);
    denied.json.mockRejectedValue(new Error("HTML response"));
    fetchMock.mockImplementation((url: string) => url.includes("/clinical") ? waiting.promise : url.includes("/parties") ? denied : response(cases));
    const pending = render().reload();
    await vi.waitFor(() => expect(render().denied).toBe(true)); expect(render().value).toBeNull(); expect(denied.json).not.toHaveBeenCalled();
    waiting.resolve(response(visit())); await pending; expect(render().denied).toBe(true);
  });
  it("does not downgrade a denied read to a transient error when a sibling request fails", async () => {
    fetchMock.mockImplementation((url: string) => url.includes("/clinical") ? Promise.reject(new Error("network")) : url.includes("/parties") ? response({}, 403) : response(cases));
    render(); await vi.waitFor(() => expect(render().denied).toBe(true)); expect(render().status).toBe("error");
  });
  it("treats malformed successful bodies as unknown, not empty context", async () => {
    fetchMock.mockResolvedValue(response({})); render(); await vi.waitFor(() => expect(render().status).toBe("error")); expect(render().value).toBeNull();
  });
  it("refreshes the same context only when explicitly requested, including a new saved-structure token", async () => {
    await ready(); render(); expect(fetchMock).toHaveBeenCalledTimes(3);
    props.refreshKey = 1; expect(render().status).toBe("loading"); await ready(); expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
