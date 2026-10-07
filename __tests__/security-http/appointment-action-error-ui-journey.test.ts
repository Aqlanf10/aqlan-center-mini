import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { baseUrl, harness } from "./_server";

/**
 * رحلةُ متصفّحٍ حقيقية: سببُ رفض إجراء الموعد يبقى ظاهرًا.
 *
 * العطل (قبل الإصلاح): `act()` في شاشة المواعيد كان يكتب سبب الرفض في حالة الخطأ
 * نفسها التي يستعملها تحميل القائمة، ثم يعيد التحميل؛ ونجاحُ التحميل يمسح تلك
 * الحالة (`setError(null)`) — فيختفي «تغيّرت حالة الموعد» في اللحظة التي ظهر فيها،
 * ويظنّ الموظّف أنّ الإلغاء أو الوصول تمّ.
 *
 * الاختبار يعمل على التطبيق المبني وببيانات اصطناعية. الرفضان الحقيقيان (409 للإلغاء
 * وللوصول) يأتيان من الخادم نفسه بعد تغيير حالة الموعد في القاعدة تحت الشاشة. أمّا 500
 * وانقطاع الشبكة والردّ غير الصالح والتأخير فتُحاكى بـ`page.route` على طلب الإجراء وحده.
 * المحدِّدات (اسم الزرّ وrole="alert") موجودة في النسخة السابقة أيضًا، فالملف نفسه
 * يُثبت العطل عليها.
 */

let browser: Browser;
let context: BrowserContext;
let page: Page;
let db: Client;
let h: Awaited<ReturnType<typeof harness>>;

const NOTE = "رحلة رفض إجراء الموعد";
const ARTIFACTS = join(process.cwd(), ".settings-ui-artifacts");
let today = "";
let tomorrow = "";
let afterTomorrow = "";
let slot = 0;

const CONFLICT_MESSAGE = "تغيّرت حالة الموعد — حدّث القائمة.";
const ARRIVE_CONFLICT_MESSAGE = "سُجّل وصوله بالفعل أو تغيّرت حالة الموعد.";

function sessionCookie(raw: string): { name: string; value: string } {
  const [name, ...rest] = raw.split("=");
  return { name, value: rest.join("=") };
}

/** موعدٌ اصطناعيّ بوقتٍ فريد في كلّ اختبار — لا يتصادم مع غيره. */
async function seedAppointment(date: string, patient: "A" | "B" = "A"): Promise<number> {
  slot += 1;
  const minutes = 7 * 60 + slot * 7;
  const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const { rows: [row] } = await db.query<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, status, note)
     VALUES ($1, $2::date, $3, 15, 'booked', $4) RETURNING id`,
    [patient === "A" ? h.seeded.patientAId : h.seeded.patientBId, date, time, NOTE],
  );
  return row.id;
}

async function statusOf(id: number): Promise<{ status: string; date: string; time: string }> {
  const { rows: [row] } = await db.query<{ status: string; date: string; time: string }>(
    `SELECT status, scheduled_date::text AS date, scheduled_time::text AS time FROM appointments WHERE id = $1`,
    [id],
  );
  return { status: row.status, date: row.date, time: row.time.slice(0, 5) };
}

function isListGet(url: string, method: string, date?: string): boolean {
  const parsed = new URL(url);
  if (parsed.pathname !== "/api/appointments" || method !== "GET") return false;
  return date === undefined || parsed.searchParams.get("date") === date;
}

function isActionOn(url: string, method: string, id: number): boolean {
  return new URL(url).pathname === `/api/appointments/${id}` && method === "PATCH";
}

async function openDay(date: string): Promise<void> {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.setViewportSize({ width: 1280, height: 900 });
  const loaded = page.waitForResponse((r) => isListGet(r.url(), r.request().method(), date));
  await page.goto(`${baseUrl}/appointments?date=${date}`, { waitUntil: "domcontentloaded" });
  await loaded;
}

function row(id: number) {
  return page.locator(`[data-appointment="${id}"]`);
}

function alertWith(text: string) {
  return page.getByRole("alert").filter({ hasText: text });
}

/** ينتظر ردّ الإجراء ثم تحديث القائمة الذي يليه — ثم يترك React يُكمل الرسم. */
async function clickAndSettle(id: number, click: () => Promise<void>): Promise<void> {
  const reloaded = page.waitForResponse((r) => isListGet(r.url(), r.request().method()));
  await click();
  await reloaded;
  await page.waitForTimeout(400);
}

async function evidence(name: string, width: 390 | 1280, text: string): Promise<void> {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.waitForTimeout(150);
  /* RTL سليم ولا تمرير أفقي، ورسالة الرفض كاملةٌ داخل عرض الشاشة. */
  expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const box = await alertWith(text).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  await mkdir(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: join(ARTIFACTS, `appointment-action-error-${name}-${width}.png`), fullPage: true });
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [days] } = await db.query<{ today: string; tomorrow: string; after: string }>(
    `SELECT ((NOW() AT TIME ZONE 'Asia/Aden')::date)::text AS today,
            ((NOW() AT TIME ZONE 'Asia/Aden')::date + 1)::text AS tomorrow,
            ((NOW() AT TIME ZONE 'Asia/Aden')::date + 2)::text AS after`,
  );
  today = days.today;
  tomorrow = days.tomorrow;
  afterTomorrow = days.after;
  await db.query("DELETE FROM appointments WHERE note = $1", [NOTE]);

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar-YE" });
  await context.addCookies([{ ...sessionCookie(h.sessions.reception.cookie), url: baseUrl }]);
  page = await context.newPage();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  if (db) {
    await db.query("DELETE FROM appointments WHERE note = $1", [NOTE]).catch(() => {});
    await db.end();
  }
});

describe("سببُ رفض إجراء الموعد يبقى ظاهرًا بعد تحديث القائمة", () => {
  it("409 حقيقي: رفضُ الإلغاء بعد تغيّر الحالة يبقى ظاهرًا رغم نجاح GET", async () => {
    const id = await seedAppointment(today);
    await openDay(today);
    await row(id).waitFor({ timeout: 60_000 });
    /* موظّفٌ آخر سجّل وصوله من جهازٍ ثانٍ — والشاشة ما زالت تعرضه «محجوزًا». */
    await db.query("UPDATE appointments SET status = 'arrived', arrived_at = NOW() WHERE id = $1", [id]);

    const patch = page.waitForResponse((r) => isActionOn(r.url(), r.request().method(), id));
    await clickAndSettle(id, () => row(id).getByRole("button", { name: "إلغاء", exact: true }).click());
    expect((await patch).status()).toBe(409);

    await expect.poll(() => alertWith(CONFLICT_MESSAGE).count(), { timeout: 5_000 }).toBe(1);
    await page.waitForTimeout(800);
    expect(await alertWith(CONFLICT_MESSAGE).isVisible()).toBe(true);
    /* لا نجاح كاذب: الموعد لم يُلغَ، ولا تُفتح ترشيحات الانتظار لمكانٍ لم يشغر. */
    expect((await statusOf(id)).status).toBe("arrived");
    expect(await page.locator("[data-freed-slot]").count()).toBe(0);

    await evidence("cancel-409", 1280, CONFLICT_MESSAGE);
    await evidence("cancel-409", 390, CONFLICT_MESSAGE);
    expect(await alertWith(CONFLICT_MESSAGE).isVisible()).toBe(true);
  });

  it("409 حقيقي: رفضُ تسجيل الوصول يبقى ظاهرًا ولا تُفتح لوحة الوصول", async () => {
    const id = await seedAppointment(today);
    await openDay(today);
    await row(id).waitFor({ timeout: 60_000 });
    await db.query("UPDATE appointments SET status = 'arrived', arrived_at = NOW() WHERE id = $1", [id]);

    const patch = page.waitForResponse((r) => isActionOn(r.url(), r.request().method(), id));
    await clickAndSettle(id, () => row(id).getByRole("button", { name: /وصل للعيادة/ }).click());
    expect((await patch).status()).toBe(409);

    await page.waitForTimeout(800);
    expect(await alertWith(ARRIVE_CONFLICT_MESSAGE).isVisible()).toBe(true);
    expect(await page.getByRole("dialog", { name: "لوحة الوصول" }).count()).toBe(0);
  });

  it("500: رسالة الخادم العربية تبقى ظاهرة والموعد لم يتغيّر", async () => {
    const id = await seedAppointment(today);
    await openDay(today);
    await row(id).waitFor({ timeout: 60_000 });
    await page.route(`**/api/appointments/${id}`, (route) => route.request().method() === "PATCH"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "تعذّر تنفيذ الإجراء. أعد المحاولة." }) })
      : route.continue());

    await clickAndSettle(id, () => row(id).getByRole("button", { name: "إلغاء", exact: true }).click());
    await page.waitForTimeout(400);
    expect(await alertWith("تعذّر تنفيذ الإجراء. أعد المحاولة.").isVisible()).toBe(true);
    expect((await statusOf(id)).status).toBe("booked");
    expect(await page.locator("[data-freed-slot]").count()).toBe(0);
  });

  it("انقطاع الشبكة: رسالةٌ عربية، بلا إعادة إرسالٍ تلقائية وبلا نجاحٍ كاذب", async () => {
    const id = await seedAppointment(today);
    await openDay(today);
    await row(id).waitFor({ timeout: 60_000 });
    let attempts = 0;
    await page.route(`**/api/appointments/${id}`, (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      attempts += 1;
      return route.abort("internetdisconnected");
    });

    await row(id).getByRole("button", { name: "إلغاء", exact: true }).click();
    await expect.poll(() => alertWith("تعذّر الاتصال بالخادم").count(), { timeout: 10_000 }).toBe(1);
    await page.waitForTimeout(1_500);
    expect(await alertWith("تعذّر الاتصال بالخادم").isVisible()).toBe(true);
    expect(attempts).toBe(1);
    expect((await statusOf(id)).status).toBe("booked");
    expect(await page.locator("[data-freed-slot]").count()).toBe(0);
  });

  it("ردٌّ ناجح غير صالح (ليس JSON) لا يُعَدّ نجاحًا", async () => {
    const id = await seedAppointment(today);
    await openDay(today);
    await row(id).waitFor({ timeout: 60_000 });
    await page.route(`**/api/appointments/${id}`, (route) => route.request().method() === "PATCH"
      ? route.fulfill({ status: 200, contentType: "text/html", body: "<html>proxy</html>" })
      : route.continue());

    await clickAndSettle(id, () => row(id).getByRole("button", { name: "إلغاء", exact: true }).click());
    expect(await alertWith("وصل ردٌّ غير صالح").isVisible()).toBe(true);
    expect(await page.locator("[data-freed-slot]").count()).toBe(0);
  });

  it("رفضُ النقل يُبقي لوحة النقل مفتوحة بمدخلاتها وسببها، ويبقى الرفض ظاهرًا", async () => {
    const id = await seedAppointment(today);
    await openDay(today);
    await row(id).waitFor({ timeout: 60_000 });
    const rejection = "الوقت المطلوب محجوز — اختر وقتًا آخر.";
    await page.route(`**/api/appointments/${id}`, (route) => route.request().method() === "PATCH"
      ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: rejection, conflict: null }) })
      : route.continue());

    await row(id).locator('[data-action="reschedule"]').click();
    await row(id).locator('input[type="date"]').fill(tomorrow);
    await row(id).locator('input[type="time"]').fill("15:30");
    await row(id).locator('[data-field="reschedule-reason"]').fill("طلب المريض وقتًا آخر");
    await clickAndSettle(id, () => row(id).locator('[data-action="reschedule-submit"]').click());

    await page.waitForTimeout(400);
    expect(await alertWith(rejection).isVisible()).toBe(true);
    expect(await row(id).locator('input[type="date"]').inputValue()).toBe(tomorrow);
    expect(await row(id).locator('input[type="time"]').inputValue()).toBe("15:30");
    expect(await row(id).locator('[data-field="reschedule-reason"]').inputValue()).toBe("طلب المريض وقتًا آخر");
    /* الشاشة لم تنتقل إلى يوم الهدف، والموعد في مكانه. */
    expect(await page.locator('input[type="date"]').first().inputValue()).toBe(today);
    expect((await statusOf(id)).date).toBe(today);

    await evidence("reschedule-409", 1280, rejection);
    await evidence("reschedule-409", 390, rejection);
  });

  it("رفضُ الإجراء ثم فشلُ تحديث القائمة: يظهر الاثنان ولا يُخفي أحدهما الآخر", async () => {
    const id = await seedAppointment(today);
    await openDay(today);
    await row(id).waitFor({ timeout: 60_000 });
    let actionDone = false;
    await page.route(`**/api/appointments/${id}`, (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      actionDone = true;
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: CONFLICT_MESSAGE }) });
    });
    await page.route("**/api/appointments?*", (route) => actionDone
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "تعذّر تحميل المواعيد." }) })
      : route.continue());

    await clickAndSettle(id, () => row(id).getByRole("button", { name: "إلغاء", exact: true }).click());
    expect(await alertWith(CONFLICT_MESSAGE).isVisible()).toBe(true);
    expect(await alertWith("تعذّر تحميل المواعيد.").isVisible()).toBe(true);
    expect((await statusOf(id)).status).toBe("booked");

    await evidence("both-failed", 390, "تعذّر تحميل المواعيد.");
    await evidence("both-failed", 1280, CONFLICT_MESSAGE);
  });

  it("الضغط المتكرر أثناء التنفيذ يرسل طلبًا واحدًا فقط", async () => {
    const id = await seedAppointment(today);
    await openDay(today);
    await row(id).waitFor({ timeout: 60_000 });
    let attempts = 0;
    await page.route(`**/api/appointments/${id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: CONFLICT_MESSAGE }) });
    });

    const cancel = row(id).getByRole("button", { name: "إلغاء", exact: true });
    await clickAndSettle(id, async () => {
      await cancel.dblclick();
      await cancel.click({ timeout: 500, trial: false }).catch(() => {});
    });
    await page.waitForTimeout(800);
    expect(attempts).toBe(1);
    expect(await alertWith(CONFLICT_MESSAGE).isVisible()).toBe(true);
  });

  it("نجاحُ محاولةٍ لاحقة يمحو رسالة المحاولة السابقة", async () => {
    const id = await seedAppointment(today);
    await openDay(today);
    await row(id).waitFor({ timeout: 60_000 });
    let first = true;
    await page.route(`**/api/appointments/${id}`, (route) => {
      if (route.request().method() !== "PATCH" || !first) return route.continue();
      first = false;
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "تعذّر تنفيذ الإجراء. أعد المحاولة." }) });
    });

    await clickAndSettle(id, () => row(id).getByRole("button", { name: "إلغاء", exact: true }).click());
    expect(await alertWith("تعذّر تنفيذ الإجراء. أعد المحاولة.").isVisible()).toBe(true);

    /* المحاولة الثانية تصل الخادم الحقيقي فتنجح. */
    await clickAndSettle(id, () => row(id).getByRole("button", { name: "إلغاء", exact: true }).click());
    await expect.poll(() => statusOf(id).then((s) => s.status), { timeout: 10_000 }).toBe("cancelled");
    await expect.poll(() => alertWith("تعذّر تنفيذ الإجراء").count(), { timeout: 5_000 }).toBe(0);
  });

  it("تبديل اليوم أثناء طلبٍ مرفوض: الردّ القديم لا يعيد قائمة اليوم السابق", async () => {
    const id = await seedAppointment(today);
    const tomorrowId = await seedAppointment(tomorrow, "B");
    await openDay(today);
    await row(id).waitFor({ timeout: 60_000 });

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/appointments/${id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await gate;
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: CONFLICT_MESSAGE }) });
    });

    await row(id).getByRole("button", { name: "إلغاء", exact: true }).click();
    const tomorrowLoaded = page.waitForResponse((r) => isListGet(r.url(), r.request().method(), tomorrow));
    await page.getByRole("button", { name: "غداً", exact: true }).click();
    await tomorrowLoaded;
    await row(tomorrowId).waitFor({ timeout: 30_000 });

    let oldDayLoads = 0;
    page.on("request", (request) => {
      if (isListGet(request.url(), request.method(), today)) oldDayLoads += 1;
    });
    const patch = page.waitForResponse((r) => isActionOn(r.url(), r.request().method(), id));
    release();
    await patch;
    await page.waitForTimeout(1_500);

    expect(await page.locator('input[type="date"]').first().inputValue()).toBe(tomorrow);
    expect(await row(tomorrowId).isVisible()).toBe(true);
    expect(await row(id).count()).toBe(0);
    expect(oldDayLoads).toBe(0);
    /* والرفض لا يُخفى لأنّ المستخدم انتقل: يظهر ومعه يومُ الإجراء. */
    expect(await alertWith(CONFLICT_MESSAGE).isVisible()).toBe(true);
  });

  it("تبديل اليوم أثناء نقلٍ ناجح: لا تُسحب الشاشة إلى يوم الهدف", async () => {
    const id = await seedAppointment(today);
    const tomorrowId = await seedAppointment(tomorrow, "B");
    await openDay(today);
    await row(id).waitFor({ timeout: 60_000 });

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/appointments/${id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await gate;
      return route.continue();
    });

    await row(id).locator('[data-action="reschedule"]').click();
    await row(id).locator('input[type="date"]').fill(afterTomorrow);
    await row(id).locator('input[type="time"]').fill("14:00");
    await row(id).locator('[data-field="reschedule-reason"]').fill("نقلٌ أثناء تصفّح يومٍ آخر");
    await row(id).locator('[data-action="reschedule-submit"]').click();

    const tomorrowLoaded = page.waitForResponse((r) => isListGet(r.url(), r.request().method(), tomorrow));
    await page.getByRole("button", { name: "غداً", exact: true }).click();
    await tomorrowLoaded;
    await row(tomorrowId).waitFor({ timeout: 30_000 });

    const patch = page.waitForResponse((r) => isActionOn(r.url(), r.request().method(), id));
    release();
    expect((await patch).status()).toBe(200);
    await page.waitForTimeout(1_500);

    expect(await statusOf(id)).toMatchObject({ status: "booked", date: afterTomorrow, time: "14:00" });
    expect(await page.locator('input[type="date"]').first().inputValue()).toBe(tomorrow);
    expect(await row(tomorrowId).isVisible()).toBe(true);
    expect(await page.getByRole("alert").filter({ hasText: /تعذّر|رفض|غير صالح/ }).count()).toBe(0);
  });
});

describe("عقد نجاح الإجراء وملكيّة التنقّل", () => {
  it.each(["false", "0", '"proxy"', "[]", "{}", '{"ok":false}', '{"ok":"true"}'])(
    "JSON بلا تأكيد نجاح (%s): يبقى رفض النقل ومدخلاته واليوم المعروض",
    async (body) => {
      const id = await seedAppointment(today);
      await openDay(today);
      await row(id).waitFor({ timeout: 60_000 });
      let attempts = 0;
      await page.route(`**/api/appointments/${id}`, (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        attempts += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body });
      });

      await row(id).locator('[data-action="reschedule"]').click();
      await row(id).locator('input[type="date"]').fill(tomorrow);
      await row(id).locator('input[type="time"]').fill("15:30");
      await row(id).locator('[data-field="reschedule-reason"]').fill("طلب المريض وقتًا آخر");
      await clickAndSettle(id, () => row(id).locator('[data-action="reschedule-submit"]').click());

      expect(await alertWith("وصل ردٌّ غير صالح").isVisible()).toBe(true);
      expect(await row(id).locator('input[type="date"]').inputValue()).toBe(tomorrow);
      expect(await row(id).locator('input[type="time"]').inputValue()).toBe("15:30");
      expect(await row(id).locator('[data-field="reschedule-reason"]').inputValue()).toBe("طلب المريض وقتًا آخر");
      expect(await page.locator('input[type="date"]').first().inputValue()).toBe(today);
      expect((await statusOf(id)).date).toBe(today);
      expect(attempts).toBe(1);
    },
  );

  it.each(["arrive", "cancel"] as const)(
    "ردّ 200 بجسم ok:false لا يفتح آثار النجاح: %s",
    async (action) => {
      const id = await seedAppointment(today);
      await openDay(today);
      await row(id).waitFor({ timeout: 60_000 });
      let candidateReads = 0;
      await page.route("**/api/waiting-list?*", (route) => {
        candidateReads += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: '{"candidates":[]}' });
      });
      await page.route(`**/api/appointments/${id}`, (route) => route.request().method() === "PATCH"
        ? route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":false}' })
        : route.continue());

      await clickAndSettle(id, () => row(id).getByRole("button", {
        name: action === "arrive" ? /وصل للعيادة/ : "إلغاء",
        exact: action === "cancel",
      }).click());

      expect(await alertWith("وصل ردٌّ غير صالح").isVisible()).toBe(true);
      expect((await statusOf(id)).status).toBe("booked");
      expect(await page.getByRole("dialog", { name: "لوحة الوصول" }).count()).toBe(0);
      expect(await page.locator("[data-freed-slot]").count()).toBe(0);
      expect(candidateReads).toBe(0);
    },
  );

  it("الخروج من اليوم والعودة إليه أثناء النقل لا يُحيي انتقالًا قديمًا", async () => {
    const id = await seedAppointment(today);
    const tomorrowId = await seedAppointment(tomorrow, "B");
    await openDay(today);
    await row(id).waitFor({ timeout: 60_000 });

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/appointments/${id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await gate;
      return route.continue();
    });

    await row(id).locator('[data-action="reschedule"]').click();
    await row(id).locator('input[type="date"]').fill(afterTomorrow);
    await row(id).locator('input[type="time"]').fill("15:00");
    await row(id).locator('[data-field="reschedule-reason"]').fill("نقلٌ أثناء الخروج والعودة");
    await row(id).locator('[data-action="reschedule-submit"]').click();

    const tomorrowLoaded = page.waitForResponse((r) => isListGet(r.url(), r.request().method(), tomorrow));
    await page.getByRole("button", { name: "غداً", exact: true }).click();
    await tomorrowLoaded;
    await row(tomorrowId).waitFor({ timeout: 30_000 });

    const todayLoaded = page.waitForResponse((r) => isListGet(r.url(), r.request().method(), today));
    await page.getByRole("button", { name: /^اليوم \(/ }).click();
    await todayLoaded;
    await row(id).waitFor({ timeout: 30_000 });

    const patch = page.waitForResponse((r) => isActionOn(r.url(), r.request().method(), id));
    const reloaded = page.waitForResponse((r) => isListGet(r.url(), r.request().method()));
    release();
    expect((await patch).status()).toBe(200);
    await reloaded;
    await page.waitForTimeout(400);

    expect(await statusOf(id)).toMatchObject({ status: "booked", date: afterTomorrow, time: "15:00" });
    expect(await page.locator('input[type="date"]').first().inputValue()).toBe(today);
    expect(await row(id).count()).toBe(0);
    expect(await page.getByRole("alert").filter({ hasText: /تعذّر|رفض|غير صالح/ }).count()).toBe(0);
  });

  it("حذف المدير الحقيقي يبقى ناجحًا بعقد الرسالة بلا حقل ok", async () => {
    const id = await seedAppointment(today);
    await context.addCookies([{ ...sessionCookie(h.sessions.admin.cookie), url: baseUrl }]);
    try {
      await openDay(today);
      await row(id).waitFor({ timeout: 60_000 });
      const deletion = page.waitForResponse((r) =>
        new URL(r.url()).pathname === `/api/appointments/${id}` && r.request().method() === "DELETE");
      page.once("dialog", (dialog) => { void dialog.accept(); });
      await clickAndSettle(id, () => row(id).getByRole("button", { name: /حذف/ }).click());

      const response = await deletion;
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ message: "حُذف الموعد وسُجِّل في التدقيق." });
      expect(await row(id).count()).toBe(0);
      expect(await page.getByRole("alert").filter({ hasText: /تعذّر|رفض|غير صالح/ }).count()).toBe(0);
      const { rows: [remaining] } = await db.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM appointments WHERE id = $1", [id],
      );
      expect(remaining.count).toBe(0);
    } finally {
      await context.addCookies([{ ...sessionCookie(h.sessions.reception.cookie), url: baseUrl }]);
    }
  });
});

