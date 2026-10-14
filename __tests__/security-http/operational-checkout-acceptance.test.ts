import { afterAll, beforeAll, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type Page, type Locator } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authedGet, baseUrl, harness } from "./_server";
import { readOperationalCheckoutQueue, readSignedReceptionProof, type OperationalCheckoutRead, type SignedReceptionProof } from "../../lib/operational-checkout";

let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser, doctorId: number;
// Native pixels stay internal, outside the repository's broad CI artifact directory.
const ARTIFACTS = join(tmpdir(), "aqlan-reception-internal-evidence", "followon");
type Role = "admin" | "reception" | "doctorA" | "cashier" | "accountant";
let serial = 0;
beforeAll(async () => {
  h = await harness();
  const url = new URL(h.seeded.dbUrl);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname); expect(url.pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  doctorId = (await db.query(`SELECT party_id FROM users WHERE username = 'secdoctora'`)).rows[0].party_id;
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  await mkdir(ARTIFACTS, { recursive: true });
  const shift = await write("cashier", "/api/shifts", "POST", { opening: { YER: "0", SAR: "0", USD: "0" } });
  expect([201, 409]).toContain(shift.status);
});
afterAll(async () => { await browser?.close(); await db?.end(); });
function write(role: Role, path: string, method: string, body: unknown, key?: string) {
  return fetch(`${baseUrl}${path}`, { method, headers: { Cookie: h.sessions[role].cookie, Origin: baseUrl,
    "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) });
}
async function accepted<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text(); expect(response.status, text).toBe(status); return JSON.parse(text) as T;
}
async function fixture(currency: "YER" | "SAR" | "USD" = "YER", linked = true, finish = true) {
  const label = `OC-${Date.now()}-${++serial}`;
  const patientId = (await db.query(`INSERT INTO patients (patient_number, full_name, primary_doctor_id)
    VALUES ($1, 'مريض اصطناعي للخروج والتحصيل', $2) RETURNING id`, [label, doctorId])).rows[0].id as number;
  const invoice = await accepted<{ id: number }>(await write("admin", "/api/invoices", "POST", {
    patientId, currency, idempotencyKey: `invoice:${label}`, items: [{ description: "خدمة مالية اصطناعية", price: "1000", doctorId }],
  }), 201);
  const visit = await accepted<{ id: number }>(await write("reception", "/api/visits", "POST", {
    patientId, patientName: "مريض اصطناعي للخروج والتحصيل", doctorId,
  }), 201);
  // Explicit synthetic fixture relationship, never a guessed latest invoice. The production invoice writer is unchanged.
  if (linked) await db.query(`UPDATE visits SET invoice_id = $2 WHERE id = $1`, [visit.id, invoice.id]);
  if (finish) await accepted(await write("admin", `/api/visits/${visit.id}`, "PATCH", { action: "finish" }));
  return { patientId, visitId: visit.id, invoiceId: invoice.id, currency, label };
}
async function read(f: Awaited<ReturnType<typeof fixture>>) {
  return accepted<OperationalCheckoutRead>(await authedGet(`/api/visits/${f.visitId}/operational-checkout`, h.sessions.reception));
}
async function queue() {
  const response = await authedGet("/api/visits?view=operational-checkout", h.sessions.reception);
  expect(response.status).toBe(200);
  const result = readOperationalCheckoutQueue(await response.json(), { username: "secreception", role: "reception" }, null);
  expect(result).not.toBeNull(); return result!.items;
}
async function collect(f: Awaited<ReturnType<typeof fixture>>, amount: string, role: Role = "cashier", reversalOfId?: number) {
  const key = `receipt:${f.label}:${++serial}`;
  const body = { patientId: f.patientId, invoiceId: f.invoiceId, currency: f.currency, amount,
    kind: reversalOfId ? "refund" : "payment", method: "cash", ...(reversalOfId ? { reversalOfId } : {}) };
  const receipt = await accepted<{ id: number; receiptNumber: string }>(await write(role, "/api/payments", "POST", body, key), 201);
  const replay = await accepted<{ id: number; receiptNumber: string }>(await write(role, "/api/payments", "POST", body, key));
  expect(replay).toEqual(receipt); return receipt;
}
async function ledger(f: Awaited<ReturnType<typeof fixture>>) {
  return (await db.query(`SELECT id, receipt_number, kind, amount_minor, currency, invoice_id, reversal_of_id FROM payments WHERE patient_id = $1 ORDER BY id`, [f.patientId])).rows;
}
async function sign(f: Awaited<ReturnType<typeof fixture>>) {
  await accepted(await write("doctorA", `/api/visits/${f.visitId}/clinical`, "POST", {
    action: "save", doctorId, diagnosis: "مراجعة اصطناعية", treatmentDone: "توثيق سريري مستقل دون رسم جديد", procedures: [],
  }));
  const before = await ledger(f);
  await accepted(await write("doctorA", `/api/visits/${f.visitId}/clinical`, "POST", { action: "sign" }));
  await accepted(await write("doctorA", `/api/visits/${f.visitId}/clinical`, "POST", { action: "sign" }), 409);
  expect(await ledger(f)).toEqual(before);
  expect((await db.query(`SELECT id FROM invoices WHERE patient_id = $1`, [f.patientId])).rows).toEqual([{ id: f.invoiceId }]);
}
async function proof(f: Awaited<ReturnType<typeof fixture>>) {
  const value = await accepted<SignedReceptionProof>(await authedGet(`/api/visits/${f.visitId}/reception-verification`, h.sessions.reception));
  const acceptedProof = readSignedReceptionProof(value); expect(acceptedProof).not.toBeNull(); return acceptedProof!;
}
async function signedFixture() {
  const label = `SIGNED-${Date.now()}-${++serial}`;
  const patientId = (await db.query(`INSERT INTO patients (patient_number, full_name, primary_doctor_id)
    VALUES ($1, 'مريض تأجيل اصطناعي', $2) RETURNING id`, [label, doctorId])).rows[0].id as number;
  const serviceId = (await db.query(`INSERT INTO services (name, category, price_minor, price_configured, is_active)
    VALUES ($1, 'filling', 1000, TRUE, TRUE) RETURNING id`, [label])).rows[0].id as number;
  const visit = await accepted<{id:number}>(await write("reception", "/api/visits", "POST", { patientId, patientName: "مريض تأجيل اصطناعي", doctorId }), 201);
  await accepted(await write("doctorA", `/api/visits/${visit.id}/clinical`, "POST", { action: "save", doctorId,
    diagnosis: "حشوة اصطناعية", treatmentDone: "عمل موثّق", procedures: [{ serviceId, toothCode: 16, quantity: 1, unitPriceMinor: 1000, doctorId }] }));
  const signed = await accepted<{invoiceId:number}>(await write("doctorA", `/api/visits/${visit.id}/clinical`, "POST", { action: "sign" }));
  return { patientId, visitId: visit.id, invoiceId: signed.invoiceId, currency: "YER" as const, label };
}
function decisionBody(value: OperationalCheckoutRead, status: "handled" | "deferred" = "handled") {
  return { patientId: value.item.patientId, finishVersion: value.item.finishVersion, receivable: value.receivable, status, reason: " مراجعة تشغيلية اصطناعية موثّقة " };
}

it("manager no-charge sign echoes the retained exact invoice without claiming a newly generated document", async () => {
  const f = await fixture();
  await accepted(await write("admin", `/api/visits/${f.visitId}/clinical`, "POST", { action: "save", doctorId,
    diagnosis: "توثيق مدير اصطناعي", treatmentDone: "مراجعة دون رسوم إضافية", procedures: [] }));
  const before = await ledger(f), invoices = (await db.query(`SELECT id, total_minor FROM invoices WHERE patient_id = $1 ORDER BY id`, [f.patientId])).rows;
  const result = await accepted<{ invoiceId: number | null; createdInvoiceId: number | null; invoiceCurrency: string; duesMinor: number; doctorId: number; signedBy: string }>(
    await write("admin", `/api/visits/${f.visitId}/clinical`, "POST", { action: "sign" }));
  expect((await db.query(`SELECT invoice_id FROM visits WHERE id = $1`, [f.visitId])).rows).toEqual([{ invoice_id: f.invoiceId }]);
  expect(result).toMatchObject({ invoiceId: f.invoiceId, createdInvoiceId: null, invoiceCurrency: "YER", duesMinor: 0, doctorId, signedBy: "secadmin" });
  const audit = (await db.query(`SELECT details FROM audit_log WHERE action = 'visit.sign' AND entity_id = $1`, [String(f.visitId)])).rows;
  expect(audit).toHaveLength(1);
  expect(audit[0].details).toMatchObject({ الفاتورة: null, الفاتورة_المرتبطة_بالزيارة: f.invoiceId });
  expect((await write("admin", `/api/visits/${f.visitId}/clinical`, "POST", { action: "sign" })).status).toBe(409);
  expect(await ledger(f)).toEqual(before);
  expect((await db.query(`SELECT id, total_minor FROM invoices WHERE patient_id = $1 ORDER BY id`, [f.patientId])).rows).toEqual(invoices);
});

it.each(["YER", "SAR", "USD"] as const)("real unsigned checkout → retained no-charge signature → current-invoice refund and re-review preserve %s debt", async currency => {
  const f = await fixture(currency), initial = await read(f);
  expect(initial.item).toMatchObject({ signedAt: null, status: "pending", visitInvoiceSettled: false });
  expect((await queue()).filter(row => row.visitId === f.visitId)).toHaveLength(1);
  const path = `/api/visits/${f.visitId}/operational-checkout`, body = decisionBody(initial);
  for (const role of ["doctorA", "cashier", "accountant"] as const) {
    expect((await write(role, path, "POST", body)).status).toBe(403);
  }
  for (const reason of [undefined, "", "  ", " ab ", "x".repeat(301)]) {
    expect((await write("reception", path, "POST", { ...body, reason })).status).toBe(400);
  }
  const partial = await collect(f, "400");
  expect((await write("reception", path, "POST", body)).status).toBe(409);
  expect((await read(f)).item).toMatchObject({ status: "pending", visitInvoiceSettled: false });
  await collect(f, "600", "reception");
  const paid = await read(f);
  expect(paid.item).toMatchObject({ status: "pending", signedAt: null, visitInvoiceSettled: true });
  const beforeDecision = await ledger(f), finalBody = decisionBody(paid, currency === "SAR" ? "deferred" : "handled");
  const decision = await accepted(await write("reception", path, "POST", finalBody));
  expect(await accepted(await write("reception", path, "POST", { ...finalBody, status: "deferred", reason: "إعادة لا تغيّر السبب الأول" }))).toEqual(decision);
  expect(await ledger(f)).toEqual(beforeDecision);
  await sign(f);
  // Signing creates no new document and preserves the exact owned reference.
  expect((await db.query(`SELECT invoice_id FROM visits WHERE id = $1`, [f.visitId])).rows[0].invoice_id).toBe(f.invoiceId);
  const afterSign = (await queue()).filter(row => row.visitId === f.visitId);
  expect(afterSign).toHaveLength(1);
  expect(afterSign[0]).toMatchObject({ eligibility: "signed", status: finalBody.status,
    financialReviewRequired: false, visitInvoiceSettled: true });
  expect((await proof(f)).receivable).toEqual(paid.receivable);
  expect(await ledger(f)).toEqual(beforeDecision);
  const originalAudit = (await db.query(`SELECT id, details FROM audit_log WHERE action = 'visit.operational_handoff_decided' AND entity_id = $1`, [String(f.visitId)])).rows;
  const oldProof = await proof(f);
  // The refund itself must raise review; there is no pre-existing link-loss flag.
  await collect(f, "100", "admin", partial.id);
  const flagged = (await queue()).find(row => row.visitId === f.visitId)!;
  expect(flagged).toMatchObject({ status: finalBody.status, financialReviewRequired: true, visitInvoiceSettled: false });
  const debtBeforeReview = await accepted<{ balances: { currency: string; balanceMinor: number }[] }>(await authedGet(`/api/visits/${f.visitId}/walkout`, h.sessions.reception));
  expect(debtBeforeReview.balances).toEqual([{ currency, balanceMinor: currency === "YER" ? 100 : 10000 }]);
  expect((await write("reception", `/api/visits/${f.visitId}/reception-verification`, "POST", { ...oldProof, reason: "قراءة قديمة يجب رفضها" })).status).toBe(409);
  const fresh = await proof(f), review = { ...fresh, reason: "مراجعة استرداد اصطناعية مع بقاء المستحق" };
  const beforeReview = await ledger(f);
  await accepted(await write("reception", `/api/visits/${f.visitId}/reception-verification`, "POST", review));
  await accepted(await write("reception", `/api/visits/${f.visitId}/reception-verification`, "POST", review));
  expect(await ledger(f)).toEqual(beforeReview);
  expect((await queue()).find(row => row.visitId === f.visitId)).toMatchObject({ status: finalBody.status, financialReviewRequired: false });
  expect((await db.query(`SELECT id, details FROM audit_log WHERE action = 'visit.operational_handoff_decided' AND entity_id = $1`, [String(f.visitId)])).rows).toEqual(originalAudit);
  const walkout = await accepted<{ balances: { currency: string; balanceMinor: number }[] }>(await authedGet(`/api/visits/${f.visitId}/walkout`, h.sessions.reception));
  expect(walkout.balances).toEqual(debtBeforeReview.balances);
  const reviewedProof = await proof(f);
  await collect(f, "50", "admin", partial.id);
  expect((await queue()).find(row => row.visitId === f.visitId)).toMatchObject({ status: finalBody.status, financialReviewRequired: true });
  expect((await write("reception", `/api/visits/${f.visitId}/reception-verification`, "POST", { ...reviewedProof, reason: "إثبات قديم بعد استرداد لاحق" })).status).toBe(409);
  const latest = await proof(f), beforeSecondReview = await ledger(f);
  await accepted(await write("reception", `/api/visits/${f.visitId}/reception-verification`, "POST", { ...latest, reason: "مراجعة الاسترداد اللاحق مع بقاء الدين" }));
  expect(await ledger(f)).toEqual(beforeSecondReview);
  expect((await queue()).find(row => row.visitId === f.visitId)).toMatchObject({ status: finalBody.status, financialReviewRequired: false });
  expect((await accepted<{ balances: { currency: string; balanceMinor: number }[] }>(await authedGet(`/api/visits/${f.visitId}/walkout`, h.sessions.reception))).balances)
    .toEqual([{ currency, balanceMinor: currency === "YER" ? 150 : 15000 }]);
  expect((await db.query(`SELECT id, details FROM audit_log WHERE action = 'visit.operational_handoff_decided' AND entity_id = $1`, [String(f.visitId)])).rows).toEqual(originalAudit);
  expect((await authedGet(`/api/invoices?patientId=${f.patientId}`, h.sessions.accountant)).status).toBe(200);
});

it("signed deferral requires exact fresh proof and reason, returns original decision, and refuses revoked authority", async () => {
  const f = await signedFixture();
  const old = await proof(f), path = `/api/visits/${f.visitId}`;
  for (const reason of [undefined, "", "  ", "ab", "x".repeat(301)]) {
    expect((await write("reception", path, "PATCH", { action: "defer", ...old, reason })).status).toBe(400);
  }
  await collect(f, "100");
  expect((await write("reception", path, "PATCH", { action: "defer", ...old, reason: "تأجيل مع قراءة قديمة" })).status).toBe(409);
  const fresh = await proof(f), command = { action: "defer", ...fresh, reason: " تأجيل اصطناعي موثّق " };
  expect((await write("reception", path, "PATCH", { ...command, patientId: h.seeded.patientBId })).status).toBe(409);
  const before = await ledger(f), first = await accepted<{ status: string; handledReason: string }>(await write("reception", path, "PATCH", command));
  const replay = await accepted<{ status: string; handledReason: string }>(await write("reception", path, "PATCH", { ...command, reason: "سبب آخر لا يحل محل الأول" }));
  expect(replay).toMatchObject({ status: first.status, handledReason: first.handledReason, already: true });
  expect(await ledger(f)).toEqual(before);
  const original = (await db.query(`SELECT role FROM users WHERE username = 'secreception'`)).rows[0];
  try {
    await db.query(`UPDATE users SET role = 'cashier' WHERE username = 'secreception'`);
    expect([401, 403]).toContain((await write("reception", path, "PATCH", command)).status);
    expect([401, 403]).toContain((await authedGet(`/api/visits/${f.visitId}/reception-verification`, h.sessions.reception)).status);
  } finally { await db.query(`UPDATE users SET role = $1 WHERE username = 'secreception'`, [original.role]); }
  expect(await ledger(f)).toEqual(before);
});

async function geometry(_page: Page, locator: Locator) {
  return locator.evaluate(node => {
    const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right,
      viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth - innerWidth,
      visible: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
      hit: hit === node || !!hit && node.contains(hit) };
  });
}
it.each([390, 1280])("native %sx900 shows exact patient/visit/phase/amount and reachable reasoned bottom controls", async width => {
  const f = await fixture(); await collect(f, "1000");
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
  const [name, ...value] = h.sessions.reception.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage(), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /التحصيل والخروج/ }).click();
    const row = page.locator(`[data-handoff-visit="${f.visitId}"]`);
    await row.getByRole("button", { name: `متابعة خروج الزيارة #${f.visitId}`, exact: true }).click();
    const panel = row.getByRole("region", { name: `متابعة الخروج التشغيلي للزيارة ${f.visitId}` });
    await expect.poll(() => panel.getAttribute("data-operational-state")).toBe("ready");
    const reason = panel.getByLabel("سبب المعالجة أو التأجيل"), action = panel.getByRole("button", { name: "تمت مراجعة الخروج — لا يثبت السداد", exact: true });
    expect(await action.isDisabled()).toBe(true); await reason.fill("مراجعة اصطناعية من الشاشة الأصلية");
    await panel.scrollIntoViewIfNeeded();
    // Native scrolling only; no zoom, stitched image, DOM reposition or hidden-shell override.
    const panelBox = await panel.boundingBox();
    await page.mouse.move(4, 450); await page.mouse.wheel(0, panelBox!.y - 75);
    await expect.poll(async () => (await geometry(page, action)).visible).toBe(true);
    await panel.evaluate(async node => {
      let previous = "", stable = 0;
      for (let frame = 0; frame < 120; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const rect = node.getBoundingClientRect(), sample = JSON.stringify([rect.y, rect.height, scrollY]);
        stable = sample === previous ? stable + 1 : 0; if (stable >= 6) return; previous = sample;
      }
      throw new Error("Native scroll did not settle");
    });
    const evidence = { panel: await geometry(page, panel), reason: await geometry(page, reason), action: await geometry(page, action), text: await panel.innerText() };
    expect(evidence.panel.visible).toBe(true); expect(evidence.action.hit).toBe(true); expect(evidence.reason.hit).toBe(true);
    expect(evidence.panel.overflow).toBeLessThanOrEqual(1); expect(evidence.panel.viewport).toEqual({ width, height: 900 });
    for (const text of ["مريض اصطناعي للخروج والتحصيل", `زيارة #${f.visitId}`, "التوثيق السريري غير مسجّل", `فاتورة الزيارة #${f.invoiceId}`, "المراجعة التشغيلية معلّقة"]) expect(evidence.text).toContain(text);
    await page.screenshot({ path: `${ARTIFACTS}/unsigned-paid-${width}.png`, fullPage: false });
    await writeFile(`${ARTIFACTS}/unsigned-paid-${width}.json`, JSON.stringify(evidence, null, 2));
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/visits/${f.visitId}/operational-checkout`) && response.request().method() === "POST");
    await action.click(); expect((await saved).status()).toBe(200);
    expect((await read(f)).item).toMatchObject({ status: "handled", signedAt: null });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

it("never guesses the invoice for an unsigned visit from unrelated paid account invoices", async () => {
  const f = await fixture("YER", false); await collect(f, "1000");
  const current = await read(f);
  expect(current.receivable).toBeNull(); expect(current.item).toMatchObject({ status: "pending", visitInvoiceSettled: false });
  const before = await ledger(f);
  await accepted(await write("reception", `/api/visits/${f.visitId}/operational-checkout`, "POST", decisionBody(current, "deferred")));
  await sign(f);
  expect((await db.query(`SELECT invoice_id FROM visits WHERE id=$1`, [f.visitId])).rows).toEqual([{ invoice_id: null }]);
  expect(await ledger(f)).toEqual(before);
});

it("closes a completed financial re-review in history without clearing the remaining debt", async () => {
  const f = await fixture();
  await accepted(await write("reception", `/api/visits/${f.visitId}/operational-checkout`, "POST", decisionBody(await read(f))));
  const priorAudit = (await db.query(`SELECT id, details FROM audit_log WHERE action = 'visit.operational_handoff_decided' AND entity_id = $1 ORDER BY id`, [String(f.visitId)])).rows;
  await collect(f, "400");
  expect((await read(f)).item.financialReviewRequired).toBe(true);
  const receipts = await ledger(f);
  const before = await accepted<{ balances: { currency: string; balanceMinor: number }[] }>(await authedGet(`/api/visits/${f.visitId}/walkout`, h.sessions.reception));
  expect(before.balances).toEqual([{ currency: "YER", balanceMinor: 600 }]);
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.reception.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /التحصيل والخروج/ }).click();
    await page.getByRole("button", { name: /سجل المعالجة/ }).click();
    const row = page.locator(`[data-handoff-visit="${f.visitId}"]`);
    await row.getByRole("button", { name: `متابعة خروج الزيارة #${f.visitId}`, exact: true }).click();
    const panel = row.getByRole("region", { name: `متابعة الخروج التشغيلي للزيارة ${f.visitId}` });
    await expect.poll(() => panel.getAttribute("data-operational-state")).toBe("ready");
    await panel.getByLabel("سبب المعالجة أو التأجيل").fill("مراجعة التحصيل الجزئي مع بقاء الدين");
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/visits/${f.visitId}/operational-checkout`) && response.request().method() === "POST");
    await panel.getByRole("button", { name: "تمت مراجعة الخروج — لا يثبت السداد", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect.poll(() => panel.count()).toBe(0);
    expect(await row.count()).toBe(1);
    expect((await read(f)).item).toMatchObject({ status: "handled", financialReviewRequired: false, visitInvoiceSettled: false });
    expect(await ledger(f)).toEqual(receipts);
    const after = await accepted<{ balances: { currency: string; balanceMinor: number }[] }>(await authedGet(`/api/visits/${f.visitId}/walkout`, h.sessions.reception));
    expect(after.balances).toEqual(before.balances);
    expect((await db.query(`SELECT id, details FROM audit_log WHERE action = 'visit.operational_handoff_decided' AND entity_id = $1 ORDER BY id`, [String(f.visitId)])).rows.slice(0, priorAudit.length)).toEqual(priorAudit);
  } finally { await context.close(); }
});

it.each([390, 1280])("manager invoice → arrival → finish → partial collection → reasoned deferral keeps exact context at %spx", async width => {
  // No SQL invoice association: this exercises the actual invoice-first contract.
  const f = await fixture("YER", false, false);
  const replay = await accepted<{ id: number }>(await write("admin", "/api/invoices", "POST", {
    patientId: f.patientId, currency: "YER", idempotencyKey: `invoice:${f.label}`,
    items: [{ description: "خدمة مالية اصطناعية", price: "1000", doctorId }],
  }));
  expect(replay.id).toBe(f.invoiceId);
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ar-YE", timezoneId: "Asia/Aden" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `${ARTIFACTS}/reception-day-${width}.png`, fullPage: false });
    const arrivalName = page.getByRole("textbox", { name: "اسم المريض", exact: true });
    const arrivalPhone = page.getByRole("textbox", { name: "هاتف المريض", exact: true });
    await arrivalName.fill("وصول اصطناعي للتجربة"); await arrivalPhone.fill("700000001");
    if (width === 390) expect((await arrivalName.boundingBox())!.width).toBeGreaterThan(250);
    await page.screenshot({ path: `${ARTIFACTS}/reception-arrival-${width}.png`, fullPage: false });
    // A failed request must keep entered fields; this response simulates a bounded outage, without creating a visit.
    const beforeArrival = (await db.query(`SELECT count(*)::int AS n FROM visits`)).rows[0].n;
    await page.route("**/api/visits", route => route.request().method() === "POST"
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "تعذّر التسجيل الاصطناعي" }) })
      : route.continue());
    const failedArrival = page.waitForResponse(response => response.url().endsWith("/api/visits") && response.request().method() === "POST");
    await page.getByRole("button", { name: "وصل", exact: true }).click();
    expect((await failedArrival).status()).toBe(503);
    await expect.poll(() => page.getByRole("button", { name: "وصل", exact: true }).isEnabled()).toBe(true);
    expect(await arrivalName.inputValue()).toBe("وصول اصطناعي للتجربة"); expect(await arrivalPhone.inputValue()).toBe("700000001");
    expect((await db.query(`SELECT count(*)::int AS n FROM visits`)).rows[0].n).toBe(beforeArrival);
    await page.unroute("**/api/visits");
    await arrivalName.fill(""); await arrivalPhone.fill("");
    const waiting = page.getByRole("region", { name: "قائمة الانتظار", exact: true });
    expect(await waiting.innerText()).toContain("مريض اصطناعي للخروج والتحصيل");
    await waiting.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${ARTIFACTS}/reception-waiting-${width}.png`, fullPage: false });
    await accepted(await write("admin", `/api/visits/${f.visitId}`, "PATCH", { action: "clear" }));
    await accepted(await write("admin", `/api/visits/${f.visitId}`, "PATCH", { action: "seat", chair: 2 }));
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("region", { name: "الكراسي", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${ARTIFACTS}/reception-chairs-${width}.png`, fullPage: false });
    const invoicesBefore = (await db.query(`SELECT id, total_minor, discount_minor FROM invoices WHERE patient_id = $1 ORDER BY id`, [f.patientId])).rows;
    await page.getByRole("region", { name: "الكراسي", exact: true }).getByRole("button", { name: "أنهِ الجلوس", exact: true }).click();
    const checkout = page.getByRole("tab", { name: /التحصيل والخروج/ });
    await expect.poll(() => checkout.getAttribute("aria-selected")).toBe("true");
    const row = page.locator(`[data-handoff-visit="${f.visitId}"]`);
    const panel = row.getByRole("region", { name: `متابعة الخروج التشغيلي للزيارة ${f.visitId}` });
    await expect.poll(() => panel.getAttribute("data-operational-state")).toBe("ready");
    expect(await panel.getByTestId("operational-visit-invoice").innerText()).toContain("لا توجد فاتورة مرتبطة");
    expect((await db.query(`SELECT id, total_minor, discount_minor FROM invoices WHERE patient_id = $1 ORDER BY id`, [f.patientId])).rows).toEqual(invoicesBefore);
    await collect(f, "400");
    const receipts = await ledger(f);
    await panel.getByRole("link", { name: /فتح حساب المريض/ }).click();
    await page.waitForURL(`**/patients/${f.patientId}?tab=account`);
    await page.goBack({ waitUntil: "networkidle" });
    await expect.poll(() => checkout.getAttribute("aria-selected")).toBe("true");
    await expect.poll(() => panel.getAttribute("data-operational-state")).toBe("ready");
    await panel.getByLabel("سبب المعالجة أو التأجيل").fill("تأجيل المتبقي بعد تحصيل جزئي اصطناعي");
    const saved = page.waitForResponse(response => response.url().endsWith(`/api/visits/${f.visitId}/operational-checkout`) && response.request().method() === "POST");
    await panel.getByRole("button", { name: "تأجيل المتابعة مع بقاء الرصيد", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect.poll(() => panel.count()).toBe(0);
    expect((await read(f)).item).toMatchObject({ status: "deferred", signedAt: null, visitInvoiceSettled: false });
    expect(await ledger(f)).toEqual(receipts);
    const account = await accepted<{ balances: { currency: string; balanceMinor: number }[] }>(await authedGet(`/api/visits/${f.visitId}/walkout`, h.sessions.reception));
    expect(account.balances).toEqual([{ currency: "YER", balanceMinor: 600 }]);
    await page.getByRole("button", { name: /سجل المعالجة/ }).click();
    await expect.poll(() => row.count()).toBe(1);
    expect(await row.innerText()).toContain("أُجّل الدفع — الرصيد باقٍ");
    await page.screenshot({ path: `${ARTIFACTS}/reception-history-${width}.png`, fullPage: false });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

it("real exact V1 survives current V2 and patient A→B→A/back/forward with a held retired read", async () => {
  const a = await fixture(), b = await fixture("SAR"); await sign(a); await sign(b);
  const v2 = await accepted<{ id: number }>(await write("reception", "/api/visits", "POST", {
    patientId: a.patientId, patientName: "مريض اصطناعي للخروج والتحصيل", doctorId,
  }), 201);
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.reception.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const url = (f: typeof a) => `${baseUrl}/patients/${f.patientId}?tab=today&checkoutVisit=${f.visitId}`;
  const checkout = () => page.getByRole("region", { name: "شبّاك ما بعد الزيارة" });
  const verified = async (f: typeof a) => {
    await expect.poll(() => checkout().getAttribute("data-financial-state")).toBe("verified");
    expect(await checkout().getAttribute("data-visit-id")).toBe(String(f.visitId));
    expect(await checkout().getByRole("link", { name: "🖨️ ملخّص المغادرة" }).getAttribute("href")).toBe(`/print/walkout/${f.visitId}`);
  };
  let release: (() => void) | undefined, held = false;
  await page.route(`**/api/visits/${a.visitId}/walkout`, async route => {
    if (held) { await route.continue(); return; }
    held = true; const actual = await route.fetch();
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ response: actual }).catch(() => {});
  });
  try {
    await page.goto(url(a), { waitUntil: "domcontentloaded" });
    await expect.poll(() => !!release).toBe(true);
    await page.goto(url(b), { waitUntil: "domcontentloaded" }); await verified(b);
    await collect(a, "100");
    await page.goto(url(a), { waitUntil: "domcontentloaded" }); await verified(a);
    release!();
    expect(await page.getByRole("region", { name: "الزيارة المحددة للتحصيل" }).innerText()).toContain(`#${v2.id}`);
    await expect.poll(() => checkout().locator('[data-testid="checkout-current-balance"][data-currency="YER"]').innerText()).toContain("900");
    await page.goBack({ waitUntil: "domcontentloaded" }); await verified(b);
    await page.goForward({ waitUntil: "domcontentloaded" }); await verified(a);
    expect((await db.query(`SELECT id FROM payments WHERE patient_id=$1`, [a.patientId])).rows).toHaveLength(1);
  } finally { release?.(); await context.close(); }
});

it("a later real signature alerts once after the unsigned event was already seen; reload does not replay history", async () => {
  const f = await fixture("YER", false);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const [name, ...value] = h.sessions.reception.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  try {
    await page.clock.install();
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /التحصيل والخروج/ }).click();
    const row = () => page.locator(`[data-handoff-visit="${f.visitId}"]:visible`);
    await expect.poll(() => row().getAttribute("data-handoff-eligibility")).toBe("finished_unsigned");
    expect(await row().innerText()).not.toContain("خروج جديد");
    await sign(f);
    const read = page.waitForResponse(response => response.url().includes("view=operational-checkout"));
    await page.clock.fastForward(20_001); expect((await read).status()).toBe(200);
    await expect.poll(() => row().getAttribute("data-handoff-eligibility")).toBe("signed");
    expect(await row().innerText()).toContain("توقيع جديد");
    expect(await row().count()).toBe(1);
    const second = page.waitForResponse(response => response.url().includes("view=operational-checkout"));
    await page.clock.fastForward(20_001); expect((await second).status()).toBe(200);
    expect(await row().count()).toBe(1);
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /التحصيل والخروج/ }).click();
    await expect.poll(() => row().count()).toBe(1); expect(await row().innerText()).not.toContain("توقيع جديد");
  } finally { await context.close(); }
});
