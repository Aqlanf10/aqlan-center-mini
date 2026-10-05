import type { Route } from "playwright";

type RouteHandler = (route: Route) => Promise<void>;
export interface RouteContext {
  route(pattern: string, handler: RouteHandler): Promise<unknown>;
  close(): Promise<void>;
}

/** Keep synthetic write/origin containment installed until its context closes. */
export async function guardBrowserRoutes(
  context: RouteContext, baseUrl: string, unexpected: string[], handler: RouteHandler,
) {
  let retiring = false;
  const active = new Set<Promise<void>>();
  const failures: unknown[] = [];
  await context.route("**/*", async route => {
    const work = (async () => {
      try {
        if (retiring) {
          const request = route.request(), url = new URL(request.url()), method = request.method();
          if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(method)) {
            unexpected.push(`${method} ${url.origin}${url.pathname} during teardown`);
          }
          await route.abort();
          return;
        }
        await handler(route);
      } catch (error) {
        failures.push(error);
        // A failed assertion/decoder must also release the intercepted request.
        try { await route.abort(); } catch (abortError) { failures.push(abortError); }
      }
    })();
    active.add(work);
    try { await work; } finally { active.delete(work); }
  });
  const drain = async () => {
    while (active.size > 0) await Promise.all([...active]);
  };
  return {
    async run(body: () => Promise<void>, verifyAfterClose: () => void) {
      try { await body(); } catch (error) { failures.push(error); }
      retiring = true;
      const deadline = Date.now() + 5_000;
      const bounded = async (stage: string, operation: () => Promise<void>) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            // Invoke close even when a preceding drain exhausted the deadline.
            Promise.resolve().then(operation),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error(`${stage} exceeded the route retirement deadline`)), Math.max(0, deadline - Date.now()));
            }),
          ]);
        } catch (error) { failures.push(error); }
        finally { if (timeout !== undefined) clearTimeout(timeout); }
      };
      try {
        // Started fetch/JSON callbacks retain their live APIRequestContext.
        await bounded("Active route drain", drain);
      } finally {
        await bounded("Browser context close", () => context.close());
        // Catch callbacks and page errors delivered while close was in flight.
        await bounded("Final route drain", drain);
      }
      try { verifyAfterClose(); } catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Browser route lifecycle failed");
    },
  };
}
