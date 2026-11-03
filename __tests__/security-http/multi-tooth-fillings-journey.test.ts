import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
import { assertInvoiceViewportBounds, invoiceViewportProof, revealInvoiceControlByWheel } from "./_invoice-browser-geometry";
import type { Invoice } from "../../lib/db";

// Real built app + loopback PostgreSQL. No network interception, patient imports,
// deployment credentials or production screenshots belong in this fixture.
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
let fillingId: number, consultationId: number, doctorId: number, otherDoctorId: number;
const stamp = randomUUID();
const output = ".settings-ui-artifacts/multi-tooth-fillings";
const teeth = [16, 26, 36];
const surfaces: Record<number, string> = { 16: "MO", 26: "DB", 36: "L" };
const finalSurfaces: Record<number, string> = { ...surfaces, 16: "MDO" };
type Child = { serviceId: number; toothCode: number; surfaces: string; doctorId: number; quantity: number;
  price: string; episodeTeeth?: number[]; groupId?: string; displayGroupId?: string; caseId?: number; planItemId?: number | null };

beforeAll(async () => {
  expect(new URL(baseUrl).origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  h = await harness();
  const database = new URL(h.seeded.dbUrl);
  expect(database.hostname).toBe("127.0.0.1");
  expect(database.pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  doctorId = (await db.query("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id;
  otherDoctorId = (await db.query("SELECT party_id FROM users WHERE username='secdoctorb'")).rows[0].party_id;
  fillingId = (await db.query(`INSERT INTO services(name,category,price_minor,price_sar_minor,price_usd_minor,price_configured,is_active)
    VALUES($1,'filling',25000,12500,4000,TRUE,TRUE) RETURNING id`, [`حشوة ضوئية اصطناعية ${stamp}`])).rows[0].id;
  consultationId = (await db.query(`INSERT INTO services(name,category,price_minor,price_configured,is_active)
    VALUES($1,'consultation',1000,TRUE,TRUE) RETURNING id`, [`كشف اصطناعي ${stamp}`])).rows[0].id;
  mkdirSync(output, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function patient() {
  return (await db.query(`INSERT INTO patients(patient_number,full_name)
    VALUES($1,'مريض اختبار الحشوات المتعددة — اصطناعي') RETURNING id`, [`FILL-HTTP-${randomUUID()}`])).rows[0].id as number;
}
async function open(width: number) {
  const patientId = await patient();
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1040 }, locale: "ar-YE", serviceWorkers: "block" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage(); page.setDefaultTimeout(20_000);
  await page.goto(`${baseUrl}/patients/${patientId}?tab=account`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("treatment-entry-open").click();
  await page.getByRole("button", { name: "علاج جديد", exact: true }).click();
  return { context, page, patientId };
}
const row = (page: Page, index = 0) => page.getByTestId(`invoice-row-${index}`);
const save = (page: Page) => page.getByRole("button", { name: "احفظ الفاتورة", exact: true });
async function keyboardActivate(control: Locator) {
  await control.focus();
  await control.press("Space");
}
async function openTeeth(page: Page) {
  const opener = page.getByTestId("invoice-tooth-button-0");
  await opener.focus(); await opener.press("Enter");
  const dialog = page.getByTestId("tooth-dialog"); await dialog.waitFor();
  expect(await dialog.getAttribute("aria-modal")).toBe("true");
  expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  return dialog;
}
async function chooseFillings(page: Page) {
  const dialog = page.getByTestId("tooth-dialog");
  for (const tooth of teeth) await keyboardActivate(dialog.getByTestId(`odontogram-tooth-${tooth}`));
  for (const tooth of teeth) {
    const field = dialog.getByTestId(`tooth-surfaces-${tooth}`);
    for (const surface of surfaces[tooth]) await keyboardActivate(field.getByTestId(`surface-${surface}`));
  }
}
async function confirmTeeth(page: Page) {
  await page.getByTestId("tooth-dialog-confirm").click();
  await page.getByTestId("tooth-dialog").waitFor({ state: "detached" });
}
async function assertSurfaces(dialog: Locator, tooth: number, selected: string) {
  for (const surface of "MODBL") expect(await dialog.getByTestId(`tooth-surfaces-${tooth}`)
    .getByTestId(`surface-${surface}`).getAttribute("aria-pressed")).toBe(String(selected.includes(surface)));
}
async function ready(page: Page) {
  await expect.poll(() => page.locator('[data-testid^="invoice-clinical-preview-"][data-preview-state="ready"]').count(), { timeout: 30_000 }).toBe(3);
  await expect.poll(() => save(page).isEnabled(), { timeout: 30_000 }).toBe(true);
}
async function clinicalRows(patientId: number) {
  return (await db.query(`SELECT pi.id,pi.tooth_code,pi.surfaces,pi.case_id,pi.doctor_id,pi.quantity,
    pi.unit_price_minor::text,pi.status,pi.billing_status,ii.plan_item_id,ii.source_type,ii.source_id::text
    FROM invoices i JOIN invoice_items ii ON ii.invoice_id=i.id JOIN plan_items pi ON pi.id=ii.plan_item_id
    WHERE i.patient_id=$1 ORDER BY pi.tooth_code`, [patientId])).rows;
}

describe("multi-tooth composite filling through the real invoice UI", () => {
  it.each([1280, 390])("preserves surfaces, independent pricing and doctors through cancel/reselection/currency/service changes at %ipx", async width => {
    const { context, page, patientId } = await open(width);
    const errors: string[] = [], submitted: { items: Child[]; currency: string; discount: string }[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/invoices") submitted.push(request.postDataJSON());
    });
    try {
      await row(page).getByLabel("الخدمة", { exact: true }).selectOption(String(fillingId));
      expect((await row(page).getByLabel("السعر", { exact: true }).inputValue()).replaceAll(",", "")).toBe("25000");
      let dialog = await openTeeth(page);
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Shift+Tab");
      expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
      await chooseFillings(page);
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
      expect(await page.getByTestId("invoice-tooth-button-0").evaluate(node => node === document.activeElement)).toBe(true);
      expect(await row(page).getAttribute("data-tooth")).toBe("");
      expect(await save(page).isDisabled()).toBe(true);
      dialog = await openTeeth(page);
      for (const tooth of teeth) expect(await dialog.getByTestId(`odontogram-tooth-${tooth}`).getAttribute("aria-pressed")).toBe("false");
      expect(await dialog.locator('[data-testid^="tooth-surfaces-"]').count()).toBe(0);
      await chooseFillings(page);
      for (const tooth of teeth) await assertSurfaces(dialog, tooth, surfaces[tooth]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const dialogProof = await dialog.evaluate(node => {
        const confirm = node.querySelector('[data-testid="tooth-dialog-confirm"]')!;
        const rect = confirm.getBoundingClientRect();
        return { viewport: { width: innerWidth, height: innerHeight },
          footer: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height,
            unobscured: confirm.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) },
          verticalScroll: [...node.querySelectorAll<HTMLElement>("*")].some(element =>
            getComputedStyle(element).overflowY === "auto" && element.scrollHeight > element.clientHeight && element.scrollTop > 0),
        };
      });
      expect(dialogProof.footer.top).toBeGreaterThanOrEqual(0);
      expect(dialogProof.footer.bottom).toBeLessThanOrEqual(dialogProof.viewport.height);
      expect(dialogProof.footer.left).toBeGreaterThanOrEqual(0);
      expect(dialogProof.footer.right).toBeLessThanOrEqual(width);
      expect(dialogProof.footer.height).toBeGreaterThanOrEqual(44);
      expect(dialogProof.footer.unobscured).toBe(true);
      if (width === 390) expect(dialogProof.verticalScroll).toBe(true);
      await page.screenshot({ path: `${output}/surfaces-${width}.png`, fullPage: false, animations: "disabled", caret: "hide" });
      await confirmTeeth(page);
      expect(await page.locator('[data-testid^="invoice-row-"]').count()).toBe(1);
      expect(await row(page).getByLabel("الكمية", { exact: true }).inputValue()).toBe("3");
      expect(await row(page).getByLabel("الكمية", { exact: true }).isDisabled()).toBe(true);
      expect(await page.locator('[data-testid^="invoice-provider-"]').count()).toBe(1);
      await page.getByTestId("invoice-provider-0").selectOption(String(doctorId)); await ready(page);

      // Reselecting a removed tooth cannot revive its former surface selection.
      dialog = await openTeeth(page);
      for (const tooth of teeth) await assertSurfaces(dialog, tooth, surfaces[tooth]);
      await keyboardActivate(dialog.getByTestId("odontogram-tooth-26"));
      await keyboardActivate(dialog.getByTestId("odontogram-tooth-26"));
      await assertSurfaces(dialog, 26, "");
      for (const surface of surfaces[26]) await keyboardActivate(dialog.getByTestId("tooth-surfaces-26").getByTestId(`surface-${surface}`));
      await keyboardActivate(dialog.getByTestId("tooth-surfaces-16").getByTestId("surface-D"));
      await dialog.getByRole("button", { name: "إلغاء", exact: true }).click(); await dialog.waitFor({ state: "detached" });
      dialog = await openTeeth(page);
      for (const tooth of teeth) await assertSurfaces(dialog, tooth, surfaces[tooth]);
      await confirmTeeth(page);

      // Same clinical choices survive currency changes; monetary decisions are
      // re-quoted in the selected currency and a former discount is withdrawn.
      await page.getByLabel("الخصم", { exact: true }).fill("1000");
      await page.getByLabel("سبب الخصم", { exact: true }).fill("Synthetic initial discount");
      await page.getByLabel("عملة الفاتورة", { exact: true }).selectOption("SAR");
      await expect.poll(async () => (await row(page).getByLabel("السعر", { exact: true }).inputValue()).replaceAll(",", "")).toBe("125.00");
      expect(["", "0"]).toContain(await page.getByLabel("الخصم", { exact: true }).inputValue());
      expect(await page.getByTestId("invoice-line-total-0").innerText()).toContain("375.00");
      dialog = await openTeeth(page);
      for (const tooth of teeth) await assertSurfaces(dialog, tooth, surfaces[tooth]);
      await confirmTeeth(page);
      await page.getByLabel("عملة الفاتورة", { exact: true }).selectOption("YER");
      await expect.poll(async () => (await row(page).getByLabel("السعر", { exact: true }).inputValue()).replaceAll(",", "")).toBe("25000");

      // A new service owns a fresh site and quote, even after grouped entry.
      await row(page).getByLabel("الخدمة", { exact: true }).selectOption(String(consultationId));
      expect(await page.locator('[data-testid^="invoice-row-"]').count()).toBe(1);
      expect(await row(page).getAttribute("data-tooth")).toBe("");
      expect(await page.getByTestId("invoice-tooth-button-0").count()).toBe(0);
      expect((await row(page).getByLabel("السعر", { exact: true }).inputValue()).replaceAll(",", "")).toBe("1000");
      await row(page).getByLabel("الخدمة", { exact: true }).selectOption(String(fillingId));
      dialog = await openTeeth(page);
      expect(await dialog.locator('[data-testid^="tooth-surfaces-"]').count()).toBe(0);
      await chooseFillings(page); await confirmTeeth(page);
      await page.getByTestId("invoice-provider-0").selectOption(String(doctorId)); await ready(page);
      dialog = await openTeeth(page);
      await keyboardActivate(dialog.getByTestId("tooth-surfaces-16").getByTestId("surface-D"));
      await confirmTeeth(page);
      dialog = await openTeeth(page);
      for (const tooth of teeth) await assertSurfaces(dialog, tooth, finalSurfaces[tooth]);
      await confirmTeeth(page);

      // One physician selection attributes the group; the supported split gives
      // tooth 26 a separate physician and price without changing teeth 16/36.
      await page.getByTestId("invoice-group-details-0").locator("summary").first().click();
      await page.getByTestId("invoice-split-tooth-1").click();
      expect(await page.locator('[data-testid^="invoice-row-"]').count()).toBe(2);
      await page.getByTestId("invoice-provider-1").selectOption(String(otherDoctorId));
      await row(page, 1).getByLabel("السعر", { exact: true }).fill("30000");
      await row(page, 1).getByLabel("سبب تغيير السعر", { exact: true }).fill("Synthetic independent filling agreement");
      await page.getByLabel("الخصم", { exact: true }).fill("5000");
      await page.getByLabel("سبب الخصم", { exact: true }).fill("Synthetic final discount");
      await ready(page);
      expect(await page.getByTestId("invoice-line-total-0").innerText()).toContain("50,000");
      expect(await page.getByTestId("invoice-line-total-1").innerText()).toContain("30,000");
      expect(await page.getByTestId("invoice-financial-summary").innerText()).toContain("75,000");
      const proofs = [];
      for (const control of [row(page).getByLabel("الكمية", { exact: true }), page.getByTestId("invoice-provider-1"),
        row(page, 1).getByLabel("السعر", { exact: true }), save(page)]) {
        await revealInvoiceControlByWheel(page, control);
        const proof = await control.evaluate(invoiceViewportProof); proofs.push(proof);
        assertInvoiceViewportBounds(proof, width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `${output}/ready-${width}.png`, fullPage: true, animations: "disabled", caret: "hide" });
      const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/invoices" && response.request().method() === "POST");
      await save(page).click();
      const response = await savedResponse; expect(response.status()).toBe(201);
      const saved = await response.json() as Invoice & { clinical: { planId: number } };
      await page.getByTestId("invoice-clinical-notice").waitFor();
      expect(submitted).toHaveLength(1);
      expect(submitted[0]).toMatchObject({ currency: "YER", discount: "5000" });
      expect(submitted[0].items).toHaveLength(3);
      for (const item of submitted[0].items) {
        expect(teeth).toContain(item.toothCode); expect(item.surfaces).toBe(finalSurfaces[item.toothCode]);
        expect(item.quantity).toBe(1); expect(item.serviceId).toBe(fillingId);
        expect(item.doctorId).toBe(item.toothCode === 26 ? otherDoctorId : doctorId);
        expect(Number(item.price.replaceAll(",", ""))).toBe(item.toothCode === 26 ? 30000 : 25000);
        for (const field of ["episodeTeeth", "groupId", "displayGroupId", "caseId"]) expect(item).not.toHaveProperty(field);
        expect(item.planItemId).toBeNull();
      }
      const stored = await clinicalRows(patientId);
      expect(new Set(stored.map(item => item.id)).size).toBe(3);
      expect(stored.map(item => [item.tooth_code, item.surfaces, item.unit_price_minor, item.case_id]))
        .toEqual([[16, "MDO", "25000", null], [26, "DB", "30000", null], [36, "L", "25000", null]]);
      for (const item of stored) {
        expect(item.plan_item_id).toBe(item.id); expect(item.source_type).toBe("plan_item"); expect(item.source_id).toBe(String(item.id));
        expect(item.quantity).toBe(1); expect(item.status).toBe("planned"); expect(item.billing_status).toBe("billed");
        expect(item.doctor_id).toBe(item.tooth_code === 26 ? otherDoctorId : doctorId);
      }
      const rereadResponse = await authedGet(`/api/invoices/${saved.id}`, h.sessions.admin);
      expect(rereadResponse.status).toBe(200);
      const reread = await rereadResponse.json() as Invoice;
      expect(reread).toMatchObject({ id: saved.id, totalMinor: 80000, discountMinor: 5000, status: "open", baseCurrency: "YER" });
      expect(reread.items.map(item => [item.toothCode, item.surfaces])).toEqual([[16, "MDO"], [26, "DB"], [36, "L"]]);
      const ledger = await (await authedGet(`/api/patients/${patientId}/ledger`, h.sessions.admin)).json();
      expect(ledger.balances.YER).toMatchObject({ billedMinor: 75000, collectedMinor: 0, dueMinor: 75000 });
      expect((await db.query("SELECT consent_at,total_minor::text FROM treatment_plans WHERE id=$1", [saved.clinical.planId])).rows)
        .toEqual([{ consent_at: null, total_minor: "80000" }]);
      for (const table of ["payments", "clinical_cases"]) expect((await db.query(`SELECT id FROM ${table} WHERE patient_id=$1`, [patientId])).rows).toEqual([]);

      const printResponse = await authedGet(`/print/invoice/${saved.id}`, h.sessions.admin); expect(printResponse.status).toBe(200);
      const html = await printResponse.text();
      const body = html.match(/<table class="items">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/)?.[1];
      expect(body).toBeTypeOf("string");
      const printRows = body!.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
      expect(printRows).toHaveLength(3);
      for (const [index, tooth] of teeth.entries()) {
        const text = printRows[index].replace(/<[^>]*>/g, "");
        expect(text).toContain(String(tooth)); expect(text).toContain(finalSurfaces[tooth]);
      }
      expect(html).toContain("75,000"); expect(html).toContain("5,000");
      const printPage = await context.newPage();
      await printPage.goto(`${baseUrl}/print/invoice/${saved.id}`, { waitUntil: "networkidle" });
      await printPage.emulateMedia({ media: "print" });
      await printPage.pdf({ path: `${output}/invoice-${width}.pdf`, format: "A4", printBackground: true });
      expect(await printPage.locator("table.items tbody tr").count()).toBe(3);
      await printPage.close();
      writeFileSync(`${output}/witness-${width}.json`, JSON.stringify({ width, height: page.viewportSize()?.height, source: "Built app, real HTTP and isolated synthetic PostgreSQL",
        submitted: submitted[0], invoiceId: saved.id, stored, totalMinor: 80000, discountMinor: 5000, remainingMinor: 75000,
        noClinicalCases: true, noPayments: true, keyboardAndCancellation: true, dialogProof, proofs, errors }, null, 2));
      expect(errors).toEqual([]);
    } catch (error) {
      await page.screenshot({ path: `${output}/failed-${width}.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }, 120_000);
});

describe("multi-tooth filling HTTP refusals", () => {
  it.each([
    [{ surfaces: "MX" }, 400, "bad_surfaces"],
    [{ toothCode: null }, 400, "tooth_required"],
    [{ episodeTeeth: [26, 36] }, 400, "episode_split_required"],
    [{ episodeTeeth: [36] }, 400, "episode_split_required"],
    [{ scope: "full_mouth" }, 400, "bad_scope"],
  ] as const)("preview and save reject %j without a partial invoice", async (patch, status, refusal) => {
    const patientId = await patient();
    const body = { patientId, currency: "YER", items: [
      { serviceId: fillingId, doctorId, toothCode: 16, surfaces: "MO", quantity: 1, price: "25000" },
      { serviceId: fillingId, doctorId, toothCode: 26, surfaces: "DB", quantity: 1, price: "25000", ...patch },
    ] };
    const preview = await authedMutation("/api/invoices/clinical-preview", h.sessions.admin, "POST", JSON.stringify(body));
    expect(preview.status).toBe(200);
    const evidence = await preview.json(); expect(evidence.lines[1].refusal).toBe(refusal);
    expect(evidence.lines[1].refusalMessage).toMatch(/[؀-ۿ]/);
    const saved = await authedMutation("/api/invoices", h.sessions.admin, "POST", JSON.stringify(body));
    expect(saved.status).toBe(status); expect((await saved.json()).message).toMatch(/[؀-ۿ]/);
    expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1", [patientId])).rows).toEqual([]);
    expect((await db.query("SELECT id FROM treatment_plans WHERE patient_id=$1", [patientId])).rows).toEqual([]);
  });

  it("blocks duplicate tooth rows and a second invoice after an exact idempotent replay", async () => {
    const patientId = await patient();
    const item = { serviceId: fillingId, doctorId, toothCode: 26, surfaces: "MO", quantity: 1, price: "25000" };
    const body = { patientId, currency: "YER", idempotencyKey: `fill-http:${randomUUID()}`, items: [item, { ...item, toothCode: 36, surfaces: "DB" }] };
    const send = (input: unknown) => authedMutation("/api/invoices", h.sessions.admin, "POST", JSON.stringify(input));
    const duplicate = await send({ ...body, items: [item, { ...item, surfaces: "D" }] });
    expect(duplicate.status).toBe(409); expect((await duplicate.json()).message).toMatch(/[؀-ۿ]/);
    expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1", [patientId])).rows).toEqual([]);
    const first = await send(body); expect(first.status).toBe(201); const saved = await first.json();
    const initial = await clinicalRows(patientId);
    const replay = await send(body); expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ id: saved.id, replayed: true });
    const again = await send({ ...body, idempotencyKey: `fill-http:${randomUUID()}` }); expect(again.status).toBe(409);
    expect((await again.json()).message).toContain("له فاتورة قائمة");
    expect(await clinicalRows(patientId)).toEqual(initial);
    expect((await db.query("SELECT id FROM invoices WHERE patient_id=$1", [patientId])).rows).toEqual([{ id: saved.id }]);
  });
});
