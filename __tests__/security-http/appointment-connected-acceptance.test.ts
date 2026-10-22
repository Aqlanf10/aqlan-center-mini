import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { Client } from "pg";
import { guardBrowserRoutes } from "../helpers/guarded-browser-routes";
import { authedGet, authedMutation, baseUrl, harness, type Session } from "./_server";

// Supplemental hosted acceptance against the real pinned app. No response mocks,
// source overlays, synthetic DOM, or local-browser workaround. Only isolated
// fixtures are seeded; the connected UI, auth, HTTP, writers and reads are real.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let browser: Browser;
let doctors: { a: number; b: number };
let financialPatient: Awaited<ReturnType<typeof patient>>;
let sequence = 0;
const prefix = `APPOINTMENT-ACCEPTANCE-${Date.now()}`;
const HOURS = ["clinic.day_start", "clinic.day_end", "clinic.shift2_start", "clinic.shift2_end"] as const;
const FINANCIAL_TABLES = ["invoices", "invoice_items", "payments", "expenses", "cashier_shifts", "journal_manual", "journal_manual_lines"] as const;
let financialBefore: Awaited<ReturnType<typeof financialFingerprint>>;
type AppointmentState = {
  id: number; patientId: number; patientName: string; patientPhone: string | null;
  scheduledDate: string; scheduledTime: string; status: string;
  reminderSentAt: Date | null; endedAt: Date | null;
};
type Mutation = { path: string; body: Record<string, unknown> };

async function financialFingerprint() {
  const result: Record<string, { count: number; digest: string }> = {};
  for (const table of FINANCIAL_TABLES) {
    // Fixed source-code allowlist, never an input-supplied identifier. Full row
    // hashes detect edits as well as insertions without emitting finance rows.
    result[table] = (await db.query<{ count: number; digest: string }>(
      `SELECT count(*)::int AS count, md5(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id)::text, '[]')) AS digest FROM ${table} t`,
    )).rows[0];
  }
  return result;
}

beforeAll(async () => {
  h = await harness();
  const target = new URL(h.seeded.dbUrl);
  expect(target.hostname).toBe("127.0.0.1");
  expect(target.pathname).toBe("/aqlan_sec_http");
  expect(new URL(baseUrl).origin).toBe(baseUrl);
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  db = new Client({ connectionString: target.toString(), ssl: false });
  await db.connect();
  expect(Math.floor(Number((await db.query("SHOW server_version_num")).rows[0].server_version_num) / 10_000)).toBe(18);
  const users = (await db.query<{ username: string; party_id: number }>(
    "SELECT username, party_id FROM users WHERE username IN ('secdoctora', 'secdoctorb') ORDER BY username",
  )).rows;
  expect(users).toHaveLength(2);
  doctors = { a: users[0].party_id, b: users[1].party_id };
  // Reuse the established receipt-correction-ui-journey.test.ts invoice/line
  // fixture verbatim in value and column shape. This is setup, not an accounting
  // journey; no payment, shift, journal, or product financial writer is invented.
  financialPatient = await patient("لوحة ذات تاريخ مالي اصطناعي");
  const { rows: [invoice] } = await db.query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
     VALUES ($1, $2, 100000, 0, 'YER', 'reception') RETURNING id`, [`${prefix}-INVOICE`, financialPatient.id],
  );
  await db.query(
    `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
     VALUES ($1, 'تقويم — دفعة', 1, 100000, 100000)`, [invoice.id],
  );
  financialBefore = await financialFingerprint();
  expect(financialBefore.invoices.count).toBeGreaterThan(0);
  expect(financialBefore.invoice_items.count).toBeGreaterThan(0);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
}, 240_000);

afterEach(async () => { if (financialBefore) expect(await financialFingerprint()).toEqual(financialBefore); });
afterAll(async () => {
  try { await browser?.close(); } finally { await db?.end(); }
  // The existing global harness owns teardown of this entire synthetic database.
});

async function clinicDay(offset: number) {
  return (await db.query<{ date: string }>(
    "SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Aden')::date + $1::int)::text AS date", [offset],
  )).rows[0].date;
}
async function patient(label: string, doctor = doctors.a) {
  const serial = ++sequence;
  const fullName = `مريض مواعيد اصطناعي ${label} ${serial}`;
  const phone = `77790${String(serial).padStart(4, "0")}`;
  const { rows: [row] } = await db.query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name, phone, primary_doctor_id) VALUES ($1, $2, $3, $4) RETURNING id",
    [`${prefix}-${serial}`, fullName, phone, doctor],
  );
  return { id: row.id, fullName, phone };
}
async function appointment(patientId: number, date: string, time = "10:00", status = "booked", doctor = doctors.a) {
  return (await db.query<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, status, doctor_id, note)
     VALUES ($1, $2::date, $3::time, 30, $4, $5, $6) RETURNING id`,
    [patientId, date, time, status, doctor, prefix],
  )).rows[0].id;
}
async function state(id: number): Promise<AppointmentState> {
  const { rows: [row] } = await db.query<AppointmentState>(
    `SELECT a.id, a.patient_id AS "patientId", p.full_name AS "patientName", p.phone AS "patientPhone",
       a.scheduled_date::text AS "scheduledDate", to_char(a.scheduled_time, 'HH24:MI') AS "scheduledTime",
       a.status, a.reminder_sent_at AS "reminderSentAt", a.ended_at AS "endedAt"
     FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = $1`, [id],
  );
  expect(row).toBeDefined();
  return row;
}
function snapshot(row: AppointmentState) {
  return { patientId: row.patientId, patientName: row.patientName, patientPhone: row.patientPhone,
    scheduledDate: row.scheduledDate, scheduledTime: row.scheduledTime, status: row.status };
}
async function mutate(id: number, body: Record<string, unknown>, session: Session = h.sessions.admin) {
  return authedMutation(`/api/appointments/${id}`, session, "PATCH", JSON.stringify(body));
}
function responseFor(page: Page, path: string, method: string) {
  return page.waitForResponse(response => new URL(response.url()).origin === baseUrl
    && new URL(response.url()).pathname === path && response.request().method() === method);
}

function patientAppointmentsResponse(page: Page, patientId: number, view: "upcoming" | "history") {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === baseUrl && url.pathname === `/api/patients/${patientId}`
      && url.searchParams.get("projection") === "appointments" && url.searchParams.get("view") === view
      && response.request().method() === "GET";
  });
}

async function withBrowser(
  session: Session,
  allowed: (mutation: Mutation) => boolean,
  body: (page: Page, writes: Mutation[], openDraft: (link: Locator) => Promise<void>) => Promise<void>,
  width = 1280,
) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: "ar-YE",
    timezoneId: "Asia/Aden", serviceWorkers: "block" });
  const [name, ...value] = session.cookie.split("=");
  await context.addCookies([{ name, value: value.join("="), url: baseUrl }]);
  const unexpected: string[] = []; const errors: string[] = []; const writes: Mutation[] = [];
  let draftHref: string | null = null;
  let interceptedDrafts = 0;
  // Context-level routing is installed BEFORE any page, popup, or navigation.
  // It covers the first request of a target=_blank popup as well as subresources.
  const guard = await guardBrowserRoutes(context, baseUrl, unexpected, async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== baseUrl) {
      if (request.method() === "GET" && request.isNavigationRequest() && draftHref === request.url()) {
        interceptedDrafts++; draftHref = null;
      } else unexpected.push(`external ${request.method()} ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      const mutation = { path: url.pathname, body: request.postDataJSON() as Record<string, unknown> };
      if (request.method() !== "PATCH" || !allowed(mutation)) {
        unexpected.push(`mutation ${request.method()} ${url.pathname}`);
        await route.abort("blockedbyclient"); return;
      }
      writes.push(mutation);
    }
    await route.continue();
  });
  await guard.run(async () => {
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    page.on("download", () => unexpected.push("unexpected download"));
    const openDraft = async (link: Locator) => {
      const href = await link.getAttribute("href");
      expect(href).not.toBeNull();
      const target = new URL(href!);
      expect(target.origin).toBe("https://wa.me");
      expect(target.pathname).toMatch(/^\/96777790\d{4}$/);
      expect([...target.searchParams.keys()]).toEqual(["text"]);
      expect(await link.getAttribute("target")).toBe("_blank");
      draftHref = href;
      const before = interceptedDrafts;
      const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()]);
      await expect.poll(() => interceptedDrafts).toBe(before + 1);
      await popup.close();
      expect(draftHref).toBeNull();
    };
    await body(page, writes, openDraft);
  }, () => { expect(unexpected).toEqual([]); expect(errors).toEqual([]); });
}

async function confirmReminder(page: Page, group: Locator, accept = true) {
  const dialogPromise = page.waitForEvent("dialog");
  await Promise.all([
    group.locator('[data-action="confirm-manual-reminder"]').click(),
    (async () => {
      const dialog = await dialogPromise;
      try {
        expect(dialog.type()).toBe("confirm");
        expect(dialog.message()).toContain("فتح مسودة واتساب وحده لا يكفي");
        expect(dialog.message()).toContain("ليس إثبات تسليم آلي");
        if (accept) await dialog.accept(); else await dialog.dismiss();
      } catch (error) {
        await dialog.dismiss().catch(() => {});
        throw error;
      }
    })(),
  ]);
}

async function settingsRows() {
  return (await db.query<{ key: string; value: string; version: string; transaction: string }>(
    "SELECT key, value, updated_at::text AS version, xmin::text AS transaction FROM settings WHERE key = ANY($1::text[]) ORDER BY key", [HOURS],
  )).rows;
}
async function settingsAuditCount() {
  return (await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM audit_log WHERE entity = 'clinic_setting' AND entity_id = ANY($1::text[])", [HOURS],
  )).rows[0].count;
}

describe("connected nonfinancial appointment acceptance", () => {
  it("rejects overlapping/partial hours without writes, then saves both valid periods in one transaction", async () => {
    const originalResponse = await authedGet("/api/settings", h.sessions.admin);
    expect(originalResponse.status).toBe(200);
    const original = await originalResponse.json();
    const before = await settingsRows(); const auditBefore = await settingsAuditCount();
    const valid = { "clinic.day_start": "08:15", "clinic.day_end": "12:45", "clinic.shift2_start": "15:15", "clinic.shift2_end": "20:45" };
    const invalid = { ...valid, "clinic.shift2_start": "12:00" };
    const versions = Object.fromEntries(HOURS.map(key => [key, original.__versions[key]]));
    await withBrowser(h.sessions.admin, ({ path, body }) => path === "/api/settings"
      && Object.keys(body).every(key => HOURS.includes(key as typeof HOURS[number]) || key === "__versions"), async (page, writes) => {
      await page.goto(`${baseUrl}/settings`);
      await page.getByRole("searchbox", { name: "بحث في الإعدادات" }).fill("دوام");
      const card = page.getByRole("article", { name: "فترات الدوام", exact: true });
      await card.getByRole("button", { name: "تعديل فترات الدوام" }).click();
      await card.getByRole("radio", { name: "فترتان", exact: true }).check();
      for (const [label, value] of [["بداية الفترة الأولى", "08:15"], ["نهاية الفترة الأولى", "12:45"],
        ["بداية الفترة الثانية", "12:00"], ["نهاية الفترة الثانية", "20:45"]]) await card.getByLabel(label, { exact: true }).fill(value);
      await expect.poll(() => card.getByRole("button", { name: "حفظ فترات الدوام" }).isDisabled()).toBe(true);
      expect(await card.getByRole("alert").innerText()).toMatch(/تداخل|تبدأ|بداية|نهاية/);
      expect(writes).toEqual([]);
      for (const values of [invalid, { "clinic.shift2_start": "16:00" }]) {
        const rejected = await authedMutation("/api/settings", h.sessions.admin, "PATCH", JSON.stringify({ ...values, __versions: versions }));
        expect(rejected.status).toBe(400);
        expect(await settingsRows()).toEqual(before);
        expect(await settingsAuditCount()).toBe(auditBefore);
      }
      await card.getByLabel("بداية الفترة الثانية", { exact: true }).fill("15:15");
      const saved = responseFor(page, "/api/settings", "PATCH");
      await card.getByRole("button", { name: "حفظ فترات الدوام" }).click();
      expect((await saved).status()).toBe(200);
      await card.getByRole("status").filter({ hasText: "حُفظت فترات الدوام معًا" }).waitFor();
      expect(writes).toEqual([{ path: "/api/settings", body: { ...valid, __versions: versions } }]);
      const rows = await settingsRows();
      expect(Object.fromEntries(rows.map(row => [row.key, row.value]))).toEqual(valid);
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map(row => row.transaction)).size).toBe(1);
      expect(new Set(rows.map(row => row.version)).size).toBe(1);
      expect(await settingsAuditCount()).toBe(auditBefore + 4);
    });
  });

  it("renders only the signed-in doctor's assigned daily appointments and refuses a doctor override", async () => {
    const today = await clinicDay(0);
    const own = await patient("جدول الطبيب أ"); const other = await patient("جدول الطبيب ب", doctors.b);
    const ownId = await appointment(own.id, today); const otherId = await appointment(other.id, today, "11:00", "booked", doctors.b);
    await withBrowser(h.sessions.doctorA, () => false, async page => {
      const loaded = responseFor(page, "/api/appointments/mine", "GET");
      await page.goto(`${baseUrl}/my-work`);
      const response = await loaded;
      expect(response.status()).toBe(200);
      const feed = await response.json();
      expect(feed.date).toBe(today); expect(feed.timeZone).toBe("Asia/Aden");
      expect(feed.appointments.map((row: { appointmentId: number }) => row.appointmentId)).toContain(ownId);
      expect(feed.appointments.map((row: { appointmentId: number }) => row.appointmentId)).not.toContain(otherId);
      const schedule = page.getByRole("region", { name: "جدول مواعيدي", exact: true });
      await schedule.getByRole("link", { name: own.fullName, exact: true }).waitFor();
      expect(await schedule.innerText()).not.toContain(other.fullName);
      expect(await schedule.getByRole("link", { name: own.fullName, exact: true }).getAttribute("href")).toBe(`/patients/${own.id}`);
      const forbidden = await authedGet(`/api/appointments/mine?date=${today}&doctorId=${doctors.b}`, h.sessions.doctorA);
      expect(forbidden.status).toBe(400);
    });
  });

  it("opening an intercepted WhatsApp draft and dismissing confirmation do not stamp; explicit current attestation does", async () => {
    const p = await patient("التذكير الصريح"); const date = await clinicDay(1); const id = await appointment(p.id, date);
    const initial = await state(id);
    await withBrowser(h.sessions.admin, ({ path, body }) => path === `/api/appointments/${id}` && body.action === "reminded",
      async (page, writes, openDraft) => {
        await page.goto(`${baseUrl}/appointments?date=${date}`);
        const group = page.locator(`[data-appointment="${id}"] [data-manual-reminder="${id}"]`);
        await group.waitFor();
        expect(await group.innerText()).toContain("التأكيد اليدوي إفادة الموظف، وليس إثبات تسليم");
        await openDraft(group.getByRole("link", { name: "💬 فتح مسودة واتساب", exact: true }));
        expect(await state(id)).toEqual(initial); expect(writes).toEqual([]);
        await confirmReminder(page, group, false);
        expect(await state(id)).toEqual(initial); expect(writes).toEqual([]);
        const confirmed = responseFor(page, `/api/appointments/${id}`, "PATCH");
        await confirmReminder(page, group);
        expect((await confirmed).status()).toBe(200);
        await expect.poll(async () => (await state(id)).reminderSentAt !== null).toBe(true);
        const after = await state(id);
        expect({ ...after, reminderSentAt: null }).toEqual(initial);
        expect(writes).toEqual([{ path: `/api/appointments/${id}`, body: { action: "reminded", snapshot: snapshot(initial) } }]);
        await expect.poll(() => group.innerText()).toContain("تذكير مسجّل ✓");
        await page.reload();
        await expect.poll(() => page.locator(`[data-manual-reminder="${id}"]`).innerText()).toContain("تذكير مسجّل ✓");
      });
  });

  it.each(["reschedule", "cancel"] as const)("a server %s after display makes stale confirmation fail without stamping", async action => {
    const p = await patient(`تذكير متقادم ${action}`); const date = await clinicDay(2); const id = await appointment(p.id, date, action === "cancel" ? "11:00" : "10:00");
    const initial = await state(id);
    await withBrowser(h.sessions.admin, ({ path, body }) => path === `/api/appointments/${id}` && body.action === "reminded", async (page, writes) => {
      await page.goto(`${baseUrl}/appointments?date=${date}`);
      const group = page.locator(`[data-manual-reminder="${id}"]`); await group.waitFor();
      // Simulate a second authorized device through the actual HTTP writer, not
      // a DOM edit or mocked GET. The first page still holds its old snapshot.
      const changed = await mutate(id, action === "reschedule"
        ? { action, date, time: "11:45", reason: "نقل اصطناعي بعد عرض التذكير" }
        : { action, reason: "إلغاء اصطناعي بعد عرض التذكير" });
      expect(changed.status).toBe(200);
      const canonical = await state(id);
      expect(canonical.reminderSentAt).toBeNull();
      expect(action === "reschedule" ? canonical.scheduledTime : canonical.status).toBe(action === "reschedule" ? "11:45" : "cancelled");
      const confirmed = responseFor(page, `/api/appointments/${id}`, "PATCH");
      await confirmReminder(page, group);
      const rejection = await confirmed;
      expect(rejection.status()).toBe(409);
      expect((await rejection.json()).message).toContain("لم يُسجّل التأكيد");
      await expect.poll(() => page.locator("[data-action-error]").innerText()).toContain("لم يُسجّل التأكيد");
      expect(writes).toEqual([{ path: `/api/appointments/${id}`, body: { action: "reminded", snapshot: snapshot(initial) } }]);
      expect(await state(id)).toEqual(canonical);
      expect(await page.locator(`[data-appointment="${id}"]`).innerText()).not.toContain("تذكير مسجّل ✓");
    });
  });

  it("patient summary shows its upcoming and closed appointments and safely records its own manual reminder", async () => {
    const p = financialPatient; const unrelated = await patient("ليس هذا الملف");
    const tomorrow = await clinicDay(1); const yesterday = await clinicDay(-1);
    const nextId = await appointment(p.id, tomorrow, "10:30");
    const closedId = await appointment(p.id, yesterday, "09:15", "cancelled");
    const otherId = await appointment(unrelated.id, tomorrow, "11:30");
    const initial = await state(nextId);
    await withBrowser(h.sessions.admin, ({ path, body }) => path === `/api/appointments/${nextId}` && body.action === "reminded",
      async (page, writes, openDraft) => {
        const loaded = patientAppointmentsResponse(page, p.id, "upcoming");
        await page.goto(`${baseUrl}/patients/${p.id}?tab=summary`);
        const initialResponse = await loaded;
        expect(initialResponse.status()).toBe(200);
        const initialFeed = await initialResponse.json();
        expect(initialFeed).toMatchObject({ patientId: p.id, view: "upcoming", timeZone: "Asia/Aden", canRemind: true });
        expect(initialFeed.appointments.map((row: { id: number }) => row.id)).toEqual([nextId]);
        const panel = page.getByTestId("patient-appointments-panel");
        const upcoming = panel.locator(`[data-patient-appointment="${nextId}"]`);
        await upcoming.waitFor();
        expect(await upcoming.innerText()).toContain(tomorrow);
        expect(await upcoming.locator("time").getAttribute("datetime")).toBe(`${tomorrow}T10:30`);
        expect(await panel.locator(`[data-patient-appointment="${closedId}"]`).count()).toBe(0);
        expect(await panel.locator(`[data-patient-appointment="${otherId}"]`).count()).toBe(0);
        const group = upcoming.locator(`[data-manual-reminder="${nextId}"]`);
        await openDraft(group.getByRole("link", { name: "💬 فتح مسودة واتساب", exact: true }));
        expect(await state(nextId)).toEqual(initial); expect(writes).toEqual([]);
        const confirmed = responseFor(page, `/api/appointments/${nextId}`, "PATCH");
        await confirmReminder(page, group);
        expect((await confirmed).status()).toBe(200);
        await expect.poll(() => upcoming.innerText()).toContain("تذكير مسجّل ✓");
        expect((await state(nextId)).reminderSentAt).not.toBeNull();
        expect(writes).toEqual([{ path: `/api/appointments/${nextId}`, body: { action: "reminded", snapshot: snapshot(initial) } }]);
        const history = patientAppointmentsResponse(page, p.id, "history");
        await panel.getByRole("button", { name: "السابقة والمغلقة", exact: true }).click();
        const historyResponse = await history;
        expect(historyResponse.status()).toBe(200);
        const historyFeed = await historyResponse.json();
        expect(historyFeed).toMatchObject({ patientId: p.id, view: "history", timeZone: "Asia/Aden", canRemind: true });
        expect(historyFeed.appointments.map((row: { id: number }) => row.id)).toEqual([closedId]);
        const closed = panel.locator(`[data-patient-appointment="${closedId}"]`); await closed.waitFor();
        expect(await closed.innerText()).toContain(yesterday);
        expect(await closed.locator("time").getAttribute("datetime")).toBe(`${yesterday}T09:15`);
        expect(await closed.locator('[data-action="confirm-manual-reminder"]').count()).toBe(0);
        expect(await panel.locator(`[data-patient-appointment="${nextId}"]`).count()).toBe(0);
        expect(await panel.locator(`[data-patient-appointment="${otherId}"]`).count()).toBe(0);
        await panel.getByRole("button", { name: "اليوم والقادمة", exact: true }).click();
        await expect.poll(() => upcoming.innerText()).toContain("تذكير مسجّل ✓");
        expect((await state(closedId)).reminderSentAt).toBeNull();
        expect((await state(otherId)).reminderSentAt).toBeNull();
      }, 390);
  });

  it("patient-panel confirmation refuses a cancellation made after display and shows the canonical closed record", async () => {
    const p = await patient("لوحة ذات تذكير متقادم"); const date = await clinicDay(1);
    const id = await appointment(p.id, date, "16:30"); const initial = await state(id);
    await withBrowser(h.sessions.admin, ({ path, body }) => path === `/api/appointments/${id}` && body.action === "reminded", async (page, writes) => {
      await page.goto(`${baseUrl}/patients/${p.id}?tab=summary`);
      const panel = page.getByTestId("patient-appointments-panel");
      const group = panel.locator(`[data-manual-reminder="${id}"]`); await group.waitFor();
      expect((await mutate(id, { action: "cancel", reason: "إلغاء اصطناعي بعد فتح ملف المريض" })).status).toBe(200);
      const canonical = await state(id); expect(canonical.status).toBe("cancelled");
      const confirmation = responseFor(page, `/api/appointments/${id}`, "PATCH");
      await confirmReminder(page, group);
      expect((await confirmation).status()).toBe(409);
      await expect.poll(() => panel.getByTestId("patient-appointments-notice").innerText()).toContain("لم يُسجّل التأكيد");
      expect(await panel.locator(`[data-patient-appointment="${id}"]`).count()).toBe(0);
      expect(writes).toEqual([{ path: `/api/appointments/${id}`, body: { action: "reminded", snapshot: snapshot(initial) } }]);
      expect(await state(id)).toEqual(canonical); expect(canonical.reminderSentAt).toBeNull();
      await panel.getByRole("button", { name: "السابقة والمغلقة", exact: true }).click();
      const closed = panel.locator(`[data-patient-appointment="${id}"]`); await closed.waitFor();
      expect(await closed.innerText()).toContain("إلغاء اصطناعي بعد فتح ملف المريض");
      expect(await closed.locator('[data-action="confirm-manual-reminder"]').count()).toBe(0);
      expect(await closed.innerText()).not.toContain("تذكير مسجّل ✓");
    }, 390);
  });

  it("real HTTP rejects premature absence/past closure and missing reminder snapshot without canonical writes", async () => {
    const p = await patient("حواجز الانتقال"); const id = await appointment(p.id, await clinicDay(3));
    const initial = await state(id);
    const transitions = async () => (await db.query("SELECT * FROM appointment_status_log WHERE appointment_id = $1 ORDER BY id", [id])).rows;
    const beforeLog = await transitions();
    for (const action of ["no_show", "close_no_show", "close_done"]) {
      expect((await mutate(id, { action })).status).toBe(409);
      expect(await state(id)).toEqual(initial); expect(await transitions()).toEqual(beforeLog);
    }
    expect((await mutate(id, { action: "reminded" })).status).toBe(400);
    expect(await state(id)).toEqual(initial); expect(await transitions()).toEqual(beforeLog);
    const pastPatient = await patient("غياب سابق"); const past = await appointment(pastPatient.id, await clinicDay(-1));
    expect((await mutate(past, { action: "close_no_show", reason: "إغلاق غياب اصطناعي سابق" })).status).toBe(200);
    expect((await state(past)).status).toBe("no_show");
    expect((await state(past)).reminderSentAt).toBeNull();
    const log = (await db.query("SELECT from_status, to_status, actor, actor_role FROM appointment_status_log WHERE appointment_id = $1 ORDER BY id", [past])).rows;
    expect(log).toEqual([{ from_status: "booked", to_status: "no_show", actor: "secadmin", actor_role: "admin" }]);
  });
});
