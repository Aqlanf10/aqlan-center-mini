import { build } from "esbuild";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MoneyAttempt, MoneyRequest } from "../../lib/money-attempt";
import type { MoneyReceiptContext } from "../../lib/durable-money-command";
import type { FinancialCommandScope, FinancialJournal } from "../../lib/financial-command-journal";

// Real React StrictMode, useMoneyAttempt's durable branch, receipt validation and
// real IndexedDB. Only the HTTP service is synthetic; no application server,
// PostgreSQL instance, live data or mocked hook/storage implementation is used.
const ORIGIN = "http://127.0.0.1:39878";
const ACTOR = "synthetic-ack-owner";
const PATIENT = 9;
const SCOPE = { actor: ACTOR, patientId: PATIENT };
const STORED_RATE = 140.123457;
const RAW_RATE = 140.1234567;
type Mount = { actor?: string; patientId?: number; owner?: string; receipt?: MoneyReceiptContext; viewKey?: string };
type Snapshot = { ready: boolean; error: string | null; attempt: MoneyAttempt | null; resultKind: string | null };
interface FixtureApi {
  run(request?: MoneyRequest): Promise<string | null>;
  consume(): void;
  snapshot(): Snapshot;
  journal(scope: FinancialCommandScope): Promise<FinancialJournal>;
}
declare global { interface Window { __durableAckFixture: FixtureApi } }
let browser: Browser;
let script: string;

beforeAll(async () => {
  const bundle = await build({
    absWorkingDir: process.cwd(),
    stdin: { contents: `
      import React, { StrictMode, useState } from "react";
      import { createRoot } from "react-dom/client";
      import { SessionProvider } from "./components/SessionProvider";
      import { useMoneyAttempt } from "./components/useMoneyAttempt";
      import { readFinancialJournal } from "./lib/financial-command-journal";
      const options = JSON.parse(new URL(location.href).searchParams.get("mount") || "{}");
      const actor = options.actor || "${ACTOR}";
      const patientId = options.patientId || ${PATIENT};
      const owner = options.owner || (options.receipt ? "correction:" + options.receipt.id : "collection:" + patientId);
      let confirmed = null;
      function Fixture() {
        const hook = useMoneyAttempt(owner, true, options.viewKey || owner, { patientId, receipt: options.receipt });
        const [resultKind, setResultKind] = useState(null);
        window.__durableAckFixture = {
          run: async (request) => {
            setResultKind(null);
            const result = await hook.run(request);
            if (result?.kind === "confirmed") confirmed = result.attempt;
            setResultKind(result?.kind || null);
            return result?.kind || null;
          },
          consume: () => { if (confirmed) hook.consume(confirmed); },
          snapshot: () => ({ ready: hook.ready, error: hook.error, attempt: hook.attempt, resultKind }),
          journal: readFinancialJournal,
        };
        return <main>
          <output id="phase">{hook.attempt?.phase || "idle"}</output>
          <output id="result">{resultKind}</output>
          <input aria-label="Amount" disabled={!hook.ready || !!hook.attempt} />
          <button onClick={() => window.__durableAckFixture.run()} disabled={!hook.ready || hook.attempt?.phase === "sending"}>Retry saved command</button>
        </main>;
      }
      createRoot(document.getElementById("root")).render(
        <StrictMode><SessionProvider value={{ username: actor, role: "admin" }}><Fixture /></SessionProvider></StrictMode>
      );
    `, sourcefile: "durable-ack-fixture.tsx", resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
  });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 120_000);
afterAll(async () => { await browser?.close(); });

type Captured = { url: string; key: string; body: string; route: Route };
const requestIdentity = ({ url, key, body }: Captured) => ({ url, key, body });
const mountUrl = (mount: Mount = {}) => `${ORIGIN}/?mount=${encodeURIComponent(JSON.stringify(mount))}`;
const snapshot = (page: Page) => page.evaluate(() => window.__durableAckFixture.snapshot());
const journal = (page: Page) => page.evaluate(scope => window.__durableAckFixture.journal(scope), SCOPE);
async function navigate(page: Page, mount: Mount = {}) {
  await page.goto(mountUrl(mount));
  await expect.poll(async () => (await snapshot(page)).ready).toBe(true);
}
async function open(mount: Mount = {}) {
  const context = await browser.newContext();
  const requests: Captured[] = [];
  const errors: string[] = [];
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN) throw new Error(`Unexpected external request: ${url.origin}`);
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script>' });
    if (request.method() === "POST" && /^\/api\/payments(?:\/\d+\/correct)?$/.test(url.pathname)) {
      requests.push({ route, url: url.pathname, body: request.postData() ?? "", key: request.headers()["idempotency-key"] ?? "" });
      return;
    }
    return route.abort();
  });
  const page = await context.newPage();
  await navigate(page, mount);
  expect(await page.evaluate(() => ({ secure: isSecureContext, indexedDB: typeof indexedDB.open, digest: typeof crypto.subtle?.digest })))
    .toEqual({ secure: true, indexedDB: "function", digest: "function" });
  return { context, page, requests, errors,
    reply: (index: number, payload: unknown, status = 200) => requests[index].route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) }),
  };
}
async function start(page: Page, requests: Captured[], request?: MoneyRequest) {
  const count = requests.length;
  if (request) await page.evaluate(request => { void window.__durableAckFixture.run(request); }, request);
  else await page.getByRole("button", { name: "Retry saved command" }).click();
  await expect.poll(() => requests.length).toBe(count + 1);
  await expect.poll(async () => (await snapshot(page)).attempt?.phase).toBe("sending");
  return requests[count];
}
async function expectUncertain(page: Page, request: Captured) {
  await expect.poll(async () => (await snapshot(page)).resultKind).toBe("uncertain");
  const state = await snapshot(page), saved = await journal(page);
  expect(state.attempt).toMatchObject({ phase: "uncertain", key: request.key, request: { url: request.url, body: request.body } });
  expect(saved).toMatchObject({ revision: 0, command: { key: request.key } });
  expect(JSON.parse(saved.command!.original)).toMatchObject({ key: request.key, request: { url: request.url, body: request.body } });
  expect(await page.getByLabel("Amount").isDisabled()).toBe(true);
  return saved;
}
async function expectConfirmed(page: Page, paymentId: number) {
  await expect.poll(async () => (await snapshot(page)).resultKind).toBe("confirmed");
  expect((await snapshot(page)).attempt).toMatchObject({ phase: "confirmed", acknowledgment: { paymentId } });
  expect(await journal(page)).toEqual({ revision: 1, command: null });
}
async function consumeTwice(page: Page) {
  await page.evaluate(() => { window.__durableAckFixture.consume(); window.__durableAckFixture.consume(); });
  await expect.poll(async () => (await snapshot(page)).attempt).toBeNull();
  expect(await journal(page)).toEqual({ revision: 1, command: null });
  expect(await page.getByLabel("Amount").isEnabled()).toBe(true);
}
const collectionRequest = (amount = "0.81"): MoneyRequest => ({
  url: "/api/payments", operation: "payment",
  body: JSON.stringify({ patientId: PATIENT, invoiceId: "12", amount, currency: "SAR", method: "cash", kind: "payment" }),
});
const receipt = (patch: Record<string, unknown> = {}) => ({
  id: 701, receiptNumber: "SYN-701", patientId: PATIENT, patientName: "Synthetic", invoiceId: 12, planId: null, openingCurrency: null,
  shiftId: 1, kind: "payment", amountMinor: 81, currency: "SAR", exchangeRate: STORED_RATE,
  baseAmountMinor: 113, baseCurrency: "YER", method: "cash", note: null, createdBy: ACTOR,
  createdAt: "2026-10-20T03:00:00Z", reversalOfId: null, ...patch,
});
const rawCalculation = (paymentId = 701) => ({
  kind: "generic-v1-request-rate", paymentId, amountMinor: 81, currency: "SAR", baseCurrency: "YER",
  exchangeRate: STORED_RATE, baseAmountMinor: 113, calculationRate: RAW_RATE,
});
const collectionProof = (request: Captured) => ({ ...receipt(), idempotencyKey: request.key,
  acknowledgmentEvidence: { version: 1, operation: "payment", requestKey: request.key, calculation: rawCalculation() },
});

const oldReceipt: MoneyReceiptContext = { id: 701, receiptNumber: "SYN-701", amountMinor: 81, remainingMinor: 80, currency: "SAR", method: "cash", invoiceId: 12, planId: null, openingCurrency: null };
const correctionRequest: MoneyRequest = { url: "/api/payments/701/correct", operation: "correct",
  body: JSON.stringify({ mode: "correct", reason: "Synthetic correction", target: "original", amount: "0.80", currency: "SAR", method: "cash" }),
};

// Correction evidence fixtures are deliberately independent from production
// constructors, so an accidental parser/constructor agreement cannot hide drift.
// The closing reversal returns the exact remaining base budget (113), not the
// standalone conversion of 80 SAR minor (112). The replacement is standalone.
const correctionProof = (request: Captured, status = 200) => ({
  original: { id: oldReceipt.id, receiptNumber: oldReceipt.receiptNumber, patientId: PATIENT },
  replayed: status === 200, idempotencyKey: request.key,
  reversal: receipt({ id: 702, receiptNumber: "SYN-702", kind: "refund", amountMinor: 80, baseAmountMinor: 113, reversalOfId: 701 }),
  replacement: receipt({ id: 703, receiptNumber: "SYN-703", amountMinor: 80, baseAmountMinor: 112, note: "بدل السند SYN-701" }),
  acknowledgmentEvidence: { version: 1, operation: "correct", requestKey: request.key, correction: {
    pair: { auditId: 1, originalId: 701, reversalId: 702, replacementId: 703, actor: ACTOR, reason: "Synthetic correction", keyedPaymentId: 703 },
    origin: { id: 701, receiptNumber: "SYN-701", amountMinor: 81, baseAmountMinor: 113, currency: "SAR", baseCurrency: "YER", exchangeRate: STORED_RATE, method: "cash", invoiceId: 12, planId: null, openingCurrency: null },
    closingRefund: { reversalId: 702, otherRefunds: [{ id: 700, amountMinor: 1, baseAmountMinor: 0 }] },
  } },
});

describe("durable money hook acknowledgment through actual IndexedDB", () => {
  it.each([201, 200])("retires the raw-FX collection exactly once on HTTP %i and permits a fresh key only after consumption", async status => {
    const f = await open();
    try {
      const request = await start(f.page, f.requests, collectionRequest());
      const saved = await journal(f.page);
      expect(saved).toMatchObject({ revision: 0, command: { key: request.key } });
      await f.reply(0, collectionProof(request), status);
      await expectConfirmed(f.page, 701);
      expect(await f.page.evaluate(() => window.__durableAckFixture.run())).toBe("confirmed");
      expect(f.requests).toHaveLength(1);
      await consumeTwice(f.page);
      const next = await start(f.page, f.requests, collectionRequest("1.00"));
      expect(next.key).not.toBe(request.key);
      await f.reply(1, { ...receipt({ id: 704, receiptNumber: "SYN-704", amountMinor: 100, baseAmountMinor: 140 }), idempotencyKey: next.key }, 201);
      await expect.poll(async () => (await snapshot(f.page)).resultKind).toBe("confirmed");
      expect(await journal(f.page)).toEqual({ revision: 2, command: null });
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  const invalidCollections: [string, (proof: ReturnType<typeof collectionProof>) => unknown][] = [
    ["ID-only body", () => ({ id: 701 })],
    ["missing evidence for rounded-rate mismatch", proof => { const { acknowledgmentEvidence: _evidence, ...ordinary } = proof; return ordinary; }],
    ["wrong key", proof => ({ ...proof, idempotencyKey: "wrong-request-key" })],
    ["wrong actor", proof => ({ ...proof, createdBy: "another-owner" })],
    ["wrong patient", proof => ({ ...proof, patientId: 10 })],
    ["wrong invoice", proof => ({ ...proof, invoiceId: 13 })],
    ["unexpected plan", proof => ({ ...proof, planId: 8 })],
    ["unexpected opening balance", proof => ({ ...proof, openingCurrency: "SAR" })],
    ["wrong native amount", proof => ({ ...proof, amountMinor: 80 })],
    ["wrong currency", proof => ({ ...proof, currency: "USD" })],
    ["wrong method", proof => ({ ...proof, method: "transfer" })],
    ["wrong base amount", proof => ({ ...proof, baseAmountMinor: 114 })],
    ["evidence from another key", proof => ({ ...proof, acknowledgmentEvidence: { ...proof.acknowledgmentEvidence, requestKey: "another-request-key" } })],
    ["evidence from another payment", proof => ({ ...proof, acknowledgmentEvidence: { ...proof.acknowledgmentEvidence, calculation: rawCalculation(702) } })],
    ["mutated raw calculation", proof => ({ ...proof, acknowledgmentEvidence: { ...proof.acknowledgmentEvidence, calculation: { ...rawCalculation(), calculationRate: 141 } } })],
    ["same-base contradictory stored-rate snapshot", proof => ({ ...proof, acknowledgmentEvidence: { ...proof.acknowledgmentEvidence, calculation: { ...rawCalculation(), calculationRate: 140 } } })],
  ];
  it.each(invalidCollections)("keeps %s uncertain, blocks replacement intent and retries exact saved bytes", async (_name, mutate) => {
    const f = await open();
    try {
      const first = await start(f.page, f.requests, collectionRequest());
      await f.reply(0, mutate(collectionProof(first)), 201);
      const original = await expectUncertain(f.page, first);
      expect(await f.page.evaluate(request => window.__durableAckFixture.run(request), collectionRequest("0.82"))).toBe("blocked");
      expect(f.requests).toHaveLength(1);
      expect(await journal(f.page)).toEqual(original);
      const retry = await start(f.page, f.requests);
      expect(requestIdentity(retry)).toEqual(requestIdentity(first));
      expect((await journal(f.page)).command?.original).toBe(original.command?.original);
      await f.reply(1, collectionProof(retry), 200);
      await expectConfirmed(f.page, 701);
      await consumeTwice(f.page);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it.each([201, 200])("accepts the proven closing correction budget on HTTP %i, not standalone rounded-rate arithmetic", async status => {
    const f = await open({ receipt: oldReceipt });
    try {
      const request = await start(f.page, f.requests, correctionRequest);
      await f.reply(0, correctionProof(request, status), status);
      await expectConfirmed(f.page, 703);
      expect((await snapshot(f.page)).attempt?.acknowledgment).toMatchObject({ reversal: { id: 702 }, replacement: { id: 703 } });
      expect(await f.page.evaluate(() => window.__durableAckFixture.run())).toBe("confirmed");
      expect(f.requests).toHaveLength(1);
      await consumeTwice(f.page);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it("keeps ordinary standalone correction compatibility without inventing response evidence", async () => {
    const original: MoneyReceiptContext = { ...oldReceipt, amountMinor: 500, remainingMinor: 500, currency: "YER" };
    const request: MoneyRequest = { ...correctionRequest, body: JSON.stringify({ mode: "correct", reason: "Synthetic correction", target: "original", amount: "50", currency: "YER", method: "cash" }) };
    const f = await open({ receipt: original });
    try {
      const sent = await start(f.page, f.requests, request);
      await f.reply(0, { original: { id: 701, receiptNumber: "SYN-701", patientId: PATIENT }, replayed: false, idempotencyKey: sent.key,
        reversal: receipt({ id: 702, receiptNumber: "SYN-702", kind: "refund", amountMinor: 500, currency: "YER", exchangeRate: 1, baseAmountMinor: 500, reversalOfId: 701 }),
        replacement: receipt({ id: 703, receiptNumber: "SYN-703", amountMinor: 50, currency: "YER", exchangeRate: 1, baseAmountMinor: 50 }),
      }, 201);
      await expectConfirmed(f.page, 703);
      await consumeTwice(f.page);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it.each(["missing", "contradictory-same-base"])("requires independent historical-rate proof for a raw replacement when proof is %s", async proofState => {
    const request = { ...correctionRequest, body: JSON.stringify({ ...JSON.parse(correctionRequest.body), amount: "0.81" }) };
    const f = await open({ receipt: oldReceipt });
    try {
      const first = await start(f.page, f.requests, request);
      const valid = correctionProof(first);
      const replacement = { ...valid.replacement, amountMinor: 81, baseAmountMinor: 113 };
      const invalid = proofState === "missing" ? { ...valid, replacement }
        : { ...valid, replacement, acknowledgmentEvidence: { ...valid.acknowledgmentEvidence,
          correction: { ...valid.acknowledgmentEvidence.correction, replacementCalculation: { ...rawCalculation(703), calculationRate: 140 } },
        } };
      await f.reply(0, invalid, 201);
      await expectUncertain(f.page, first);
      const retry = await start(f.page, f.requests);
      expect(requestIdentity(retry)).toEqual(requestIdentity(first));
      await f.reply(1, { ...valid, replacement, acknowledgmentEvidence: { ...valid.acknowledgmentEvidence,
        correction: { ...valid.acknowledgmentEvidence.correction, replacementCalculation: rawCalculation(703) },
      } }, 200);
      await expectConfirmed(f.page, 703);
      await consumeTwice(f.page);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it.each([
    { version: 1, status: "unconfirmed" },
    { version: 2, status: "unconfirmed" },
    { version: 1, operation: "payment" },
  ])("never falls back to standalone arithmetic when supplied evidence is unconfirmed or malformed: %j", async evidence => {
    const f = await open();
    try {
      const first = await start(f.page, f.requests, collectionRequest("1.00"));
      const ordinary = { ...receipt({ amountMinor: 100, baseAmountMinor: 140 }), idempotencyKey: first.key };
      await f.reply(0, { ...ordinary, acknowledgmentEvidence: evidence }, 200);
      await expectUncertain(f.page, first);
      const retry = await start(f.page, f.requests);
      expect(requestIdentity(retry)).toEqual(requestIdentity(first));
      await f.reply(1, ordinary, 200);
      await expectConfirmed(f.page, 701);
      await consumeTwice(f.page);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  const invalidCorrections: [string, (proof: ReturnType<typeof correctionProof>) => unknown][] = [
    ["missing closing-budget evidence", proof => { const { acknowledgmentEvidence: _evidence, ...ordinary } = proof; return ordinary; }],
    ["wrong original", proof => ({ ...proof, original: { ...proof.original, id: 699 } })],
    ["wrong original receipt number", proof => ({ ...proof, original: { ...proof.original, receiptNumber: "SYN-OTHER" } })],
    ["wrong original patient", proof => ({ ...proof, original: { ...proof.original, patientId: 10 } })],
    ["wrong reversal actor", proof => ({ ...proof, reversal: { ...proof.reversal, createdBy: "another-owner" } })],
    ["wrong reversal origin", proof => ({ ...proof, reversal: { ...proof.reversal, reversalOfId: 699 } })],
    ["missing reversal origin", proof => ({ ...proof, reversal: { ...proof.reversal, reversalOfId: undefined } })],
    ["wrong reversal method", proof => ({ ...proof, reversal: { ...proof.reversal, method: "transfer" } })],
    ["wrong reversal target", proof => ({ ...proof, reversal: { ...proof.reversal, invoiceId: 13 } })],
    ["wrong reversal base budget", proof => ({ ...proof, reversal: { ...proof.reversal, baseAmountMinor: 112 } })],
    ["wrong replacement actor", proof => ({ ...proof, replacement: { ...proof.replacement, createdBy: "another-owner" } })],
    ["wrong replacement target", proof => ({ ...proof, replacement: { ...proof.replacement, invoiceId: 13 } })],
    ["refund masquerading as replacement", proof => ({ ...proof, replacement: { ...proof.replacement, reversalOfId: 701 } })],
    ["same reversal and replacement ID", proof => ({ ...proof, replacement: { ...proof.replacement, id: 702 } })],
    ["original masquerading as reversal", proof => ({ ...proof, reversal: { ...proof.reversal, id: 701 } })],
    ["wrong correction audit key", proof => ({ ...proof, acknowledgmentEvidence: { ...proof.acknowledgmentEvidence, requestKey: "another-correction-key" } })],
    ["wrong correction audit reason", proof => ({ ...proof, acknowledgmentEvidence: { ...proof.acknowledgmentEvidence, correction: { ...proof.acknowledgmentEvidence.correction, pair: { ...proof.acknowledgmentEvidence.correction.pair, reason: "Another reason" } } } })],
    ["wrong prior-refund budget", proof => ({ ...proof, acknowledgmentEvidence: { ...proof.acknowledgmentEvidence, correction: { ...proof.acknowledgmentEvidence.correction, closingRefund: { reversalId: 702, otherRefunds: [{ id: 700, amountMinor: 1, baseAmountMinor: 1 }] } } } })],
    ["stale expected remaining amount despite internally consistent server proof", proof => ({ ...proof,
      reversal: { ...proof.reversal, amountMinor: 81 },
      acknowledgmentEvidence: { ...proof.acknowledgmentEvidence, correction: { ...proof.acknowledgmentEvidence.correction, closingRefund: { reversalId: 702, otherRefunds: [] } } },
    })],
  ];
  it.each(invalidCorrections)("does not retire %s or let correction mutate into void", async (_name, mutate) => {
    const f = await open({ receipt: oldReceipt });
    try {
      const first = await start(f.page, f.requests, correctionRequest);
      await f.reply(0, mutate(correctionProof(first)), 200);
      const saved = await expectUncertain(f.page, first);
      const voidRequest: MoneyRequest = { url: correctionRequest.url, operation: "void", body: JSON.stringify({ mode: "void", reason: "Synthetic correction" }) };
      expect(await f.page.evaluate(request => window.__durableAckFixture.run(request), voidRequest)).toBe("blocked");
      expect(f.requests).toHaveLength(1);
      expect(await journal(f.page)).toEqual(saved);
      const retry = await start(f.page, f.requests);
      expect(requestIdentity(retry)).toEqual(requestIdentity(first));
      expect((await journal(f.page)).command?.original).toBe(saved.command?.original);
      await f.reply(1, correctionProof(retry), 200);
      await expectConfirmed(f.page, 703);
      await consumeTwice(f.page);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it("restores the exact old receipt context after reload instead of adopting changed remaining, method or target", async () => {
    const f = await open({ receipt: oldReceipt });
    try {
      const first = await start(f.page, f.requests, correctionRequest);
      await f.reply(0, { id: 703 }, 201);
      const saved = await expectUncertain(f.page, first);
      // A new document realm removes every module-level hook cache. IndexedDB
      // alone must preserve the first receipt expectations and request bytes.
      await navigate(f.page, { receipt: { ...oldReceipt, remainingMinor: 79, method: "transfer", invoiceId: 99 }, viewKey: "changed-after-reload" });
      expect((await snapshot(f.page)).attempt).toMatchObject({ phase: "uncertain", key: first.key, request: correctionRequest });
      expect(await journal(f.page)).toEqual(saved);
      expect(JSON.parse(saved.command!.original).receipt).toEqual(oldReceipt);
      expect(await f.page.getByLabel("Amount").isDisabled()).toBe(true);
      const retry = await start(f.page, f.requests);
      expect(requestIdentity(retry)).toEqual(requestIdentity(first));
      await f.reply(1, correctionProof(retry), 200);
      await expectConfirmed(f.page, 703);
      await consumeTwice(f.page);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

  it("acknowledges the same durable proof from two tabs only once, including the 200 replay after a 201", async () => {
    const f = await open();
    try {
      const original = await start(f.page, f.requests, collectionRequest());
      await f.reply(0, { id: 701 }, 201);
      await expectUncertain(f.page, original);
      const second = await f.context.newPage();
      await navigate(second);
      expect((await snapshot(second)).attempt).toMatchObject({ phase: "uncertain", key: original.key, request: collectionRequest() });
      const firstRetry = await start(f.page, f.requests);
      const secondRetry = await start(second, f.requests);
      expect(requestIdentity(firstRetry)).toEqual(requestIdentity(original));
      expect(requestIdentity(secondRetry)).toEqual(requestIdentity(original));
      await f.reply(1, collectionProof(firstRetry), 201);
      await expectConfirmed(f.page, 701);
      await consumeTwice(f.page);
      await f.reply(2, collectionProof(secondRetry), 200);
      await expectConfirmed(second, 701);
      await consumeTwice(second);
      expect(await journal(f.page)).toEqual({ revision: 1, command: null });
      expect(f.requests).toHaveLength(3);
      expect(f.errors).toEqual([]);
    } finally { await f.context.close(); }
  });

});
