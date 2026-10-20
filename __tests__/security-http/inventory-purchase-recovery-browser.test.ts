import { build } from "esbuild";
import { createHash } from "node:crypto";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalPurchaseRequest } from "../../lib/inventory-purchase-protocol";
import { createPurchaseCommand, type PurchaseCommand } from "../../lib/inventory-purchase-command";
import type { PurchaseAttempt } from "../../components/inventory/useDurablePurchaseAttempt";
import type { PurchaseJournal, PurchaseScope } from "../../lib/purchase-command-journal";

// Real React StrictMode, current InventoryOverview, and real IndexedDB. Only the
// HTTP service is synthetic. No production data or mocked hook/storage is used.
const ORIGIN = "http://127.0.0.1:39879";
const ACTOR = "synthetic-purchase-owner", ACTOR_ID = 7, ITEM_ID = 19;
const SCOPE = { actor: ACTOR, actorUserId: ACTOR_ID, itemId: ITEM_ID };
const DOCUMENT = { kind: "in", qty: 1.001, expiryDate: null, unitCost: "25", supplierPartyId: 5, reason: "Synthetic purchase" };
type Snapshot = { ready: boolean; error: string | null; attempt: PurchaseAttempt | null; resultKind: string | null };
interface Fixture {
  run(document?: Record<string, unknown>): Promise<string | null>;
  consume(): void;
  refresh(): Promise<void>;
  snapshot(): Snapshot;
  journal(scope: PurchaseScope): Promise<PurchaseJournal>;
  reserve(scope: PurchaseScope, revision: number, command: PurchaseCommand): Promise<PurchaseJournal>;
  acknowledge(scope: PurchaseScope, command: PurchaseCommand): Promise<PurchaseJournal>;
  switchSession(username: string): void;
}
declare global { interface Window { __purchaseFixture: Fixture } }
let browser: Browser, source: string;
beforeAll(async () => {
  const bundle = await build({
    absWorkingDir: process.cwd(),
    stdin: { contents: `
      import React, { StrictMode, useState } from "react";
      import { createRoot } from "react-dom/client";
      import { SessionProvider, useSessionActions } from "./components/SessionProvider";
      import { useDurablePurchaseAttempt } from "./components/inventory/useDurablePurchaseAttempt";
      import InventoryOverview from "./components/inventory/InventoryOverview";
      import { readPurchaseJournal, reservePurchaseCommand, acknowledgePurchaseCommand } from "./lib/purchase-command-journal";
      const options = JSON.parse(new URL(location.href).searchParams.get("mount") || "{}");
      let settled = null;
      function Fixture() {
        const hook = useDurablePurchaseAttempt(${ITEM_ID});
        const session = useSessionActions();
        const [resultKind, setResultKind] = useState(null);
        window.__purchaseFixture = {
          run: async document => {
            const result = await hook.run(document);
            if (result?.kind === "settled") settled = result.attempt;
            setResultKind(result?.kind || null); return result?.kind || null;
          },
          consume: () => { if (settled) hook.consume(settled); },
          refresh: hook.refresh,
          snapshot: () => ({ ready: hook.ready, error: hook.error, attempt: hook.attempt, resultKind }),
          journal: readPurchaseJournal, reserve: reservePurchaseCommand, acknowledge: acknowledgePurchaseCommand,
          switchSession: username => session.setSession({ username, role: "admin" }),
        };
        return <main><output id="phase">{hook.attempt?.phase || "idle"}</output>
          <input aria-label="Draft quantity" disabled={!hook.ready || !!hook.attempt} />
          <button onClick={() => void window.__purchaseFixture.run()} disabled={!hook.ready || hook.attempt?.phase === "sending"}>Retry saved purchase</button>
        </main>;
      }
      createRoot(document.getElementById("root")).render(<StrictMode>
        <SessionProvider value={{ username: options.actor || "${ACTOR}", role: "admin" }}>
          {options.ui ? <InventoryOverview /> : <Fixture />}
        </SessionProvider>
      </StrictMode>);
    `, sourcefile: "purchase-recovery-fixture.tsx", loader: "tsx", resolveDir: process.cwd() },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
  });
  source = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 120_000);
afterAll(async () => { await browser?.close(); });
type Captured = { route: Route; key: string; body: string; actor: string; actorId: string; url: string };
const identity = ({ key, body, actor, actorId, url }: Captured) => ({ key, body, actor, actorId, url });
const snapshot = (page: Page) => page.evaluate(() => window.__purchaseFixture.snapshot());
const journal = (page: Page) => page.evaluate(scope => window.__purchaseFixture.journal(scope), SCOPE);
const url = (mount: { actor?: string; ui?: boolean } = {}) => `${ORIGIN}/?mount=${encodeURIComponent(JSON.stringify(mount))}`;
async function open(mount: { actor?: string; ui?: boolean } = {}) {
  const context = await browser.newContext(), requests: Captured[] = [], errors: string[] = [];
  const auth = { id: ACTOR_ID, username: mount.actor || ACTOR, role: "admin" };
  let readsFail = false;
  const item = { id: ITEM_ID, name: "Synthetic stock", category: "other", unit: "piece", minLevel: 1, note: null, isActive: true, balance: 2, status: "ok" };
  context.on("page", page => {
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", dialog => { void dialog.accept(); });
  });
  await context.route("**/*", async route => {
    const request = route.request(), path = new URL(request.url());
    if (path.origin !== ORIGIN) throw new Error(`Unexpected external request: ${path.origin}`);
    if (path.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: source });
    if (path.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script>' });
    if (path.pathname === "/api/auth/me") return route.fulfill({ json: auth });
    if (request.method() === "POST" && path.pathname === `/api/inventory/${ITEM_ID}/movements`) {
      requests.push({ route, body: request.postData() ?? "", key: request.headers()["idempotency-key"] ?? "",
        actor: request.headers()["x-purchase-actor"] ?? "", actorId: request.headers()["x-purchase-actor-id"] ?? "", url: path.pathname });
      return;
    }
    if (path.pathname === "/api/parties") return route.fulfill({ json: [{ id: 5, name: "Synthetic supplier", isActive: true }] });
    if (path.pathname === "/api/inventory") return route.fulfill(readsFail ? { status: 503, json: { message: "Synthetic refresh failure" } }
      : { json: { items: [item], alerts: { lowItems: [], expired: [], soon: [] } } });
    if (path.pathname === `/api/inventory/${ITEM_ID}`) return route.fulfill(readsFail ? { status: 503, json: { message: "Synthetic refresh failure" } }
      : { json: { item, movements: [], batches: { batches: [], adjustTotal: 0 } } });
    return route.abort();
  });
  const page = await context.newPage(); await page.goto(url(mount));
  if (!mount.ui) await expect.poll(async () => (await snapshot(page)).ready).toBe(true);
  return { context, page, requests, errors, auth, failReads: () => { readsFail = true; },
    reply: (index: number, payload: unknown, status = 201) => requests[index].route.fulfill({ status, json: payload }),
  };
}
function proof(request: Captured, rejected = false) {
  const purchase = JSON.parse(request.body).purchase as Record<string, unknown>;
  const common = { protocol: "inventory-purchase-v1", actorUserId: Number(request.actorId), requestKey: request.key,
    requestDigest: createHash("sha256").update(canonicalPurchaseRequest(ITEM_ID, purchase)).digest("hex"), itemId: ITEM_ID, replayed: false };
  if (rejected) return { ...common, status: "rejected", message: "المورّد غير موجود أو موقوف." };
  return { ...common, status: "committed", movementId: 42, payableCreated: !!purchase.supplierPartyId,
    result: { ok: true, balance: 3.001, movement: { id: 42, itemId: ITEM_ID, kind: "in", qty: purchase.qty,
      expiryDate: purchase.expiryDate ?? null, reason: purchase.reason ?? null, visitId: null, isReturn: false,
      createdBy: decodeURIComponent(request.actor), createdAt: "2026-10-20T14:00:00Z" } } };
}
async function start(page: Page, requests: Captured[], document?: Record<string, unknown>) {
  const count = requests.length;
  await page.evaluate(document => { void window.__purchaseFixture.run(document); }, document);
  await expect.poll(() => requests.length).toBe(count + 1);
  await expect.poll(async () => (await snapshot(page)).attempt?.phase).toBe("sending");
  return requests[count];
}
async function uncertain(page: Page, first: Captured) {
  await expect.poll(async () => (await snapshot(page)).attempt?.phase).toBe("uncertain");
  expect((await journal(page)).command).toMatchObject({ key: first.key, body: first.body, actorUserId: ACTOR_ID });
  expect(await page.getByLabel("Draft quantity").isDisabled()).toBe(true);
}

describe("purchase recovery through real browser IndexedDB", () => {
  it("arbitrates competing reservations and preserves revision tombstones against a stale tab", async () => {
    const f = await open();
    try {
      const second = await f.context.newPage(); await second.goto(url());
      await expect.poll(async () => (await snapshot(second)).ready).toBe(true);
      const commands = await Promise.all([1, 2].map(qty => createPurchaseCommand(ACTOR, ACTOR_ID, ITEM_ID, { kind: "in", qty })));
      const reserved = await Promise.all([f.page, second].map((page, index) => page.evaluate(({ scope, command }) =>
        window.__purchaseFixture.reserve(scope, 0, command), { scope: SCOPE, command: commands[index] })));
      expect(reserved[0]).toEqual(reserved[1]);
      const original = reserved[0].command!;
      await f.page.evaluate(({ scope, original }) => window.__purchaseFixture.acknowledge(scope, original), { scope: SCOPE, original });
      expect(await journal(f.page)).toEqual({ revision: 1, command: null });
      const replacement = await createPurchaseCommand(ACTOR, ACTOR_ID, ITEM_ID, { kind: "in", qty: 3 });
      expect(await second.evaluate(async ({ scope, replacement }) => {
        try { await window.__purchaseFixture.reserve(scope, 0, replacement); return "unexpected"; }
        catch (error) { return (error as { code: string }).code; }
      }, { scope: SCOPE, replacement })).toBe("changed");
      // Replaying the same old identity is safe; it may not become a fresh key.
      expect(await second.evaluate(({ scope, original }) => window.__purchaseFixture.reserve(scope, 0, original), { scope: SCOPE, original }))
        .toEqual({ revision: 1, command: original });
      await second.evaluate(({ scope, original }) => window.__purchaseFixture.acknowledge(scope, original), { scope: SCOPE, original });
      expect(await journal(f.page)).toEqual({ revision: 1, command: null });
      expect(f.requests).toHaveLength(0);
    } finally { await f.context.close(); }
  });
  it("encodes a non-ASCII username while retaining numeric principal binding", async () => {
    const actor = "مستخدم-اختبار", f = await open({ actor });
    try {
      const first = await start(f.page, f.requests, DOCUMENT);
      expect(first.actor).toBe(encodeURIComponent(actor)); expect(first.actorId).toBe(String(ACTOR_ID));
      await f.reply(0, proof(first));
      await expect.poll(async () => (await snapshot(f.page)).attempt?.phase).toBe("settled");
      expect(await f.page.evaluate(scope => window.__purchaseFixture.journal(scope), { ...SCOPE, actor })).toEqual({ revision: 1, command: null });
    } finally { await f.context.close(); }
  });
  it("reserves once for same-tick double submission and sends only after durable transaction completion", async () => {
    const f = await open();
    try {
      await f.page.evaluate(() => {
        const tx = IDBDatabase.prototype.transaction;
        const tracking = { complete: false, strict: false, sentAfterComplete: false };
        Object.assign(window, { purchaseDurability: tracking });
        IDBDatabase.prototype.transaction = function (...args) {
          const result = tx.apply(this, args);
          if (args[1] === "readwrite") {
            tracking.complete = false; tracking.strict = args[2]?.durability === "strict";
            result.addEventListener("complete", () => { tracking.complete = true; });
          }
          return result;
        };
        const fetchOriginal = window.fetch;
        window.fetch = (...args) => {
          if (args[1]?.method === "POST") tracking.sentAfterComplete = tracking.complete;
          return fetchOriginal(...args);
        };
      });
      await f.page.evaluate(document => { void window.__purchaseFixture.run(document); void window.__purchaseFixture.run(document); }, DOCUMENT);
      await expect.poll(() => f.requests.length).toBe(1);
      expect((await journal(f.page)).command).toMatchObject({ key: f.requests[0].key, body: f.requests[0].body });
      expect(await f.page.evaluate(() => (window as unknown as { purchaseDurability: object }).purchaseDurability))
        .toMatchObject({ strict: true, sentAfterComplete: true });
      expect(f.requests[0].actor).toBe(ACTOR); expect(f.requests[0].actorId).toBe(String(ACTOR_ID));
      expect(JSON.parse(f.requests[0].body)).not.toHaveProperty("kind");
      await f.reply(0, proof(f.requests[0]));
      await expect.poll(async () => (await snapshot(f.page)).attempt?.phase).toBe("settled");
      expect(await journal(f.page)).toEqual({ revision: 1, command: null });
      expect(await f.page.evaluate(() => window.__purchaseFixture.run())).toBe("settled");
      expect(f.requests).toHaveLength(1);
      await f.page.evaluate(() => { window.__purchaseFixture.consume(); window.__purchaseFixture.consume(); });
      await expect.poll(async () => (await snapshot(f.page)).attempt).toBeNull();
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });
  it("restores response-loss recovery after reload and retries the exact original key/body", async () => {
    const f = await open();
    try {
      const first = await start(f.page, f.requests, DOCUMENT);
      await first.route.abort("failed"); await uncertain(f.page, first);
      await f.page.reload(); await expect.poll(async () => (await snapshot(f.page)).ready).toBe(true);
      await uncertain(f.page, first);
      expect(await f.page.evaluate(document => window.__purchaseFixture.run(document), { ...DOCUMENT, qty: 2 })).toBe("blocked");
      const retry = await start(f.page, f.requests); expect(identity(retry)).toEqual(identity(first));
      await f.reply(1, { ...proof(retry), replayed: true }, 200);
      await expect.poll(async () => (await snapshot(f.page)).attempt?.phase).toBe("settled");
      expect(await journal(f.page)).toEqual({ revision: 1, command: null });
    } finally { await f.context.close(); }
  });
  it.each(["malformed", "wrong-key", "wrong-digest", "wrong-actor", "wrong-movement", "generic-409", "unauthorized", "server-error", "redirect"])(
    "retains %s rather than creating a replacement command", async failure => {
      const f = await open();
      try {
        const first = await start(f.page, f.requests, DOCUMENT), valid = proof(first);
        if (failure === "malformed") await first.route.fulfill({ status: 201, body: "not JSON", contentType: "application/json" });
        else if (failure === "redirect") await first.route.fulfill({ status: 307, headers: { location: `${ORIGIN}/` } });
        else if (failure === "generic-409") await f.reply(0, { message: "Rejected without a durable receipt" }, 409);
        else if (failure === "unauthorized") await f.reply(0, { message: "Login required" }, 401);
        else if (failure === "server-error") await f.reply(0, valid, 500);
        else {
          const patches: Record<string, Record<string, unknown>> = {
            "wrong-key": { requestKey: crypto.randomUUID() }, "wrong-digest": { requestDigest: "0".repeat(64) },
            "wrong-actor": { actorUserId: 8 }, "wrong-movement": { movementId: 43 },
          };
          await f.reply(0, { ...valid, ...patches[failure] });
        }
        await uncertain(f.page, first);
        const retry = await start(f.page, f.requests); expect(identity(retry)).toEqual(identity(first));
        await f.reply(1, { ...proof(retry), replayed: true }, 200);
        await expect.poll(async () => (await snapshot(f.page)).attempt?.phase).toBe("settled");
      } finally { await f.context.close(); }
    });
  it("bounds a hung transport and retains the immutable purchase for retry", async () => {
    const f = await open();
    try {
      await f.page.clock.install();
      const first = await start(f.page, f.requests, DOCUMENT);
      await f.page.clock.fastForward(20_001);
      await uncertain(f.page, first);
      const retry = await start(f.page, f.requests); expect(identity(retry)).toEqual(identity(first));
      await f.reply(1, { ...proof(retry), replayed: true }, 200);
      await expect.poll(async () => (await snapshot(f.page)).attempt?.phase).toBe("settled");
    } finally { await f.context.close(); }
  });
  it("does not lose recovery when local retirement fails after a valid receipt", async () => {
    const f = await open();
    try {
      const first = await start(f.page, f.requests, DOCUMENT);
      await f.page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        Object.assign(window, { restorePurchaseStorage: () => { IDBObjectStore.prototype.put = put; } });
        IDBObjectStore.prototype.put = function (...args) { const request = put.apply(this, args); this.transaction.abort(); return request; };
      });
      await f.reply(0, proof(first)); await uncertain(f.page, first);
      await f.page.evaluate(() => (window as unknown as { restorePurchaseStorage(): void }).restorePurchaseStorage());
      const retry = await start(f.page, f.requests); expect(identity(retry)).toEqual(identity(first));
      await f.reply(1, { ...proof(retry), replayed: true }, 200);
      await expect.poll(async () => (await snapshot(f.page)).attempt?.phase).toBe("settled");
    } finally { await f.context.close(); }
  });
  it("terminal rejection unlocks editing only after matching persisted rejection evidence", async () => {
    const f = await open();
    try {
      const first = await start(f.page, f.requests, DOCUMENT); await first.route.abort("failed"); await uncertain(f.page, first);
      const retry = await start(f.page, f.requests); await f.reply(1, proof(retry, true), 409);
      await expect.poll(async () => (await snapshot(f.page)).attempt?.receipt?.status).toBe("rejected");
      expect(await journal(f.page)).toEqual({ revision: 1, command: null });
      await f.page.evaluate(() => window.__purchaseFixture.consume());
      const next = await start(f.page, f.requests, { ...DOCUMENT, supplierPartyId: undefined });
      expect(next.key).not.toBe(first.key);
      await f.reply(2, proof(next)); await expect.poll(async () => (await snapshot(f.page)).attempt?.phase).toBe("settled");
    } finally { await f.context.close(); }
  });
  it("coordinates second-tab recovery and keeps the first tab's original receipt requirement", async () => {
    const f = await open();
    try {
      const first = await start(f.page, f.requests, DOCUMENT); await first.route.abort("failed"); await uncertain(f.page, first);
      const second = await f.context.newPage(); await second.goto(url());
      await expect.poll(async () => (await snapshot(second)).ready).toBe(true);
      expect((await snapshot(second)).attempt?.command.key).toBe(first.key);
      const retry = await start(second, f.requests); expect(identity(retry)).toEqual(identity(first));
      await f.reply(1, { ...proof(retry), replayed: true }, 200);
      await expect.poll(async () => (await snapshot(second)).attempt?.phase).toBe("settled");
      await f.page.evaluate(() => window.__purchaseFixture.refresh());
      expect((await snapshot(f.page)).attempt?.command.key).toBe(first.key);
      const ownRetry = await start(f.page, f.requests); expect(identity(ownRetry)).toEqual(identity(first));
      await f.reply(2, { ...proof(ownRetry), replayed: true }, 200);
      await expect.poll(async () => (await snapshot(f.page)).attempt?.phase).toBe("settled");
      expect(await journal(f.page)).toEqual({ revision: 1, command: null });
    } finally { await f.context.close(); }
  });
  it("sends nothing when durable reservation aborts, including abort after put success", async () => {
    const f = await open();
    try {
      await f.page.evaluate(() => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) { const request = put.apply(this, args); this.transaction.abort(); return request; };
      });
      expect(await f.page.evaluate(document => window.__purchaseFixture.run(document), DOCUMENT)).toBe("blocked");
      expect(f.requests).toHaveLength(0); expect((await journal(f.page)).command).toBeNull();
    } finally { await f.context.close(); }
  });
  it("fails closed when storage becomes unavailable after hydration", async () => {
    const f = await open();
    try {
      await f.page.evaluate(() => { Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true }); });
      expect(await f.page.evaluate(document => window.__purchaseFixture.run(document), DOCUMENT)).toBe("blocked");
      expect(f.requests).toHaveLength(0);
    } finally { await f.context.close(); }
  });
  it("does not leak or replay another principal's recovery on a session switch", async () => {
    const f = await open();
    try {
      const first = await start(f.page, f.requests, DOCUMENT); await first.route.abort("failed"); await uncertain(f.page, first);
      f.auth.id = 8; f.auth.username = "another-owner";
      await f.page.evaluate(() => window.__purchaseFixture.switchSession("another-owner"));
      await expect.poll(async () => (await snapshot(f.page)).ready).toBe(true);
      expect((await snapshot(f.page)).attempt).toBeNull();
      expect(await f.page.evaluate(() => window.__purchaseFixture.run())).toBe("busy");
      expect(f.requests).toHaveLength(1);
      expect((await journal(f.page)).command?.key).toBe(first.key);
    } finally { await f.context.close(); }
  });
  it("revokes in-flight UI ownership after /me detects a reused username with another numeric id", async () => {
    const f = await open();
    try {
      const first = await start(f.page, f.requests, DOCUMENT);
      f.auth.id = 8;
      await f.page.evaluate(() => window.__purchaseFixture.refresh());
      expect((await snapshot(f.page)).attempt).toBeNull();
      expect((await snapshot(f.page)).ready).toBe(false);
      await f.reply(0, proof(first));
      await expect.poll(async () => (await journal(f.page)).command).toBeNull();
      expect((await snapshot(f.page)).attempt).toBeNull();
      expect((await snapshot(f.page)).resultKind).not.toBe("settled");
      expect(await f.page.evaluate(document => window.__purchaseFixture.run(document), DOCUMENT)).toBeNull();
    } finally { await f.context.close(); }
  });
  it("revokes a delayed hash before any reservation/network send on detected principal change", async () => {
    const f = await open();
    try {
      await f.page.evaluate(document => {
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
        Object.assign(window, { releasePurchaseHash: release });
        crypto.subtle.digest = async (...args) => { await gate; return digest(...args); };
        void window.__purchaseFixture.run(document);
      }, DOCUMENT);
      f.auth.id = 8; await f.page.evaluate(() => window.__purchaseFixture.refresh());
      await f.page.evaluate(() => (window as unknown as { releasePurchaseHash(): void }).releasePurchaseHash());
      expect((await snapshot(f.page)).ready).toBe(false);
      expect(f.requests).toHaveLength(0); expect((await journal(f.page)).command).toBeNull();
    } finally { await f.context.close(); }
  });
  it("integrates with the existing detail form, freezes values, and cannot revive success after refresh failure", async () => {
    const f = await open({ ui: true });
    try {
      await f.page.getByRole("button", { name: "سجل الحركات" }).click();
      await f.page.getByRole("button", { name: "إدخال (شراء/استلام)" }).click();
      await f.page.getByLabel("الكمية (piece) *", { exact: true }).fill("1.001");
      await f.page.getByLabel(/ثمن الوحدة للشراء/).fill("25");
      await f.page.getByLabel("المورّد", { exact: true }).selectOption("5");
      await expect.poll(async () => f.page.getByRole("button", { name: "تأكيد وقيد الحركة" }).isEnabled()).toBe(true);
      await f.page.getByRole("button", { name: "تأكيد وقيد الحركة" }).click();
      await expect.poll(() => f.requests.length).toBe(1);
      expect(await f.page.getByLabel("الكمية (piece) *", { exact: true }).isDisabled()).toBe(true);
      expect(await f.page.getByLabel("المورّد", { exact: true }).isDisabled()).toBe(true);
      await f.requests[0].route.abort("failed");
      await expect.poll(async () => f.page.getByRole("button", { name: "إعادة محاولة الشراء المحفوظ" }).isEnabled()).toBe(true);
      await f.page.reload(); await f.page.getByRole("button", { name: "سجل الحركات" }).click();
      await expect.poll(async () => f.page.getByLabel("الكمية (piece) *", { exact: true }).inputValue()).toBe("1.001");
      await f.page.getByRole("button", { name: "إعادة محاولة الشراء المحفوظ" }).click();
      await expect.poll(() => f.requests.length).toBe(2);
      expect(identity(f.requests[1])).toEqual(identity(f.requests[0]));
      f.failReads(); await f.reply(1, { ...proof(f.requests[1]), replayed: true }, 200);
      await expect.poll(async () => f.page.getByTestId("purchase-recovery").count()).toBe(0);
      expect(f.requests).toHaveLength(2);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });
});
