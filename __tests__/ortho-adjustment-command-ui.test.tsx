import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdjustmentForm } from "../components/PatientOrtho";
import { wiresFor } from "../lib/ortho";

// Exercise the actual standalone form's state and submit handlers with synthetic data.
// Peripheral components are stubbed; no route, database, browser, or real network runs.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, changed: false, pending: [] as Array<() => void>, memos: new Map<number, { value: unknown; deps?: readonly unknown[] }>(),
  session: { userId: 7, username: "synthetic-doctor", role: "doctor", permissions: { canUploadXrays: true } } as Record<string, unknown>,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useContext: () => null,
    useMemo: (compute: () => unknown, deps?: readonly unknown[]) => {
      const index = hooks.cursor++; const before = hooks.memos.get(index);
      if (before && deps && before.deps && deps.length === before.deps.length && deps.every((value, at) => Object.is(value, before.deps![at]))) return before.value;
      const value = compute(); hooks.memos.set(index, { value, deps }); return value;
    },
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = hooks.cursor++; const before = hooks.effects.get(index);
      if (before && deps && before.deps && deps.length === before.deps.length
        && deps.every((value, at) => Object.is(value, before.deps![at]))) return;
      hooks.pending.push(() => {
        before?.cleanup?.();
        hooks.effects.set(index, { deps, cleanup: effect() || undefined });
      });
    },
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) {
        hooks.values[index] = typeof initial === "function" ? initial() : initial;
      }
      return [hooks.values[index], (value: unknown) => {
        const next = typeof value === "function" ? value(hooks.values[index]) : value;
        if (!Object.is(next, hooks.values[index])) hooks.changed = true;
        hooks.values[index] = next;
      }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
  };
});
vi.mock("../components/LegacyOnboardingChecklist", () => ({ LegacyOnboardingChecklist: () => null }));
vi.mock("../components/OrthoPackageLink", () => ({ OrthoPackageLink: () => null }));
vi.mock("../components/PatientCeph", () => ({ PatientCeph: () => null }));
vi.mock("../components/PatientDiagnosis", () => ({ PatientDiagnosis: () => null }));
vi.mock("../components/WebCephRecordsGrid", () => ({ WebCephRecordsGrid: () => null }));
vi.mock("../components/SettingsProvider", () => ({ useClinicName: () => "Synthetic clinic", useSetting: () => "" }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => hooks.session }));

type Props = ComponentProps<typeof AdjustmentForm>;
type Case = Props["caseRow"];
type Element = ReactElement<Record<string, unknown>>;
const base: Case = {
  id: 95001, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null,
  status: "active", phase: "aligning", startDate: "2026-09-01", plannedMonths: 18,
  upperWire: "014 NiTi", lowerWire: "012 NiTi", planId: null, retainer: null, retainerOn: null, note: null,
  closedAt: null, closedBy: null, closedNote: null, baselineKind: null, baselineRecordedAt: null,
  elastics: null, responsibleDoctorName: null, legacyFinancialMode: null, remainingObjectives: null,
  adjustments: [{ id: 94001, visitId: 91001, visitSigned: true, doneOn: "2026-09-01", phase: "aligning",
    upperWire: "012 NiTi", lowerWire: null, elastics: "none", elasticNote: null,
    done: "Historical signed adjustment, not today's work", nextWeeks: 4, note: null,
    recordedBy: "Synthetic clinician", photos: [],
  }],
  progress: { monthsElapsed: 1, monthsPlanned: 18, monthsRemaining: 17, percent: 6,
    overdue: false, adjustments: 1, lastAdjustment: "2026-09-01", daysSinceLast: 33 },
};
const today = "2026-10-04";
const fetchMock = vi.fn();
const onSaved = vi.fn();
const onError = vi.fn();
let caseRow: Case;
let patientId = 92001;
let storage: Map<string, string>;

function render(commit = true) {
  // Layout publication happens after render, then React settles its state before
  // a user can act. Do not simulate effects by mutating values during render.
  for (let round = 0; round < 20; round++) {
    hooks.cursor = 0; hooks.changed = false;
    const tree = AdjustmentForm({ caseRow, today, wires: wiresFor(caseRow.slot), patientId, onSaved, onError });
    if (!commit) return tree;
    hooks.pending.splice(0).forEach(run => run());
    if (!hooks.changed) return tree;
  }
  throw Error("Adjustment form did not settle");
}
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function input(label: string) {
  const node = elements(render()).find((entry) => entry.props["aria-label"] === label);
  if (!node) throw new Error(`Missing adjustment input: ${label}`);
  return node;
}
function edit(label: string, value: string) {
  (input(label).props.onChange as (event: unknown) => void)({ target: { value } });
}
async function submit() {
  const form = render();
  const retry = elements(form).find((entry) => entry.props["data-testid"] === "adjustment-reconcile");
  if (retry) await (retry.props.onClick as (event: unknown) => Promise<void>)({ preventDefault: vi.fn() });
  else await form.props.onSubmit({ preventDefault: vi.fn() });
}
function startNew() {
  const button = elements(render()).find((entry) => entry.props["data-testid"] === "adjustment-new-intent");
  if (!button) throw new Error("Missing explicit new intent");
  (button.props.onClick as () => void)();
}
const body = (index = 0) => JSON.parse(String(fetchMock.mock.calls[index][1].body)) as Record<string, unknown>;
const response = (status: number, value: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => value });

function unmount() {
  // Genuine remount discards memoized owners and runs their layout cleanup,
  // not only useState slots. Ordinary rerenders preserve every hook lifetime.
  for (const effect of hooks.effects.values()) effect.cleanup?.();
  hooks.effects.clear(); hooks.memos.clear(); hooks.values = []; hooks.cursor = 0; hooks.pending = []; hooks.changed = false;
}

beforeEach(() => {
  unmount();
  vi.clearAllMocks();
  caseRow = structuredClone(base);
  fetchMock.mockReset();
  patientId = 92001;
  hooks.session = { userId: 7, username: "synthetic-doctor", role: "doctor", permissions: { canUploadXrays: true } };
  storage = new Map();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => response(201, {
    id: 96001, patientId, caseId: caseRow.id, visitId: 91002, attachedToToday: true,
    requestKey: (init.headers as Record<string, string>)["Idempotency-Key"],
  }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { unmount(); vi.unstubAllGlobals(); });

// Deterministic actual-handler tests with a hook simulator, not browser E2E.
describe("durable standalone adjustment commands", () => {
  it("latches same-turn duplicate submits and sends a secure request key", async () => {
    const form = render();
    await Promise.all([form.props.onSubmit({ preventDefault() {} }), form.props.onSubmit({ preventDefault() {} })]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toMatch(/^ortho-adjust:[a-z0-9-]+$/);
  });
  it.each(["network", "500", "body", "foreign acknowledgement"])("freezes body/key after %s", async (failure) => {
    if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("Lost response"));
    else if (failure === "body") fetchMock.mockResolvedValueOnce({ ok: true, status: 201, json: async () => { throw new Error("truncated"); } });
    else fetchMock.mockResolvedValueOnce(response(failure === "500" ? 500 : 201, { id: 96001, patientId: 999, caseId: 95001 }));
    edit("ما نُفّذ في الشدّة", "Exact clinical command");
    await submit();
    edit("ما نُفّذ في الشدّة", "Must not replace unresolved command");
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toEqual(fetchMock.mock.calls[0][1]);
    expect(body(1).done).toBe("Exact clinical command");
    expect(onSaved).toHaveBeenCalledOnce();
  });
  it("recovers across reload without automatic send, then explicitly retries the exact command", async () => {
    fetchMock.mockRejectedValueOnce(new Error("lost"));
    edit("ما نُفّذ في الشدّة", "Frozen before reload");
    await submit(); unmount(); render();
    expect(fetchMock).toHaveBeenCalledOnce();
    await submit();
    expect(fetchMock.mock.calls[1][1]).toEqual(fetchMock.mock.calls[0][1]);
    expect(onSaved).toHaveBeenCalledOnce();
  });
  it.each(["patient", "authority"])("does not reuse another %s's command", async (transition) => {
    fetchMock.mockRejectedValueOnce(new Error("lost"));
    await submit();
    if (transition === "patient") patientId = 92002;
    else hooks.session = { ...hooks.session, userId: 8, username: "other-doctor" };
    await submit();
    expect(fetchMock.mock.calls[1][1].headers["Idempotency-Key"]).not.toBe(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]);
  });
  it.each(["permissions", "role"])("preserves unresolved identity across same-actor %s changes", async (change) => {
    fetchMock.mockRejectedValueOnce(new Error("lost acknowledgement"));
    edit("ما نُفّذ في الشدّة", "Frozen before authority refresh");
    await submit();
    const first = fetchMock.mock.calls[0][1];
    hooks.session = change === "role" ? { ...hooks.session, role: "admin" }
      : { ...hooks.session, permissions: { canUploadXrays: false, canEditPlans: false } };
    render();
    edit("ما نُفّذ في الشدّة", "Must not supersede original intent");
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toEqual(first);
    expect(body(1).done).toBe("Frozen before authority refresh");
  });
  it("keeps unresolved command through forbidden role and restores it only after a current grant", async () => {
    fetchMock.mockRejectedValueOnce(new Error("lost"));
    edit("ما نُفّذ في الشدّة", "Frozen before role withdrawal"); await submit();
    const first = fetchMock.mock.calls[0][1];
    hooks.session = { ...hooks.session, role: "reception" }; await submit();
    expect(fetchMock).toHaveBeenCalledOnce();
    unmount(); hooks.session = { ...hooks.session, role: "admin" }; await submit();
    expect(fetchMock.mock.calls[1][1]).toEqual(first);
  });
  it("retains an acknowledged tombstone across a same-actor permission refresh", async () => {
    await submit(); const original = [...storage.values()][0];
    unmount(); hooks.session = { ...hooks.session, permissions: { canUploadXrays: false } };
    await submit();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect([...storage.values()]).toEqual([original]);
    expect(onSaved).toHaveBeenCalledTimes(2);
  });
  it("does not let a different immutable actor with the same username recover the old command", async () => {
    fetchMock.mockRejectedValueOnce(new Error("lost")); await submit();
    const first = fetchMock.mock.calls[0][1];
    const oldStored = [...storage.values()][0];
    hooks.session = { ...hooks.session, userId: 8 }; render();
    expect(elements(render()).some((entry) => entry.props["data-testid"] === "adjustment-reconcile")).toBe(false);
    await submit();
    expect(fetchMock.mock.calls[1][1].headers["Idempotency-Key"]).not.toBe(first.headers["Idempotency-Key"]);
    expect([...storage.values()]).toContain(oldStored);
    unmount(); hooks.session = { ...hooks.session, userId: 7 }; await submit();
    expect(fetchMock.mock.calls[2][1]).toEqual(first);
  });
  it("preserves unresolved intent when the same immutable actor's display username changes", async () => {
    fetchMock.mockRejectedValueOnce(new Error("lost"));
    edit("ما نُفّذ في الشدّة", "Original clinical intent"); await submit();
    const first = fetchMock.mock.calls[0][1];
    unmount(); hooks.session = { ...hooks.session, username: "renamed-doctor" }; await submit();
    expect(fetchMock.mock.calls[1][1]).toEqual(first);
  });
  it.each([undefined, null, 0, -1, 1.5, "7"])("fails closed without a valid immutable actor id (%s)", async (userId) => {
    hooks.session = { ...hooks.session, userId }; await submit();
    expect(fetchMock).not.toHaveBeenCalled(); expect(storage.size).toBe(0);
  });
  it("retires captured handlers on a same-username immutable actor replacement", async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const old = render(); const pending = old.props.onSubmit({ preventDefault() {} });
    hooks.session = { ...hooks.session, userId: 8 }; render();
    resolve(response(201, { id: 96001, patientId, caseId: caseRow.id,
      requestKey: fetchMock.mock.calls[0][1].headers["Idempotency-Key"], visitId: null, attachedToToday: false }));
    await pending; await old.props.onSubmit({ preventDefault() {} });
    expect(fetchMock).toHaveBeenCalledOnce(); expect(onSaved).not.toHaveBeenCalled();
    expect(JSON.parse([...storage.values()][0]).receipt).toBeNull();
  });
  it("retired permission closure cannot retry or apply a late response", async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const old = render(); const pending = old.props.onSubmit({ preventDefault() {} });
    hooks.session = { ...hooks.session, role: "reception" }; render();
    resolve(response(201, { id: 96001, patientId, caseId: caseRow.id, requestKey: fetchMock.mock.calls[0][1].headers["Idempotency-Key"], visitId: null, attachedToToday: false }));
    await pending;
    await old.props.onSubmit({ preventDefault() {} }); await submit();
    expect(fetchMock).toHaveBeenCalledOnce(); expect(onSaved).not.toHaveBeenCalled();
  });
  it.each(["malformed", "foreign", "money", "bad key"])("rejects %s stored command without replacing it", async (kind) => {
    fetchMock.mockRejectedValueOnce(new Error("lost")); await submit();
    const [key, raw] = [...storage][0]; const command = JSON.parse(raw);
    if (kind === "foreign") command.scope.patientId++;
    if (kind === "money") command.body = JSON.stringify({ ...JSON.parse(command.body), amount: 100 });
    if (kind === "bad key") command.key = "bad";
    storage.set(key, kind === "malformed" ? "{" : JSON.stringify(command));
    const corrupt = storage.get(key); unmount(); await submit();
    expect(fetchMock).toHaveBeenCalledOnce(); expect(storage.get(key)).toBe(corrupt);
  });
  it("creates distinct keys for legitimate equal-content new intent only after acknowledgement", async () => {
    await submit(); const original = fetchMock.mock.calls[0][1];
    await submit(); // reconcile saved command, not new clinical intent
    expect(fetchMock).toHaveBeenCalledOnce();
    startNew(); await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].body).toBe(original.body);
    expect(fetchMock.mock.calls[1][1].headers["Idempotency-Key"]).not.toBe(original.headers["Idempotency-Key"]);
  });
  it("never repeats photos after an acknowledged result and interrupted parent callback", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic-photo");
    const file = new File(["synthetic"], "test.png", { type: "image/png" });
    (input("اختيار صور").props.onChange as (event: unknown) => void)({ target: { files: [file], value: "" } });
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init: RequestInit) => url.includes("documents") ? Promise.resolve(response(200, { id: 23 })) : normal(url, init));
    onSaved.mockImplementationOnce(() => { throw new Error("parent refresh lost"); });
    await submit(); expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount(); await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("لم تُعد محاولة رفع الصور"));
  });
  it("skips photo uploads after recovery of a lost adjustment response", async () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic-photo");
    (input("اختيار صور").props.onChange as (event: unknown) => void)({ target: { files: [new File(["x"], "x.png", { type: "image/png" })], value: "" } });
    fetchMock.mockRejectedValueOnce(new Error("lost")); await submit(); await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => url === "/api/ortho/95001")).toBe(true);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ photosUploaded: 0 }));
  });
  it("fails closed when persistence is unavailable before sending", async () => {
    vi.stubGlobal("sessionStorage", { getItem() { return null; }, setItem() { throw new Error("quota"); } });
    await submit(); await submit();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("new adjustment text validation remains editable",()=>{
 it("preserves oversized authored text without storage/network and permits correction",async()=>{
  const text="x".repeat(401); edit("ما نُفّذ في الشدّة",text); await submit();
  expect(fetchMock).not.toHaveBeenCalled(); expect(storage.size).toBe(0);
  expect(input("ما نُفّذ في الشدّة").props.value).toBe(text);
  expect(onError).toHaveBeenLastCalledWith(expect.stringContaining("400"));
  edit("ما نُفّذ في الشدّة","Corrected complete text"); await submit();
  expect(fetchMock).toHaveBeenCalledOnce(); expect(body().done).toBe("Corrected complete text");
 });
 it("retries an existing oversized frozen request unchanged rather than blocking or rewriting it",async()=>{
  fetchMock.mockRejectedValueOnce(new Error("lost")); await submit();
  const [key,raw]=[...storage.entries()][0]; const command=JSON.parse(raw);
  command.body=JSON.stringify({...JSON.parse(command.body),done:"x".repeat(401)});
  storage.set(key,JSON.stringify(command)); unmount(); await submit();
  expect(fetchMock).toHaveBeenCalledTimes(2); expect(fetchMock.mock.calls[1][1].body).toBe(command.body);
  expect(fetchMock.mock.calls[1][1].headers["Idempotency-Key"]).toBe(command.key);
 });
});

describe('explicit authored adjustment interval and date',()=>{
 it.each(['','0','not-a-number','-1','1.5','53'])('does not silently persist invalid interval %j as four weeks',async value=>{
  edit('أسابيع حتى الشدّة القادمة',value);await submit();expect(fetchMock).not.toHaveBeenCalled();expect(storage.size).toBe(0);expect(input('أسابيع حتى الشدّة القادمة').props.value).toBe(value);
 });
 it('does not freeze or send an empty authored session date',async()=>{
  edit('تاريخ الشدّة','');await submit();expect(fetchMock).not.toHaveBeenCalled();expect(storage.size).toBe(0);
 });
 it.each(['1','52',' 4 '])('persists valid authored interval %j exactly as its numeric value',async value=>{
  edit('أسابيع حتى الشدّة القادمة',value);await submit();expect(JSON.parse(fetchMock.mock.calls[0][1].body).nextWeeks).toBe(Number(value));
 });
 it('keeps invalid interval editable and removes the fabricated default preview until correction',async()=>{
  edit('أسابيع حتى الشدّة القادمة','bad');await submit();expect(elements(render()).some(n=>typeof n.props.children==='string'&&n.props.children.includes('موعد المتابعة المقترح غير متاح'))).toBe(true);expect(fetchMock).not.toHaveBeenCalled();
  edit('أسابيع حتى الشدّة القادمة','6');await submit();expect(JSON.parse(fetchMock.mock.calls[0][1].body).nextWeeks).toBe(6);
 });
 it('replays a frozen command unchanged even if the visible interval is now invalid',async()=>{
  fetchMock.mockRejectedValueOnce(new Error('lost'));edit('أسابيع حتى الشدّة القادمة','6');await submit();const original=fetchMock.mock.calls[0][1];edit('أسابيع حتى الشدّة القادمة','bad');await submit();expect(fetchMock.mock.calls[1][1]).toEqual(original);
 });

});


describe("authored session calendar date admission", () => {
  it.each(["", "2026-02-30", "2025-02-29", "2026-13-01", "0000-01-01"])("keeps invalid date %j editable without freezing or sending", async value => {
    edit("تاريخ الشدّة", value); await submit();
    expect(fetchMock).not.toHaveBeenCalled(); expect(storage.size).toBe(0);
    edit("تاريخ الشدّة", "2024-02-29"); await submit();
    expect(fetchMock).toHaveBeenCalledOnce(); expect(body().doneOn).toBe("2024-02-29");
  });
  it("does not calculate a proposed follow-up from an impossible date", () => {
    edit("تاريخ الشدّة", "2026-02-30");
    expect(elements(render()).some(n => typeof n.props.children === "string" && n.props.children.includes("تاريخ جلسة صحيح"))).toBe(true);
  });
  it.each(["2000-02-29", "2024-02-29", "2026-11-06", "2099-12-31"])("preserves valid authored date %s without a past/future policy", async value => {
    edit("تاريخ الشدّة", value); await submit();
    expect(fetchMock).toHaveBeenCalledOnce(); expect(body().doneOn).toBe(value);
  });
  it("replays a frozen legacy impossible date unchanged after remount", async () => {
    fetchMock.mockRejectedValueOnce(new Error("lost")); await submit();
    const [key, raw] = [...storage.entries()][0]; const command = JSON.parse(raw);
    command.body = JSON.stringify({ ...JSON.parse(command.body), doneOn: "2026-02-30" });
    storage.set(key, JSON.stringify(command)); unmount();
    edit("تاريخ الشدّة", ""); await submit();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].body).toBe(command.body);
    expect(fetchMock.mock.calls[1][1].headers["Idempotency-Key"]).toBe(command.key);
  });

});


describe("lossless authored interval string admission", () => {
  it.each(["1.0000000000000001", "51.9999999999999999"])("does not freeze a rounded near-integer %s", async value => {
    edit("أسابيع حتى الشدّة القادمة", value); await submit();
    expect(fetchMock).not.toHaveBeenCalled(); expect(storage.size).toBe(0);
    expect(input("أسابيع حتى الشدّة القادمة").props.value).toBe(value);
  });
  it("does not preview a rounded near-integer as an authored interval", () => {
    edit("أسابيع حتى الشدّة القادمة", "1.0000000000000001");
    expect(elements(render()).some(n => typeof n.props.children === "string" && n.props.children.includes("موعد المتابعة المقترح غير متاح"))).toBe(true);
  });
  it.each(["+1", "1.0", "1e0", ".1e1", " 01 ", "0x4", "0b100", "0o4"])("retains exact integral spelling %s", async value => {
    edit("أسابيع حتى الشدّة القادمة", value); await submit(); expect(body().nextWeeks).toBe(Number(value));
  });
  it("allows correction without losing the input and keeps frozen retry unchanged", async () => {
    edit("أسابيع حتى الشدّة القادمة", "1.0000000000000001"); await submit(); expect(fetchMock).not.toHaveBeenCalled();
    edit("أسابيع حتى الشدّة القادمة", "6"); fetchMock.mockRejectedValueOnce(new Error("lost")); await submit();
    const frozen = fetchMock.mock.calls[0][1]; edit("أسابيع حتى الشدّة القادمة", "1.0000000000000001"); await submit();
    expect(fetchMock.mock.calls[1][1]).toEqual(frozen);
  });

});


it("does not publish command recovery for an abandoned actor render", async () => {
  fetchMock.mockRejectedValueOnce(Error("Uncertain original command")); await submit();
  const originalSession = hooks.session, memos = new Map(hooks.memos), values = [...hooks.values];
  const retry = elements(render()).find(entry => entry.props["data-testid"] === "adjustment-reconcile")!;
  hooks.session = { ...hooks.session, userId: 99 }; render(false);
  hooks.pending = []; hooks.memos = memos; hooks.values = values; hooks.session = originalSession;
  await (retry.props.onClick as (event: unknown) => Promise<void>)({ preventDefault() {} });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][1]).toEqual(fetchMock.mock.calls[0][1]);
});
