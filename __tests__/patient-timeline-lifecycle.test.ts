import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePatientTimeline } from "../components/patient/usePatientTimeline";

// Pure hook scheduling harness, no browser, server, DB, live permissions or role mutation.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, setters: new Map<number, (value: unknown) => void>(),
  layouts: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(), pendingLayouts: [] as Array<() => void>,
  effects: new Map<number, { deps?: readonly unknown[]; cleanup?: () => void }>(),
  memos: new Map<number, { deps?: readonly unknown[]; value: unknown }>(), pending: [] as Array<() => void> }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = initial; return index; };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return { ...react,
    useState: (initial: unknown) => { const index = slot(typeof initial === "function" ? initial() : initial);
      if (!hooks.setters.has(index)) hooks.setters.set(index, (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; });
      return [hooks.values[index], hooks.setters.get(index)]; },
    useRef: (initial: unknown) => hooks.values[slot({ current: initial })],
    useCallback: (callback: unknown, deps?: readonly unknown[]) => { const index = slot(undefined); const previous = hooks.memos.get(index); if (previous && same(previous.deps, deps)) return previous.value; hooks.memos.set(index, { deps, value: callback }); return callback; },
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = slot(undefined); const previous = hooks.layouts.get(index); if (previous && same(previous.deps, deps)) return; hooks.pendingLayouts.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.layouts.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); }); },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = slot(undefined); const previous = hooks.effects.get(index); if (previous && same(previous.deps, deps)) return; hooks.pending.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.effects.set(index, { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }); }); },
  };
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: vi.fn(async () => body) });
const rich = (patientId = 91) => ({ patientId, canSeeFinancial: true,
  sources: { plans: true, documents: true, financial: true, appointments: "all" }, events: [
    { key: "invoice:41", kind: "invoice", at: "2026-10-01T10:00:00Z", title: "PRIVATE MONEY", detail: "PRIVATE METHOD", amountMinor: 111, currency: "USD", href: `/patients/${patientId}?tab=account` },
    { key: "document:42", kind: "document", at: "2026-10-01T10:00:00Z", title: "PRIVATE FILE", detail: null, amountMinor: null, currency: null, href: `/patients/${patientId}?tab=files` },
  ] });
const scoped = (patientId = 91) => ({ patientId, canSeeFinancial: false,
  sources: { plans: false, documents: false, financial: false, appointments: "scoped" }, events: [] });
let options = { patientId: 91, authorityKey: "reader:admin", refreshKey: 0, readable: true, open: true };
let pendingResponse: ReturnType<typeof response> | Promise<ReturnType<typeof response>>;
function ResourceProbe() { return usePatientTimeline(options); }
function render(flush = true, commit = true) {
  hooks.cursor = 0; const result = ResourceProbe();
  if (commit) hooks.pendingLayouts.splice(0).forEach((effect) => effect());
  if (flush) hooks.pending.splice(0).forEach((effect) => effect());
  return result;
}
/** Discard a speculative render's state/memos/effects, as React does on abandonment.
 * Ref objects intentionally remain shared: a render-time ref mutation would leak
 * into the committed owner and fail these assertions. No speculative effect runs. */
function abandon(next: Partial<typeof options>) {
  const committed = { values: hooks.values, memos: hooks.memos, pending: hooks.pending, pendingLayouts: hooks.pendingLayouts, options };
  hooks.values = [...hooks.values]; hooks.memos = new Map(hooks.memos); hooks.pending = []; hooks.pendingLayouts = [];
  options = { ...options, ...next };
  const result = render(false, false);
  hooks.values = committed.values; hooks.memos = committed.memos; hooks.pending = committed.pending; hooks.pendingLayouts = committed.pendingLayouts; options = committed.options;
  return result;
}
const flush = () => hooks.pending.splice(0).forEach((effect) => effect());
async function settle() { await vi.advanceTimersByTimeAsync(0); }
beforeEach(() => {
  vi.useFakeTimers(); hooks.values = []; hooks.cursor = 0; hooks.setters.clear(); hooks.layouts.clear(); hooks.pendingLayouts = []; hooks.effects.clear(); hooks.memos.clear(); hooks.pending = [];
  options = { patientId: 91, authorityKey: "reader:admin", refreshKey: 0, readable: true, open: true };
  pendingResponse = response(rich()); vi.stubGlobal("fetch", vi.fn(() => pendingResponse));
});
afterEach(() => { hooks.layouts.forEach((effect) => effect.cleanup?.()); hooks.effects.forEach((effect) => effect.cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("patient timeline current-authority lifecycle", () => {
  it("waits for explicit current parent readiness and open state", async () => {
    options.readable = false; render(); await settle(); expect(fetch).not.toHaveBeenCalled();
    options.readable = true; options.open = false; render(); await settle(); expect(fetch).not.toHaveBeenCalled();
    options.open = true; render(); await settle(); expect(render().payload?.events).toHaveLength(2);
  });
  it("hides a successful snapshot before effects when a refresh begins and peers remain pending", async () => {
    render(); await settle(); expect(render().payload?.events).toHaveLength(2);
    options.refreshKey++; options.readable = false;
    expect(render(false).payload).toBeNull(); flush();
    await settle(); expect(render().payload).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
    // Failed parent refresh keeps readiness false even after loading stops.
    options.refreshKey++; render(); await settle(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("reloads after parent peers confirm current authority, with no restored old snapshot", async () => {
    render(); await settle(); options.refreshKey++; options.readable = false; render();
    pendingResponse = response(scoped()); options.readable = true;
    expect(render(false).payload).toBeNull(); flush(); await settle();
    expect(render().payload).toEqual(scoped());
  });
  it.each([401, 403, 404, 500, 503])("clears successful events before a %s body and never waits for that body", async (status) => {
    render(); await settle(); const denied = response(null, status);
    denied.json.mockImplementation(() => new Promise(() => {})); pendingResponse = denied;
    const reload = render().reload(); expect(render().payload).toBeNull();
    await reload; expect(render().payload).toBeNull(); expect(render().error).not.toBeNull(); expect(denied.json).not.toHaveBeenCalled();
  });
  it("fences an old JSON body behind a newer denial", async () => {
    render(); await settle(); const body = deferred<unknown>(); const oldResponse = response(null);
    oldResponse.json.mockImplementation(() => body.promise); pendingResponse = oldResponse;
    const oldRead = render().reload(); await settle();
    pendingResponse = response(null, 403); await render().reload();
    body.resolve(rich()); await oldRead; expect(render().payload).toBeNull(); expect(render().error).not.toBeNull();
  });
  it("fences old response bodies immediately on same-patient authority narrowing", async () => {
    const body = deferred<unknown>(); const oldResponse = response(null); oldResponse.json.mockImplementation(() => body.promise);
    pendingResponse = oldResponse; render(); await settle();
    options.authorityKey = "reader:doctor:no-plan-no-files"; pendingResponse = response(scoped());
    expect(render(false).payload).toBeNull(); body.resolve(rich()); await settle(); expect(render(false).payload).toBeNull();
    flush(); await settle(); expect(render().payload).toEqual(scoped());
  });
  it("fences patient switches before effects and rejects cross-patient payloads", async () => {
    render(); await settle(); options.patientId = 92;
    expect(render(false).payload).toBeNull(); flush(); await settle();
    expect(render().payload).toBeNull(); expect(render().error).toContain("غير مكتملة");
  });
  it("closes and reopens with a new read, never reusing earlier sensitive events", async () => {
    render(); await settle(); options.open = false; expect(render(false).payload).toBeNull(); flush();
    pendingResponse = response(scoped()); options.open = true; expect(render(false).payload).toBeNull(); flush(); await settle();
    expect(fetch).toHaveBeenCalledTimes(2); expect(render().payload).toEqual(scoped());
  });
  it("does not revive an old body across close/reopen even before effect cleanup", async () => {
    const body = deferred<unknown>(); const oldResponse = response(null); oldResponse.json.mockImplementation(() => body.promise);
    pendingResponse = oldResponse; render(); await settle(); options.open = false; render(false);
    options.open = true; pendingResponse = response(scoped()); render(false);
    body.resolve(rich()); await settle(); expect(render(false).payload).toBeNull();
    flush(); await settle(); expect(render().payload).toEqual(scoped());
  });
  it("does not overwrite a newer success with stale denied headers", async () => {
    const headers = deferred<ReturnType<typeof response>>(); pendingResponse = headers.promise;
    render(); pendingResponse = response(scoped()); await render().reload();
    headers.resolve(response(null, 403)); await settle(); expect(render().payload).toEqual(scoped());
  });
  it("does not update after unmount", async () => {
    const body = deferred<unknown>(); const slow = response(null); slow.json.mockImplementation(() => body.promise);
    pendingResponse = slow; render(); await settle(); hooks.layouts.forEach((effect) => effect.cleanup?.()); hooks.effects.forEach((effect) => effect.cleanup?.());
    const before = JSON.stringify(hooks.values); body.resolve(rich()); await settle(); expect(JSON.stringify(hooks.values)).toBe(before);
  });
  it("clears stale events on rejected fetch, invalid JSON, or legacy success", async () => {
    render(); await settle(); vi.mocked(fetch).mockRejectedValueOnce(new Error("network")); await render().reload();
    expect(render().payload).toBeNull(); expect(render().error).not.toBeNull();
    const bad = response(null); bad.json.mockRejectedValue(new Error("JSON")); pendingResponse = bad; await render().reload();
    expect(render().payload).toBeNull(); expect(render().error).not.toBeNull();
    pendingResponse = response({ events: [] }); await render().reload(); expect(render().payload).toBeNull(); expect(render().error).toContain("غير مكتملة");
  });
  it("abandoned owner render neither retires a committed read nor publishes to a future owner", async () => {
    render(); await settle(); expect(render().payload).toEqual(rich());
    const body = deferred<unknown>(); const waiting = response(null); waiting.json.mockImplementation(() => body.promise);
    pendingResponse = waiting; const committedRead = render().reload(); await settle();
    const signal = vi.mocked(fetch).mock.calls.at(-1)?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    const beforeFetches = vi.mocked(fetch).mock.calls.length;
    expect(abandon({ authorityKey: "future:restricted", refreshKey: 7 }).payload).toBeNull();
    expect(signal?.aborted).toBe(false); expect(fetch).toHaveBeenCalledTimes(beforeFetches);
    body.resolve(rich()); await committedRead; expect(render().payload).toEqual(rich());
    // The same future owner now really commits. A discarded render cannot seed
    // its data or request; only this committed effect can obtain a fresh read.
    options.authorityKey = "future:restricted"; options.refreshKey = 7; pendingResponse = response(scoped());
    expect(render(false).payload).toBeNull(); flush(); await settle(); expect(render().payload).toEqual(scoped());
    expect(fetch).toHaveBeenCalledTimes(beforeFetches + 1);
  });
  it("a committed new owner masks old body completion before passive cleanup runs", async () => {
    render(); await settle(); const body = deferred<unknown>(); const waiting = response(null);
    waiting.json.mockImplementation(() => body.promise); pendingResponse = waiting;
    const oldRead = render().reload(); await settle();
    options.authorityKey = "committed:restricted"; options.refreshKey++;
    expect(render(false).payload).toBeNull();
    // Completion still targets the old state key. It cannot become readable in
    // the newly committed owner during the pre-passive-cleanup interval.
    body.resolve(rich()); await oldRead; expect(render(false).payload).toBeNull();
    pendingResponse = response(scoped()); flush(); await settle(); expect(render().payload).toEqual(scoped());
  });
  it("retired effect microtasks cannot start an obsolete owner's read", async () => {
    render(); options.authorityKey = "current:restricted"; pendingResponse = response(scoped()); render();
    await settle(); expect(fetch).toHaveBeenCalledTimes(1); expect(render().payload).toEqual(scoped());
  });

  it("retained reload after unmount cannot clear state or start another request", async () => {
    render(); await settle(); const retained = render().reload;
    hooks.layouts.forEach((effect) => effect.cleanup?.());
    // Layout retirement is sufficient before delayed passive unmount cleanup.
    const before = JSON.stringify(hooks.values); const calls = vi.mocked(fetch).mock.calls.length;
    await retained(); expect(fetch).toHaveBeenCalledTimes(calls); expect(JSON.stringify(hooks.values)).toBe(before);
  });
  it("retained A reload cannot clear or abort B after B commits before passive cleanup", async () => {
    render(); await settle(); const retained = render().reload;
    options.authorityKey = "B:committed"; const next = render(false);
    const body = deferred<unknown>(); const waiting = response(null); waiting.json.mockImplementation(() => body.promise);
    pendingResponse = waiting; const current = next.reload(); await settle();
    const signal = vi.mocked(fetch).mock.calls.at(-1)?.[1]?.signal; const calls = vi.mocked(fetch).mock.calls.length;
    const before = JSON.stringify(hooks.values);
    await retained(); expect(fetch).toHaveBeenCalledTimes(calls); expect(signal?.aborted).toBe(false);
    expect(JSON.stringify(hooks.values)).toBe(before);
    body.resolve(scoped()); await current; expect(render(false).payload).toEqual(scoped());
  });
  it("old passive cleanup cannot cancel a new owner's keyed request", async () => {
    render(); await settle(); const oldCleanup = [...hooks.effects.values()][0].cleanup;
    options.authorityKey = "B:committed"; const next = render(false);
    const body = deferred<unknown>(); const waiting = response(null); waiting.json.mockImplementation(() => body.promise);
    pendingResponse = waiting; const current = next.reload(); await settle();
    const signal = vi.mocked(fetch).mock.calls.at(-1)?.[1]?.signal;
    oldCleanup?.(); expect(signal?.aborted).toBe(false);
    body.resolve(scoped()); await current; expect(render(false).payload).toEqual(scoped());
  });

});
