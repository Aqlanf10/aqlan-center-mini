import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { baseUrl, harness } from "./_server";
import { CATEGORY_LABEL } from "../../lib/services-catalog";

// Actual built app and isolated synthetic database; no real accounts or financial data.
let browser: Browser;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
const stamp = Date.now();
beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

describe("actual prospective commission category editor", () => {
  it.each([1280, 390])("edits exact catalog keys at %s RTL without filling untouched overrides or rewriting legacy rates", async (width) => {
    const defaultPercent = width === 390 ? 0 : 17;
    const config = { calculationMode: "by_category", defaultPercent, categoryRates: { endo: 72, custom_saved: 41 },
      customServiceRates: [{ id: "legacy-special", serviceName: "خدمة خاصة للاختبار", percent: 83 }], deductLabCost: false, basis: "collected_cash" };
    const [{ id: partyId }] = (await db.query<{ id: number }>(`INSERT INTO parties (name, kind, commission_percent) VALUES ($1, 'doctor', 20) RETURNING id`, [`طبيب نسب اصطناعي ${width}`])).rows;
    const username = `cat-${stamp}-${width}`;
    const [{ id: userId }] = (await db.query<{ id: number }>(`INSERT INTO users (username, display_name, password_hash, role, party_id, commission_config)
      VALUES ($1, $2, 'unused-synthetic-hash', 'doctor', $3, $4) RETURNING id`, [username, `طبيب نسب اصطناعي ${width}`, partyId, JSON.stringify(config)])).rows;
    const customCategory = `catalog_raw_${width}`;
    await db.query(`INSERT INTO services (name, category) VALUES ($1, $2)`, [`خدمة فئة اصطناعية ${width}`, customCategory]);
    const context = await browser.newContext({ viewport: { width, height: 1100 }, locale: "ar-YE" });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage();
    const writes: Array<{ url: string; body: { commissionConfig?: { categoryRates: Record<string, number>; defaultPercent: number } } }> = [];
    page.on("request", (request) => {
      if (request.method() !== "GET" && request.method() !== "HEAD") writes.push({ url: request.url(), body: request.postDataJSON() });
    });
    try {
      await page.goto(`${baseUrl}/settings/users`);
      await page.getByPlaceholder("بحث بالاسم أو التخصص...").fill(`طبيب نسب اصطناعي ${width}`);
      const open = async () => {
        await page.getByRole("button", { name: "💰 النِسب والأتعاب", exact: true }).click();
        await page.getByRole("region", { name: "نسب فئات الخدمات" }).waitFor();
      };
      await open();
      const region = page.getByRole("region", { name: "نسب فئات الخدمات" });
      for (const key of Object.keys(CATEGORY_LABEL)) expect(await region.getByRole("spinbutton", { name: `نسبة فئة ${key}`, exact: true }).count()).toBe(1);
      expect(await region.getByRole("spinbutton", { name: "نسبة فئة rct", exact: true }).inputValue()).toBe(String(defaultPercent));
      expect(await region.getByRole("spinbutton", { name: "نسبة فئة filling", exact: true }).inputValue()).toBe(String(defaultPercent));
      expect(await region.getByText("النسبة الخاصة بالخدمة لها الأولوية", { exact: false }).count()).toBe(1);
      const save = async () => {
        const response = page.waitForResponse((candidate) => candidate.url() === `${baseUrl}/api/users/${userId}` && candidate.request().method() === "PATCH");
        await page.getByRole("button", { name: "حفظ التغييرات والصلاحيات", exact: true }).click();
        expect((await response).status()).toBe(200);
        await region.waitFor({ state: "hidden" });
      };
      await save();
      expect(writes).toHaveLength(1);
      for (const key of ["commissionConfig", "commissionPercent", "clearCommissionConfig"]) expect(Object.hasOwn(writes[0].body, key)).toBe(false);
      const { rows: initialHistory } = await db.query(`SELECT * FROM doctor_commission_history WHERE party_id = $1 ORDER BY id`, [partyId]);
      expect(initialHistory).toEqual([]);
      const { rows: initialAudits } = await db.query(`SELECT * FROM audit_log WHERE action = 'doctor.commission.update' AND entity = 'party' AND entity_id = $1 ORDER BY id`, [String(partyId)]);
      expect(initialAudits).toEqual([]);
      expect((await db.query(`SELECT commission_config FROM users WHERE id = $1`, [userId])).rows[0].commission_config).toBe(JSON.stringify(config));
      await open();
      const disclosure = region.locator("summary");
      await disclosure.scrollIntoViewIfNeeded();
      expect((await disclosure.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await disclosure.click();
      expect(await region.getByRole("spinbutton", { name: "نسبة فئة endo", exact: true }).inputValue()).toBe("72");
      expect(await region.getByRole("spinbutton", { name: "نسبة فئة custom_saved", exact: true }).inputValue()).toBe("41");
      expect(await region.getByRole("spinbutton", { name: `نسبة فئة ${customCategory}`, exact: true }).inputValue()).toBe(String(defaultPercent));
      expect(await region.getByText("علاج الجذور والعصب", { exact: true }).count()).toBe(1);
      const rct = region.getByRole("spinbutton", { name: "نسبة فئة rct", exact: true });
      const filling = region.getByRole("spinbutton", { name: "نسبة فئة filling", exact: true });
      await rct.fill("12.345"); await filling.fill("0");
      for (const input of await region.getByRole("spinbutton").all()) {
        expect(await input.getAttribute("step")).toBe("any");
        expect(await input.evaluate(element => (element as HTMLInputElement).checkValidity())).toBe(true);
        await input.scrollIntoViewIfNeeded();
        const box = (await input.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      await rct.scrollIntoViewIfNeeded(); await rct.focus();
      expect(await rct.evaluate((input) => getComputedStyle(input).outlineStyle)).not.toBe("none");
      expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const fieldset = page.getByRole("group", { name: "مسودة العمولة", exact: true });
      const fieldsetBox = (await fieldset.boundingBox())!;
      expect(fieldsetBox.x).toBeGreaterThanOrEqual(0);
      expect(fieldsetBox.x + fieldsetBox.width).toBeLessThanOrEqual(width);
      expect(await fieldset.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const output = join(process.cwd(), ".settings-ui-artifacts"); await mkdir(output, { recursive: true });
      await page.screenshot({ path: join(output, `commission-category-editor-${width}.png`) });
      await save();
      expect(writes).toHaveLength(2); expect(writes.every((write) => write.url === `${baseUrl}/api/users/${userId}`)).toBe(true);
      expect(writes[1].body.commissionConfig!.categoryRates).toMatchObject({ rct: 12.345, filling: 0, endo: 72, custom_saved: 41 });
      expect(writes[1].body.commissionConfig!.categoryRates).not.toHaveProperty(customCategory);
      const [{ commission_config: stored }] = (await db.query<{ commission_config: string }>(`SELECT commission_config FROM users WHERE id = $1`, [userId])).rows;
      expect(JSON.parse(stored)).toMatchObject({ defaultPercent, categoryRates: { rct: 12.345, filling: 0, endo: 72, custom_saved: 41 }, customServiceRates: config.customServiceRates });
      const { rows: history } = await db.query<{ id: number; config: { categoryRates: Record<string, number> }; source: string }>(`SELECT id, config, source FROM doctor_commission_history WHERE party_id = $1 ORDER BY id`, [partyId]);
      expect(history).toHaveLength(2); expect(history[0].source).toBe("baseline"); expect(history[0].config.categoryRates).not.toHaveProperty("rct"); expect(history[1].source).toBe("advanced");
      expect(history[1].config.categoryRates).toMatchObject({ rct: 12.345, filling: 0, endo: 72 });
      const [{ actor, details }] = (await db.query<{ actor: string; details: Record<string, unknown> }>(`SELECT actor, details FROM audit_log WHERE action = 'doctor.commission.update' AND entity = 'party' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [String(partyId)])).rows;
      expect(actor).toBe("secadmin"); expect(details["قبل_القيمة"]).toMatchObject({ config: { categoryRates: { endo: 72 } } });
      expect(details["بعد_القيمة"]).toMatchObject({ config: { categoryRates: { rct: 12.345, filling: 0, endo: 72 } } });
      expect(typeof details["نافذ_من"]).toBe("string");
      await open();
      expect(await rct.inputValue()).toBe("12.345"); expect(await filling.inputValue()).toBe("0");
    } finally { await context.close(); }
  }, 180_000);
});
