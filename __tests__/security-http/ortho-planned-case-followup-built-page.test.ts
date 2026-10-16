import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { chromium, type Browser, type Locator } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { baseUrl, harness } from "./_server";

// Real built page, real read API/permissions, and synthetic PostgreSQL records.
// The browser may only read; links/messages/bookings are never sent or opened.
let h: Awaited<ReturnType<typeof harness>>, db: Client, browser: Browser;
let today: string;
const fixtures = new Map<number, { patientId: number; caseId: number; mixedCaseId: number; bookingId: number;
  patientName: string; mixedName: string; foreignName: string }>();
async function insert(sql: string, values: unknown[]) {
  return (await db.query<{ id: number }>(sql, values)).rows[0].id;
}
beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  const first = await fetch(`${baseUrl}/api/ortho/followups`, { headers: { Cookie: h.sessions.doctorA.cookie } });
  expect(first.status).toBe(200); today = (await first.json()).today;
  const doctor = (await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id;
  const foreignDoctor = (await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username='secdoctorb'")).rows[0].party_id;
  const serviceId = (await db.query<{ id: number }>("SELECT id FROM appointment_services WHERE code='ORTHO_FOLLOW_UP'")).rows[0].id;
  for (const width of [390, 1280]) {
    const create = async (name: string, owner: number, mixed = false) => {
      const patient = await insert("INSERT INTO patients (patient_number,full_name,primary_doctor_id) VALUES ($1,$2,$3) RETURNING id",
        [`SYNTHETIC-PLANNED-FOLLOWUP-${width}-${owner}-${mixed}-${Date.now()}`, name, owner]);
      const ortho = await insert("INSERT INTO ortho_cases (patient_id,start_date,created_by) VALUES ($1,'2025-01-01','synthetic-planned-followup') RETURNING id", [patient]);
      const clinical = 1_400_000_000 + ortho;
      await db.query(`INSERT INTO clinical_cases (id,patient_id,ortho_case_id,specialty,title,started_on,created_by)
        VALUES ($1,$2,$3,'orthodontics','Synthetic exact Ortho case','2025-01-01','synthetic-planned-followup')`, [clinical, patient, ortho]);
      expect(clinical).not.toBe(ortho);
      const plan = await insert(`INSERT INTO treatment_plans (patient_id,title,total_minor,base_currency,status)
        VALUES ($1,'Synthetic existing case plan',125000,'SAR','active') RETURNING id`, [patient]);
      await db.query("UPDATE ortho_cases SET plan_id=$2 WHERE id=$1", [ortho, plan]);
      const planned = await insert(`INSERT INTO planned_visits (patient_id,plan_id,sequence,title,status)
        VALUES ($1,$2,1,'Synthetic exact periodic session','scheduled') RETURNING id`, [patient, plan]);
      const item = await insert(`INSERT INTO plan_items (plan_id,case_id,service_name,category,status)
        VALUES ($1,$2,'Synthetic pending case work','ortho','in_progress') RETURNING id`, [plan, clinical]);
      await db.query("INSERT INTO treatment_sessions (plan_item_id,sequence,planned_visit_id) VALUES ($1,1,$2)", [item, planned]);
      if (mixed) {
        const endo = await insert(`INSERT INTO clinical_cases (patient_id,specialty,title,created_by)
          VALUES ($1,'endodontics','Synthetic other specialty','synthetic-planned-followup') RETURNING id`, [patient]);
        const otherItem = await insert(`INSERT INTO plan_items (plan_id,case_id,service_name,category)
          VALUES ($1,$2,'Synthetic endodontic work','endo') RETURNING id`, [plan, endo]);
        await db.query("INSERT INTO treatment_sessions (plan_item_id,sequence,planned_visit_id) VALUES ($1,1,$2)", [otherItem, planned]);
      }
      const booking = await insert(`INSERT INTO appointments (patient_id,scheduled_date,scheduled_time,status,service_id,appointment_type,doctor_id,planned_visit_id)
        VALUES ($1,$2::date,'10:30','booked',$3,'follow_up',$4,$5) RETURNING id`, [patient, today, serviceId, owner, planned]);
      await db.query("UPDATE planned_visits SET appointment_id=$2 WHERE id=$1", [planned, booking]);
      return { patient, ortho, booking };
    };
    const patientName = `متابعة خطة حالة اصطناعية ${width}`;
    const mixedName = `زيارة مختلطة للمراجعة اصطناعية ${width}`;
    const foreignName = `مريض طبيب آخر محجوب اصطناعي ${width}`;
    const exact = await create(patientName, doctor);
    const mixed = await create(mixedName, doctor, true);
    await create(foreignName, foreignDoctor);
    fixtures.set(width, { patientId: exact.patient, caseId: exact.ortho, mixedCaseId: mixed.ortho, bookingId: exact.booking,
      patientName, mixedName, foreignName });
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  await mkdir(".settings-ui-artifacts", { recursive: true });
}, 240_000);
afterAll(async () => { await browser?.close(); await db?.end(); });

async function snapshot() {
  const tables = ["appointments", "planned_visits", "treatment_sessions", "plan_items", "treatment_plans", "ortho_cases", "ortho_adjustments", "visits", "invoices", "payments"];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await db.query(`SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) contents FROM ${table} r`)).rows;
  return result;
}
async function capture(card: Locator, width: number, kind: string) {
  await card.page().evaluate(async () => { await document.fonts.ready; });
  await card.evaluate(element => window.scrollTo({ top: Math.max(0, scrollY + element.getBoundingClientRect().top - 80), behavior: "instant" }));
  const bounds = await card.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
      viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
      text: element.textContent, paragraphs: Array.from(element.querySelectorAll("p")).filter(p => p.textContent?.trim()).map(p => {
        const box = p.getBoundingClientRect(); return { text: p.textContent, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
          exposed: p.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) };
      }) };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-1); expect(bounds.right).toBeLessThanOrEqual(width + 1);
  expect(bounds.documentWidth).toBeLessThanOrEqual(width + 1);
  for (const p of bounds.paragraphs) { expect(p.left).toBeGreaterThanOrEqual(-1); expect(p.right).toBeLessThanOrEqual(width + 1); expect(p.exposed).toBe(true); }
  await card.screenshot({ path: `.settings-ui-artifacts/ortho-planned-followup-${kind}-${width}.png` });
  await writeFile(`.settings-ui-artifacts/ortho-planned-followup-${kind}-${width}.json`, JSON.stringify(bounds, null, 2));
}

describe("read-only exact planned Ortho follow-up in the real board", () => {
  it.each([390, 1280])("shows precise pending case linkage and mixed-case uncertainty at %ipx without writes", async width => {
    const fixture = fixtures.get(width)!;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE", timezoneId: "Asia/Aden", serviceWorkers: "block" });
    const [name, ...value] = h.sessions.doctorA.cookie.split("=");
    await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
    const unexpected: string[] = [], errors: string[] = [];
    await context.route("**/*", async route => {
      const request = route.request();
      if (new URL(request.url()).origin !== baseUrl || !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        unexpected.push(`${request.method()} ${new URL(request.url()).pathname}`); await route.abort(); return;
      }
      await route.continue();
    });
    const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
    try {
      const before = await snapshot();
      const [response] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === "/api/ortho/followups"), page.goto(`${baseUrl}/ortho`)]);
      expect(response.status()).toBe(200);
      const payload = await response.json();
      const rows = payload.buckets.flatMap((bucket: { rows: Array<{ caseId: number; patientName: string }> }) => bucket.rows);
      expect(rows.find((r: { caseId: number }) => r.caseId === fixture.caseId).nextAppointment).toMatchObject({ id: fixture.bookingId, matchBasis: "planned_case_sessions" });
      expect(rows.find((r: { caseId: number }) => r.caseId === fixture.mixedCaseId).bookingContext.reviewAppointments[0].reason).toBe("different_or_unresolved_planned_case");
      expect(JSON.stringify(payload)).not.toContain(fixture.foreignName);
      await page.getByRole("button", { name: /^منذ ٨ أسابيع\+/ }).click();
      const exact = page.locator("li").filter({ has: page.getByRole("link", { name: fixture.patientName, exact: true }) });
      const mixed = page.locator("li").filter({ has: page.getByRole("link", { name: fixture.mixedName, exact: true }) });
      await exact.getByText(/جلسات خطة مرتبطة بهذه الحالة؛ الحجز لا يثبت التنفيذ/).waitFor();
      await mixed.getByText("يحتاج مراجعة سياق المتابعة", { exact: false }).waitFor();
      await capture(exact, width, "exact"); await capture(mixed, width, "review");
      expect(await snapshot()).toEqual(before); expect(unexpected).toEqual([]); expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
});
