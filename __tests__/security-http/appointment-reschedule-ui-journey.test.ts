import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

/**
 * رحلةُ متصفّحٍ حقيقية لنقل الموعد — لا وحداتٌ تُستدعى بل شاشةٌ تُضغط.
 *
 * ما تثبته ولا يثبته اختبارُ الوحدة:
 *   ١) أنّ زرّ «نقل الموعد» موصولٌ فعلًا بمسار النقل — لا بإلغاءٍ ثمّ حجز.
 *   ٢) أنّ السبب إلزاميّ **في الشاشة** أيضًا: الزرّ معطَّل قبل كتابته، فلا يُرسَل
 *      طلبٌ يُعرف رفضُه سلفًا.
 *   ٣) أنّ **رقم الموعد نفسه** بقي بعد النقل: هذا هو الفرق كلّه. فالنقل بالإلغاء
 *      والحجز كان يُحتسب المريض «ملغيًا» وهو لم يُلغِ، ويكبّر أرقامَ الإلغاء التي
 *      يقرأها المالك.
 *   ٤) أنّ النقل إلى يومٍ آخر ينقل الشاشة معه — وإلّا بقي المستخدم ينظر إلى يومٍ
 *      لم يعد فيه الموعد فيظنّه ضاع فيحجز ثانيًا.
 *   ٥) أنّ السبب وصل سجلّ التدقيق بالفعل: «لماذا تغيّر موعدي؟» سؤالٌ يُسأل.
 */

let browser: Browser;
let context: BrowserContext;
let page: Page;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;

const FROM_TIME = "11:00";
const TO_TIME = "13:30";
const NEXT_DAY_TIME = "09:30";
const NOTE = "رحلة نقل الموعد";
let appointmentId = 0;
let today = "";
let tomorrow = "";
let observeCrossDayLoads = false;
let oldDayLoadsAfterCrossDaySubmit = 0;

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();

  const { rows: [days] } = await db.query<{ today: string; tomorrow: string }>(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Aden')::date)::text AS today,
            ((NOW() AT TIME ZONE 'Asia/Aden')::date + 1)::text AS tomorrow`,
  );
  today = days.today;
  tomorrow = days.tomorrow;

  /* المكانُ المقصود يُفرَّغ أوّلًا: لو كان مشغولًا لَرُفض النقل لسببٍ مشروع،
     فصارت الرحلة تُثبت الرفض لا النقل. */
  await db.query(
    `DELETE FROM appointments
      WHERE scheduled_date IN ($1::date, $2::date)
        AND patient_id IN ($3, $4)`,
    [today, tomorrow, h.seeded.patientAId, h.seeded.patientBId],
  );

  const { rows: [appointment] } = await db.query<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, status, note)
     VALUES ($1, $2::date, $3, 30, 'booked', $4)
     RETURNING id`,
    [h.seeded.patientAId, today, FROM_TIME, NOTE],
  );
  appointmentId = appointment.id;

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
  page = await context.newPage();

  /* TD-REG-026: راقب طلبات الجدول بعد إرسال النقل بين يومين. قبل الإصلاح
     act() كان يطلق GET لليوم القديم من closure ثم setDate يطلق GET للغد.
     الاختبار لا يكتفي بالنتيجة النهائية؛ يثبت أن مسار النجاح نفسه لم يعد
     يصدر إعادة تحميل لليوم القديم. */
  page.on("request", (request) => {
    if (!observeCrossDayLoads) return;
    const url = new URL(request.url());
    if (url.pathname !== "/api/appointments" || request.method() !== "GET") return;
    if (url.searchParams.get("date") === today) oldDayLoadsAfterCrossDaySubmit += 1;
  });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  if (db) {
    await db.query("DELETE FROM appointments WHERE note = $1", [NOTE]).catch(() => {});
    await db.end();
  }
});

/** حالةُ الموعد كما هي في القاعدة — لا كما تزعم الشاشة. */
async function stateOf(id: number): Promise<{ date: string; time: string; status: string }> {
  const { rows: [row] } = await db.query<{ date: string; time: string; status: string }>(
    `SELECT scheduled_date::text AS date, scheduled_time::text AS time, status
       FROM appointments WHERE id = $1`,
    [id],
  );
  return { date: row.date, time: row.time.slice(0, 5), status: row.status };
}

describe("نقل موعدٍ من شاشة المواعيد", () => {
  it("السبب إلزاميّ في الشاشة: زرُّ التأكيد معطَّل قبل كتابته", async () => {
    await page.goto(`${baseUrl}/appointments?date=${today}`);
    const row = page.locator(`[data-appointment="${appointmentId}"]`);
    await row.waitFor({ timeout: 60_000 });

    await row.locator('[data-action="reschedule"]').click();
    const submit = row.locator('[data-action="reschedule-submit"]');
    await submit.waitFor();
    await expect.poll(() => submit.isDisabled(), { timeout: 10_000 }).toBe(true);

    /* حرفان لا يكفيان — الحدُّ نفسه الذي يفرضه الخادم. */
    await row.locator('[data-field="reschedule-reason"]').fill("طل");
    await expect.poll(() => submit.isDisabled(), { timeout: 10_000 }).toBe(true);
  });

  it("النقل داخل اليوم يُبقي رقم الموعد نفسه — لا إلغاءً وحجزًا", async () => {
    const row = page.locator(`[data-appointment="${appointmentId}"]`);
    await row.locator('input[type="time"]').fill(TO_TIME);
    await row.locator('[data-field="reschedule-reason"]').fill("طلب المريض تأخير الموعد");

    const submit = row.locator('[data-action="reschedule-submit"]');
    await expect.poll(() => submit.isDisabled(), { timeout: 10_000 }).toBe(false);
    await submit.click();

    await expect.poll(() => stateOf(appointmentId).then((s) => s.time), { timeout: 60_000 })
      .toBe(TO_TIME);

    const after = await stateOf(appointmentId);
    expect(after.status).toBe("booked");
    expect(after.date).toBe(today);

    /* ولا موعدَ ثانٍ وُلد للمريض نفسه: النقل نقلٌ لا نسخة. */
    const { rows: [{ count }] } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM appointments WHERE note = $1`, [NOTE],
    );
    expect(count).toBe("1");

    /* والشاشة تُظهر الوقت الجديد — لا القديم إلى أن يُحدَّث يدويًّا. */
    await expect.poll(
      () => page.locator(`[data-appointment="${appointmentId}"]`).innerText(),
      { timeout: 30_000 },
    ).toContain(TO_TIME);
  });

  it("والسببُ وصل سجلّ التدقيق مع الوقتين", async () => {
    const { rows: [entry] } = await db.query<{ action: string; details: unknown }>(
      `SELECT action, details FROM audit_log
        WHERE entity = 'appointment' AND entity_id = $1 AND action = 'appointment.reschedule'
        ORDER BY id DESC LIMIT 1`,
      [String(appointmentId)],
    );
    expect(entry?.action).toBe("appointment.reschedule");
    const details = (typeof entry.details === "string"
      ? JSON.parse(entry.details) : entry.details) as Record<string, string>;
    expect(details["السبب"]).toBe("طلب المريض تأخير الموعد");
    expect(details["من"]).toBe(`${today} ${FROM_TIME}`);
    expect(details["إلى"]).toBe(`${today} ${TO_TIME}`);
  });

  it("النقل إلى يومٍ آخر ينقل الشاشة إليه فلا يظنّ المستخدم أنّ الموعد ضاع", async () => {
    const row = page.locator(`[data-appointment="${appointmentId}"]`);
    await row.locator('[data-action="reschedule"]').click();
    await row.locator('input[type="date"]').fill(tomorrow);
    await row.locator('input[type="time"]').fill(NEXT_DAY_TIME);
    await row.locator('[data-field="reschedule-reason"]').fill("تأجيل ليومٍ آخر بطلب المريض");

    oldDayLoadsAfterCrossDaySubmit = 0;
    observeCrossDayLoads = true;
    await row.locator('[data-action="reschedule-submit"]').click();

    await expect.poll(() => stateOf(appointmentId).then((s) => s.date), { timeout: 60_000 })
      .toBe(tomorrow);
    expect((await stateOf(appointmentId)).time).toBe(NEXT_DAY_TIME);
    expect((await stateOf(appointmentId)).status).toBe("booked");

    /* الشاشة تبعت الموعد: حقلُ التاريخ صار يوم الغد والصفّ ما زال معروضًا. */
    await expect.poll(
      () => page.locator('input[type="date"]').first().inputValue(),
      { timeout: 30_000 },
    ).toBe(tomorrow);
    const movedRow = page.locator(`[data-appointment="${appointmentId}"]`);
    await movedRow.waitFor({ timeout: 30_000 });

    /* أعطِ أي استجابة متأخرة فرصةً للوصول. حتى بعدها يجب أن يبقى التاريخ
       على الغد والصف نفسه ظاهرًا بوقته الجديد. */
    await page.waitForTimeout(1_250);
    expect(await page.locator('input[type="date"]').first().inputValue()).toBe(tomorrow);
    expect(await movedRow.isVisible()).toBe(true);
    expect(await movedRow.innerText()).toContain(NEXT_DAY_TIME);

    /* أصل السباق نفسه اختفى: لا GET لليوم القديم بعد submit النقل بين يومين. */
    expect(oldDayLoadsAfterCrossDaySubmit).toBe(0);
    observeCrossDayLoads = false;
  });
});
