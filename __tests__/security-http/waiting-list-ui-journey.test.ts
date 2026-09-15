import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

/**
 * رحلةُ متصفّحٍ حقيقية لقائمة الانتظار — لا وحداتٌ تُستدعى بل شاشةٌ تُضغط.
 *
 * السيناريو أ: موعدٌ يُلغى ⇒ تظهر لوحةُ المرشَّحين بسبب ترشيحٍ مقروء ⇒ يُضغط
 * «احجز له» ⇒ يوجد موعدٌ حقيقيّ في القاعدة وصفُّ الانتظار يصير «حُجز» ومعه رقمه.
 * السيناريو ب: شاشةُ القائمة — تُسجَّل مكالمةٌ بنتيجتها فتظهر في السجلّ،
 * وتُعدَّل التفضيلات فتبقى الأقدميّة كما هي.
 *
 * وهذا ما لا يثبته اختبارُ وحدة: أنّ الأزرار موصولةٌ فعلًا بما يزعم التوثيق.
 */

let browser: Browser;
let context: BrowserContext;
let page: Page;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;

const SLOT_TIME = "10:00";
let appointmentId = 0;
let waitingId = 0;
let today = "";

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();

  const { rows: [day] } = await db.query<{ today: string }>(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Aden')::date)::text AS today`,
  );
  today = day.today;

  /* مكانٌ سيشغر: موعدُ المريض أ اليوم. */
  const { rows: [appointment] } = await db.query<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, status, note)
     VALUES ($1, $2::date, $3, 30, 'booked', 'رحلة قائمة الانتظار')
     RETURNING id`,
    [h.seeded.patientAId, today, SLOT_TIME],
  );
  appointmentId = appointment.id;

  /* ومن ينتظره: المريض ب، بلا قيدٍ يُقصيه عن هذا المكان. */
  await db.query(
    `DELETE FROM waiting_list WHERE patient_id = $1`, [h.seeded.patientBId],
  );
  const { rows: [entry] } = await db.query<{ id: number }>(
    `INSERT INTO waiting_list (patient_id, preferred_period, urgency, created_by)
     VALUES ($1, 'any', 'urgent', 'رحلة') RETURNING id`,
    [h.seeded.patientBId],
  );
  waitingId = entry.id;

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
  page = await context.newPage();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  if (db) {
    if (waitingId) await db.query("DELETE FROM waiting_list WHERE id = $1", [waitingId]);
    await db.query(
      "DELETE FROM appointments WHERE note = 'رحلة قائمة الانتظار' OR patient_id = $1 AND scheduled_date = $2::date",
      [h.seeded.patientBId, today],
    ).catch(() => {});
    if (appointmentId) await db.query("DELETE FROM appointments WHERE id = $1", [appointmentId]);
    await db.end();
  }
});

describe("السيناريو أ — مكانٌ يشغر فيُنادى من ينتظره ويُحجز له", () => {
  it("الإلغاء يُظهر المرشَّح بسببه، و«احجز له» يُنتج موعدًا حقيقيًّا", async () => {
    await page.goto(`${baseUrl}/appointments?date=${today}`);
    const row = page.locator(`[data-appointment="${appointmentId}"]`);
    await row.waitFor({ timeout: 60_000 });

    await row.getByRole("button", { name: "إلغاء", exact: true }).click();

    /* لوحةُ الشغور تظهر — وهذا وحده ما كان مفقودًا في كلّ بابٍ عدا هذه الشاشة. */
    const panel = page.locator(`[data-freed-slot="${SLOT_TIME}"]`);
    await panel.waitFor({ timeout: 60_000 });

    const candidate = panel.locator(`[data-candidate="${waitingId}"]`);
    await candidate.waitFor();

    /* السببُ مقروء: ترتيبٌ لا يُفسَّر لا يُوثق به. */
    const reason = await candidate.locator(`[data-match-reason="${waitingId}"]`).innerText();
    expect(reason.trim().length).toBeGreaterThan(0);
    expect(reason).toMatch(/ينتظر منذ/);

    await candidate.locator('[data-action="book-candidate"]').click();
    await page.getByRole("status").filter({ hasText: "حُجز الموعد" }).waitFor({ timeout: 60_000 });

    /* الإثباتُ في القاعدة لا في الشاشة: موعدٌ موجود، وصفٌّ يشير إليه. */
    const { rows: [made] } = await db.query<{ id: number }>(
      `SELECT id FROM appointments
        WHERE patient_id = $1 AND scheduled_date = $2::date AND scheduled_time::text LIKE $3
        ORDER BY id DESC LIMIT 1`,
      [h.seeded.patientBId, today, `${SLOT_TIME}%`],
    );
    expect(made?.id).toBeTruthy();

    const { rows: [after] } = await db.query<{ status: string; appointment_id: number | null }>(
      `SELECT status, appointment_id FROM waiting_list WHERE id = $1`, [waitingId],
    );
    expect(after.status).toBe("booked");
    expect(after.appointment_id).toBe(made.id);
  }, 180_000);
});

describe("السيناريو ب — شاشةُ القائمة: مكالمةٌ تُسجَّل وتفضيلاتٌ تُعدَّل", () => {
  let secondId = 0;

  beforeAll(async () => {
    const { rows: [entry] } = await db.query<{ id: number }>(
      `INSERT INTO waiting_list (patient_id, preferred_period, urgency, created_by)
       VALUES ($1, 'any', 'normal', 'رحلة ب') RETURNING id`,
      [h.seeded.patientAId],
    );
    secondId = entry.id;
  }, 60_000);

  afterAll(async () => {
    if (secondId) await db.query("DELETE FROM waiting_list WHERE id = $1", [secondId]);
  });

  it("«سجّل مكالمة» تكتب واقعةً بنتيجتها، و«تعديل التفضيلات» يحفظ الأقدميّة", async () => {
    await page.goto(`${baseUrl}/waiting-list`);
    const card = page.locator(`[data-waiting-entry="${secondId}"]`);
    await card.waitFor({ timeout: 60_000 });

    const { rows: [before] } = await db.query<{ created_at: string }>(
      `SELECT created_at::text FROM waiting_list WHERE id = $1`, [secondId],
    );

    await card.locator('[data-action="contact"]').click();
    await card.locator('[data-field="outcome"]').selectOption("call_back");
    await card.locator('[data-field="contact-note"]').fill("يفضّل المعاودة بعد العصر");
    await card.locator('[data-action="confirm-contact"]').click();
    await page.getByRole("status").filter({ hasText: "سُجّلت المكالمة" }).waitFor({ timeout: 60_000 });

    const { rows: events } = await db.query<{ outcome: string; note: string | null }>(
      `SELECT outcome, note FROM waiting_list_contact_events WHERE waiting_list_id = $1`,
      [secondId],
    );
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("call_back");
    expect(events[0].note).toBe("يفضّل المعاودة بعد العصر");

    /* والملخَّصُ ظاهرٌ تحت الاسم — «نودي» وحدها كانت لا تقول شيئًا. */
    await card.getByText(/كُلّم 1 مرة/).waitFor({ timeout: 60_000 });

    await card.locator('[data-action="edit-preferences"]').click();
    await card.locator('[data-field="urgency"]').selectOption("urgent");
    await card.locator('[data-weekday="1"]').click();
    await card.locator('[data-weekday="3"]').click();
    await card.locator('[data-action="save-preferences"]').click();
    await page.getByRole("status").filter({ hasText: "حُفظت التفضيلات" }).waitFor({ timeout: 60_000 });

    const { rows: [after] } = await db.query<{
      urgency: string; preferred_days: number[]; created_at: string;
    }>(
      `SELECT urgency, preferred_days, created_at::text FROM waiting_list WHERE id = $1`,
      [secondId],
    );
    expect(after.urgency).toBe("urgent");
    expect(after.preferred_days.map(Number)).toEqual([1, 3]);
    /* الأقدميّة تبقى: التعديل ليس إنشاءً جديدًا يُرجع صاحبه آخر القائمة. */
    expect(after.created_at).toBe(before.created_at);
  }, 180_000);
});
