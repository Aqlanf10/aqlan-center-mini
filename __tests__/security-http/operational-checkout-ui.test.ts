import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedGet, baseUrl, harness } from "./_server";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { readOperationalCheckoutQueue } from "../../lib/operational-checkout";

let h: Awaited<ReturnType<typeof harness>>, browser: Browser, db: Client;
beforeAll(async () => {
  await mkdir("artifacts/operational-checkout", { recursive: true });
  await writeFile("artifacts/operational-checkout/started.txt", "synthetic-suite-started\n");
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
// Read-only DOM measurements. Nested queue clipping is distinct from fixed-shell
// obstruction; every control must fit both before an ordinary user action.
function operationalGeometry(node: Element) {
  const rect = node.getBoundingClientRect();
  const shell = Array.from(document.querySelectorAll("body *")).flatMap(element => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    if (!["fixed", "sticky"].includes(style.position) || style.visibility !== "visible"
      || style.display === "none" || Number(style.opacity) === 0 || box.width <= 0 || box.height <= 0
      || box.right <= rect.left || box.left >= rect.right || element.contains(node)) return [];
    const edge = style.top !== "auto" && box.top <= 1 && box.bottom > 0 && box.bottom < innerHeight ? "top"
      : style.bottom !== "auto" && box.bottom >= innerHeight - 1 && box.top > 0 && box.top < innerHeight ? "bottom" : null;
    return edge ? [{ edge, top: box.top, bottom: box.bottom }] : [];
  });
  const shellTop = Math.max(0, ...shell.filter(box => box.edge === "top").map(box => box.bottom));
  const shellBottom = Math.min(innerHeight, ...shell.filter(box => box.edge === "bottom").map(box => box.top));
  let left = 0, right = innerWidth, top = shellTop, bottom = shellBottom;
  const clipping = [];
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
    const x = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
    const y = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
    if (!x && !y) continue;
    const bounds = { left: box.left + parent.clientLeft, top: box.top + parent.clientTop,
      right: box.left + parent.clientLeft + parent.clientWidth, bottom: box.top + parent.clientTop + parent.clientHeight };
    if (x) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    if (y) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
    clipping.push({ ...bounds, x, y, scrollTop: parent.scrollTop, scrollLeft: parent.scrollLeft });
  }
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const ex = Math.min(2, rect.width / 4), ey = Math.min(2, rect.height / 4);
  const kx = Math.min(8, rect.width / 4), ky = Math.min(8, rect.height / 4);
  const hits = [
    { name: "center", x: cx, y: cy }, { name: "top", x: cx, y: rect.top + ey },
    { name: "right", x: rect.right - ex, y: cy }, { name: "bottom", x: cx, y: rect.bottom - ey },
    { name: "left", x: rect.left + ex, y: cy }, { name: "top-left", x: rect.left + kx, y: rect.top + ky },
    { name: "top-right", x: rect.right - kx, y: rect.top + ky },
    { name: "bottom-right", x: rect.right - kx, y: rect.bottom - ky },
    { name: "bottom-left", x: rect.left + kx, y: rect.bottom - ky },
  ].map(point => ({ ...point, owned: node.contains(document.elementFromPoint(point.x, point.y)) }));
  return { bounds: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
    shell: { top: shellTop, bottom: shellBottom, obstructions: shell }, usable: { left, right, top, bottom }, clipping, hits,
    viewport: { width: innerWidth, height: innerHeight }, dir: document.documentElement.dir,
    scrollWidth: document.documentElement.scrollWidth, scrollY,
    fullyVisible: rect.width > 0 && rect.height > 0 && rect.left >= left && rect.right <= right && rect.top >= top && rect.bottom <= bottom,
    unobscured: hits.every(point => point.owned) };
}
type OperationalGeometry = ReturnType<typeof operationalGeometry>;
function assertOperationalGeometry(proof: OperationalGeometry, width: number, action = true) {
  expect(proof.viewport).toEqual({ width, height: 1000 }); expect(proof.dir).toBe("rtl");
  expect(proof.scrollWidth).toBeLessThanOrEqual(width + 1);
  expect(proof.usable.right).toBeGreaterThan(proof.usable.left);
  expect(proof.usable.bottom).toBeGreaterThan(proof.usable.top);
  expect(proof.fullyVisible).toBe(true); expect(proof.unobscured).toBe(true);
  expect(proof.hits).toHaveLength(9); for (const hit of proof.hits) expect(hit.owned, hit.name).toBe(true);
  if (action) expect(proof.bounds.height).toBeGreaterThanOrEqual(44);
}
async function settleOperationalWheel(control: Locator) {
  await control.evaluate(async node => {
    let previous = "", stableFrames = 0;
    for (let frame = 0; frame < 180; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const rect = node.getBoundingClientRect(), scrolls = [];
      for (let parent = node.parentElement; parent; parent = parent.parentElement) scrolls.push([parent.scrollTop, parent.scrollLeft]);
      const sample = JSON.stringify([scrollX, scrollY, rect.left, rect.right, rect.top, rect.bottom, ...scrolls]);
      stableFrames = sample === previous ? stableFrames + 1 : 1;
      if (stableFrames >= 6) return;
      previous = sample;
    }
    throw new Error("Operational target did not settle after native wheel input");
  });
}
async function revealOperationalTarget(page: Page, queue: Locator, control: Locator, width: number, nested: boolean) {
  expect(await control.count()).toBe(1);
  const before = await control.evaluate(operationalGeometry);
  const pointer = await queue.evaluate((node, input) => {
    const { nested, shellTop, shellBottom } = input;
    const box = node.getBoundingClientRect(), main = node.closest("main")?.getBoundingClientRect();
    const x = nested ? box.left + 4 : (main?.left ?? 0) + 4;
    const y = nested ? box.top + box.height / 2 : (shellTop + shellBottom) / 2;
    const target = document.elementFromPoint(x, y);
    return { x, y, exists: target !== null, inQueue: target !== null && node.contains(target),
      nativeField: Boolean(target?.closest("input,textarea,select")) };
  }, { nested, shellTop: before.shell.top, shellBottom: before.shell.bottom });
  expect(pointer.exists).toBe(true); expect(pointer.nativeField).toBe(false); expect(pointer.inQueue).toBe(nested);
  const center = (before.usable.top + before.usable.bottom) / 2;
  const distance = before.bounds.top + before.bounds.height / 2 - center;
  const deltaY = Math.abs(distance) < 1 ? 2 : distance;
  await page.mouse.move(pointer.x, pointer.y); await page.mouse.wheel(0, deltaY);
  await expect.poll(async () => {
    const proof = await control.evaluate(operationalGeometry);
    return proof.fullyVisible && proof.unobscured;
  }).toBe(true);
  await settleOperationalWheel(control);
  const proof = await control.evaluate(operationalGeometry);
  assertOperationalGeometry(proof, width, nested);
  return { proof, wheel: { method: "native-mouse-wheel", nested, pointer, deltaY,
    beforeScrollY: before.scrollY, beforeClipping: before.clipping } };
}


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
    let capture: { bytes: Buffer; geometry: unknown[]; finalAction: OperationalGeometry } | undefined;
    try { await guard.run(async () => {
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
      const reason = panel.getByRole("textbox", { name: "سبب المعالجة أو التأجيل" });
      await reason.fill("مراجعة اصطناعية دون فاتورة");
      await page.evaluate(async () => { await document.fonts.ready; });
      const queue = page.getByRole("list", { name: "مهام الاستقبال المعلقة", exact: true });
      const geometry: unknown[] = [{ target: "queue-scrollport", ...await revealOperationalTarget(page, queue, queue, width, false) }];
      const handled = panel.getByRole("button", { name: "تمت مراجعة الخروج — لا يثبت السداد", exact: true });
      const controls = [
        { target: "retry", control: panel.getByRole("button", { name: "إعادة التحقق من الزيارة", exact: true }) },
        { target: "account-link", control: panel.getByRole("link") },
        { target: "reason", control: reason },
        { target: "defer", control: panel.getByRole("button", { name: "تأجيل المتابعة مع بقاء الرصيد", exact: true }) },
        { target: "handled", control: handled },
      ];
      for (const { target, control } of controls) {
        expect(await control.isEnabled()).toBe(true);
        geometry.push({ target, ...await revealOperationalTarget(page, queue, control, width, true) });
      }
      expect(await reason.inputValue()).toBe("مراجعة اصطناعية دون فاتورة");
      expect(await panel.getAttribute("data-operational-state")).toBe("ready");
      expect(await panel.getByRole("link").getAttribute("href")).toBe("/patients/31?tab=account");
      expect(writes).toBe(0); expect(allowDecision).toBe(false);
      const finalAction = await handled.evaluate(operationalGeometry);
      assertOperationalGeometry(finalAction, width);
      const bytes = await page.screenshot({ type: "png", fullPage: false });
      expect(bytes.byteLength).toBeLessThanOrEqual(524_288);
      expect(await handled.evaluate(operationalGeometry)).toEqual(finalAction);
      capture = { bytes, geometry, finalAction };
      allowDecision = true; await handled.click();
      await expect.poll(() => writes).toBe(1);
      await expect.poll(() => page.getByRole("button", { name: "سجل المعالجة (1)" }).count()).toBe(1);
      await page.getByRole("button", { name: "سجل المعالجة (1)" }).click();
      expect(await queueRow.innerText()).toContain("لا تعني سداد الرصيد");
      expect(await queueRow.getAttribute("data-handoff-eligibility")).toBe("finished_unsigned");
    }, () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); });
    } finally { await context.close(); }
    // Emit only after the complete native handled journey, isolation checks and
    // context cleanup succeed. The pixels were captured while the decision was
    // still pending; a successful screenshot alone cannot satisfy acceptance.
    expect(capture).toBeDefined();
    if (!capture) throw new Error("Missing operational native capture");
    expect(writes).toBe(1); expect(decision).toBe("handled");
    const filename = `operational-checkout-ready-${width}.png`;
    const evidence = { protocol: 1, synthetic: true, runId: process.env.GITHUB_RUN_ID ?? null,
      checkoutSha: process.env.GITHUB_SHA ?? null, suite: "__tests__/security-http/operational-checkout-ui.test.ts",
      sourceSha256: createHash("sha256").update(readFileSync("__tests__/security-http/operational-checkout-ui.test.ts")).digest("hex"),
      filename, viewport: { width, height: 1000 }, mime: "image/png", bytes: capture.bytes.byteLength,
      sha256: createHash("sha256").update(capture.bytes).digest("hex"), geometry: capture.geometry, finalAction: capture.finalAction,
      capturePhase: "verified-ready-before-handled", nativeHandledWrites: writes, handledInHistory: true,
      unexpectedRequests: unexpected.length, pageErrors: errors.length, contextClosed: true };
    const encoded = JSON.stringify(evidence);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(65_536);
    await writeFile(`artifacts/operational-checkout/${filename}`, capture.bytes);
    console.info("OPERATIONAL_CHECKOUT_UI_PROOF_V1", encoded);
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
