import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page, type Route, type Request } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedGet, baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { readOperationalCheckoutQueue } from "../../lib/operational-checkout";

const RECEPTION_EVIDENCE_MARKER = "AQLAN_RECEPTION_UI_PNG_V1";
const RECEPTION_EVIDENCE_SUITE = "__tests__/security-http/reception-signature-handoff-ui.test.ts";
const RECEPTION_SCENES = ["day", "pending", "history"] as const;
type ReceptionCapture = { scene: typeof RECEPTION_SCENES[number]; png: Buffer };
const evidenceHash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

/** Exact synthetic viewport buffers only, using the existing bounded CI-log
 * BEGIN/CHUNK/MANIFEST transport. Emit after assertions and browser teardown;
 * capture, validation, source-read or stdout failures fail the actual test.
 * No filesystem image discovery, cookies, traces, environment dump or uploader change.
 */
async function emitReceptionEvidence(width: number, captures: readonly ReceptionCapture[]): Promise<void> {
  const imageByteCap = 512 * 1024, totalByteCap = 1536 * 1024, chunkCharCap = 4096;
  if (![390, 1280].includes(width) || captures.length !== RECEPTION_SCENES.length) throw new Error("Incomplete reception evidence batch");
  const images = captures.map(({ scene, png }, index) => {
    if (scene !== RECEPTION_SCENES[index] || !Buffer.isBuffer(png) || png.length < 45 || png.length > imageByteCap
      || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || png.readUInt32BE(8) !== 13
      || png.toString("ascii", 12, 16) !== "IHDR" || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== 1000
      || png.subarray(-12).toString("hex") !== "0000000049454e44ae426082") throw new Error("Invalid reception evidence PNG");
    const base64Length = 4 * Math.ceil(png.length / 3);
    return { scene, filename: `reception-${scene}-${width}.png`, width, height: 1000, mime: "image/png", bytes: png.length,
      sha256: evidenceHash(png), base64Length, chunks: Math.ceil(base64Length / chunkCharCap) };
  });
  const totalBytes = images.reduce((sum, image) => sum + image.bytes, 0);
  if (totalBytes > totalByteCap) throw new Error("Reception evidence exceeds batch byte cap");
  const sourceSha256 = evidenceHash(readFileSync(join(process.cwd(), RECEPTION_EVIDENCE_SUITE)));
  const runId = /^\d{1,24}$/.test(process.env.GITHUB_RUN_ID ?? "") ? process.env.GITHUB_RUN_ID : "unavailable";
  const checkoutSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : "unavailable";
  const identity = { protocol: 1, suite: RECEPTION_EVIDENCE_SUITE, sourceSha256, runId, checkoutSha,
    synthetic: true, chunkCharCap, imageByteCap, totalByteCap, totalBytes, images };
  const batch = evidenceHash(JSON.stringify(identity));
  const records = [`${RECEPTION_EVIDENCE_MARKER} BEGIN ${JSON.stringify({ batch, scenes: images.length })}`];
  for (const [position, { png }] of captures.entries()) {
    const image = images[position], data = png.toString("base64");
    for (let index = 0; index < image.chunks; index++) records.push(`${RECEPTION_EVIDENCE_MARKER} CHUNK ${JSON.stringify({
      batch, scene: image.scene, filename: image.filename, index: index + 1, count: image.chunks,
      data: data.slice(index * chunkCharCap, (index + 1) * chunkCharCap),
    })}`);
  }
  records.push(`${RECEPTION_EVIDENCE_MARKER} MANIFEST ${JSON.stringify({ batch, ...identity })}`);
  if (records.some(record => Buffer.byteLength(record) > 8192)
    || records.reduce((sum, record) => sum + Buffer.byteLength(record) + 1, 0) > 2304 * 1024) throw new Error("Reception evidence exceeds stdout cap");
  for (const record of records) await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${record}\n`, error => error ? reject(error) : resolve());
  });
}

let h: Awaited<ReturnType<typeof harness>>, browser: Browser, db: Client;
let patientId = 0, visitId = 0;
const NAME = "مريض تسليم التوقيع الاصطناعي";
const register = (page: Page) => page.getByRole("region", { name: "زيارات الخروج للاستقبال", includeHidden: true });
const openCheckout = async (page: Page) => { await page.getByRole("tab", { name: /التحصيل والخروج/ }).click(); };
const item = (page: Page, id: number) => register(page).locator(`[data-handoff-visit="${id}"]:visible`);
async function contextFor(cookie: string, width = 1280): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  return context;
}
const SAFE_API = new Set(["/api/visits", "/api/visits/readiness", "/api/appointments", "/api/parties", "/api/booking-requests", "/api/display/notice", "/api/lab", "/api/messages", "/api/auth/me"]);
async function allowBuiltBoardRead(route: Route, unexpected: string[]) {
  const request = route.request(), url = new URL(request.url()), method = request.method();
  if (url.origin === baseUrl && ["GET", "HEAD"].includes(method)
    && (SAFE_API.has(url.pathname) || url.pathname === "/" || url.pathname.startsWith("/_next/")
      || ["/logo.png", "/favicon.ico", "/icon.png", "/apple-icon.png", "/manifest.webmanifest", "/sw.js"].includes(url.pathname))) {
    await route.continue(); return;
  }
  unexpected.push(`${method} ${url.origin}${url.pathname}${url.search}`); await route.abort();
}
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  expect(["127.0.0.1", "localhost"]).toContain(new URL(h.seeded.dbUrl).hostname);
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctor = (await db.query(`SELECT party_id FROM users WHERE username = 'secdoctora'`)).rows[0].party_id;
  patientId = (await db.query(`INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`RH-HTTP-${Date.now()}`, NAME, doctor])).rows[0].id;
  // The reception board's ordinary arrival-day/status poll cannot discover this signature.
  visitId = (await db.query(`INSERT INTO visits (patient_id, patient_name, doctor_id, status, arrived_at, finished_at, treatment_done)
    VALUES ($1, $2, $3, 'done', NOW() - INTERVAL '5 days', NOW() - INTERVAL '4 days', 'مراجعة موثقة بلا فاتورة جديدة') RETURNING id`,
    [patientId, NAME, doctor])).rows[0].id;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

describe("reception signature discovery on the built application", () => {
  it("discovers an old-arrival done→signed visit in an already-open independent reception browser", async () => {
    const reception = await contextFor(h.sessions.reception.cookie), doctor = await contextFor(h.sessions.doctorA.cookie);
    const unexpected: string[] = [], errors: string[] = [];
    let signPermit = false;
    const receptionGuard = await guardBrowserRoutes(reception, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === baseUrl && ["GET", "HEAD"].includes(request.method()) && [
        `/patients/${patientId}`, `/api/patients/${patientId}`, `/api/patients/${patientId}/workflow`, `/api/visits/${visitId}/walkout`,
      ].includes(url.pathname)) { await route.continue(); return; }
      await allowBuiltBoardRead(route, unexpected);
    });
    const doctorGuard = await guardBrowserRoutes(doctor, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === baseUrl && request.method() === "POST" && url.pathname === `/api/visits/${visitId}/clinical`
        && signPermit && JSON.stringify(request.postDataJSON()) === JSON.stringify({ action: "sign" })) {
        signPermit = false; await route.continue(); return;
      }
      await allowBuiltBoardRead(route, unexpected);
    });
    const receptionPage = await reception.newPage(), doctorPage = await doctor.newPage();
    for (const page of [receptionPage, doctorPage]) page.on("pageerror", error => errors.push(error.message));
    type Read = { epoch: number; clockEpoch: number; status: number | null; finished: boolean;
      accepted: boolean; targetCount: number; pendingCount: number; failure: "aborted" | "transport" | "invalid-json" | null };
    const reads: Read[] = [], pending = new Map<Request, Read>();
    let readCount = 0, clockEpoch = 0, traceOverflow = false;
    receptionPage.on("request", request => {
      const url = new URL(request.url());
      if (request.method() !== "GET" || url.origin !== baseUrl || url.pathname !== "/api/visits"
        || url.searchParams.get("view") !== "operational-checkout" || url.searchParams.has("date")) return;
      readCount += 1;
      if (reads.length >= 32) { traceOverflow = true; return; }
      const read: Read = { epoch: readCount, clockEpoch, status: null, finished: false,
        accepted: false, targetCount: 0, pendingCount: 0, failure: null };
      reads.push(read); pending.set(request, read);
    });
    receptionPage.on("requestfailed", request => {
      const read = pending.get(request); if (!read) return;
      read.failure = request.failure()?.errorText === "net::ERR_ABORTED" ? "aborted" : "transport";
      pending.delete(request);
    });
    receptionPage.on("requestfinished", request => {
      const read = pending.get(request); if (!read) return;
      void (async () => {
        try {
          const response = await request.response();
          read.status = response?.status() ?? null;
          const snapshot = readOperationalCheckoutQueue(await response?.json(), { username: "secreception", role: "reception" }, null);
          read.accepted = snapshot !== null;
          read.targetCount = snapshot?.items.filter(row => row.visitId === visitId && row.patientId === patientId && row.status === "pending").length ?? 0;
          read.pendingCount = snapshot?.items.filter(row => row.status === "pending").length ?? 0;
          read.finished = true;
        } catch { read.failure = "invalid-json"; }
        finally { pending.delete(request); }
      })();
    });
    const currentReady = async (targetCount: number, expectedClockEpoch: number, afterEpoch = 0) => {
      await expect.poll(() => {
        const latest = reads.at(-1);
        return { pending: pending.size, overflow: traceOverflow, newer: (latest?.epoch ?? 0) > afterEpoch,
          clockEpoch: latest?.clockEpoch, status: latest?.status, finished: latest?.finished,
          accepted: latest?.accepted, targetCount: latest?.targetCount, failure: latest?.failure };
      }).toEqual({ pending: 0, overflow: false, newer: true, clockEpoch: expectedClockEpoch,
        status: 200, finished: true, accepted: true, targetCount, failure: null });
      // An old rendered list or absence of loading is insufficient: stale and
      // denied reads deliberately withhold the numeric fresh badge.
      await expect.poll(() => receptionPage.getByRole("tab", { name: /التحصيل والخروج/ }).innerText())
        .toMatch(new RegExp(`\\(${reads.at(-1)!.pendingCount}\\)`));
      return readCount;
    };
    try {
      await receptionGuard.run(async () => {
        await doctorGuard.run(async () => {
          // Load the independent doctor browser first. No later navigation or
          // manual focus is needed there to sign after reception owns its baseline.
          expect((await doctorPage.goto(baseUrl, { waitUntil: "domcontentloaded" }))?.status()).toBe(200);
          expect(await register(doctorPage).count()).toBe(0);
          await receptionPage.clock.install();
          expect((await receptionPage.goto(baseUrl, { waitUntil: "domcontentloaded" }))?.status()).toBe(200);
          expect(await receptionPage.getByRole("tabpanel", { name: "الانتظار والكراسي" }).isVisible()).toBe(true);
          await openCheckout(receptionPage);
          await currentReady(0, 0);
          expect(await item(receptionPage, visitId).count()).toBe(0);
          // Pause only after hydration and the current read complete. A short
          // pause boundary may start an ordinary read; drain and accept that read
          // too before jumping 20s, otherwise its 12s abort can be fired by the jump.
          const pauseTime = await receptionPage.evaluate(() => Date.now() + 1000);
          await receptionPage.clock.pauseAt(new Date(pauseTime));
          await receptionPage.getByRole("tab", { name: "الانتظار والكراسي" }).click();
          const baselineEpoch = await currentReady(0, 0);
          signPermit = true;
          const signed = await doctorPage.evaluate(async id => {
            const response = await fetch(`/api/visits/${id}/clinical`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sign" }) });
            return { status: response.status, body: await response.json() };
          }, visitId);
          expect(signed.status).toBe(200); expect(signed.body.invoiceId).toBeNull();
          // Only the clock-owned poll may discover the signature. There must be
          // no unresolved read or intervening focus-driven discovery to count as
          // this witness, and the new poll must finish before any next clock jump.
          expect(pending.size).toBe(0); expect(readCount).toBe(baselineEpoch);
          clockEpoch = 1;
          await receptionPage.clock.fastForward(20_001);
          await currentReady(1, 1, baselineEpoch);
          expect(readCount).toBe(baselineEpoch + 1);
          await expect.poll(() => receptionPage.getByRole("tab", { name: /التحصيل والخروج/ }).innerText()).toMatch(/\([1-9]\d*\)/);
          await openCheckout(receptionPage);
          await expect.poll(() => item(receptionPage, visitId).count()).toBe(1);
          expect(await item(receptionPage, visitId).innerText()).toContain(NAME);
          expect(await item(receptionPage, visitId).innerText()).toContain("توقيع جديد");
          expect(await item(receptionPage, visitId).getByRole("link").getAttribute("href")).toBe(`/patients/${patientId}?tab=today&checkoutVisit=${visitId}`);
          const discoveredEpoch = await currentReady(1, 1, baselineEpoch);
          clockEpoch = 2;
          await receptionPage.clock.fastForward(20_001);
          await currentReady(1, 2, discoveredEpoch);
          expect(readCount).toBe(discoveredEpoch + 1);
          expect(await item(receptionPage, visitId).count()).toBe(1);
          signPermit = true;
          const retry = await doctorPage.evaluate(async id => (await fetch(`/api/visits/${id}/clinical`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sign" }),
          })).status, visitId);
          expect(retry).toBe(409);
          await receptionPage.clock.resume();
          await receptionPage.reload({ waitUntil: "domcontentloaded" });
          await openCheckout(receptionPage);
          await expect.poll(() => item(receptionPage, visitId).count()).toBe(1);
          expect(await item(receptionPage, visitId).innerText()).not.toContain("توقيع جديد");
          // Another open visit must not displace this exact signed handoff.
          const newerVisit = (await db.query(`INSERT INTO visits (patient_id, patient_name, status, arrived_at)
            VALUES ($1, $2, 'waiting', NOW()) RETURNING id`, [patientId, NAME])).rows[0].id as number;
          await item(receptionPage, visitId).getByRole("link").click();
          const checkout = receptionPage.getByRole("region", { name: "شبّاك ما بعد الزيارة" });
          await checkout.waitFor();
          await expect.poll(() => checkout.innerText()).toContain(`زيارة #${visitId}`);
          expect(await receptionPage.getByRole("region", { name: "الزيارة المحددة للتحصيل" }).innerText()).toContain(`#${newerVisit}`);
          expect(await checkout.getByRole("link", { name: "🖨️ ملخّص المغادرة" }).getAttribute("href")).toBe(`/print/walkout/${visitId}`);
          expect(await receptionPage.getByRole("region", { name: "زيارة اليوم", exact: true }).count()).toBe(0);
          expect((await db.query(`SELECT status, invoice_id, signed_at FROM visits WHERE id = $1`, [visitId])).rows[0]).toMatchObject({ status: "done", invoice_id: null, signed_at: expect.any(Date) });
          expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
        }, () => {});
      }, () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); });
    } catch (error) {
      // Bounded structural facts from the isolated synthetic fixture only.
      // Never emit response bodies, names, cookies, headers, URLs or raw errors.
      console.info("RECEPTION_POLL_DIAGNOSTIC_V1", JSON.stringify({ synthetic: true, readCount, clockEpoch,
        traceOverflow, pending: pending.size, pageErrorCount: errors.length, unexpectedCount: unexpected.length, reads }));
      throw error;
    }
  }, 120_000);

  it("rejects non-front-desk sessions on the real projection and keeps ordinary visits stripped", async () => {
    for (const session of [h.sessions.doctorA, h.sessions.doctorB, h.sessions.accountant, h.sessions.cashier, h.sessions.portalA]) {
      expect([401, 403]).toContain((await authedGet("/api/visits?view=operational-checkout", session)).status);
    }
    const response = await authedGet("/api/visits", h.sessions.reception);
    expect(response.status).toBe(200);
    for (const row of await response.json()) { expect(row).not.toHaveProperty("signedAt"); expect(row).not.toHaveProperty("invoiceId"); }
    const anonymous = await fetch(`${baseUrl}/api/visits?view=operational-checkout`);
    expect(anonymous.status).toBe(401);
  });

  it.each([1280, 390])("at %ipx handles stale/error/permission loss and late A→B→A date reads without false empty state", async width => {
    const context = await contextFor(h.sessions.reception.cookie, width);
    const unexpected: string[] = [], errors: string[] = [];
    let mode: "ready" | "failed" | "malformed" | "denied" | "other-owner" = "ready";
    let activeId = 901, hold = false;
    const releases: Array<() => void> = [];
    const payload = (date: string | null) => {
      const toDate = date ?? "2026-10-10";
      const fromDate = new Date(Date.parse(`${toDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      return { version: 1, operationalItems: [], owner: { username: mode === "other-owner" ? "different-reception" : "secreception", role: "reception" },
        fromDate, toDate, clinicTimeZone: "Asia/Aden", items: [{ visitId: activeId, patientId: 31,
          patientName: `مريض تسليم اصطناعي ${activeId}`, patientNumber: "SYN-31", signedAt: `${toDate}T09:00:00Z`, status: "pending", handledReason: null, financialReviewRequired: false, visitInvoiceSettled: false }] };
    };
    const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === baseUrl && request.method() === "GET" && url.pathname === "/api/visits" && url.searchParams.get("view") === "operational-checkout") {
        const body = payload(url.searchParams.get("date")), thisMode = mode;
        if (hold) { hold = false; await new Promise<void>(resolve => releases.push(resolve)); }
        if (thisMode === "failed" || thisMode === "denied") { await route.fulfill({ status: thisMode === "denied" ? 403 : 503, json: { message: "تعذّر التحميل اصطناعياً" } }); return; }
        await route.fulfill({ json: thisMode === "malformed" ? { ...body, items: null } : body }); return;
      }
      await allowBuiltBoardRead(route, unexpected);
    });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    const refresh = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await guard.run(async () => {
      try {
        await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
        await openCheckout(page);
        await expect.poll(() => item(page, 901).count()).toBe(1);
        for (const failure of ["failed", "malformed"] as const) {
          mode = failure; await refresh();
          await expect.poll(() => register(page).innerText()).toContain("آخر قائمة غير محدثة");
          expect(await item(page, 901).count()).toBe(1);
          expect(await item(page, 901).getByRole("link").count()).toBe(0);
          expect(await register(page).innerText()).not.toContain("لا توجد زيارات بانتظار المعالجة");
          await expect.poll(() => page.getByRole("tab", { name: /التحصيل والخروج/ }).innerText()).toContain("(…)");
          mode = "ready"; await register(page).getByRole("button", { name: "تحديث زيارات الخروج" }).click();
          await expect.poll(() => item(page, 901).getByRole("link").count()).toBe(1);
        }
        // Start A, navigate to B, then A again before releasing the old A response.
        hold = true; await refresh(); await expect.poll(() => releases.length).toBe(1);
        activeId = 902; await register(page).locator('input[aria-label="نهاية فترة الخروج أو التوقيع"]:visible').fill("2026-10-09");
        await expect.poll(() => item(page, 902).count()).toBe(1);
        activeId = 903; await register(page).locator('input[aria-label="نهاية فترة الخروج أو التوقيع"]:visible').fill("2026-10-10");
        await expect.poll(() => item(page, 903).count()).toBe(1);
        releases.shift()!();
        await refresh(); await expect.poll(() => item(page, 903).count()).toBe(1);
        expect(await item(page, 901).count()).toBe(0); expect(await item(page, 902).count()).toBe(0);
        const bounds = await item(page, 903).getByRole("link").evaluate(element => {
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height, right: rect.right, left: rect.left, viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
        });
        expect(bounds.width).toBeGreaterThanOrEqual(44); expect(bounds.height).toBeGreaterThanOrEqual(44);
        expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(bounds.viewport); expect(bounds.overflow).toBe(false);
        mode = "denied"; await refresh();
        await expect.poll(() => item(page, 903).count()).toBe(0);
        expect(await register(page).innerText()).toContain("صلاحية الوصول");
        mode = "ready"; await refresh(); await expect.poll(() => item(page, 903).count()).toBe(1);
        mode = "other-owner"; await refresh(); await expect.poll(() => item(page, 903).count()).toBe(0);
        expect(await register(page).innerText()).toContain("صلاحية الوصول");
      } finally { for (const release of releases.splice(0)) release(); }
    }, () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); });
  }, 120_000);
  it.each([1280, 390])("keeps the day clear and updates a bounded pending/history tab at %ipx", async width => {
    const context = await contextFor(h.sessions.reception.cookie, width);
    const unexpected: string[] = [];
    const captures: ReceptionCapture[] = [];
    let resolved = false;
    const payload = () => ({ version: 1, operationalItems: [], owner: { username: "secreception", role: "reception" },
      fromDate: "2026-10-09", toDate: "2026-10-10", clinicTimeZone: "Asia/Aden",
      items: Array.from({ length: 30 }, (_, index) => ({ visitId: 7000 + index, patientId: 31,
        patientName: `مريض اصطناعي ${index}`, patientNumber: "SYN-31", signedAt: "2026-10-10T09:00:00Z",
        financialReviewRequired: false, visitInvoiceSettled: false, status: resolved && index === 0 ? "deferred" : "pending", handledReason: resolved && index === 0 ? "تأجيل موثّق" : null })) });
    const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
      const url = new URL(route.request().url());
      if (url.origin === baseUrl && route.request().method() === "GET" && url.pathname === "/api/visits" && url.searchParams.get("view") === "operational-checkout") {
        await route.fulfill({ json: payload() }); return;
      }
      await allowBuiltBoardRead(route, unexpected);
    });
    const page = await context.newPage();
    await guard.run(async () => {
      await page.clock.install();
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const checkoutTab = page.getByRole("tab", { name: /التحصيل والخروج/ });
      await expect.poll(() => checkoutTab.innerText()).toContain("(30)");
      expect(await register(page).isVisible()).toBe(false);
      expect(await page.getByRole("region", { name: "ملخص اليوم" }).isVisible()).toBe(true);
      captures.push({ scene: "day", png: await page.screenshot({ type: "png", fullPage: false, animations: "disabled", caret: "hide" }) });
      await openCheckout(page);
      expect(await page.getByRole("region", { name: "ملخص اليوم" }).isVisible()).toBe(false);
      const list = page.getByRole("list", { name: "مهام الاستقبال المعلقة" });
      const bounds = await list.evaluate(element => ({ height: element.getBoundingClientRect().height,
        scroll: element.scrollHeight, viewport: innerWidth, right: element.getBoundingClientRect().right }));
      expect(bounds.height).toBeLessThanOrEqual(257); expect(bounds.scroll).toBeGreaterThan(bounds.height);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
      captures.push({ scene: "pending", png: await page.screenshot({ type: "png", fullPage: false, animations: "disabled", caret: "hide" }) });
      await page.getByRole("tab", { name: "الانتظار والكراسي" }).click();
      resolved = true;
      await page.clock.fastForward(20_001);
      await expect.poll(() => checkoutTab.innerText()).toContain("(29)");
      await openCheckout(page);
      expect(await item(page, 7000).count()).toBe(0);
      await page.getByRole("button", { name: "سجل المعالجة (1)" }).click();
      expect(await item(page, 7000).innerText()).toContain("الرصيد باقٍ");
      expect(await item(page, 7000).getByRole("link").getAttribute("href")).toBe("/patients/31?tab=today&checkoutVisit=7000");
      captures.push({ scene: "history", png: await page.screenshot({ type: "png", fullPage: false, animations: "disabled", caret: "hide" }) });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect.poll(() => checkoutTab.innerText()).toContain("(29)");
      await checkoutTab.focus(); await page.keyboard.press("Home");
      expect(await page.getByRole("tab", { name: "الانتظار والكراسي" }).getAttribute("aria-selected")).toBe("true");
      await page.keyboard.press("End");
      expect(await checkoutTab.getAttribute("aria-selected")).toBe("true");
    }, () => { expect(unexpected).toEqual([]); });
    await context.close();
    await emitReceptionEvidence(width, captures);
  }, 120_000);

});
