import { describe, expect, it, vi } from "vitest";
import type { Route } from "playwright";
import { guardBrowserRoutes, type RouteContext } from "./helpers/guarded-browser-routes";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let routeHandler!: (route: Route) => Promise<void>;
  let closed = false;
  const context: RouteContext = {
    route: vi.fn(async (_pattern: string, handler: (route: Route) => Promise<void>) => { routeHandler = handler; }),
    close: vi.fn(async () => { closed = true; }),
  };
  const route = (method = "GET", url = "http://clinic.test/api/visits/readiness") => ({
    request: () => ({ method: () => method, url: () => url }),
    abort: vi.fn(async () => {}),
    fulfill: vi.fn(async () => {}),
    fetch: vi.fn(async () => ({ json: async () => {
      if (closed) throw new Error("Response has been disposed");
      return { visit: { patientId: 1 } };
    } })),
  });
  return { context, route, dispatch: (request: ReturnType<typeof route>) => routeHandler(request as unknown as Route) };
}

describe("guarded browser route teardown", () => {
  it("holds close until a fetched response is decoded and fulfilled", async () => {
    const f = fixture(), entered = deferred(), release = deferred(), bodyDone = deferred();
    const unexpected: string[] = [];
    const guard = await guardBrowserRoutes(f.context, "http://clinic.test", unexpected, async route => {
      const response = await route.fetch(); entered.resolve(); await release.promise;
      const payload = await response.json(); expect(payload.visit.patientId).toBe(1);
      await route.fulfill({ json: payload });
    });
    const request = f.route(), routed = f.dispatch(request); await entered.promise;
    const run = guard.run(async () => { bodyDone.resolve(); }, () => expect(unexpected).toEqual([]));
    await bodyDone.promise; await Promise.resolve();
    expect(f.context.close).not.toHaveBeenCalled();
    release.resolve(); await routed; await run;
    expect(request.fulfill).toHaveBeenCalledOnce();
    expect(f.context.close).toHaveBeenCalledOnce();
    expect(request.abort).not.toHaveBeenCalled();
  });

  it.each(["malformed JSON", "failed assertion"])("keeps %s fatal while draining an active handler", async kind => {
    const f = fixture(), entered = deferred(), release = deferred(), bodyDone = deferred();
    const guard = await guardBrowserRoutes(f.context, "http://clinic.test", [], async route => {
      const response = await route.fetch(); entered.resolve(); await release.promise;
      if (kind === "malformed JSON") await response.json();
      else expect(200).toBe(503);
    });
    const request = f.route();
    if (kind === "malformed JSON") request.fetch.mockResolvedValue({ json: async () => JSON.parse("{") });
    const routed = f.dispatch(request); await entered.promise;
    const run = guard.run(async () => { bodyDone.resolve(); }, () => {});
    const rejected = expect(run).rejects.toThrow(kind === "malformed JSON" ? /JSON/ : /503/);
    await bodyDone.promise; await Promise.resolve();
    expect(f.context.close).not.toHaveBeenCalled();
    release.resolve(); await routed; await rejected;
    expect(request.abort).toHaveBeenCalledOnce();
    expect(f.context.close).toHaveBeenCalledOnce();
  });

  it.each(["during drain", "during close"])("blocks a late write and fails its final assertion %s", async phase => {
    const f = fixture(), entered = deferred(), release = deferred(), bodyDone = deferred();
    const unexpected: string[] = [], writes: string[] = [];
    const guard = await guardBrowserRoutes(f.context, "http://clinic.test", unexpected, async route => {
      if (route.request().method() === "PATCH") writes.push("PATCH");
      entered.resolve(); await release.promise; await route.fulfill({ json: {} });
    });
    const pending = f.dispatch(f.route()); await entered.promise;
    const late = f.route("PATCH", "http://clinic.test/api/patients/1");
    if (phase === "during close") vi.mocked(f.context.close).mockImplementation(async () => { await f.dispatch(late); });
    const run = guard.run(async () => {
      expect(writes).toEqual([]); expect(unexpected).toEqual([]); bodyDone.resolve();
    }, () => {
      expect(writes).toEqual([]); expect(unexpected).toEqual([]);
    });
    const rejected = expect(run).rejects.toHaveProperty("name", "AssertionError");
    await bodyDone.promise; await Promise.resolve();
    if (phase === "during drain") await f.dispatch(late);
    release.resolve(); await pending; await rejected;
    expect(late.abort).toHaveBeenCalledOnce(); expect(late.fetch).not.toHaveBeenCalled();
    expect(late.fulfill).not.toHaveBeenCalled(); expect(writes).toEqual([]);
    expect(unexpected).toEqual(["PATCH http://clinic.test/api/patients/1 during teardown"]);
  });

  it("aborts an ordinary retirement read without starting another fetch", async () => {
    const f = fixture(), unexpected: string[] = [];
    const guard = await guardBrowserRoutes(f.context, "http://clinic.test", unexpected, async route => { await route.fetch(); });
    const late = f.route();
    vi.mocked(f.context.close).mockImplementation(async () => { await f.dispatch(late); });
    await guard.run(async () => {}, () => expect(unexpected).toEqual([]));
    expect(late.abort).toHaveBeenCalledOnce(); expect(late.fetch).not.toHaveBeenCalled();
  });

  it("keeps off-origin retirement requests blocked and reported", async () => {
    const f = fixture(), unexpected: string[] = [];
    const guard = await guardBrowserRoutes(f.context, "http://clinic.test", unexpected, async route => { await route.fetch(); });
    const late = f.route("GET", "https://outside.test/track");
    vi.mocked(f.context.close).mockImplementation(async () => { await f.dispatch(late); });
    await expect(guard.run(async () => {}, () => expect(unexpected).toEqual([]))).rejects.toHaveProperty("name", "AssertionError");
    expect(late.abort).toHaveBeenCalledOnce(); expect(late.fetch).not.toHaveBeenCalled();
    expect(late.fulfill).not.toHaveBeenCalled();
    expect(unexpected).toEqual(["GET https://outside.test/track during teardown"]);
  });

  it.each(["during drain", "during close"])("fails on a page error delivered %s", async phase => {
    const f = fixture(), errors: string[] = [], entered = deferred(), release = deferred(), bodyDone = deferred();
    const guard = await guardBrowserRoutes(f.context, "http://clinic.test", [], async route => {
      entered.resolve(); await release.promise;
      if (phase === "during drain") errors.push("late page failure");
      await route.fulfill({ json: {} });
    });
    const pending = f.dispatch(f.route()); await entered.promise;
    if (phase === "during close") vi.mocked(f.context.close).mockImplementation(async () => { errors.push("late page failure"); });
    const run = guard.run(async () => { expect(errors).toEqual([]); bodyDone.resolve(); }, () => expect(errors).toEqual([]));
    const rejected = expect(run).rejects.toThrow(/late page failure/);
    await bodyDone.promise; await Promise.resolve();
    release.resolve(); await pending; await rejected;
  });

  it("retains the original test failure alongside cleanup and final-check failures", async () => {
    const f = fixture(), original = new Error("original assertion"), closeError = new Error("close failure"), finalError = new Error("late page failure");
    const guard = await guardBrowserRoutes(f.context, "http://clinic.test", [], async route => { await route.fulfill({ json: {} }); });
    vi.mocked(f.context.close).mockRejectedValue(closeError);
    const error = await guard.run(async () => { throw original; }, () => { throw finalError; }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([original, closeError, finalError]);
    expect(f.context.close).toHaveBeenCalledOnce();
  });

  it.each(["handler", "abort", "close"])("bounds a stalled %s while attempting close and preserving all failures", async stalled => {
    vi.useFakeTimers();
    try {
      const f = fixture(), entered = deferred(), bodyDone = deferred();
      const forever = new Promise<void>(() => undefined);
      const original = new Error("original assertion"), finalError = new Error("late verification failure"), routeError = new Error("route assertion");
      const guard = await guardBrowserRoutes(f.context, "http://clinic.test", [], async route => {
        if (stalled === "handler") { entered.resolve(); await forever; }
        if (stalled === "abort") throw routeError;
        await route.fulfill({ json: {} });
      });
      const request = f.route();
      if (stalled === "abort") request.abort.mockImplementation(async () => { entered.resolve(); await forever; });
      const routed = f.dispatch(request);
      if (stalled === "close") {
        await routed;
        vi.mocked(f.context.close).mockImplementation(async () => { await forever; });
      } else await entered.promise;
      const verify = vi.fn(() => { throw finalError; });
      const completed = guard.run(async () => { bodyDone.resolve(); throw original; }, verify).catch(error => error);
      await bodyDone.promise; await Promise.resolve();
      await vi.runAllTimersAsync();
      expect(f.context.close).toHaveBeenCalledOnce();
      expect(verify).toHaveBeenCalledOnce();
      const error = await completed;
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors).toContain(original); expect(error.errors).toContain(finalError);
      expect(error.errors.some((failure: Error) => failure.message.includes("route retirement deadline"))).toBe(true);
      if (stalled === "abort") expect(error.errors).toContain(routeError);
    } finally { vi.useRealTimers(); }
  });
});
