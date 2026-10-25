import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, clinicDateString } from "../../lib/schedule";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { authedGet, baseUrl, harness, type Session } from "./_server";

// Hosted acceptance in the existing built-app/proxy harness. Every patient and
// financial/clinical row below is synthetic in aqlan_sec_http. No source overlay,
// response payload mock, browser-state export, screenshot or external message.
// route.fetch performs the REAL POST; only delivery of its reply is interrupted.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let doctorId: number;
let timeZone: string;
let sequence = 0;
const prefix = `SYN-REBOOK-BROWSER-${randomUUID()}`;
const reason = "طلب المريض الاصطناعي موعدًا بديلًا";
const pollOptions = { timeout: 15_000 };
const success = "تمت إعادة حجز الجلسة. بقي الموعد السابق وحالته محفوظين في السجل.";
const untouchedTables = ["invoices", "invoice_items", "payments", "cashier_shifts", "journal_manual", "journal_manual_lines",
  "patient_opening_balances", "expenses", "payables", "treatment_plans", "plan_items", "treatment_sessions",
  "visits", "visit_procedures", "plan_installments"] as const;
type Role = "admin" | "reception";
type Result = { appointmentId: number; title: string; replayed: boolean };
type Intent = { expectedAppointmentId: number; expectedGeneration: string; date: string; time: string; reason: string; requestId: string };
type Write = { raw: string; body: Intent; status?: number; result?: Result; delivered: boolean };

beforeAll(async () => {
  h = await harness();
  const target = new URL(h.seeded.dbUrl);
  expect(target.hostname).toBe("127.0.0.1");
  expect(target.pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  doctorId = (await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username = 'secdoctora'")).rows[0].party_id;
  const response = await authedGet(`/api/patients/${h.seeded.patientAId}/workflow`, h.sessions.admin);
  expect(response.status).toBe(200);
  timeZone = (await response.json() as { timeZone: string }).timeZone;
  expect(typeof timeZone).toBe("string");
  // Also validates the server-provided zone rather than deriving a clinic day
  // from the browser workstation. Browser contexts deliberately use another zone.
  expect(clinicDateString(new Date(), timeZone)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);
afterAll(async () => { try { await browser?.close(); } finally { await db?.end(); } });

async function fixture(status: "no_show" | "cancelled") {
  const serial = ++sequence;
  const unique = `${prefix}-${serial}`;
  const today = clinicDateString(new Date(), timeZone);
  const name = `مريض إعادة حجز اصطناعي ${serial}`;
  const title = `جلسة إعادة حجز اصطناعية ${serial}`;
  const patient = (await db.query<{ id: number }>(`INSERT INTO patients
    (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`, [unique, name, doctorId])).rows[0].id;
  const plan = (await db.query<{ id: number }>(`INSERT INTO treatment_plans
    (patient_id, title, total_minor, status) VALUES ($1, 'خطة إعادة حجز اصطناعية', 1200, 'active') RETURNING id`, [patient])).rows[0].id;
  const item = (await db.query<{ id: number }>(`INSERT INTO plan_items
    (plan_id, service_name, unit_price_minor) VALUES ($1, 'بند علاجي اصطناعي محفوظ', 1200) RETURNING id`, [plan])).rows[0].id;
  const old = (await db.query<{ id: number }>(`INSERT INTO appointments
    (patient_id, scheduled_date, scheduled_time, duration_minutes, status, ended_at, cancel_reason, doctor_id)
    VALUES ($1, $2::date - 1, '10:00', 30, $3, NOW(), 'سبب تاريخي اصطناعي محفوظ', $4) RETURNING id`,
  [patient, today, status, doctorId])).rows[0].id;
  const planned = (await db.query<{ id: number }>(`INSERT INTO planned_visits
    (patient_id, plan_id, sequence, title, status, appointment_id, doctor_id, duration_minutes)
    VALUES ($1, $2, 1, $3, 'scheduled', $4, $5, 30) RETURNING id`, [patient, plan, title, old, doctorId])).rows[0].id;
  await db.query("UPDATE appointments SET planned_visit_id = $2 WHERE id = $1", [old, planned]);
  await db.query("INSERT INTO treatment_sessions (plan_item_id, sequence, planned_visit_id) VALUES ($1, 1, $2)", [item, planned]);
  await db.query(`INSERT INTO appointment_status_log (appointment_id, from_status, to_status, reason, actor)
    VALUES ($1, 'booked', $2, 'سبب تاريخي اصطناعي محفوظ', 'synthetic-rebook-browser')`, [old, status]);
  // Same valid financial fixture column/value shapes as rebooking-http. These
  // nonempty sentinels prevent a vacuous 'no money changed' assertion.
  const shift = (await db.query<{ id: number }>(`INSERT INTO cashier_shifts
    (opened_by, closed_by, status, closed_at) VALUES ('synthetic-rebook-browser', 'synthetic-rebook-browser', 'closed', NOW()) RETURNING id`)).rows[0].id;
  const invoice = (await db.query<{ id: number }>(`INSERT INTO invoices
    (invoice_number, patient_id, total_minor) VALUES ($1, $2, 1200) RETURNING id`, [`${unique}-INV`, patient])).rows[0].id;
  await db.query(`INSERT INTO invoice_items (invoice_id, description, unit_price_minor, total_minor)
    VALUES ($1, 'بند مالي اصطناعي محفوظ', 1200, 1200)`, [invoice]);
  await db.query(`INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, amount_minor, currency, base_amount_minor)
    VALUES ($1, $2, $3, $4, 100, 'YER', 100)`, [`${unique}-PAY`, patient, invoice, shift]);
  const response = await authedGet(`/api/patients/${patient}/workflow`, h.sessions.admin);
  expect(response.status).toBe(200);
  const workflow = await response.json() as { timeZone: string; plannedVisits: { id: number; canRebook: boolean; rebookGeneration: string }[] };
  expect(workflow.timeZone).toBe(timeZone);
  const projected = workflow.plannedVisits.find(row => row.id === planned)!;
  expect(projected.canRebook).toBe(true);
  expect(projected.rebookGeneration).toMatch(/^[a-f0-9]{32}$/);
  return { patient, name, number: unique, title, old, planned, status, date: addDays(today, 950 + serial), time: "10:00",
    generation: projected.rebookGeneration };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function untouchedFingerprint() {
  const result: Record<string, { count: number; digest: string }> = {};
  for (const table of untouchedTables) {
    // Source-code table allowlist. Hash the complete rows without exporting them.
    result[table] = (await db.query<{ count: number; digest: string }>(`SELECT count(*)::int AS count,
      md5(COALESCE(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), '')) AS digest FROM ${table} t`)).rows[0];
  }
  for (const table of ["invoices", "invoice_items", "payments", "cashier_shifts", "treatment_plans", "plan_items", "treatment_sessions"]) {
    expect(result[table].count).toBeGreaterThan(0);
  }
  return result;
}
async function history(f: Fixture) {
  return {
    old: (await db.query("SELECT to_jsonb(a) - 'planned_visit_id' AS row FROM appointments a WHERE id = $1", [f.old])).rows,
    log: (await db.query("SELECT * FROM appointment_status_log WHERE appointment_id = $1 ORDER BY id", [f.old])).rows,
    planned: (await db.query("SELECT to_jsonb(p) - 'appointment_id' AS row FROM planned_visits p WHERE id = $1", [f.planned])).rows,
  };
}
async function verifySaved(f: Fixture, write: Write, role: Role) {
  const saved = write.result!;
  expect(Number.isSafeInteger(saved.appointmentId)).toBe(true);
  expect(saved.appointmentId).toBeGreaterThan(0);
  expect(saved.appointmentId).not.toBe(f.old);
  expect((await db.query("SELECT id, planned_visit_id, status FROM appointments WHERE patient_id = $1 ORDER BY id", [f.patient])).rows).toEqual([
    { id: f.old, planned_visit_id: null, status: f.status },
    { id: saved.appointmentId, planned_visit_id: f.planned, status: "booked" },
  ]);
  expect((await db.query("SELECT appointment_id, status FROM planned_visits WHERE id = $1", [f.planned])).rows[0])
    .toEqual({ appointment_id: saved.appointmentId, status: "scheduled" });
  expect((await db.query(`SELECT patient_id, scheduled_date::text AS date, to_char(scheduled_time, 'HH24:MI') AS time,
    doctor_id, arrived_at, ended_at FROM appointments WHERE id = $1`, [saved.appointmentId])).rows[0])
    .toEqual({ patient_id: f.patient, date: f.date, time: f.time, doctor_id: doctorId, arrived_at: null, ended_at: null });
  const actor = role === "admin" ? "secadmin" : "secreception";
  const actorId = (await db.query<{ id: number }>("SELECT id FROM users WHERE username = $1", [actor])).rows[0].id;
  const audit = (await db.query(`SELECT actor, actor_role, details FROM audit_log
    WHERE entity = 'planned_visit' AND action = 'planned_visit.rebook' AND entity_id = $1`, [String(f.planned)])).rows;
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ actor, actor_role: role, details: {
    actorUserId: actorId, patientId: f.patient, requestId: write.body.requestId,
    oldAppointmentId: f.old, newAppointmentId: saved.appointmentId,
    intent: { plannedVisitId: f.planned, expectedAppointmentId: f.old, expectedGeneration: f.generation,
      date: f.date, time: f.time, reason },
    response: { appointmentId: saved.appointmentId, title: f.title },
    oldAppointment: { id: f.old, status: f.status, planned_visit_id: f.planned },
    newAppointment: { id: saved.appointmentId, patient_id: f.patient, status: "booked", planned_visit_id: f.planned },
  } });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function connected(f: Fixture, session: Session, width: number) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 },
    locale: "ar-YE", timezoneId: timeZone === "America/Los_Angeles" ? "Asia/Tokyo" : "America/Los_Angeles", serviceWorkers: "block" });
  const [name, ...value] = session.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = [], errors: string[] = [];
  const writes: Write[] = [];
  const workflowReads: number[] = [];
  let documents = 0;
  context.on("request", request => {
    if (request.isNavigationRequest() && request.resourceType() === "document") documents++;
  });
  const gates: ReturnType<typeof deferred>[] = [];
  let armed: { mode: "drop" | "deliver"; gate: ReturnType<typeof deferred> } | null = null;
  const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== baseUrl) {
      unexpected.push(`external ${method} ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient"); return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const admission = armed;
      if (method !== "POST" || url.pathname !== `/api/planned-visits/${f.planned}/rebook` || url.search || !admission) {
        unexpected.push(`mutation ${method} ${url.pathname}`); await route.abort("blockedbyclient"); return;
      }
      armed = null; // One deliberate click admits exactly one real mutation.
      const raw = request.postData()!;
      const body = request.postDataJSON() as Intent;
      expect(Object.keys(body).sort()).toEqual(["date", "expectedAppointmentId", "expectedGeneration", "reason", "requestId", "time"]);
      expect(body).toMatchObject({ expectedAppointmentId: f.old, expectedGeneration: f.generation, date: f.date, time: f.time, reason });
      expect(body.requestId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      if (writes.length) expect(raw).toBe(writes[0].raw);
      const write: Write = { raw, body, delivered: false };
      writes.push(write);
      // No retries/redirects hidden inside interception. The actual auth, CSRF,
      // proxy, transaction, immutable audit and idempotency writer execute here.
      const response = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
      write.result = await response.json() as Result;
      write.status = response.status();
      expect(write.status).toBe(writes.length === 1 ? 201 : 200);
      expect(write.result).toMatchObject({ title: f.title, replayed: writes.length > 1 });
      if (writes.length > 1) expect(write.result.appointmentId).toBe(writes[0].result!.appointmentId);
      await admission.gate.promise;
      if (admission.mode === "drop") await route.abort("failed");
      else await route.fulfill({ response }); // Deliver original status, headers and bytes unchanged.
      write.delivered = true;
      return;
    }
    const workflow = /^\/api\/patients\/(\d+)\/workflow$/.exec(url.pathname);
    if (method === "GET" && workflow) workflowReads.push(Number(workflow[1]));
    await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("download", () => unexpected.push("unexpected download"));
  page.on("dialog", dialog => { unexpected.push(`unexpected ${dialog.type()} dialog`); void dialog.dismiss(); });
  return { page, writes, workflowReads, documentCount: () => documents,
    arm(mode: "drop" | "deliver") {
      expect(armed).toBeNull(); const gate = deferred(); gates.push(gate); armed = { mode, gate }; return gate.resolve;
    },
    async run(body: () => Promise<void>) {
      await guard.run(async () => { try { await body(); } finally { gates.forEach(gate => gate.resolve()); } }, () => {
        expect(unexpected).toEqual([]); expect(errors).toEqual([]); expect(armed).toBeNull();
      });
    },
  };
}

const plannedSection = (page: Page) => page.getByRole("region", { name: "الجلسات المخطَّطة", exact: true });
const formFor = (page: Page, f: Fixture) => page.getByRole("form", { name: `إعادة حجز ${f.title}`, exact: true });
async function openPatient(page: Page, f: Fixture) {
  // Genuine authenticated document navigation, never a URL-only history patch,
  // injected router/anchor or replaced patient GET (including projections).
  const response = await page.goto(`${baseUrl}/patients/${f.patient}?tab=summary`, { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  await expect.poll(() => page.getByTestId("patient-tab-summary").getAttribute("aria-current"), pollOptions).toBe("page");
  await plannedSection(page).getByText(f.title, { exact: false }).waitFor();
  expect(await plannedSection(page).innerText()).toContain("تحتاج إعادة حجز");
  expect(await plannedSection(page).getByRole("button", { name: "ابدأ الزيارة", exact: true }).count()).toBe(0);
}
async function bounds(control: Locator, width: number) {
  await control.scrollIntoViewIfNeeded();
  const box = await control.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width, height: rect.height,
      top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight, pageWidth: document.documentElement.scrollWidth,
      hit: element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)),
      direction: getComputedStyle(element).direction };
  });
  expect(box.width).toBeGreaterThan(0); expect(box.height).toBeGreaterThan(0);
  expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width);
  expect(box.top).toBeGreaterThanOrEqual(0); expect(box.bottom).toBeLessThanOrEqual(box.viewportHeight);
  expect(box.pageWidth).toBeLessThanOrEqual(width); expect(box.hit).toBe(true);
  return box;
}
async function fillForm(page: Page, f: Fixture) {
  await plannedSection(page).getByRole("button", { name: "إعادة حجز", exact: true }).click();
  const form = formFor(page, f);
  await form.getByLabel("التاريخ", { exact: true }).fill(f.date);
  await form.getByLabel("الوقت", { exact: true }).fill(f.time);
  await form.getByRole("textbox", { name: /^سبب إعادة الحجز/ }).fill(reason);
  return form;
}
async function locked(form: Locator) {
  for (const control of [form.getByLabel("التاريخ", { exact: true }), form.getByLabel("الوقت", { exact: true }),
    form.getByRole("textbox", { name: /^سبب إعادة الحجز/ }), form.getByRole("button", { name: "إلغاء", exact: true })]) {
    expect(await control.isDisabled()).toBe(true);
  }
}
async function refreshedHistory(page: Page, f: Fixture, appointmentId: number) {
  const panel = page.getByTestId("patient-appointments-panel");
  await panel.getByRole("button", { name: "تحديث المواعيد", exact: true }).click();
  const replacement = panel.locator(`[data-patient-appointment="${appointmentId}"]`);
  await replacement.waitFor();
  expect(await replacement.innerText()).toContain("محجوز");
  expect(await replacement.locator("time").getAttribute("datetime")).toBe(`${f.date}T${f.time}`);
  expect(await panel.locator("[data-patient-appointment]").count()).toBe(1);
  await panel.getByRole("button", { name: "السابقة والمغلقة", exact: true }).click();
  const old = panel.locator(`[data-patient-appointment="${f.old}"]`); await old.waitFor();
  expect(await old.innerText()).toContain(f.status === "no_show" ? "لم يحضر" : "ملغى");
  if (f.status === "cancelled") expect(await old.innerText()).toContain("سبب تاريخي اصطناعي محفوظ");
  expect(await panel.locator("[data-patient-appointment]").count()).toBe(1);
  expect(await panel.locator(`[data-patient-appointment="${appointmentId}"]`).count()).toBe(0);
}

describe("planned-session rebooking through the real patient Summary", () => {
  it.each([
    { role: "admin", width: 1280, status: "cancelled" }, { role: "admin", width: 390, status: "no_show" },
    { role: "reception", width: 1280, status: "no_show" }, { role: "reception", width: 390, status: "cancelled" },
  ] as const)("$role at $width px preserves $status history and recovers a committed lost reply without duplication", async ({ role, width, status }) => {
    const f = await fixture(status);
    const before = await history(f), untouched = await untouchedFingerprint();
    const ui = await connected(f, h.sessions[role], width);
    await ui.run(async () => {
      const { page } = ui;
      await openPatient(page, f);
      expect(await plannedSection(page).innerText()).toContain(status === "no_show" ? "لم يحضر الموعد السابق." : "أُلغي الموعد السابق.");
      expect(await plannedSection(page).innerText()).toContain("إعادة الحجز تنشئ موعدًا جديدًا ولا تبدأ زيارة");
      await bounds(plannedSection(page).getByRole("button", { name: "إعادة حجز", exact: true }), width);
      let form = await fillForm(page, f);
      // An unsent Cancel clears the draft and never sends or schedules anything.
      await form.getByRole("button", { name: "إلغاء", exact: true }).click();
      await form.waitFor({ state: "hidden" }); expect(ui.writes).toEqual([]);
      await plannedSection(page).getByRole("button", { name: "إعادة حجز", exact: true }).click();
      form = formFor(page, f);
      const date = form.getByLabel("التاريخ", { exact: true });
      const time = form.getByLabel("الوقت", { exact: true });
      const why = form.getByRole("textbox", { name: /^سبب إعادة الحجز/ });
      const clinicToday = clinicDateString(new Date(), timeZone);
      expect(await date.inputValue()).toBe(addDays(clinicToday, 1));
      expect(await date.getAttribute("min")).toBe(clinicToday);
      expect(await time.inputValue()).toBe("16:00"); expect(await why.inputValue()).toBe("");
      expect(await why.getAttribute("maxlength")).toBe("500");
      expect(await form.evaluate(element => getComputedStyle(element).direction)).toBe("rtl");
      for (const control of [date, time, why, form.getByRole("button", { name: "تأكيد إعادة الحجز", exact: true }),
        form.getByRole("button", { name: "إلغاء", exact: true })]) await bounds(control, width);
      await date.fill(f.date); await time.fill(f.time);
      await why.fill("ab");
      await form.getByRole("button", { name: "تأكيد إعادة الحجز", exact: true }).click();
      await form.getByRole("alert").waitFor();
      expect(await why.getAttribute("aria-invalid")).toBe("true");
      expect(await form.getByRole("alert").innerText()).toContain("3 أحرف على الأقل");
      expect(ui.writes).toEqual([]);
      await why.fill(`  ${reason}  `);
      const drop = ui.arm("drop");
      await form.getByRole("button", { name: "تأكيد إعادة الحجز", exact: true }).click();
      await expect.poll(() => ui.writes[0]?.status, pollOptions).toBe(201);
      expect(await form.getAttribute("aria-busy")).toBe("true"); await locked(form);
      expect(await form.getByRole("button", { name: "جارٍ الحجز…", exact: true }).isDisabled()).toBe(true);
      // Two extra native submit events exercise the synchronous same-attempt guard.
      await form.evaluate(element => { (element as HTMLFormElement).requestSubmit(); (element as HTMLFormElement).requestSubmit(); });
      await verifySaved(f, ui.writes[0], role); expect(ui.writes).toHaveLength(1);
      expect(await history(f)).toEqual(before); expect(await untouchedFingerprint()).toEqual(untouched);
      drop();
      await form.getByRole("button", { name: "إعادة الطلب نفسه", exact: true }).waitFor();
      expect(await form.getAttribute("aria-busy")).toBe("false"); await locked(form);
      expect(await form.getByRole("alert").innerText()).toContain("قد يكون الحجز قد تم");
      expect(await date.inputValue()).toBe(f.date); expect(await time.inputValue()).toBe(f.time);
      expect(await why.inputValue()).toBe(`  ${reason}  `);
      for (const control of [form.getByRole("button", { name: "إعادة الطلب نفسه", exact: true }),
        form.getByRole("button", { name: "تحديث الملف للتحقق", exact: true })]) await bounds(control, width);
      const deliver = ui.arm("deliver"); deliver();
      await form.getByRole("button", { name: "إعادة الطلب نفسه", exact: true }).click();
      await expect.poll(() => ui.writes[1]?.status, pollOptions).toBe(200);
      await page.getByText(success, { exact: true }).waitFor(); await form.waitFor({ state: "hidden" });
      await expect.poll(() => plannedSection(page).innerText(), pollOptions).not.toContain("تحتاج إعادة حجز");
      expect(ui.writes).toHaveLength(2); expect(ui.writes[1].raw).toBe(ui.writes[0].raw);
      expect(ui.writes[1].result).toEqual({ ...ui.writes[0].result!, replayed: true });
      await refreshedHistory(page, f, ui.writes[0].result!.appointmentId);
      await verifySaved(f, ui.writes[1], role);
      expect(await history(f)).toEqual(before); expect(await untouchedFingerprint()).toEqual(untouched);
    });
  });

  it.each([390, 1280])("retires a closed Summary and ignores its late response while another patient is active at %i px", async width => {
    const f = await fixture("no_show"), other = await fixture("cancelled");
    const before = await history(f), otherBefore = await history(other), untouched = await untouchedFingerprint();
    const ui = await connected(f, h.sessions.admin, width);
    await ui.run(async () => {
      const { page } = ui;
      await openPatient(page, f); const form = await fillForm(page, f);
      expect(ui.documentCount()).toBe(1);
      const deliver = ui.arm("deliver");
      await form.getByRole("button", { name: "تأكيد إعادة الحجز", exact: true }).click();
      await expect.poll(() => ui.writes[0]?.status, pollOptions).toBe(201);
      await locked(form); await verifySaved(f, ui.writes[0], "admin");
      // Real canonical tab navigation unmounts Summary but keeps the document
      // alive, so the late response really reaches the retired React callback.
      await page.getByTestId("patient-tab-files").click();
      await expect.poll(() => page.getByTestId("patient-tab-files").getAttribute("aria-current"), pollOptions).toBe("page");
      await form.waitFor({ state: "hidden" });
      expect(ui.documentCount()).toBe(1);
      // The real global search uses Next's router: B becomes active in the SAME
      // document before A's response arrives. No injected router or fixture GET.
      await page.keyboard.press("Control+k");
      const search = page.getByRole("dialog", { name: "البحث السريع", exact: true });
      await search.getByRole("combobox", { name: "ابحث عن مريض أو شاشة", exact: true }).fill(other.number);
      await search.getByRole("option").filter({ has: page.getByText(other.name, { exact: true }) }).click();
      await page.waitForURL(url => url.pathname === `/patients/${other.patient}`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => page.getByTestId("patient-tab-summary").getAttribute("aria-current"), pollOptions).toBe("page");
      await plannedSection(page).getByText(other.title, { exact: false }).waitFor();
      expect(ui.documentCount()).toBe(1);
      const otherForm = await fillForm(page, other);
      const reads = ui.workflowReads.length;
      const returned = page.waitForResponse(response => new URL(response.url()).origin === baseUrl
        && new URL(response.url()).pathname === `/api/planned-visits/${f.planned}/rebook` && response.request().method() === "POST");
      deliver();
      const response = await returned;
      expect(response.status()).toBe(201); expect(await response.finished()).toBeNull();
      expect(await response.json()).toEqual(ui.writes[0].result);
      await expect.poll(() => ui.writes[0].delivered, pollOptions).toBe(true);
      await page.waitForLoadState("networkidle");
      expect(ui.workflowReads).toHaveLength(reads);
      expect(ui.documentCount()).toBe(1);
      expect(new URL(page.url()).pathname).toBe(`/patients/${other.patient}`);
      expect(await plannedSection(page).innerText()).not.toContain(f.title);
      expect(await page.getByText(success, { exact: true }).count()).toBe(0);
      expect(await otherForm.getAttribute("aria-busy")).toBe("false");
      expect(await otherForm.getByRole("textbox", { name: /^سبب إعادة الحجز/ }).isEnabled()).toBe(true);
      expect(await otherForm.getByRole("textbox", { name: /^سبب إعادة الحجز/ }).inputValue()).toBe(reason);
      expect(await otherForm.getByLabel("التاريخ", { exact: true }).inputValue()).toBe(other.date);
      expect(await otherForm.getByLabel("الوقت", { exact: true }).inputValue()).toBe(other.time);
      await otherForm.getByRole("button", { name: "إلغاء", exact: true }).click();
      expect(ui.writes).toHaveLength(1);
      expect((await db.query("SELECT id FROM appointments WHERE patient_id = $1", [other.patient])).rows).toEqual([{ id: other.old }]);
      expect((await db.query("SELECT appointment_id FROM planned_visits WHERE id = $1", [other.planned])).rows[0].appointment_id).toBe(other.old);
      expect(await history(other)).toEqual(otherBefore);
      expect((await db.query("SELECT id FROM audit_log WHERE action = 'planned_visit.rebook' AND entity_id = $1", [String(other.planned)])).rows).toEqual([]);
      await page.goto(`${baseUrl}/patients/${f.patient}?tab=summary`, { waitUntil: "domcontentloaded" });
      await plannedSection(page).waitFor();
      expect(ui.documentCount()).toBe(2);
      expect(await plannedSection(page).innerText()).not.toContain("تحتاج إعادة حجز");
      expect(await page.getByText(success, { exact: true }).count()).toBe(0);
      await refreshedHistory(page, f, ui.writes[0].result!.appointmentId);
      await verifySaved(f, ui.writes[0], "admin");
      expect(await history(f)).toEqual(before); expect(await untouchedFingerprint()).toEqual(untouched);
    });
  });
});
