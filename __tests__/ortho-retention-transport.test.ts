import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendRetentionCommand, hasRetentionNoStore } from "../lib/ortho-retention-transport";
import { makeRetentionOwner } from "../lib/ortho-retention-owner";
import { makeRetentionRecoveryLedger } from "../lib/ortho-retention-recovery";
import { expectation, scope } from "./fixtures/ortho-retention-ui";
const transport = vi.fn();
beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("fetch", transport); transport.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup() {
  const access = { allowed: true }, recovery = makeRetentionRecoveryLedger();
  const owner = makeRetentionOwner({ ...scope, actorId: 17, recovery, authorized: () => access.allowed, writable: () => access.allowed,
    admitFresh: () => true, canDiscardQuarantined: () => false, deny() { access.allowed = false; } }); owner.activate(); owner.change("authored draft");
  return { owner, access, recovery };
}
// Transport tests intentionally use only errors/refusals. Actual successful saves
// must be exercised by the real built-route HTTP/native sources, not a fake writer.
describe("retention transport uncertainty", () => {
  it("never sends a captured lease after permanent retirement", async () => {
    const { owner } = setup(), lease = owner.begin(expectation(), owner.document)!; owner.retire();
    expect(await sendRetentionCommand(lease)).toBe("retired"); expect(transport).not.toHaveBeenCalled();
  });
  it("retains byte-identical commands after network failure and exact retry", async () => {
    const { owner } = setup(); transport.mockRejectedValue(new TypeError("synthetic connection loss"));
    const first = owner.begin(expectation(), owner.document)!; expect(await sendRetentionCommand(first)).toBe("uncertain");
    const retry = owner.beginRetry()!; expect(await sendRetentionCommand(retry)).toBe("uncertain");
    expect(transport.mock.calls.map(call => call[1].body)).toEqual([first.body, first.body]); expect(owner.uncertain).toBe(true); expect(owner.document).toBe("authored draft");
  });
  it("current401/403 closes private visibility and leaves uncertain recovery", async () => {
    const { owner, recovery } = setup(); transport.mockResolvedValue(new Response(null, { status: 403 }));
    expect(await sendRetentionCommand(owner.begin(expectation(), owner.document)!)).toBe("denied");
    expect(owner.active()).toBe(false); expect(owner.document).toBe(""); expect(owner.beginRetry()).toBeNull(); expect(recovery.needsUnloadWarning()).toBe(true);
  });
  it("settles a valid fresh refusal but keeps a refusal on retry unresolved", async () => {
    const { owner } = setup(); transport.mockImplementation(async () => new Response(JSON.stringify({ ok: false, code: "revision_changed" }), { status: 409, headers: { "cache-control": "no-store" } }));
    expect(await sendRetentionCommand(owner.begin(expectation(), owner.document)!)).toBe("refused"); expect(owner.uncertain).toBe(false); expect(owner.dirty).toBe(true);
    const second = owner.begin(expectation(), owner.document)!; second.markUncertain(); second.finish();
    expect(await sendRetentionCommand(owner.beginRetry()!)).toBe("refused"); expect(owner.uncertain).toBe(true);
  });
  it("rejects missing privacy headers, malformed success and malformed error as uncertainty", async () => {
    for (const response of [new Response("{}", { status: 201 }), new Response("{}", { status: 201, headers: { "cache-control": "no-store" } }),
      new Response("bad", { status: 409, headers: { "cache-control": "no-store" } })]) {
      const { owner } = setup(); transport.mockResolvedValue(response);
      expect(await sendRetentionCommand(owner.begin(expectation(), owner.document)!)).toBe("uncertain"); expect(owner.uncertain).toBe(true);
    }
  });
  it("timeout aborts transport without releasing the immutable recovery command", async () => {
    vi.useFakeTimers(); const { owner } = setup();
    transport.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    const pending = sendRetentionCommand(owner.begin(expectation(), owner.document)!);
    await vi.advanceTimersByTimeAsync(20_000); expect(await pending).toBe("uncertain"); expect(owner.busy).toBe(false); expect(owner.uncertain).toBe(true);
  });
});

it("admits only an actual no-store directive and refuses following redirects with a private body", async () => {
  for (const value of ["no-store", "private, No-Store, max-age=0"]) expect(hasRetentionNoStore(new Response(null, { headers: { "cache-control": value } }))).toBe(true);
  for (const value of ["x=no-store", "no-store-extra", "private", "no-store=token", 'foo="a,no-store,b"', 'foo="x",no-store']) expect(hasRetentionNoStore(new Response(null, { headers: { "cache-control": value } }))).toBe(false);
  const { owner } = setup(); transport.mockRejectedValue(new TypeError("redirect rejected"));
  expect(await sendRetentionCommand(owner.begin(expectation(), owner.document)!)).toBe("uncertain");
  expect(transport.mock.calls[0][1]).toMatchObject({ redirect: "error", credentials: "same-origin" }); expect(owner.uncertain).toBe(true);
});
it("keeps the deadline active after headers resolve while the actual response body remains stalled", async () => {
  vi.useFakeTimers(); const { owner } = setup(); let bodyRead = false, headersReturned = false;
  transport.mockImplementation(async (_url: string, init: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { init.signal?.addEventListener("abort", () => controller.error(new Error("synthetic body aborted")), { once: true }); },
      pull() { bodyRead = true; return new Promise<void>(() => {}); },
    });
    headersReturned = true; return new Response(stream, { status: 201, headers: { "cache-control": "no-store" } });
  });
  const lease = owner.begin(expectation(), owner.document)!, pending = sendRetentionCommand(lease);
  await vi.advanceTimersByTimeAsync(1); expect(headersReturned).toBe(true); expect(bodyRead).toBe(true); expect(owner.busy).toBe(true);
  await vi.advanceTimersByTimeAsync(19_999); expect(await pending).toBe("uncertain"); expect(owner.busy).toBe(false); expect(owner.uncertain).toBe(true);
  expect(owner.beginRetry()?.body).toBe(lease.body);
});

it("rechecks the admitted lease after the asynchronous verifier's completion boundary", async () => {
  // A transport-boundary race probe only. It does not represent a clinical
  // success or replace the actual-owner/strict-receipt/real-writer evidence.
  let current = true, finishedWhileCurrent: boolean | null = null;
  const lease: Parameters<typeof sendRetentionCommand>[0] = { orthoCaseId: scope.orthoCaseId, body: "{}", current: () => current,
    checkHeaders: () => current, async confirmResponse() { queueMicrotask(() => { current = false; }); return true; },
    refuse() {}, markUncertain() {}, finish() { finishedWhileCurrent = current; } };
  transport.mockResolvedValue(new Response("{}", { status: 201, headers: { "cache-control": "no-store" } }));
  expect(await sendRetentionCommand(lease)).toBe("retired"); expect(finishedWhileCurrent).toBe(false);
});
