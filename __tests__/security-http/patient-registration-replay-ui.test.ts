import { expect, it } from "vitest";
import { chromium } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";
import { PATIENT_CREATE_UNCERTAIN } from "../../lib/patient-create-warning";

it("retains the browser registration key when a committed HTTP response is lost", async () => {
  const h = await harness();
  const db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  try {
    await db.connect();
    const context = await browser.newContext();
    const [name, value] = h.sessions.reception.cookie.split("=");
    await context.addCookies([{ name, value, url: baseUrl }]);
    const page = await context.newPage();
    const keys: (string | undefined)[] = [];
    let committed: { id: number; patientNumber: string } | undefined;
    let firstStatus = 0;
    await page.route("**/api/patients", async route => {
      if (route.request().method() !== "POST") return route.continue();
      keys.push(route.request().headers()["idempotency-key"]);
      if (keys.length > 1) return route.continue();
      const response = await route.fetch();
      firstStatus = response.status();
      committed = await response.json();
      await response.dispose();
      await route.abort("failed"); // Discard the real server response after COMMIT.
    });
    await page.goto(baseUrl + "/patients");
    await page.getByRole("button", { name: "+ مريض جديد", exact: true }).click();
    const fullName = "شاهد زمرد تسجيل مرجاني اصطناعي";
    await page.getByLabel("الاسم الكامل", { exact: true }).fill(fullName);
    await page.getByRole("checkbox", { name: /مريض سابق/ }).check();
    await page.getByLabel("مبلغ الرصيد السابق", { exact: true }).fill("83");
    const save = page.getByRole("button", { name: "احفظ وافتح الملف", exact: true });
    await save.click();
    await page.getByText(PATIENT_CREATE_UNCERTAIN, { exact: true }).waitFor();
    expect(firstStatus).toBe(201);
    expect(committed?.id).toBeGreaterThan(0);
    await Promise.all([page.waitForURL(baseUrl + "/patients/" + committed!.id), save.click()]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^register:/);
    expect(keys[1]).toBe(keys[0]);
    const { rows } = await db.query(`SELECT p.id, p.patient_number, b.amount_minor::text,
      (SELECT count(*)::int FROM patient_opening_balance_history h WHERE h.patient_id=p.id) AS history,
      (SELECT count(*)::int FROM audit_log a WHERE a.entity='patient' AND a.entity_id=p.id::text
        AND a.action IN ('patient.create','opening_balance.set')) AS audits
      FROM patients p JOIN patient_opening_balances b ON b.patient_id=p.id WHERE p.full_name=$1`, [fullName]);
    expect(rows).toEqual([{ id: committed!.id, patient_number: committed!.patientNumber, amount_minor: "83", history: 1, audits: 2 }]);

    const ledgerRefusal = page.waitForResponse(r => new URL(r.url()).pathname === `/api/patients/${committed!.id}/ledger`);
    await page.getByLabel("أقسام ملف المريض").getByRole("button", { name: /الحساب/ }).click();
    expect((await ledgerRefusal).status()).toBe(403);
    await page.getByRole("checkbox", { name: /مريض سابق/ }).check();
    await page.getByLabel("عملة الرصيد السابق").selectOption("SAR");
    await page.getByLabel("مبلغ الرصيد السابق").fill("7.50");
    await page.getByRole("button", { name: "إضافة الرصيد السابق", exact: true }).click();
    await page.getByText("سُجّل الرصيد السابق.", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "تسجيل تحصيل", exact: true }).count()).toBe(0);
    const additional = await db.query(`SELECT currency, amount_minor::text FROM patient_opening_balances
      WHERE patient_id=$1 ORDER BY currency`, [committed!.id]);
    expect(additional.rows).toEqual([{ currency: "SAR", amount_minor: "750" }, { currency: "YER", amount_minor: "83" }]);
    expect((await db.query("SELECT 1 FROM payments WHERE patient_id=$1", [committed!.id])).rows).toHaveLength(0);
  } finally {
    await browser.close();
    await db.end();
  }
}, 120_000);
