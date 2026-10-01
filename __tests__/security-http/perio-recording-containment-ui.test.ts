import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";
import { CONDITION_LABEL, toothName } from "../../lib/dental";

let browser: Browser;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

it("Perio is explicitly unavailable without invented findings; the ordinary tooth chart still saves", async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar-YE" });
  const [name, ...value] = h.sessions.admin.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const page = await context.newPage();
  const chartPath = `/api/patients/${h.seeded.patientAId}/chart`;
  const mutations: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) mutations.push(request.url());
  });
  try {
    await page.goto(`${baseUrl}/patients/${h.seeded.patientAId}?tab=chart`);
    await page.getByRole("button", { name: "مخطط اللثة (Perio Chart)" }).click();
    const notice = page.getByRole("alert").filter({ hasText: "قياسات اللثة غير محفوظة" });
    await notice.waitFor();
    expect(await notice.textContent()).toContain("إدخال قياسات اللثة غير متاح");
    expect(await notice.textContent()).toContain("ملاحظات الزيارة السريرية");
    expect(await notice.locator("..").locator("select").count()).toBe(0);
    expect(await page.getByTitle("نزف عند السبر (BOP)").count()).toBe(0);
    expect(await page.getByText("2 mm", { exact: true }).count()).toBe(0);
    expect(mutations).toEqual([]);

    await page.reload();
    await page.getByRole("button", { name: "مخطط اللثة (Perio Chart)" }).click();
    await notice.waitFor();
    expect(await notice.locator("..").locator("select").count()).toBe(0);

    await page.getByRole("button", { name: "مخطط الأسنان (Odontogram)" }).click();
    expect(await notice.count()).toBe(0);
    await page.getByRole("button", { name: toothName(11), exact: true }).click();
    await page.getByRole("button", { name: CONDITION_LABEL.caries, exact: true }).click();
    const saved = page.waitForResponse((response) => response.url().endsWith(chartPath) && response.request().method() === "POST");
    await page.getByRole("button", { name: "تثبيت الحالة على المخطط السني", exact: true }).click();
    expect((await saved).status()).toBe(201);
    const { rows } = await db.query<{ condition: string }>(
      `SELECT condition FROM tooth_conditions WHERE patient_id = $1 AND tooth_code = 11 ORDER BY id DESC LIMIT 1`,
      [h.seeded.patientAId],
    );
    expect(rows[0].condition).toBe("caries");
  } finally { await context.close(); }
}, 120_000);
