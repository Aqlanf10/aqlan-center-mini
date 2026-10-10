import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedGet, baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { readOperationalCheckoutQueue } from "../../lib/operational-checkout";

let h: Awaited<ReturnType<typeof harness>>, browser: Browser, db: Client;
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  expect(["127.0.0.1", "localhost"]).toContain(new URL(h.seeded.dbUrl).hostname);
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });
const write = (path: string, method: string, body: unknown, cookie: string) => fetch(`${baseUrl}${path}`, {
  method, headers: { Cookie: cookie, Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify(body),
});
describe("finished unsigned checkout on the actual HTTP boundary", () => {
  it("manager finish enters the queue without a signature or debt; explicit reasoned handling persists and roles remain separated", async () => {
    const patientId = (await db.query(`INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض خروج اصطناعي') RETURNING id`, [`OP-HTTP-${Date.now()}`])).rows[0].id;
    const visitId = (await db.query(`INSERT INTO visits (patient_id, patient_name, status, arrived_at) VALUES ($1, 'مريض خروج اصطناعي', 'waiting', NOW()) RETURNING id`, [patientId])).rows[0].id;
    expect((await write(`/api/visits/${visitId}`, "PATCH", { action: "finish" }, h.sessions.admin.cookie)).status).toBe(200);
    const listed = await authedGet("/api/visits?view=operational-checkout", h.sessions.reception);
    expect(listed.status).toBe(200);
    const accepted = readOperationalCheckoutQueue(await listed.json(), { username: "secreception", role: "reception" }, null);
    expect(accepted?.items.filter(row => row.visitId === visitId)).toMatchObject([{ patientId, eligibility: "finished_unsigned", signedAt: null, status: "pending" }]);
    const readResponse = await authedGet(`/api/visits/${visitId}/operational-checkout`, h.sessions.reception);
    expect(readResponse.status).toBe(200); const read = await readResponse.json();
    expect(read).toMatchObject({ receivable: null, item: { patientId, visitId, signedAt: null } });
    const body = { patientId, finishVersion: read.item.finishVersion, receivable: null, status: "handled", reason: "خروج اصطناعي دون فاتورة جديدة" };
    for (const session of [h.sessions.doctorA, h.sessions.doctorB, h.sessions.accountant, h.sessions.cashier, h.sessions.portalA]) {
      expect([401, 403]).toContain((await authedGet(`/api/visits/${visitId}/operational-checkout`, session)).status);
      expect([401, 403]).toContain((await write(`/api/visits/${visitId}/operational-checkout`, "POST", body, session.cookie)).status);
    }
    expect((await write(`/api/visits/${visitId}/operational-checkout`, "POST", { ...body, patientId: patientId + 100000 }, h.sessions.reception.cookie)).status).toBe(409);
    for (let retry = 0; retry < 2; retry++) expect((await write(`/api/visits/${visitId}/operational-checkout`, "POST", body, h.sessions.reception.cookie)).status).toBe(200);
    expect((await db.query(`SELECT details FROM audit_log WHERE action = 'visit.operational_handoff_decided' AND entity_id = $1`, [String(visitId)])).rows).toHaveLength(1);
    expect((await db.query(`SELECT signed_at, invoice_id, status FROM visits WHERE id = $1`, [visitId])).rows[0]).toEqual({ signed_at: null, invoice_id: null, status: "done" });
    expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
    expect((await db.query(`SELECT id FROM payments WHERE patient_id = $1`, [patientId])).rows).toHaveLength(0);
    const finished = await authedGet("/api/visits?view=operational-checkout", h.sessions.reception);
    expect(readOperationalCheckoutQueue(await finished.json(), { username: "secreception", role: "reception" }, null)?.items.find(row => row.visitId === visitId)).toMatchObject({ status: "handled", signedAt: null });
  });

  it.each([390, 1280])("at %ipx gates account access and operational decisions on exact verified owner/version, without fabricated visit charges", async width => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
    const [name, ...value] = h.sessions.reception.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const unexpected: string[] = [], errors: string[] = [];
    let decision: "pending" | "handled" = "pending", allowDecision = false, writes = 0;
    let mode: "ready" | "failed" | "other-owner" = "ready";
    const row = () => ({ visitId: 91001, patientId: 31, patientName: "مريض خروج اصطناعي", patientNumber: "SYN-31", signedAt: null,
      finishedAt: "2026-10-10T09:00:00.123Z", finishVersion: "finished:2026-10-10T09:00:00.123456Z", dateBasis: "finished",
      status: decision, financialReviewRequired: false, visitInvoiceSettled: false, handledReason: decision === "handled" ? "مراجعة اصطناعية دون فاتورة" : null });
    const owner = { username: "secreception", role: "reception" };
    const safe = new Set(["/api/visits", "/api/visits/readiness", "/api/appointments", "/api/parties", "/api/booking-requests", "/api/display/notice", "/api/lab", "/api/messages", "/api/auth/me"]);
    const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === baseUrl && request.method() === "GET" && url.pathname === "/api/visits" && url.searchParams.get("view") === "operational-checkout") {
        await route.fulfill({ json: { version: 1, owner, fromDate: "2026-10-09", toDate: "2026-10-10", clinicTimeZone: "Asia/Aden", items: [], operationalItems: [row()] } }); return;
      }
      if (url.origin === baseUrl && url.pathname === "/api/visits/91001/operational-checkout") {
        if (request.method() === "GET") {
          await route.fulfill({ status: mode === "failed" ? 503 : 200, json: mode === "failed" ? { message: "تعذّر التحقق اصطناعيًا" }
            : { version: 1, owner: mode === "other-owner" ? { ...owner, username: "other" } : owner, item: row(), receivable: null } }); return;
        }
        if (request.method() === "POST" && allowDecision) {
          allowDecision = false; writes++;
          expect(request.postDataJSON()).toEqual({ patientId: 31, finishVersion: row().finishVersion, receivable: null, status: "handled", reason: "مراجعة اصطناعية دون فاتورة" });
          decision = "handled"; await route.fulfill({ json: { ok: true, item: row() } }); return;
        }
      }
      if (url.origin === baseUrl && ["GET", "HEAD"].includes(request.method()) && (safe.has(url.pathname) || url.pathname === "/" || url.pathname.startsWith("/_next/")
        || ["/logo.png", "/favicon.ico", "/icon.png", "/apple-icon.png", "/manifest.webmanifest", "/sw.js"].includes(url.pathname))) { await route.continue(); return; }
      unexpected.push(`${request.method()} ${url.pathname}`); await route.abort();
    });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await guard.run(async () => {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.getByRole("tab", { name: /التحصيل والخروج/ }).click();
      await expect.poll(() => page.locator('[data-handoff-visit="91001"]').count()).toBe(1);
      const queueRow = page.locator('[data-handoff-visit="91001"]');
      expect(await queueRow.innerText()).toContain("التوثيق السريري غير مسجّل");
      expect(await queueRow.locator('a[href*="checkoutVisit="]').count()).toBe(0);
      mode = "failed"; await queueRow.getByRole("button", { name: "متابعة خروج الزيارة #91001" }).click();
      const panel = page.getByRole("region", { name: "متابعة الخروج التشغيلي للزيارة 91001" });
      await expect.poll(() => panel.getAttribute("data-operational-state")).toBe("error");
      expect(await panel.getByRole("link").count()).toBe(0); expect(await panel.locator('input').count()).toBe(0);
      mode = "other-owner"; await panel.getByRole("button", { name: "إعادة التحقق من الزيارة" }).click();
      await expect.poll(() => panel.getAttribute("data-operational-state")).toBe("error");
      expect(await panel.getByRole("link").count()).toBe(0);
      mode = "ready"; await panel.getByRole("button", { name: "إعادة التحقق من الزيارة" }).click();
      await expect.poll(() => panel.getAttribute("data-operational-state")).toBe("ready");
      expect(await panel.getByTestId("operational-visit-invoice").innerText()).toContain("لا توجد فاتورة مرتبطة بهذه الزيارة");
      expect(await panel.getByRole("link").getAttribute("href")).toBe("/patients/31?tab=account");
      expect(await panel.innerText()).not.toContain("الحساب مسدّد");
      const bounds = await panel.getByRole("link").evaluate(element => ({ left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right, height: element.getBoundingClientRect().height, width: innerWidth }));
      expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(bounds.width); expect(bounds.height).toBeGreaterThanOrEqual(44);
      await panel.getByRole("textbox", { name: "سبب المعالجة أو التأجيل" }).fill("مراجعة اصطناعية دون فاتورة");
      allowDecision = true; await panel.getByRole("button", { name: "تمت مراجعة الخروج — لا يثبت السداد" }).click();
      await expect.poll(() => writes).toBe(1);
      await expect.poll(() => page.getByRole("button", { name: "سجل المعالجة (1)" }).count()).toBe(1);
      await page.getByRole("button", { name: "سجل المعالجة (1)" }).click();
      expect(await queueRow.innerText()).toContain("لا تعني سداد الرصيد");
      expect(await queueRow.getAttribute("data-handoff-eligibility")).toBe("finished_unsigned");
    }, () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); });
    await context.close();
  }, 120_000);
});

it("keeps historical decisions in history and counts financial rechecks separately from pending", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.reception.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = [];
  const safe = new Set(["/api/visits", "/api/visits/readiness", "/api/appointments", "/api/parties", "/api/booking-requests", "/api/display/notice", "/api/lab", "/api/messages", "/api/auth/me"]);
  const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === baseUrl && request.method() === "GET" && url.pathname === "/api/visits" && url.searchParams.get("view") === "operational-checkout") {
      await route.fulfill({ json: { version: 1, owner: { username: "secreception", role: "reception" }, fromDate: "2026-10-09", toDate: "2026-10-10", clinicTimeZone: "Asia/Aden", operationalItems: [],
        items: [{ visitId: 92001, patientId: 31, patientName: "قرار تاريخي اصطناعي", patientNumber: "SYN-31", signedAt: "2026-10-10T09:00:00.000Z",
          status: "deferred", handledReason: "المراجعة لاحقًا", financialReviewRequired: true, visitInvoiceSettled: true }] } }); return;
    }
    if (url.origin === baseUrl && request.method() === "GET" && url.pathname === "/api/visits/92001/reception-verification") {
      await route.fulfill({ status: 503, json: { message: "قراءة اصطناعية غير متاحة" } }); return;
    }
    if (url.origin === baseUrl && ["GET", "HEAD"].includes(request.method()) && (safe.has(url.pathname) || url.pathname === "/" || url.pathname.startsWith("/_next/")
      || ["/logo.png", "/favicon.ico", "/icon.png", "/apple-icon.png", "/manifest.webmanifest", "/sw.js"].includes(url.pathname))) { await route.continue(); return; }
    unexpected.push(`${request.method()} ${url.pathname}`); await route.abort();
  });
  const page = await context.newPage();
  await guard.run(async () => {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const tab = page.getByRole("tab", { name: /التحصيل والخروج/ });
    await expect.poll(() => tab.innerText()).toContain("(0)"); await tab.click();
    await expect.poll(() => page.getByRole("button", { name: "تحتاج إعادة تحقق مالية (1)" }).count()).toBe(1);
    expect(await page.locator('[data-handoff-visit="92001"]').count()).toBe(0);
    await page.getByRole("button", { name: "تحتاج إعادة تحقق مالية (1)" }).click();
    const row = page.locator('[data-handoff-visit="92001"]');
    expect(await row.getAttribute("data-handoff-status")).toBe("deferred");
    expect(await row.innerText()).toContain("الحالة المالية تحتاج إعادة تحقق");
    expect(await row.innerText()).toContain("فاتورة هذه الزيارة مسدّدة وفق القراءة الحالية");
    expect(await row.innerText()).toContain("لا يعني سداد رصيد الحساب");
    await row.getByRole("button", { name: "إعادة التحقق المالي للزيارة #92001" }).click();
    const verification = page.getByRole("region", { name: "إعادة التحقق المالي للزيارة 92001" });
    await expect.poll(() => verification.getAttribute("data-verification-state")).toBe("error");
    expect(await verification.getByRole("textbox").count()).toBe(0);
    expect(await verification.getByRole("button", { name: "تسجيل إعادة التحقق — لا يثبت السداد" }).count()).toBe(0);
    expect(await row.getAttribute("data-handoff-status")).toBe("deferred");
    expect(await page.getByRole("button", { name: "سجل المعالجة (1)" }).count()).toBe(1);
  }, () => { expect(unexpected).toEqual([]); });
  await context.close();
}, 120_000);
