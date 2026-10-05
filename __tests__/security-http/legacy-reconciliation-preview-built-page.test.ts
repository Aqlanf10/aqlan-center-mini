import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Patient } from "@/lib/patient";
import { previewTextLineHasOwnedHits } from "../fixtures/preview-label-text-boundary";
import { baseUrl, harness } from "./_server";

/**
 * Actual built patient page, Account tab, SessionProvider and PatientLedger.
 * Synthetic GET responses only; no renderer, app route, DB client, fixture seed,
 * financial mutation, authentication replacement response or React internals.
 * Running even collection starts the existing security global setup: execute
 * only in the separately authorized isolated harness, never against Production.
 */
let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
const DIRECTORY = ".settings-ui-artifacts";
const PANEL = "معاينة بيانات مالية سابقة";
const OPEN = "معاينة اتفاق سابق دون حفظ";
const CLOSE = "إغلاق المعاينة ومسح مدخلاتها";
const DATE = "البيانات التاريخية حتى";
const AGREED = "كامل المبلغ المتفق عليه";
const PAID = "المدفوع حتى التاريخ المحدد";
const UNKNOWN = "الأرشيف وسجل تعديل الرصيد غير محمّلين في هذه المعاينة";
const NO_LINK = "تساوي الأرقام لا يثبت ارتباطه بهذا الاتفاق";
const panel = (page: Page) => page.getByRole("region", { name: PANEL, exact: true });
const currencyControl = (page: Page) => panel(page).getByRole("combobox", { name: /^عملة الاتفاق التاريخي/ });

type StorageEvent = { area: "local" | "session"; operation: string; key: string | null };
declare global {
  interface Window { __legacyPreviewStorageEvents?: StorageEvent[] }
}

beforeAll(async () => {
  expect(new URL(baseUrl).origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  h = await harness();
  const database = new URL(h.seeded.dbUrl);
  expect(database.pathname).toBe("/aqlan_sec_http");
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(database.hostname);
  expect(h.seeded.patientAId).not.toBe(h.seeded.patientBId);
  for (const id of [h.seeded.patientAId, h.seeded.patientBId]) expect(Number.isSafeInteger(id) && id > 0).toBe(true);
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(DIRECTORY, { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); });

function patient(id: number): Patient {
  return {
    id, patientNumber: `SYNTHETIC-PREVIEW-${id}`, fullName: `مريض معاينة اصطناعي ${id}`,
    phone: null, altPhone: null, gender: "unknown", birthYear: null, address: null,
    medicalAlert: null, note: null, createdAt: "2026-01-01T09:00:00.000Z", photoDocumentId: null, flags: [],
  };
}
const workflow = () => ({
  openVisit: null, lastVisit: null, nextAppointment: null, activePlans: [], plannedVisits: [],
  counts: { visits: 0, openLabOrders: 0, documents: 0, orthoCase: false },
  financial: null, alerts: [], canSeeFinancial: true,
});
function ledger(patientId: number, mode: "standard" | "aggregate" | "missing" = "standard") {
  const empty = { billedMinor: 0, collectedMinor: 0, openingMinor: 0, dueMinor: 0 };
  const base = { patientId, invoiceId: null, planId: null, openingCurrency: "SAR", kind: "payment",
    currency: "SAR", exchangeRate: 140, method: "cash", note: null, createdAt: "2026-09-02T09:00:00.000Z" };
  return {
    invoices: [], plans: [], opening: null, openings: [{ patientId, currency: "SAR",
      amountMinor: mode === "aggregate" ? 90_000 : 35_000, asOfDate: "2026-09-01", note: null }],
    baseCurrency: "YER", balance: empty,
    balances: { YER: empty, SAR: { billedMinor: 0, collectedMinor: 5_000,
      openingMinor: mode === "aggregate" ? 90_000 : 35_000, dueMinor: mode === "aggregate" ? 85_000 : 30_000 }, USD: empty },
    openingAccess: { add: false, edit: false }, receiptRemaining: {},
    legacyBalanceArrangements: [], legacyArrangementAccess: { manage: false },
    ...(mode === "missing" ? {} : { legacyOpeningPositions: [{
      currency: "SAR", openingMinor: mode === "aggregate" ? 90_000 : 35_000,
      settledMinor: 5_000, remainingMinor: mode === "aggregate" ? 85_000 : 30_000,
    }] }),
    payments: [
      { ...base, id: 970001, receiptNumber: "SYNTH-OPENING-50", amountMinor: 5_000, baseAmountMinor: 7_000 },
    ],
  };
}
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const events = (page: Page) => page.evaluate(() => (window.__legacyPreviewStorageEvents ?? []).map(event => ({ ...event })));

async function fixture(width: number) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 },
    locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block", acceptDownloads: false });
  const installCookie = async (role: "admin" | "reception") => {
    const [name, ...value] = h.sessions[role].cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  };
  await installCookie("admin");
  // Observe operations and keys only. Never retain storage values, cookies or credentials.
  await context.addInitScript(() => {
    const log: StorageEvent[] = []; window.__legacyPreviewStorageEvents = log;
    const record = (storage: Storage, operation: string, key: string | null) => {
      log.push({ area: storage === window.localStorage ? "local" : "session", operation, key });
    };
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    const remove = Storage.prototype.removeItem, clear = Storage.prototype.clear;
    Storage.prototype.getItem = function(this: Storage, key: string) { record(this, "getItem", key); return get.call(this, key); };
    Storage.prototype.setItem = function(this: Storage, key: string, value: string) { record(this, "setItem", key); return set.call(this, key, value); };
    Storage.prototype.removeItem = function(this: Storage, key: string) { record(this, "removeItem", key); return remove.call(this, key); };
    Storage.prototype.clear = function(this: Storage) { record(this, "clear", null); return clear.call(this); };
  });
  const writes: string[] = [], external: string[] = [], unexpected: string[] = [], errors: string[] = [];
  const downloads: string[] = [], newPages: string[] = [], navigation: string[] = [];
  const reads: string[] = [];
  const pending: Array<{ patientId: number; route: Route }> = [];
  const active = new Set<object>();
  const ids = [h.seeded.patientAId, h.seeded.patientBId];
  const allowedDocuments = new Set(ids.map(id => `${baseUrl}/patients/${id}?tab=account`));
  const background = (path: string) => path === "/api/visits" || path.startsWith("/api/visits/readiness?patientId=")
    || ["/api/booking-requests?status=new", "/api/lab?summary=1", "/api/messages?unread=1"].includes(path);
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status,
    contentType: "application/json", body: JSON.stringify(value) });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const target = url.pathname + url.search;
    if (url.origin !== baseUrl) { external.push(method + " " + url.origin + target); await route.abort(); return; }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      writes.push(method + " " + target); await route.abort(); return;
    }
    if (request.isNavigationRequest() && !allowedDocuments.has(url.href)) {
      navigation.push(method + " " + target); await route.abort(); return;
    }
    if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
    if (method !== "GET") { unexpected.push(method + " " + target); await route.abort(); return; }
    reads.push(target);
    for (const id of ids) {
      const prefix = `/api/patients/${id}`;
      if (target === prefix) { await json(route, { patient: patient(id), visits: [], appointments: [] }); return; }
      if (target === prefix + "/workflow") { await json(route, workflow()); return; }
      if (target === prefix + "/ledger") { pending.push({ patientId: id, route }); return; }
      // The existing Account sibling performs this read, independently of the preview.
      if (target === prefix + "/legacy") { await json(route, { treatments: [], orphanPayments: [] }); return; }
      if (target === prefix + "/documents") { await json(route, { documents: [], storageReady: false, storageMessage: null }); return; }
      if (target === `/api/visits/readiness?patientId=${id}`) { await json(route, { visit: null }); return; }
    }
    if (["/api/services", "/api/visits", "/api/booking-requests?status=new"].includes(target)) { await json(route, []); return; }
    if (target === "/api/lab?summary=1") { await json(route, { late: 0 }); return; }
    if (target === "/api/messages?unread=1") { await json(route, { unread: 0, urgent: 0 }); return; }
    // Never invent auth/me, archive ownership, a grant, or a successful unknown API read.
    unexpected.push(method + " " + target); await route.abort();
  });
  const page = await context.newPage();
  page.on("download", () => downloads.push("unexpected download"));
  context.on("page", extra => {
    newPages.push("unexpected page");
    extra.on("download", () => downloads.push("unexpected download"));
    extra.on("pageerror", error => errors.push(error.message));
  });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) active.add(request); });
  page.on("requestfinished", request => active.delete(request));
  page.on("requestfailed", request => active.delete(request));
  await page.clock.setFixedTime(new Date("2026-10-05T09:00:00.000Z"));
  const finish = async () => { await expect.poll(() => active.size).toBe(0); await settle(page); };
  const snapshot = () => Object.freeze({
    writes: Object.freeze([...writes]), external: Object.freeze([...external]),
    unexpected: Object.freeze([...unexpected]), errors: Object.freeze([...errors]),
    downloads: Object.freeze([...downloads]), newPages: Object.freeze([...newPages]),
    navigation: Object.freeze([...navigation]), pages: context.pages().length,
  });
  const assertIsolation = (value: ReturnType<typeof snapshot>, pages: number) => {
    expect(value.writes).toEqual([]); expect(value.external).toEqual([]);
    expect(value.unexpected).toEqual([]); expect(value.errors).toEqual([]); expect(value.pages).toBe(pages);
    expect(value.downloads).toEqual([]); expect(value.newPages).toEqual([]); expect(value.navigation).toEqual([]);
  };
  const close = async () => {
    const before = snapshot();
    try { assertIsolation(before, 1); expect(pending).toHaveLength(0); }
    finally {
      await context.close();
      const after = snapshot(); assertIsolation(after, 0);
      expect(after.writes).toEqual(before.writes); expect(after.external).toEqual(before.external);
      expect(after.unexpected).toEqual(before.unexpected); expect(after.errors).toEqual(before.errors);
      expect(after.downloads).toEqual(before.downloads); expect(after.newPages).toEqual(before.newPages);
      expect(after.navigation).toEqual(before.navigation);
    }
  };
  const waitRead = async (id: number) => {
    await expect.poll(() => pending.length).toBe(1); expect(pending[0].patientId).toBe(id);
    expect(await panel(page).count()).toBe(0);
  };
  const respond = async (body?: unknown, status = 200) => {
    const next = pending.shift(); if (!next) throw new Error("No exact synthetic ledger GET is pending");
    await json(next.route, body === undefined ? ledger(next.patientId) : body, status); await finish();
  };
  const storageBaseline = async () => {
    const result = await events(page);
    expect(result).toEqual([
      { area: "local", operation: "removeItem", key: "aqlan_session_token" },
      { area: "local", operation: "removeItem", key: "aqlan_session_user" },
    ]);
    return result;
  };
  const quietMark = async () => ({ foreground: reads.filter(path => !background(path)), storage: await events(page) });
  const assertQuiet = async (mark: Awaited<ReturnType<typeof quietMark>>) => {
    await settle(page);
    expect(reads.filter(path => !background(path))).toEqual(mark.foreground);
    expect(await events(page)).toEqual(mark.storage);
    assertIsolation(snapshot(), 1);
  };
  const go = async (id: number) => {
    expect(pending).toHaveLength(0);
    const response = await page.goto(`${baseUrl}/patients/${id}?tab=account`, { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200); await waitRead(id);
  };
  const remountAccount = async (id: number) => {
    await page.getByTestId("patient-tab-files").click();
    await expect.poll(() => panel(page).count()).toBe(0); await finish();
    expect(new URL(page.url()).searchParams.get("tab")).toBe("files");
    await page.getByTestId("patient-tab-account").click(); await waitRead(id);
  };
  try {
    await go(h.seeded.patientAId);
    return { page, context, respond, finish, waitRead, go, remountAccount, installCookie,
      storageBaseline, quietMark, assertQuiet, close };
  } catch (error) { await close(); throw error; }
}

async function blank(page: Page) {
  const area = panel(page); await area.getByRole("button", { name: OPEN, exact: true }).waitFor();
  expect(await area.locator("input, select, dl").count()).toBe(0);
  await area.getByRole("button", { name: OPEN, exact: true }).click();
  expect(await currencyControl(page).count()).toBe(1);
  expect(await currencyControl(page).inputValue()).toBe("");
  for (const label of [DATE, AGREED, PAID]) expect(await area.getByLabel(label, { exact: true }).inputValue()).toBe("");
}
async function fill(page: Page) {
  const area = panel(page);
  if (await area.getByRole("button", { name: OPEN, exact: true }).count()) await blank(page);
  await currencyControl(page).selectOption("SAR");
  await area.getByLabel(DATE, { exact: true }).fill("2026-09-01");
  await area.getByLabel(AGREED, { exact: true }).fill("600");
  await area.getByLabel(PAID, { exact: true }).fill("250");
}
async function amount(page: Page, label: string, expected: string) {
  const row = panel(page).locator("dl > div").filter({ has: page.getByText(label, { exact: true }) });
  await expect.poll(() => row.count()).toBe(1);
  expect(await row.locator("dd").innerText()).toBe(expected);
}
async function freshDraft(f: Awaited<ReturnType<typeof fixture>>) {
  const mark = await f.quietMark();
  await blank(f.page); await fill(f.page); await f.assertQuiet(mark);
}

async function captureMobileTextView(page: Page, view: "upper" | "lower") {
  const area = panel(page);
  if (view === "upper") {
    // Center the genuine field grid; do not offset, hide or restyle the mobile chrome.
    await area.locator("label").first().evaluate(label =>
      label.parentElement?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  } else {
    await area.locator("details > p").evaluate(paragraph =>
      paragraph.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  }
  await settle(page);
  const evidence = await area.evaluate((section, selectedView) => {
    const rect = (box: DOMRect) => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      width: box.width, height: box.height });
    const inViewport = (box: DOMRect) => box.width > 0 && box.height > 0 && box.left >= 0
      && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
    const points = (element: Element, box: DOMRect, directText: boolean) => {
      const midX = box.left + box.width / 2, midY = box.top + box.height / 2;
      const dx = Math.min(directText ? 1 : 3, box.width / 4);
      const dy = Math.min(directText ? 1 : 3, box.height / 4);
      return [
        { point: "centre", x: midX, y: midY }, { point: "top", x: midX, y: box.top + dy },
        { point: "bottom", x: midX, y: box.bottom - dy }, { point: "left", x: box.left + dx, y: midY },
        { point: "right", x: box.right - dx, y: midY },
      ].map(sample => {
        const hit = document.elementFromPoint(sample.x, sample.y);
        const associated = element instanceof HTMLLabelElement ? element.control : null;
        const nativeControl = associated instanceof HTMLInputElement || associated instanceof HTMLSelectElement;
        // Preserve raw ownership. The separate identity fact never accepts a
        // descendant or a control discovered through a selector instead of label.control.
        return { ...sample, owned: hit === element || (!directText && !!hit && element.contains(hit)),
          hitTag: hit?.tagName.toLowerCase() ?? null,
          hitsNativeLabelControl: directText && nativeControl && hit === associated };
      });
    };
    const labels = Array.from(section.querySelectorAll("label"));
    const targets: Array<{ kind: string; element: Element }> = [];
    if (selectedView === "upper") {
      const intro = section.querySelector('p[role="note"]');
      if (intro) targets.push({ kind: "introduction", element: intro });
      for (const [index, label] of labels.slice(0, 5).entries()) targets.push({ kind: `field-label-${index}`, element: label });
    } else {
      const disclaimer = section.querySelector("details > p");
      if (disclaimer) targets.push({ kind: "receipt-timing-disclaimer", element: disclaimer });
    }
    const text = targets.map(({ kind, element }) => {
      const style = getComputedStyle(element);
      const associated = element instanceof HTMLLabelElement ? element.control : null;
      const associatedControl = associated ? {
        nativeLabel: element instanceof HTMLLabelElement,
        nativeControl: associated instanceof HTMLInputElement || associated instanceof HTMLSelectElement,
        tag: associated.tagName.toLowerCase(), bounds: rect(associated.getBoundingClientRect()),
      } : null;
      const lines: Array<{ text: string; bounds: ReturnType<typeof rect>; inViewport: boolean;
        hits: ReturnType<typeof points> }> = [];
      let lineCount = 0;
      // Direct label text only: select option labels are not painted field labels.
      for (const node of Array.from(element.childNodes)) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const value = node.textContent ?? "", start = value.search(/\S/);
        if (start < 0) continue;
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, value.trimEnd().length);
        for (const box of Array.from(range.getClientRects())) {
          if (!box.width || !box.height) continue;
          lineCount++;
          if (lines.length < 16) lines.push({ text: value.trim().slice(0, 500), bounds: rect(box),
            inViewport: inViewport(box), hits: points(element, box, true) });
        }
      }
      return { kind, visibleStyle: style.display !== "none" && style.visibility === "visible" && Number(style.opacity) > 0,
        lineCount, truncated: lineCount > lines.length, lines, associatedControl };
    });
    const fields = selectedView === "upper"
      ? labels.slice(0, 5).map(label => label.querySelector("input, select"))
      : [section.querySelector("details > summary")];
    const controls = fields.filter((element): element is Element => element !== null).map(element => {
      const box = element.getBoundingClientRect();
      return { tag: element.tagName.toLowerCase(), bounds: rect(box), inViewport: inViewport(box),
        value: element instanceof HTMLInputElement || element instanceof HTMLSelectElement ? element.value : null,
        hits: points(element, box, false) };
    });
    // Read-only checks that the genuine mobile header and navigation remain painted.
    const chrome = (selector: string, required: readonly string[]) => Array.from(document.querySelectorAll(selector))
      .filter(element => required.every(name => element.classList.contains(name)))
      .filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; })
      .slice(0, 3).map(element => { const box = element.getBoundingClientRect();
        return { bounds: rect(box), inViewport: inViewport(box), hits: points(element, box, false) }; });
    return { view: selectedView, viewportWidth: innerWidth, viewportHeight: innerHeight, scrollY,
      labelCount: labels.length, text, controls,
      header: chrome("div", ["sticky", "top-0", "lg:hidden"]),
      bottomNavigation: chrome("nav", ["fixed", "bottom-0", "lg:hidden"]) };
  }, view);
  const screenshot = `legacy-reconciliation-preview-390-${view}-viewport.png`;
  // Genuine current viewport, including unmodified sticky header and bottom navigation.
  await page.screenshot({ path: join(DIRECTORY, screenshot), fullPage: false });
  return { screenshot, ...evidence };
}

function assertMobileTextViews(views: Awaited<ReturnType<typeof captureMobileTextView>>[]) {
  expect(views.map(view => view.view)).toEqual(["upper", "lower"]);
  for (const view of views) {
    expect(view.viewportWidth).toBe(390); expect(view.viewportHeight).toBe(844);
    expect(view.labelCount).toBe(4);
    expect(view.text.map(target => target.kind)).toEqual(view.view === "upper"
      ? ["introduction", "field-label-0", "field-label-1", "field-label-2", "field-label-3"]
      : ["receipt-timing-disclaimer"]);
    for (const target of view.text) {
      expect(target.visibleStyle, target.kind).toBe(true); expect(target.truncated, target.kind).toBe(false);
      expect(target.lineCount, target.kind).toBeGreaterThan(0);
      for (const line of target.lines) {
        expect(line.inViewport, target.kind).toBe(true);
        expect(line.hits).toHaveLength(5);
        expect(previewTextLineHasOwnedHits({ kind: target.kind, bounds: line.bounds,
          hits: line.hits, associatedControl: target.associatedControl }), target.kind).toBe(true);
      }
    }
    expect(view.controls).toHaveLength(view.view === "upper" ? 4 : 1);
    if (view.view === "upper") expect(view.controls.map(control => control.value)).toEqual(["SAR", "2026-09-01", "600", "250"]);
    for (const control of view.controls) {
      expect(control.inViewport).toBe(true); expect(control.bounds.width).toBeGreaterThanOrEqual(44);
      expect(control.bounds.height).toBeGreaterThanOrEqual(44);
      expect(control.hits).toHaveLength(5); expect(control.hits.every(hit => hit.owned)).toBe(true);
    }
    for (const chrome of [view.header, view.bottomNavigation]) {
      expect(chrome).toHaveLength(1); expect(chrome[0].inViewport).toBe(true);
      expect(chrome[0].hits.every(hit => hit.owned)).toBe(true);
    }
  }
}

async function captureGeometry(page: Page, width: number) {
  const area = panel(page);
  await page.evaluate(async () => { await document.fonts.ready; });
  const controls = area.locator("button, input, select, summary");
  const controlBounds = [];
  for (let index = 0; index < await controls.count(); index++) {
    const control = controls.nth(index);
    await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
    await settle(page);
    controlBounds.push(await control.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const section = element.closest("section")!; const owner = section.getBoundingClientRect();
      const midX = bounds.left + bounds.width / 2, midY = bounds.top + bounds.height / 2;
      const points = [
        { point: "centre", x: midX, y: midY }, { point: "top", x: midX, y: bounds.top + 3 },
        { point: "bottom", x: midX, y: bounds.bottom - 3 }, { point: "left", x: bounds.left + 3, y: midY },
        { point: "right", x: bounds.right - 3, y: midY },
      ].map(({ point, x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return { point, x, y, contained: !!hit && (hit === element || element.contains(hit)),
          hitTag: hit?.tagName.toLowerCase() ?? null };
      });
      return { tag: element.tagName.toLowerCase(), label: element.closest("label")?.textContent?.trim()
          ?? element.textContent?.trim() ?? "", scrollY, width: bounds.width, height: bounds.height,
        left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
        viewportWidth: innerWidth, viewportHeight: innerHeight, sectionDirection: getComputedStyle(section).direction,
        insideSection: bounds.left >= owner.left - 1 && bounds.right <= owner.right + 1
          && bounds.top >= owner.top - 1 && bounds.bottom <= owner.bottom + 1,
        noOverflow: element.scrollWidth <= element.clientWidth + 1, points };
    }));
  }
  await area.locator('dl[aria-label="الأرقام التاريخية المدخلة"]').evaluate(element =>
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await settle(page);
  const geometry = await area.evaluate(section => {
    const box = section.getBoundingClientRect();
    const textRuns: Array<{ text: string; left: number; right: number; top: number; bottom: number; contained: boolean }> = [];
    const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (!rect.width || !rect.height) continue;
        textRuns.push({ text: node.textContent.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          contained: rect.left >= box.left - 1 && rect.right <= box.right + 1
            && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1
            && rect.left >= -1 && rect.right <= innerWidth + 1 });
      }
    }
    return { direction: document.documentElement.dir, sectionDirection: getComputedStyle(section).direction,
      viewportWidth: innerWidth, viewportHeight: innerHeight, scrollY,
      documentWidth: document.documentElement.scrollWidth, sectionWidth: box.width,
      sectionLeft: box.left, sectionRight: box.right, sectionScrollWidth: section.scrollWidth,
      sectionClientWidth: section.clientWidth, textRuns };
  });
  const stem = `legacy-reconciliation-preview-${width}`;
  // One actual full-section PNG per width. A tall section is not all visible in
  // one viewport: the separate control samples above prove scrolled hit targets.
  // Save both artifacts before fatal geometry assertions, without altering CSS.
  await area.screenshot({ path: join(DIRECTORY, stem + ".png") });
  const mobileTextViews = width === 390
    ? [await captureMobileTextView(page, "upper"), await captureMobileTextView(page, "lower")]
    : undefined;
  await writeFile(join(DIRECTORY, stem + "-bounds.json"), JSON.stringify({
    version: 1, fixture: "synthetic-read-only-built-account", screenshot: stem + ".png", width,
    capture: "full-preview-section; independent per-control scrolled viewport measurements",
    geometry, controls: controlBounds,
    ...(mobileTextViews ? { mobileTextViews } : {}),
  }, null, 2) + "\n", "utf8");
  expect(geometry.direction).toBe("rtl"); expect(geometry.sectionDirection).toBe("rtl");
  expect(geometry.viewportWidth).toBe(width); expect(geometry.documentWidth).toBeLessThanOrEqual(width + 1);
  expect(geometry.sectionLeft).toBeGreaterThanOrEqual(-1); expect(geometry.sectionRight).toBeLessThanOrEqual(width + 1);
  expect(geometry.sectionScrollWidth).toBeLessThanOrEqual(geometry.sectionClientWidth + 1);
  expect(geometry.textRuns.length).toBeGreaterThan(0);
  expect(geometry.textRuns.filter(run => !run.contained)).toEqual([]);
  expect(controlBounds).toHaveLength(6);
  for (const control of controlBounds) {
    expect(control.height, control.label).toBeGreaterThanOrEqual(44);
    expect(control.width, control.label).toBeGreaterThanOrEqual(44);
    expect(control.insideSection, control.label).toBe(true); expect(control.noOverflow, control.label).toBe(true);
    expect(control.left, control.label).toBeGreaterThanOrEqual(-1);
    expect(control.right, control.label).toBeLessThanOrEqual(control.viewportWidth + 1);
    expect(control.top, control.label).toBeGreaterThanOrEqual(-1);
    expect(control.bottom, control.label).toBeLessThanOrEqual(control.viewportHeight + 1);
    expect(control.points.every(point => point.contained), control.label).toBe(true);
  }
  // Both new viewport PNGs and the extended mobile JSON already exist on any assertion failure.
  if (mobileTextViews) assertMobileTextViews(mobileTextViews);
}

describe("read-only legacy comparison on the actual built Account page", () => {
  it.each([390, 1280])("keeps arithmetic, provenance and draft lifetimes separate at %ipx", async width => {
    const f = await fixture(width), page = f.page;
    try {
      await f.respond(); await f.storageBaseline();
      const quiet = await f.quietMark(); await fill(page);
      await amount(page, "المتبقي التاريخي المحسوب", "350.00 ر.س");
      await amount(page, "أصل الرصيد السابق المسجل", "350.00 ر.س");
      await amount(page, "صافي السداد المرتبط المسجل", "50.00 ر.س");
      await amount(page, "المتبقي الحالي حسب الحساب", "300.00 ر.س");
      const area = panel(page);
      expect(await area.innerText()).toContain(UNKNOWN); expect(await area.innerText()).toContain(NO_LINK);
      expect(await area.locator("a, form, button[type=submit]").count()).toBe(0);
      expect(await area.getByRole("button").allTextContents()).toEqual([CLOSE]);
      await area.locator("summary").click();
      expect(await area.locator("li").count()).toBe(1);
      expect(await area.locator("li").innerText()).toContain("SYNTH-OPENING-50");
      expect(await area.locator("li").innerText()).toContain("50.00 ر.س");
      expect(await area.innerText()).toContain("ولا يثبت وقت قبض المال فعليًا");
      expect(await page.getByRole("region", { name: "الدفعات", exact: true }).innerText()).toContain("SYNTH-OPENING-50");
      await captureGeometry(page, width);
      await area.getByLabel(DATE, { exact: true }).fill("2026-10-06");
      await expect.poll(() => area.innerText()).toContain("تاريخًا مستقبليًا");
      expect(await area.locator("dl").count()).toBe(0);
      expect(await area.getByLabel(AGREED, { exact: true }).inputValue()).toBe("600");
      expect(await area.getByLabel(PAID, { exact: true }).inputValue()).toBe("250");
      await area.getByLabel(DATE, { exact: true }).fill("2026-10-05");
      await amount(page, "المتبقي التاريخي المحسوب", "350.00 ر.س");
      await currencyControl(page).selectOption("USD");
      expect(await area.getByLabel(AGREED, { exact: true }).inputValue()).toBe("");
      expect(await area.getByLabel(PAID, { exact: true }).inputValue()).toBe("");
      expect(await area.locator("dl").count()).toBe(0);
      await area.getByRole("button", { name: CLOSE, exact: true }).click(); await blank(page);
      await f.assertQuiet(quiet);

      // Ordinary tab unmount/remount; no financial callback is invoked to force a read.
      await f.remountAccount(h.seeded.patientAId); await f.respond(ledger(h.seeded.patientAId, "aggregate"));
      await freshDraft(f);
      await amount(page, "المتبقي التاريخي المحسوب", "350.00 ر.س");
      await amount(page, "أصل الرصيد السابق المسجل", "900.00 ر.س");
      await amount(page, "المتبقي الحالي حسب الحساب", "850.00 ر.س");
      expect(await area.innerText()).toContain("قد يجمع الرصيد أكثر من اتفاق");
      expect(await area.innerText()).toContain(NO_LINK);
      await f.remountAccount(h.seeded.patientAId); await f.respond(ledger(h.seeded.patientAId, "missing"));
      await freshDraft(f);
      expect(await area.innerText()).toContain("تفصيل الرصيد السابق غير متاح؛ لا يُفترض أنه صفر");
      expect(await area.innerText()).toContain(UNKNOWN);

      for (const status of [403, 503]) {
        await f.remountAccount(h.seeded.patientAId);
        await f.respond({ message: "Synthetic Account read unavailable" }, status);
        await page.getByRole("alert", { name: "خطأ حساب المريض", exact: true }).waitFor();
        expect(await panel(page).count()).toBe(0);
        await f.remountAccount(h.seeded.patientAId); await f.respond(); await freshDraft(f);
      }
      // Real patient URLs, full document remounts A→B→A; not a retained-root injection.
      await f.go(h.seeded.patientBId); await f.respond(); await f.storageBaseline(); await freshDraft(f);
      await f.go(h.seeded.patientAId); await f.respond(); await f.storageBaseline(); await freshDraft(f);

      // Genuine cookie replacement + reload proves cross-session REMOUNT reset only.
      // Production exposes no read-only retained-root session-switch control.
      for (const role of ["reception", "admin"] as const) {
        await f.installCookie(role);
        const response = await page.reload({ waitUntil: "domcontentloaded" }); expect(response?.status()).toBe(200);
        await f.waitRead(h.seeded.patientAId); await f.respond(); await f.storageBaseline(); await freshDraft(f);
      }
    } finally { await f.close(); }
  });
});
