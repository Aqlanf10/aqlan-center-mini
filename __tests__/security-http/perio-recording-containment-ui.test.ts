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

it("both chart actions open the saved periodontal workspace without writing or losing the chart draft", async () => {
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
    await page.goto(`${baseUrl}/patients/${h.seeded.patientAId}?tab=chart&keep=perio-chart-navigation#record`);
    const chart = page.locator('[data-workspace-section="chart"]');
    await chart.getByRole("button", { name: toothName(11), exact: true }).click();
    const note = chart.getByRole("textbox", { name: "ملاحظة", exact: true });
    await note.fill("Synthetic chart draft retained across periodontal navigation");
    await chart.getByRole("button", { name: "افتح مساحة اللثة (Periodontics)", exact: true }).click();
    const workspace = page.getByRole("region", { name: "مساحة فحص اللثة", exact: true });
    await workspace.waitFor({ state: "visible" });
    await workspace.locator('button:not([disabled])').filter({ hasText: "تحديث السجل" }).waitFor();
    const destination = new URL(page.url());
    expect(destination.pathname).toBe(`/patients/${h.seeded.patientAId}`);
    expect(destination.searchParams.get("tab")).toBe("treatment");
    expect(destination.searchParams.get("sub")).toBe("perio");
    expect(destination.searchParams.get("keep")).toBe("perio-chart-navigation");
    expect(destination.hash).toBe("#record");
    expect(await page.getByRole("alert").filter({ hasText: "قياسات اللثة غير محفوظة" }).count()).toBe(0);
    expect(mutations).toEqual([]);

    await page.getByTestId("workspace-nav-chart").click();
    await note.waitFor({ state: "visible" });
    expect(await note.inputValue()).toBe("Synthetic chart draft retained across periodontal navigation");
    await chart.getByRole("button", { name: "افتح مساحة اللثة الكاملة", exact: true }).click();
    await workspace.waitFor({ state: "visible" });
    await workspace.locator('button:not([disabled])').filter({ hasText: "تحديث السجل" }).waitFor();
    expect(mutations).toEqual([]);
    await page.getByTestId("workspace-nav-chart").click();
    await note.waitFor({ state: "visible" });
    expect(await note.inputValue()).toBe("Synthetic chart draft retained across periodontal navigation");

    // Deep-link reload retains the canonical destination, not an in-memory legacy view.
    await chart.getByRole("button", { name: "افتح مساحة اللثة (Periodontics)", exact: true }).click();
    await workspace.waitFor({ state: "visible" });
    await workspace.locator('button:not([disabled])').filter({ hasText: "تحديث السجل" }).waitFor();
    await page.reload();
    await workspace.waitFor({ state: "visible" });
    await workspace.locator('button:not([disabled])').filter({ hasText: "تحديث السجل" }).waitFor();
    expect(await page.getByRole("alert").filter({ hasText: "قياسات اللثة غير محفوظة" }).count()).toBe(0);
    expect(mutations).toEqual([]);
    await page.getByTestId("workspace-nav-chart").click();
    await chart.getByRole("button", { name: toothName(11), exact: true }).click();
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
