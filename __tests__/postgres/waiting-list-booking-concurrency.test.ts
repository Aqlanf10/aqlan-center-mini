import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = assertRealPostgresUrl();

const {
  addWaitingEntry, claimWaitingForBooking, createPatient, ensureSchema, getPool,
  getWaitingEntry, listWaitingContactEvents, recordWaitingContact,
  resetPoolForTesting, saveSettings, updateWaitingPreferences,
} = await import("../../lib/db");
const { convertWaitingToAppointment } = await import("../../lib/waiting-list-booking");

/**
 * تحويلُ الانتظار إلى موعد — على PostgreSQL حقيقيّ.
 *
 * وهذا لا يُثبَت على PGlite: محرّكٌ باتصالٍ واحد، فالمعاملتان تتسلسلان عليه
 * ويبدو كلُّ سباقٍ سليمًا. السباق الحقيقيّ يحتاج اتصالين متوازيين.
 *
 * وما يُحرَس هنا ثلاثةٌ لا يجوز أن يسقط أيُّها في مركزٍ يعمل:
 *   • موظّفان يضغطان «احجز له» على المنتظِر نفسه ⇒ موعدٌ واحد لا موعدان.
 *   • لا صفَّ يقول «حُجز» وهو بلا موعدٍ موجود — في أيّ لحظةٍ من السباق.
 *   • المكالماتُ وقائع: تُضاف كلُّها ولا تمحو إحداها الأخرى.
 */

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  /* مركزٌ بكرسيّين وورديةٍ واسعة: الحدُّ المقصود هنا هو حارسُ الصفّ لا السعة. */
  await saveSettings({
    "clinic.chairs": "2", "clinic.day_start": "09:00", "clinic.day_end": "21:00",
  });
}, 180_000);

afterAll(async () => { await resetPoolForTesting(); });

let seq = 0;
async function patient(): Promise<number> {
  seq += 1;
  const created = await createPatient({
    fullName: `منتظِر ${seq} ${Date.now()}`,
    phone: `73${String(Date.now() + seq).slice(-7)}`,
    altPhone: null, gender: "female", birthYear: 1995,
    address: null, medicalAlert: null, note: null,
  });
  return created.id;
}

async function waiting(patientId: number, over: Record<string, unknown> = {}) {
  const created = await addWaitingEntry({
    patientId, preferredPeriod: "any", urgency: "normal", ...over,
  } as Parameters<typeof addWaitingEntry>[0], { actor: "الاستقبال", actorRole: "reception" });
  if (!created.ok) throw new Error(created.message);
  return created.entry;
}

const staff = (username: string) => ({
  username, role: "reception" as const, channel: "ui" as const,
});

/** لا صفَّ في القاعدة كلِّها يقول «حُجز» وهو بلا موعد — ثابتٌ يُفحص بعد كلّ سباق. */
async function assertNoOrphanBooked(): Promise<void> {
  const { rows: [orphan] } = await getPool().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM waiting_list
      WHERE status = 'booked' AND appointment_id IS NULL`,
  );
  expect(orphan.n).toBe(0);
}

describe("أ) موظّفان يحجزان للمنتظِر نفسه في اللحظة نفسها", () => {
  it("موعدٌ واحد يُكتب، والثاني يُردّ برسالةٍ عربية", async () => {
    const entry = await waiting(await patient());

    const [a, b] = await Promise.all([
      convertWaitingToAppointment(
        { waitingId: entry.id, date: "2026-04-06", time: "10:00", durationMinutes: 30 },
        staff("موظّف أ"),
      ),
      convertWaitingToAppointment(
        { waitingId: entry.id, date: "2026-04-06", time: "10:30", durationMinutes: 30 },
        staff("موظّف ب"),
      ),
    ]);

    const made = [a, b].filter(
      (result) => result.ok && result.appointment !== null,
    );
    expect(made).toHaveLength(1);

    const refused = [a, b].filter((result) => !result.ok);
    expect(refused).toHaveLength(1);
    for (const one of refused) {
      if (!one.ok) expect(one.message).toMatch(/[؀-ۿ]/);
    }

    /* عددُ المواعيد هو الإثبات: موعدان لمنتظِرٍ واحد عطبٌ ولو بدا الردّان سليمين. */
    const { rows: [count] } = await getPool().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM appointments
        WHERE patient_id = $1 AND scheduled_date = '2026-04-06'`,
      [entry.patientId],
    );
    expect(count.n).toBe(1);

    const after = await getWaitingEntry(entry.id);
    expect(after?.status).toBe("booked");
    expect(after?.appointmentId).toBeTruthy();
    await assertNoOrphanBooked();
  }, 120_000);
});

describe("ب) خمسُ محاولاتٍ متزامنة على الصفّ نفسه", () => {
  it("واحدةٌ تنجح وأربعٌ تُردّ — ولا موعدَ زائد", async () => {
    const entry = await waiting(await patient());

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => convertWaitingToAppointment(
        { waitingId: entry.id, date: "2026-04-07", time: `1${n}:00`, durationMinutes: 30 },
        staff(`موظّف ${n}`),
      )),
    );

    const made = results.filter((result) => result.ok && result.appointment !== null);
    expect(made).toHaveLength(1);

    const { rows: [count] } = await getPool().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM appointments
        WHERE patient_id = $1 AND scheduled_date = '2026-04-07'`,
      [entry.patientId],
    );
    expect(count.n).toBe(1);
    await assertNoOrphanBooked();
  }, 120_000);
});

describe("ج) الحجزُ المرفوض لا يترك الصفّ معلّقًا", () => {
  it("تاريخٌ غير صالح ⇒ يُردّ، والصفّ يبقى مفتوحًا وقابلًا لحجزٍ تالٍ", async () => {
    const entry = await waiting(await patient());

    const bad = await convertWaitingToAppointment(
      { waitingId: entry.id, date: "ليس تاريخًا", time: "10:00" }, staff("موظّف أ"),
    );
    expect(bad.ok).toBe(false);

    const still = await getWaitingEntry(entry.id);
    expect(still?.status).toBe("waiting");
    /* والمطالبةُ أُطلقت: لو بقيت لبقي الصفُّ محجوزًا دقيقتين بلا سبب. */
    expect(still?.bookingClaimAt ?? null).toBeNull();

    const good = await convertWaitingToAppointment(
      { waitingId: entry.id, date: "2026-04-08", time: "10:00", durationMinutes: 30 },
      staff("موظّف أ"),
    );
    expect(good.ok).toBe(true);
    await assertNoOrphanBooked();
  }, 120_000);
});

describe("د) تكرارُ الضغط لا يُنتج موعدين", () => {
  it("الضغطةُ الثانية تعيد الموعد نفسه ولا تحجز غيره", async () => {
    const entry = await waiting(await patient());
    const first = await convertWaitingToAppointment(
      { waitingId: entry.id, date: "2026-04-09", time: "10:00", durationMinutes: 30 },
      staff("موظّف أ"),
    );
    expect(first.ok).toBe(true);
    if (!first.ok || !first.appointment) return;

    const second = await convertWaitingToAppointment(
      { waitingId: entry.id, date: "2026-04-09", time: "11:00", durationMinutes: 30 },
      staff("موظّف أ"),
    );
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.appointment).toBeNull();
      expect("alreadyBooked" in second ? second.alreadyBooked : null)
        .toBe(first.appointment.id);
    }

    const { rows: [count] } = await getPool().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM appointments
        WHERE patient_id = $1 AND scheduled_date = '2026-04-09'`,
      [entry.patientId],
    );
    expect(count.n).toBe(1);
  }, 120_000);
});

describe("هـ) مكالماتٌ متزامنة", () => {
  it("كلُّها تُكتب — الوقائع تُضاف ولا يمحو بعضها بعضًا", async () => {
    const entry = await waiting(await patient());
    const actor = { actor: "الاستقبال", actorRole: "reception" };

    await Promise.all([
      recordWaitingContact(entry.id, { outcome: "no_answer", channel: "phone" }, actor),
      recordWaitingContact(entry.id, { outcome: "busy", channel: "phone" }, actor),
      recordWaitingContact(entry.id, { outcome: "call_back", channel: "whatsapp" }, actor),
    ]);

    const events = await listWaitingContactEvents(entry.id);
    expect(events).toHaveLength(3);
    const back = await getWaitingEntry(entry.id);
    expect(back?.contactAttempts).toBe(3);
  }, 120_000);
});

describe("و) المطالبةُ المعلّقة تنتهي وحدها", () => {
  it("مطالبةٌ قديمة (>دقيقتين) تُؤخذ من غيره فلا يُقفل الصفّ بعطبٍ عابر", async () => {
    const entry = await waiting(await patient());
    expect((await claimWaitingForBooking(entry.id, "موظّف أ")).ok).toBe(true);

    /* محاكاةُ انهيارٍ بين المطالبة والحجز: الختم يُقدَّم ثلاث دقائق. */
    await getPool().query(
      `UPDATE waiting_list SET booking_claim_at = NOW() - INTERVAL '3 minutes' WHERE id = $1`,
      [entry.id],
    );
    expect((await claimWaitingForBooking(entry.id, "موظّف ب")).ok).toBe(true);
  }, 120_000);
});

describe("ز) تعديلُ التفضيلات لا يُعيد فتح صفٍّ مُغلق", () => {
  it("الصفُّ المحجوز لا تُعدَّل تفضيلاته، والأقدميّة تبقى للمفتوح", async () => {
    const entry = await waiting(await patient());
    const before = await getWaitingEntry(entry.id);

    const changed = await updateWaitingPreferences(
      entry.id, { urgency: "urgent", preferredDays: [1, 2] },
      { actor: "الاستقبال", actorRole: "reception" },
    );
    expect(changed.ok).toBe(true);
    const mid = await getWaitingEntry(entry.id);
    expect(mid?.createdAt).toBe(before?.createdAt);

    const booked = await convertWaitingToAppointment(
      { waitingId: entry.id, date: "2026-04-10", time: "10:00", durationMinutes: 30 },
      staff("موظّف أ"),
    );
    expect(booked.ok).toBe(true);

    const closed = await updateWaitingPreferences(
      entry.id, { urgency: "normal" }, { actor: "الاستقبال", actorRole: "reception" },
    );
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.message).toMatch(/[؀-ۿ]/);
  }, 120_000);
});
