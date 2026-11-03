import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";
let browser: Browser, db: Client, h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness(); expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
});
afterAll(async () => { await browser?.close(); await db?.end(); });
describe("explicit end of active treatment in the actual patient workspace", () => {
  it.each([390, 768, 1440])("saves/replays and reloads the clinician decision at %ipx", async width => {
    const patientId = (await db.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'حالة انتقال اصطناعية') RETURNING id", [`SYN-TRANSITION-${randomUUID()}`])).rows[0].id;
    const caseId = (await db.query("INSERT INTO ortho_cases(patient_id,created_by,status,phase) VALUES($1,'synthetic','active','finishing') RETURNING id", [patientId])).rows[0].id;
    await db.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic')", [patientId, caseId]);
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE" });
    const [name, ...value] = h.sessions.admin.cookie.split("="); await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage(), errors: string[] = []; page.on("pageerror", e => errors.push(e.message)); page.setDefaultTimeout(20_000);
    const endpoint = `${baseUrl}/api/ortho/${caseId}/retention-transition`;
    try {
      await page.goto(`${baseUrl}/patients/${patientId}?tab=treatment&sub=ortho&orthoCaseId=${caseId}&pillar=retention`);
      const section = page.getByRole("region", { name: "قرار بدء متابعة التثبيت", exact: true });
      await section.getByLabel("سبب إنهاء العلاج النشط", { exact: true }).fill("قرار الطبيب الاصطناعي بعد مراجعة الحالة");
      await section.getByLabel("خطة متابعة التثبيت", { exact: true }).fill("خطة متابعة اصطناعية محفوظة دون إنشاء موعد تلقائي");
      await section.getByLabel("مصدر تاريخ انتهاء العلاج", { exact: true }).selectOption("unknown");
      await section.getByLabel("توضيح مصدر تاريخ الانتقال", { exact: true }).fill("السجل التاريخي الاصطناعي لا يحدد التاريخ");
      await section.getByLabel("أؤكد قرار إنهاء العلاج النشط والانتقال إلى متابعة التثبيت", { exact: true }).check();
      let first = true;
      if (width === 768) await page.route(endpoint, async route => {
        if (route.request().method() !== "POST" || !first) return route.continue();
        first = false;
        const saved = await route.fetch(); expect(saved.status()).toBe(201);
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, code: "write_unconfirmed", message: "Synthetic lost confirmation" }) });
      });
      const response = page.waitForResponse(r => r.url() === endpoint && r.request().method() === "POST");
      await section.getByRole("button", { name: "تسجيل قرار بدء التثبيت", exact: true }).click();
      expect((await response).status()).toBe(width === 768 ? 503 : 201);
      if (width === 768) {
        const retry = page.waitForResponse(r => r.url() === endpoint && r.request().method() === "POST");
        await section.getByRole("button", { name: "التحقق من قرار التثبيت بنفس الطلب", exact: true }).click();
        expect((await retry).status()).toBe(200);
      }
      await section.getByText("سُجّل قرار الانتقال إلى التثبيت", { exact: true }).waitFor();
      await page.reload();
      await section.getByText("سُجّل قرار الانتقال إلى التثبيت", { exact: true }).waitFor();
      expect(await section.innerText()).toContain("تاريخ انتهاء العلاج: غير معروف");
      expect(await section.innerText()).toContain("خطة متابعة اصطناعية محفوظة");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: `.settings-ui-artifacts/ortho-transition-${width}.png`, fullPage: true });
      expect((await db.query("SELECT status,phase,retainer,retainer_on,closed_at FROM ortho_cases WHERE id=$1", [caseId])).rows[0]).toEqual({ status: "retention", phase: "retention", retainer: null, retainer_on: null, closed_at: null });
      expect((await db.query("SELECT status,completed_at FROM clinical_cases WHERE ortho_case_id=$1", [caseId])).rows[0]).toEqual({ status: "active", completed_at: null });
      expect((await db.query(`SELECT (SELECT count(*)::int FROM ortho_retention_transitions WHERE ortho_case_id=$2) decisions,
       (SELECT count(*)::int FROM ortho_retention_entries WHERE ortho_case_id=$2) devices,(SELECT count(*)::int FROM invoices WHERE patient_id=$1) invoices,
       (SELECT count(*)::int FROM payments WHERE patient_id=$1) payments,(SELECT count(*)::int FROM appointments WHERE patient_id=$1) appointments,
       (SELECT count(*)::int FROM visits WHERE patient_id=$1) visits`, [patientId, caseId])).rows[0]).toEqual({ decisions: 1, devices: 0, invoices: 0, payments: 0, appointments: 0, visits: 0 });
      const denied = await fetch(endpoint, { method: "POST", headers: { Cookie: h.sessions.reception.cookie, Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify({ patientId, command: {} }) });
      expect(denied.status).toBe(403); expect(denied.headers.get("cache-control")).toContain("no-store");
      const legacyDenied = await fetch(`${baseUrl}/api/ortho/${caseId}`, { method: "PATCH", headers: { Cookie: h.sessions.reception.cookie, Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify({ phase: "working" }) });
      expect(legacyDenied.status).toBe(403);
      const hidden = await fetch(`${endpoint}?patientId=${patientId}`, { headers: { Cookie: h.sessions.accountant.cookie } }); expect(hidden.status).toBe(403);
      expect(errors).toEqual([]);
    } catch (error) { await page.screenshot({ path: `.settings-ui-artifacts/ortho-transition-failure-${width}.png`, fullPage: true }); throw error; }
    finally { await context.close(); }
  });
});
