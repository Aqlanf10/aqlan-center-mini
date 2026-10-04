import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { Client } from "pg";
import { chairCount, SETTING_DEFAULTS, type SettingsMap } from "../../lib/settings";
import { baseUrl, harness } from "./_server";

// Remote built-app gate. The cockpit consumes real HTTP GET responses from the
// existing isolated database. No visit/list/readiness response is mocked, and no
// chair or financial command is submitted. Malformed-list rejection remains
// covered independently by patient-cockpit-readiness-lifecycle.test.tsx.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let noVisitPatientId: number;
let waitingPatientId: number;
let waitingVisitId: number;
const stamp = Date.now();
const statuses = ["waiting", "called", "in_chair", "done"];
type ChairRow = { id: number; patientId: number | null; chair: number | null; status: string };

beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const doctor = (await db.query<{ party_id: number }>(
    "SELECT party_id FROM users WHERE username = 'secdoctora'",
  )).rows[0].party_id;
  const patient = async (suffix: string) => (await db.query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id",
    [`CHAIR-CONTRACT-${stamp}-${suffix}`, `مريض عقد الجاهزية التجريبي ${suffix}`, doctor],
  )).rows[0].id;
  noVisitPatientId = await patient("empty");
  waitingPatientId = await patient("waiting");
  waitingVisitId = (await db.query<{ id: number }>(
    "INSERT INTO visits (patient_name, patient_id, doctor_id) VALUES ($1, $2, $3) RETURNING id",
    ["زيارة انتظار اصطناعية", waitingPatientId, doctor],
  )).rows[0].id;
  // The preceding shared suite restores clinic.chairs directly in SQL. RootLayout
  // uses getSettings()'s 5-second process cache, whereas GET /api/settings reads
  // stored values. Expire that known cache once before comparing real responses;
  // do not change settings or weaken the expected availability assertion.
  await new Promise((resolve) => setTimeout(resolve, 5_100));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function storedState(patientId: number) {
  return (await db.query(
    `SELECT (SELECT COUNT(*)::int FROM visits WHERE patient_id = $1) AS visits,
            (SELECT COUNT(*)::int FROM payments WHERE patient_id = $1) AS payments,
            (SELECT COUNT(*)::int FROM invoices WHERE patient_id = $1) AS invoices,
            (SELECT jsonb_agg(jsonb_build_object('id', id, 'status', status, 'chair', chair) ORDER BY id)
               FROM visits WHERE patient_id = $1) AS visit_states`,
    [patientId],
  )).rows;
}

function waitForGet(page: Page, path: string) {
  return page.waitForResponse((response) => response.request().method() === "GET"
    && new URL(response.url()).origin === baseUrl
    && `${new URL(response.url()).pathname}${new URL(response.url()).search}` === path);
}

describe("actual visit API contract reaches the cockpit", () => {
  it.each(["no-visit", "waiting"] as const)("accepts the real shared chair list for a %s patient without any command", async (kind) => {
    const patientId = kind === "no-visit" ? noVisitPatientId : waitingPatientId;
    const before = await storedState(patientId);
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: "ar-YE", serviceWorkers: "block" });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const writes: string[] = [];
    const external: string[] = [];
    // GETs continue unchanged, including the two responses under test.
    await context.route("**/*", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== baseUrl) { external.push(url.origin); await route.abort(); return; }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        writes.push(`${request.method()} ${url.pathname}`);
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "Synthetic commands blocked" }) });
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    try {
      const settingsResponse = await context.request.get(`${baseUrl}/api/settings`);
      expect(settingsResponse.status()).toBe(200);
      const settings = await settingsResponse.json() as Partial<SettingsMap>;
      const count = chairCount({ ...SETTING_DEFAULTS, ...settings });
      const [listResponse, readyResponse] = await Promise.all([
        waitForGet(page, "/api/visits"),
        waitForGet(page, `/api/visits/readiness?patientId=${patientId}`),
        page.goto(`${baseUrl}/patients/${patientId}?tab=summary`, { waitUntil: "domcontentloaded" }),
      ]);
      expect(listResponse.status()).toBe(200); expect(readyResponse.status()).toBe(200);
      const rows = await listResponse.json() as ChairRow[];
      expect(Array.isArray(rows)).toBe(true);
      // Only status counts enter failure diagnostics; no patient names or records.
      const statusCounts = rows.reduce<Record<string, number>>((counts, row) => {
        counts[row.status] = (counts[row.status] ?? 0) + 1; return counts;
      }, {});
      expect(rows.every((row) => statuses.includes(row.status)), JSON.stringify(statusCounts)).toBe(true);
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
      expect(rows.every((row) => Number.isSafeInteger(row.id) && row.id > 0
        && (row.patientId === null || (Number.isSafeInteger(row.patientId) && row.patientId > 0))
        && (row.chair === null || (Number.isSafeInteger(row.chair) && row.chair > 0)))).toBe(true);
      const readiness = await readyResponse.json() as { visit: null | { visitId: number; patientId: number; status: string } };
      if (kind === "no-visit") expect(readiness.visit).toBeNull();
      else expect(readiness.visit).toMatchObject({ visitId: waitingVisitId, patientId, status: "waiting" });

      const cockpit = page.locator('[aria-label="قمرة المريض"]');
      const entry = cockpit.getByRole("button", { name: /^إدخال إلى الكرسي/ });
      await expect.poll(() => entry.count()).toBe(1);
      expect(await cockpit.innerText()).not.toMatch(/غير متاحة|غير معروفة|غير متطابقة|قيد التحقق/);
      if (kind === "no-visit") expect(await cockpit.innerText()).toContain("لا زيارة اليوم في القراءة الحالية");
      const occupied = new Set(rows.filter((row) => row.status === "called" || row.status === "in_chair").map((row) => row.chair));
      const free = Array.from({ length: count }, (_, index) => index + 1).filter((chair) => !occupied.has(chair));
      expect(await entry.isEnabled()).toBe(free.length > 0);
      if (free.length > 0) expect(await entry.innerText()).toContain(`إدخال إلى الكرسي ${free[0]}`);
      // A genuinely full list can disable entry; it must still be a known state.
      expect(writes).toEqual([]); expect(external).toEqual([]); expect(errors).toEqual([]);
      expect(await storedState(patientId)).toEqual(before);
    } finally { await context.close(); }
  });
});
