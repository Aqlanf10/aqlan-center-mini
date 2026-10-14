import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { build } from "esbuild";
import { baseUrl, harness } from "./_server";
import type * as Journal from "../../lib/financial-command-journal";

// Exercise the actual IndexedDB implementation in Chromium, not an in-memory
// storage mock. These are browser-storage checks, not financial journey claims.
declare global { interface Window { financialJournal: typeof Journal } }
let browser: Browser;
let source: string;
beforeAll(async () => {
  await harness();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const bundled = await build({ entryPoints: ["lib/financial-command-journal.ts"], bundle: true, write: false, format: "iife", globalName: "financialJournal", platform: "browser" });
  source = `${bundled.outputFiles[0].text}\nwindow.financialJournal = financialJournal;`;
});
afterAll(async () => { await browser?.close(); });
const scope = { actor: "synthetic-journal-owner", patientId: 991 };
const command = (key: string): Journal.FinancialCommand => ({ kind: "invoice", key, original: JSON.stringify({ patientId: 991, idempotencyKey: key }), payload: JSON.stringify({ outcome: "uncertain", key }) });
async function pageIn(context: BrowserContext): Promise<Page> {
  const page = await context.newPage(); await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(source); return page;
}
describe("durable financial command journal in real browser storage", () => {
  it("survives reload with exact intent and separates actors and patients", async () => {
    const context = await browser.newContext();
    try {
      const page = await pageIn(context); const intent = command("journal:reload:one");
      await page.evaluate(({ scope, intent }) => window.financialJournal.reserveFinancialCommand(scope, 0, intent), { scope, intent });
      await page.reload({ waitUntil: "domcontentloaded" }); await page.evaluate(source);
      expect(await page.evaluate(scope => window.financialJournal.readFinancialJournal(scope), scope)).toEqual({ revision: 0, command: intent });
      for (const other of [{ ...scope, actor: "another-synthetic-owner" }, { ...scope, patientId: 992 }]) {
        expect(await page.evaluate(scope => window.financialJournal.readFinancialJournal(scope), other)).toEqual({ revision: 0, command: null });
      }
    } finally { await context.close(); }
  });
  it("atomically elects one intent when two tabs race with different keys", async () => {
    const context = await browser.newContext();
    try {
      const pages = await Promise.all([pageIn(context), pageIn(context)]);
      const results = await Promise.all(pages.map((page, i) => page.evaluate(({ scope, intent }) => window.financialJournal.reserveFinancialCommand(scope, 0, intent), { scope, intent: command(`journal:race:${i}`) })));
      expect(results[0]).toEqual(results[1]); expect(results[0].command).not.toBeNull();
    } finally { await context.close(); }
  });
  it("acknowledges only the exact command, erases payload, and refuses a stale second tab", async () => {
    const context = await browser.newContext();
    try {
      const page = await pageIn(context); const intent = command("journal:ack:one");
      await page.evaluate(({ scope, intent }) => window.financialJournal.reserveFinancialCommand(scope, 0, intent), { scope, intent });
      expect(await page.evaluate(async ({ scope, wrong }) => {
        try { await window.financialJournal.acknowledgeFinancialCommand(scope, wrong); return "unexpected"; } catch (error) { return (error as Journal.FinancialRecoveryError).code; }
      }, { scope, wrong: command("journal:ack:wrong") })).toBe("changed");
      expect(await page.evaluate(({ scope, intent }) => window.financialJournal.acknowledgeFinancialCommand(scope, intent), { scope, intent })).toEqual({ revision: 1, command: null });
      expect(await page.evaluate(async ({ scope, next }) => {
        try { await window.financialJournal.reserveFinancialCommand(scope, 0, next); return "unexpected"; } catch (error) { return (error as Journal.FinancialRecoveryError).code; }
      }, { scope, next: command("journal:stale:two") })).toBe("changed");
      expect(await page.evaluate(({ scope, next }) => window.financialJournal.reserveFinancialCommand(scope, 1, next), { scope, next: command("journal:fresh:two") })).toMatchObject({ revision: 1, command: { key: "journal:fresh:two" } });
    } finally { await context.close(); }
  });
  it("preserves immutable original across uncertain replies and refuses altered intent", async () => {
    const context = await browser.newContext();
    try {
      const page = await pageIn(context); const intent = command("journal:original:one");
      await page.evaluate(({ scope, intent }) => window.financialJournal.reserveFinancialCommand(scope, 0, intent), { scope, intent });
      const changed = { ...intent, payload: JSON.stringify({ outcome: "refused" }) };
      expect(await page.evaluate(({ scope, changed }) => window.financialJournal.reserveFinancialCommand(scope, 0, changed), { scope, changed })).toMatchObject({ command: changed });
      expect(await page.evaluate(async ({ scope, changed }) => {
        try { await window.financialJournal.reserveFinancialCommand(scope, 0, changed); return "unexpected"; } catch (error) { return (error as Journal.FinancialRecoveryError).code; }
      }, { scope, changed: { ...intent, original: JSON.stringify({ patientId: 992 }) } })).toBe("changed");
    } finally { await context.close(); }
  });
  it("fails closed when browser persistence is unavailable", async () => {
    const context = await browser.newContext();
    try {
      const page = await pageIn(context);
      expect(await page.evaluate(async scope => {
        Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true });
        try { await window.financialJournal.readFinancialJournal(scope); return "unexpected"; } catch (error) { return (error as Journal.FinancialRecoveryError).code; }
      }, scope)).toBe("unavailable");
    } finally { await context.close(); }
  });
});
