import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { Client } from "pg";
import { baseUrl, harness } from "./_server";

let browser: Browser;
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
const original = ["VIP", "متأخر السداد"];
const third = "يحتاج مرافقًا";
const workspaceFields = ["id", "patientNumber", "fullName", "phone", "gender", "birthYear", "createdAt",
  "altPhone", "email", "address", "birthDate", "guardianName", "guardianPhone", "referralSource", "referredBy",
  "preferredChannel", "flags"].sort();

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
});
afterAll(async () => { await browser?.close(); await db?.end(); });

it("edits only the selected flags in the desk workspace across reloads and refuses unavailable or stale selections", async () => {
  const { rows: [patient] } = await db.query(`INSERT INTO patients(patient_number,full_name,flags,medical_alert,note)
    VALUES($1,'Synthetic flags patient',$2,'Synthetic private alert','Synthetic clinical note') RETURNING id`,
    [`FLAGS-UI-${Date.now()}`, original]);
  const context = await browser.newContext({ locale: "ar-YE", serviceWorkers: "block" });
  try {
    const [name, ...value] = h.sessions.reception.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const page = await context.newPage();
    const api = `${baseUrl}/api/patients/${patient.id}`;
    const view = api + "?projection=workspace";
    const url = `${baseUrl}/patients/${patient.id}?tab=summary`;
    const panel = page.getByRole("region", { name: "الهوية والتواصل" });
    const stored = async () => (await db.query("SELECT flags FROM patients WHERE id=$1", [patient.id])).rows[0].flags;
    const reopen = async (expected: string[]) => {
      const reading = page.waitForResponse(r => r.url() === view && r.status() === 200);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const result = await (await reading).json();
      expect(Object.keys(result).sort()).toEqual(["appointments", "patient", "visits"]);
      expect(Object.keys(result.patient).sort()).toEqual(workspaceFields);
      expect(result.patient.flags).toEqual(expected);
      for (const flag of [...original, third]) {
        await expect.poll(() => panel.getByRole("button", { name: new RegExp(flag) }).getAttribute("aria-pressed")).toBe(String(expected.includes(flag)));
      }
    };
    let writes = 0;
    page.on("request", request => { if (request.url() === api && request.method() === "PATCH") writes++; });
    const toggle = async (flag: string, code: number) => {
      const saved = page.waitForResponse(r => r.url() === api && r.request().method() === "PATCH");
      await panel.getByRole("button", { name: new RegExp(flag) }).click();
      const response = await saved;
      expect(response.status(), await response.text()).toBe(code);
      if (code === 200) expect(Object.keys(await response.json()).sort()).toEqual(workspaceFields);
    };

    await reopen(original);
    await toggle(third, 200);
    await reopen([...original, third]);
    await toggle(original[0], 200);
    await reopen([original[1], third]);
    expect(await stored()).toEqual([original[1], third]);

    // Another desk saved its own change after this page loaded.
    await db.query("UPDATE patients SET flags=$2 WHERE id=$1", [patient.id, original]);
    await toggle(third, 409);
    expect(await stored()).toEqual(original);
    await page.route(view, async route => {
      const response = await route.fetch();
      const body = await response.json();
      delete body.patient.flags;
      await route.fulfill({ response, json: body });
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await panel.getByText(/تعذّر تحميل أعلام المريض/).waitFor();
    expect(await panel.locator("button[aria-pressed]").count()).toBe(0);
    expect(writes).toBe(3);
    expect(await stored()).toEqual(original);
  } finally { await context.close(); }
});
