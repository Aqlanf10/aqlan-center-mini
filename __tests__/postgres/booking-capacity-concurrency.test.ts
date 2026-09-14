import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  BookAppointmentInput, BookingActor, BookingResult,
} from "../../lib/book-appointment";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = assertRealPostgresUrl();
/* سقف اتصالاتٍ يتّسع لعشرة متسابقين في اللحظة نفسها. السقف الافتراضي (٣) يجعل
   السبعةَ الباقين ينتظرون على مسبح الاتصالات لا على قفل اليوم — فيصير «التزامن»
   طابورًا مصطنعًا صنعه المسبح، ويمرّ اختبارٌ لم يختبر الحارس أصلًا. */
process.env.DB_POOL_MAX = "12";

const {
  createPatient, ensureSchema, getPool, listAudit, resetPoolForTesting,
  saveSettings, seedAppointmentServices,
} = await import("../../lib/db");
const { bookAppointment } = await import("../../lib/book-appointment");

/**
 * حجزُ المواعيد تحت التزامن — على PostgreSQL حقيقيّ لا سواه.
 *
 * الحجز في هذا النظام له بابٌ واحد: `bookAppointment`، وحارسه قفلٌ استشاريّ على
 * اليوم داخل المعاملة (`pg_advisory_xact_lock` على التاريخ) يُؤخذ في
 * `writeAppointmentInDay`. وهذا القفل هو المُدَّعى المُختبَر هنا، ولا يُثبَت إلا
 * على PostgreSQL حقيقيّ: PGlite محرّكٌ باتصالٍ واحد، فمعاملتان «متزامنتان»
 * تتداخلان على الاتصال نفسه، وتراجُعُ الخاسرة (ROLLBACK) يمحو عمل الفائزة. فما
 * يُرى على المحاكي سلوكُ المحاكي لا سلوك الإنتاج — والفرق بينهما هو بالضبط ما
 * يجب أن يُختبر على المحرّك الحقيقيّ.
 *
 * والدليل المعتمد هنا ليس ما يُعيده الحجز، بل **عدد الصفوف في الجدول**: نتيجتان
 * ناجحتان بصفٍّ واحد، أو نجاحٌ واحد بصفَّين، كلتاهما فشلٌ يُبلَّغ لا يُغطّى.
 */

const TIME_SLOT = "10:00";

let patientCounter = 0;

/** مريضٌ جديدٌ لكلّ متسابق — باسمٍ ورقمٍ لا يشترك فيهما اختبارٌ مع آخر. */
async function newPatientId(label: string): Promise<number> {
  patientCounter += 1;
  const patient = await createPatient({
    fullName: `سباق ${label} ${patientCounter}`,
    phone: `77${String(1_000_000 + patientCounter)}`,
    altPhone: null,
    gender: "male",
    birthYear: 1990,
    address: null,
    medicalAlert: null,
    note: null,
  });
  return patient.id;
}

/** موظّف استقبالٍ بلا صلاحية تجاوز — الحال الغالبة في المركز. */
function receptionist(username: string): BookingActor {
  return { username, role: "reception", channel: "ui" };
}

const isBooked = (result: BookingResult): result is Extract<BookingResult, { ok: true }> =>
  result.ok;
const isRefused = (result: BookingResult): result is Extract<BookingResult, { ok: false }> =>
  !result.ok;

/** طلبُ حجزٍ عاديّ: نصف ساعة، إجراءٌ عام، داخل الدوام. */
function request(
  patientId: number, date: string, extra: Partial<BookAppointmentInput> = {},
): BookAppointmentInput {
  return { patientId, date, time: TIME_SLOT, durationMinutes: 30, ...extra };
}

async function countSlotRows(date: string, time: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM appointments
      WHERE scheduled_date = $1::date AND scheduled_time = $2::time`,
    [date, time],
  );
  return Number(rows[0].count);
}

async function countChairRows(date: string, time: string, chairNo: number): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM appointments
      WHERE scheduled_date = $1::date AND scheduled_time = $2::time AND chair_no = $3::int`,
    [date, time, chairNo],
  );
  return Number(rows[0].count);
}

async function setChairs(count: number): Promise<void> {
  await saveSettings({ "clinic.chairs": String(count) });
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await seedAppointmentServices();
}, 120_000);

afterAll(async () => {
  await resetPoolForTesting();
});

/**
 * الزحمة على آخر كرسيّ.
 *
 * جهازُ الاستقبال وهاتفُ الطبيب يفتحان اليومَ نفسه في اللحظة نفسها فيريانه يتّسع
 * لموعدٍ واحد، فيَعِد كلٌّ منهما مريضًا. وفي الصباح يأتي مريضان لكرسيٍّ واحد،
 * ويُلام المركز على جدولٍ لم يحرسه أحد. فالمطلوب أن يُسلسل قفلُ اليوم المتنافسَين:
 * واحدٌ يحجز، والآخر يُردّ في الحال — قبل أن يَعِد المريض لا بعده.
 */
describe("سباق آخر كرسيّ في الوقت نفسه", () => {
  it("متسابقان على آخر كرسيّ: فائزٌ واحد وصفٌّ واحد", async () => {
    const date = "2027-03-01";
    await setChairs(1);
    const [first, second] = [await newPatientId("كرسي-أ"), await newPatientId("كرسي-ب")];

    const results = await Promise.all([
      bookAppointment(request(first, date), receptionist("استقبال أ")),
      bookAppointment(request(second, date), receptionist("استقبال ب")),
    ]);

    expect(results.filter(isBooked)).toHaveLength(1);
    const refused = results.filter(isRefused);
    expect(refused).toHaveLength(1);
    expect(refused[0].status).toBe(409);

    /* والمردود يعرف لماذا رُدّ — لا رسالةَ مبهمة أمام مريضٍ واقف. */
    const loser = refused[0];
    const conflict = loser.status === 409 ? loser.conflict : null;
    expect(conflict?.reasons.join(" ")).toContain("الكراسي ممتلئة");

    /* البرهان الحقيقيّ: الجدول. صفٌّ واحد لا اثنان ولا صفر. */
    expect(await countSlotRows(date, TIME_SLOT)).toBe(1);
  }, 60_000);
});

/**
 * كرسيّان على كرسيّ.
 *
 * الاستقبال يخصّص الكرسيَّ رقم ٢ لمريضٍ، ويخصّصه زميلُه في اللحظة نفسها لمريضٍ
 * آخر، والمركز فيه كراسٍ شاغرة — فالسعة العامة لا تردّ أحدًا. ولو لم يُحرس
 * الكرسيُّ الصريح لجلس مريضان على كرسيٍّ واحدٍ بينما الثالث فارغ. والحارس يجب
 * أن يمنع هذا وحده: كرسيان مختلفان في الوقت نفسه يجب أن يمرّا كلاهما، وإلا كان
 * الحارس يمنع العمل لا الازدحام.
 */
describe("سباق الكرسيّ الصريح", () => {
  it("الكرسيّ نفسه في الوقت نفسه: واحدٌ يجلس عليه لا اثنان", async () => {
    const date = "2027-03-02";
    await setChairs(3);
    const [first, second] = [await newPatientId("كرسي٢-أ"), await newPatientId("كرسي٢-ب")];

    const results = await Promise.all([
      bookAppointment(request(first, date, { chairNo: 2 }), receptionist("استقبال أ")),
      bookAppointment(request(second, date, { chairNo: 2 }), receptionist("استقبال ب")),
    ]);

    expect(results.filter(isBooked)).toHaveLength(1);
    expect(results.filter(isRefused)).toHaveLength(1);
    expect(results.filter(isRefused)[0].status).toBe(409);
    expect(await countChairRows(date, TIME_SLOT, 2)).toBe(1);
    expect(await countSlotRows(date, TIME_SLOT)).toBe(1);
  }, 60_000);

  it("كرسيّان مختلفان في الوقت نفسه: كلاهما يمرّ", async () => {
    const date = "2027-03-03";
    await setChairs(3);
    const [first, second] = [await newPatientId("كرسي١-ج"), await newPatientId("كرسي٢-ج")];

    const results = await Promise.all([
      bookAppointment(request(first, date, { chairNo: 1 }), receptionist("استقبال أ")),
      bookAppointment(request(second, date, { chairNo: 2 }), receptionist("استقبال ب")),
    ]);

    expect(results.filter(isBooked)).toHaveLength(2);
    expect(await countChairRows(date, TIME_SLOT, 1)).toBe(1);
    expect(await countChairRows(date, TIME_SLOT, 2)).toBe(1);
    expect(await countSlotRows(date, TIME_SLOT)).toBe(2);
  }, 60_000);
});

/**
 * يومان لا يتزاحمان.
 *
 * القفل على اليوم لا على المركز. ولو كان قفلًا واحدًا للجدول كلّه لصار حجزُ موعدٍ
 * لشهرٍ قادم ينتظر حجزَ موعدٍ لليوم — طابورٌ واحد على شاشة الاستقبال في ذروة
 * الزحمة، وهو ما يجب أن يمنعه النظام لا أن يصنعه.
 */
describe("استقلال أيام الحجز", () => {
  it("يومان مختلفان معًا: كلاهما ينجح ولو كان في المركز كرسيٌّ واحد", async () => {
    await setChairs(1);
    const [first, second] = [await newPatientId("يوم-أ"), await newPatientId("يوم-ب")];

    const results = await Promise.all([
      bookAppointment(request(first, "2027-03-04"), receptionist("استقبال أ")),
      bookAppointment(request(second, "2027-03-05"), receptionist("استقبال ب")),
    ]);

    expect(results.filter(isBooked)).toHaveLength(2);
    expect(await countSlotRows("2027-03-04", TIME_SLOT)).toBe(1);
    expect(await countSlotRows("2027-03-05", TIME_SLOT)).toBe(1);
  }, 60_000);
});

/**
 * التجاوز حقٌّ موثَّق لا بابٌ خلفيّ.
 *
 * حالةٌ طارئة تستوجب أن يتجاوز المديرُ السعةَ بسببٍ مكتوب يُسجَّل باسمه ووقته.
 * والخطر أن يفتح ازدحامُ اللحظة البابَ لمن لا يملك الصلاحية: الاثنان يضغطان معًا،
 * فيمرّ من لا يحقّ له في زحمة السباق. والسجلّ يجب أن يحمل سطرًا واحدًا لا سطرين
 * ولا صفرًا — تجاوزٌ بلا شاهد يساوي تجاوزًا بلا حساب.
 */
describe("سباق تجاوز السعة", () => {
  it("صاحبُ الصلاحية يمرّ بسببه، وغيرُه يُردّ — والسجلّ سطرٌ واحد", async () => {
    const date = "2027-03-06";
    await setChairs(1);

    /* الكرسيّ الوحيد مشغولٌ قبل السباق. */
    const taken = await bookAppointment(
      request(await newPatientId("تجاوز-أصل"), date), receptionist("استقبال أصل"),
    );
    expect(taken.ok).toBe(true);

    const [privileged, plain] = [
      await newPatientId("تجاوز-مصرّح"), await newPatientId("تجاوز-ممنوع"),
    ];
    const [allowed, denied] = await Promise.all([
      bookAppointment(
        request(privileged, date, { overrideReason: "حالة طارئة — كسر جهاز التقويم" }),
        { username: "د. عقلان", role: "reception", canOverrideCapacity: true, channel: "ui" },
      ),
      bookAppointment(
        request(plain, date, { overrideReason: "المريض مستعجل" }),
        receptionist("استقبال بلا صلاحية"),
      ),
    ]);

    expect(allowed.ok).toBe(true);
    expect(denied.ok).toBe(false);
    if (isRefused(denied)) {
      expect(denied.status).toBe(409);
      const conflict = denied.status === 409 ? denied.conflict : null;
      expect(conflict?.overrideHint).toContain("صلاحية");
    }

    /* صفّان: الأصل والتجاوز الموثَّق — لا ثالثَ للممنوع. */
    expect(await countSlotRows(date, TIME_SLOT)).toBe(2);

    if (isBooked(allowed)) {
      expect(allowed.overridden).toBe(true);
      const log = await listAudit({
        action: "appointment.capacity_override",
        entity: "appointment",
        entityId: String(allowed.appointment.id),
      });
      expect(log).toHaveLength(1);
      expect(log[0].actor).toBe("د. عقلان");
    }

    /* ولا سطرَ تجاوزٍ لغير صاحبه في هذا اليوم كلّه. */
    const allOverrides = await listAudit({ action: "appointment.capacity_override" });
    expect(allOverrides.filter((row) => row.actor === "استقبال بلا صلاحية")).toHaveLength(0);
  }, 60_000);
});

/**
 * ذروة الزحمة: عشرة طلباتٍ على ثلاثة كراسٍ.
 *
 * هذه أشدّ صور المشكلة الحقيقية في المركز — الهاتف والاستقبال والبوابة والوكيل
 * يطلبون الوقت نفسه معًا. والخطأ بواحدٍ هنا ليس رقمًا في تقرير: هو مريضٌ حادي عشر
 * يقف في ممرٍّ لا كرسيَّ فيه. فالمطلوب أن يساوي عددُ النجاحات عددَ الصفوف تمامًا،
 * وألّا يتجاوز عددَ الكراسي.
 */
describe("عشرة متسابقين على ثلاثة كراسٍ", () => {
  it("النجاحات تساوي الصفوف تمامًا ولا تتجاوز الكراسي", async () => {
    const date = "2027-03-07";
    const chairs = 3;
    await setChairs(chairs);

    const patients: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      patients.push(await newPatientId(`ذروة-${index}`));
    }

    const results = await Promise.all(
      patients.map((patientId, index) =>
        bookAppointment(request(patientId, date), receptionist(`جهاز ${index}`))),
    );

    const booked = results.filter(isBooked).length;
    const rows = await countSlotRows(date, TIME_SLOT);
    expect(booked).toBe(rows);
    expect(rows).toBeLessThanOrEqual(chairs);
    /* ولا نقصان: قفلٌ يردّ الجميع «احتياطًا» يُفرغ الكراسي بدل أن يحرسها —
       فالثلاثة تُملأ كاملةً، والسبعة الباقون يُردّون لأن الكرسي شُغل فعلًا. */
    expect(rows).toBe(chairs);
    expect(results.filter(isRefused)).toHaveLength(10 - booked);
    for (const refused of results.filter(isRefused)) expect(refused.status).toBe(409);
  }, 120_000);
});
