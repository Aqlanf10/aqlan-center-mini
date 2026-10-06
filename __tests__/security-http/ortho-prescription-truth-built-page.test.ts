import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";

// CI-only built Next page acceptance. All rows are isolated synthetic fixtures;
// browser writes and external requests are blocked before reaching a server.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client; let browser: Browser;
type Fixture = { patientId: number; activeId: number; closedId: number };
const fixtures = new Map<number, Fixture>();
const custom = "وصفة خاصة موثقة";
const objectives = "أهداف خط الأساس الاصطناعي محفوظة";
const planNote = "ملاحظات خطة اصطناعية محفوظة دون تعديل";
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const doctor = (await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id;
  for (const width of [390, 1280]) {
    const patientId = (await db.query<{ id: number }>(
      "INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1,$2,$3) RETURNING id",
      [`ORTHO-PRESCRIPTION-${width}-${Date.now()}`, "مريض وصفة تقويم اصطناعي — ليس حقيقياً", doctor],
    )).rows[0].id;
    const activeId = (await db.query<{ id: number }>(
      `INSERT INTO ortho_cases (patient_id, appliance, arches, slot, bracket_system, note, created_by)
       VALUES ($1,'fixed_metal','both','022',NULL,$2,'synthetic-ortho-prescription-ui') RETURNING id`,
      [patientId, planNote],
    )).rows[0].id;
    const closedId = (await db.query<{ id: number }>(
      `INSERT INTO ortho_cases (patient_id, appliance, arches, slot, bracket_system, status, phase,
         baseline_kind, legacy_financial_mode, remaining_objectives, note, created_by)
       VALUES ($1,'fixed_metal','both','022',$2,'completed','retention','legacy','installments',$3,$4,
         'synthetic-ortho-prescription-ui') RETURNING id`,
      [patientId, custom, objectives, planNote],
    )).rows[0].id;
    fixtures.set(width, { patientId, activeId, closedId });
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function storedState(patientId: number) {
  return (await db.query(`SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM ortho_cases c WHERE c.patient_id=$1) AS cases,
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM ortho_adjustments a JOIN ortho_cases c ON c.id=a.case_id WHERE c.patient_id=$1) AS adjustments,
    (SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.id),'[]'::jsonb) FROM visits v WHERE v.patient_id=$1) AS visits,
    (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb) FROM patient_documents d WHERE d.patient_id=$1) AS documents,
    (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM treatment_plans p WHERE p.patient_id=$1) AS plans,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM plan_installments i JOIN treatment_plans p ON p.id=i.plan_id WHERE p.patient_id=$1) AS installments,
    (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM payments p WHERE p.patient_id=$1) AS payments,
    (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM invoices i WHERE i.patient_id=$1) AS invoices,
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM appointments a WHERE a.patient_id=$1) AS appointments`, [patientId])).rows;
}
const workspace = (page: Page) => page.locator('[data-testid="patient-ortho-workspace"]');
const caseCard = (page: Page, caseId: number) => workspace(page).locator(":scope > ul > li")
  .filter({ has: page.getByText(`#${caseId}`, { exact: true }) });
const prescription = (card: Locator) => card.getByText("فلسفة البراكيت", { exact: true }).locator("..").locator(":scope > span").nth(1);
async function ready(page: Page) {
  await expect.poll(() => workspace(page).getAttribute("data-read-state")).toBe("ready");
}
async function openPrescription(card: Locator) {
  // Includes the hidden full label at phone widths, where the visible tab says خطة.
  await card.locator("button").filter({ hasText: "خطة العلاج والميكانيكا" }).click();
  await prescription(card).waitFor({ state: "visible" });
}
async function capture(card: Locator, kind: "unrecorded" | "closed-custom", width: number) {
  const value = prescription(card);
  await card.page().evaluate(async () => { await document.fonts.ready; });
  // Keep the complete case card below the app's fixed top bar. Scrolling only
  // its prescription into view allowed the header to cover case identity/status
  // in the first CI screenshots even though the changed value remained readable.
  await card.evaluate((element) => {
    window.scrollTo({ top: Math.max(0, scrollY + element.getBoundingClientRect().top - 80), behavior: "instant" });
  });
  const frame = await card.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const identifier = Array.from(element.querySelectorAll("span")).find((span) => /^#\d+$/.test(span.textContent ?? ""))!;
    const label = identifier.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight, caseLabel: identifier.textContent,
      identityExposed: identifier.contains(document.elementFromPoint(label.left + label.width / 2, label.top + label.height / 2)) };
  });
  expect(frame.top).toBeGreaterThanOrEqual(79);
  expect(frame.bottom).toBeLessThanOrEqual(frame.viewportHeight + 1);
  expect(frame.identityExposed).toBe(true);
  const geometry = await value.evaluate((element) => {
    const box = element.getBoundingClientRect(); const cell = element.parentElement!.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(element); const text = range.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { label: element.textContent, box: { x: box.x, y: box.y, width: box.width, height: box.height },
      cell: { left: cell.left, right: cell.right, top: cell.top, bottom: cell.bottom },
      text: { left: text.left, right: text.right, top: text.top, bottom: text.bottom },
      fontSize: style.fontSize, display: style.display, visibility: style.visibility,
      viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth };
  });
  expect(geometry.label).toBe(kind === "unrecorded" ? "غير مسجّلة" : custom);
  expect(geometry.box.width).toBeGreaterThan(0); expect(geometry.box.height).toBeGreaterThan(0);
  expect(geometry.display).not.toBe("none"); expect(geometry.visibility).toBe("visible");
  expect(Number.parseFloat(geometry.fontSize)).toBeGreaterThanOrEqual(12);
  expect(geometry.text.left).toBeGreaterThanOrEqual(geometry.cell.left - 1);
  expect(geometry.text.right).toBeLessThanOrEqual(geometry.cell.right + 1);
  expect(geometry.text.top).toBeGreaterThanOrEqual(geometry.cell.top - 1);
  expect(geometry.text.bottom).toBeLessThanOrEqual(geometry.cell.bottom + 1);
  expect(geometry.cell.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.cell.right).toBeLessThanOrEqual(width + 1);
  expect(geometry.documentWidth).toBeLessThanOrEqual(width + 1);
  await card.screenshot({ path: `.settings-ui-artifacts/ortho-prescription-${kind}-${width}.png` });
  return { ...geometry, frame };
}

describe("built orthodontic prescription truth", () => {
  it.each([390, 1280])("retains unrecorded and closed legacy custom prescriptions at %ipx without browser writes", async (width) => {
    const fixture = fixtures.get(width)!;
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 },
      locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
    const [name, ...value] = h.sessions.admin.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const unexpected: string[] = []; const errors: string[] = [];
    await context.route("**/*", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort(); return;
      }
      await route.continue();
    });
    const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
    const waitForOrtho = () => page.waitForResponse((response) => response.request().method() === "GET"
      && new URL(response.url()).pathname === "/api/ortho"
      && new URL(response.url()).searchParams.get("patientId") === String(fixture.patientId));
    const verifyRead = async (response: Awaited<ReturnType<typeof waitForOrtho>>, bracketSystem: string | null) => {
      expect(response.status()).toBe(200);
      const payload = await response.json() as { cases: Array<{ id: number; patientId: number; bracketSystem: string | null }> };
      expect(payload.cases).toHaveLength(2);
      expect(payload.cases.find((row) => row.id === fixture.activeId)).toMatchObject({ patientId: fixture.patientId, bracketSystem });
      expect(payload.cases.find((row) => row.id === fixture.closedId)).toMatchObject({ patientId: fixture.patientId, bracketSystem: custom });
      await ready(page);
    };
    try {
      let before = await storedState(fixture.patientId);
      const [initial] = await Promise.all([waitForOrtho(),
        page.goto(`${baseUrl}/patients/${fixture.patientId}?tab=ortho`, { waitUntil: "domcontentloaded" })]);
      await verifyRead(initial, null);
      const active = caseCard(page, fixture.activeId); const closed = caseCard(page, fixture.closedId);
      await openPrescription(active); await openPrescription(closed);
      expect(await prescription(active).textContent()).toBe("غير مسجّلة");
      expect(await prescription(closed).textContent()).toBe(custom);
      expect(await closed.textContent()).toContain(objectives);
      expect(await closed.textContent()).toContain(planNote);
      expect(await storedState(fixture.patientId)).toEqual(before);

      // Fixture-only edits establish real HTTP round trips for both blank forms
      // and a clinician-recorded literal Roth / MBT. The browser remains read-only.
      for (const recorded of ["", "   ", "Roth / MBT", null]) {
        await db.query("UPDATE ortho_cases SET bracket_system=$1 WHERE id=$2 AND patient_id=$3",
          [recorded, fixture.activeId, fixture.patientId]);
        before = await storedState(fixture.patientId);
        const [response] = await Promise.all([waitForOrtho(),
          workspace(page).getByRole("button", { name: "تحديث كابينة التقويم", exact: true }).click()]);
        await verifyRead(response, recorded);
        expect(await prescription(active).textContent()).toBe(recorded?.trim() ? recorded : "غير مسجّلة");
        expect(await prescription(closed).textContent()).toBe(custom);
        expect(await closed.textContent()).toContain(objectives);
        expect(await storedState(fixture.patientId)).toEqual(before);
      }
      const bounds = { width, active: await capture(active, "unrecorded", width), closed: await capture(closed, "closed-custom", width) };
      await writeFile(`.settings-ui-artifacts/ortho-prescription-${width}-bounds.json`, `${JSON.stringify(bounds, null, 2)}\n`);
      expect(await storedState(fixture.patientId)).toEqual(before);
      expect(unexpected).toEqual([]); expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 240_000);
});
