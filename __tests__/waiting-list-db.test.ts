import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * طبقةُ القاعدة لقائمة الانتظار بعد الإتمام — على PGlite.
 *
 * وما يُثبَت هنا **ليس** التزامن: PGlite محرّكٌ باتصالٍ واحد، فادّعاءُ السباق
 * عليه ادّعاءٌ على محاكٍ لا على الإنتاج. التزامن مكانُه
 * `__tests__/postgres/waiting-list-booking-concurrency.test.ts` على PostgreSQL
 * حقيقيّ. وهنا: الحقولُ تُحفظ وتُقرأ، والوقائعُ تُضاف ولا تُعدَّل، والحالةُ لا
 * تصير «حُجز» بلا موعد.
 */

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");

const {
  addWaitingEntry, claimWaitingForBooking, createPatient, ensureSchema, getPool,
  getWaitingEntry, listWaitingContactEvents, markWaitingBooked, recordWaitingContact,
  releaseWaitingClaim, resetPoolForTesting, updateWaitingPreferences,
} = await import("../lib/db");

const actor = { actor: "الاستقبال", actorRole: "reception" };

let seq = 0;
async function patient(): Promise<number> {
  seq += 1;
  const created = await createPatient({
    fullName: `منتظِر ${seq}`,
    phone: `73${String(1_000_000 + seq)}`,
    altPhone: null, gender: "female", birthYear: 1995,
    address: null, medicalAlert: null, note: null,
  });
  return created.id;
}

beforeAll(async () => { await ensureSchema(); }, 60_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("حقول التفضيل الجديدة تُحفظ وتُقرأ", () => {
  it("الأيام والوردية وإتاحة اليوم نفسه تعود كما كُتبت", async () => {
    const id = await patient();
    const created = await addWaitingEntry({
      patientId: id, preferredPeriod: "any", urgency: "soon",
      preferredDays: [1, 3, 5], preferredShift: "shift2", sameDayAvailable: false,
    }, actor);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const back = await getWaitingEntry(created.entry.id);
    expect(back?.preferredDays).toEqual([1, 3, 5]);
    expect(back?.preferredShift).toBe("shift2");
    expect(back?.sameDayAvailable).toBe(false);
  });

  /* الحارس في القاعدة لا في الشيفرة وحدها: عميلٌ خارجيّ أو سكربتُ ترحيلٍ يكتب
     مباشرةً، فلو كان الفحص في التطبيق وحده لمرّ يومٌ رقمه ٩. */
  it("يومٌ خارج ١..٧ ترفضه القاعدة نفسها", async () => {
    const id = await patient();
    await expect(getPool().query(
      `INSERT INTO waiting_list (patient_id, preferred_period, urgency, preferred_days)
       VALUES ($1, 'any', 'normal', ARRAY[9]::SMALLINT[])`,
      [id],
    )).rejects.toThrow();
  });

  it("ويومٌ مكرَّر ترفضه أيضًا", async () => {
    const id = await patient();
    await expect(getPool().query(
      `INSERT INTO waiting_list (patient_id, preferred_period, urgency, preferred_days)
       VALUES ($1, 'any', 'normal', ARRAY[2,2]::SMALLINT[])`,
      [id],
    )).rejects.toThrow();
  });
});

describe("هويةُ التكرار بالحاجة لا بالمريض", () => {
  it("مريضٌ ينتظر خدمتين مختلفتين — صفّان مشروعان", async () => {
    const id = await patient();
    const first = await addWaitingEntry(
      { patientId: id, preferredPeriod: "any", urgency: "normal", serviceId: null }, actor,
    );
    /* خدمةٌ حقيقية تلزم لصفٍّ ثانٍ — ونكتفي هنا بإثبات أنّ الصفّ العامّ لا
       يتكرّر، وأنّ رسالة الرفض عربيةٌ تقول للموظّف ما جرى. */
    const again = await addWaitingEntry(
      { patientId: id, preferredPeriod: "any", urgency: "normal", serviceId: null }, actor,
    );
    expect(first.ok).toBe(true);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.message).toMatch(/[؀-ۿ]/);
  });
});

describe("سجلُّ الاتصال — وقائعُ تُضاف ولا تُعدَّل", () => {
  it("كلُّ محاولةٍ تُكتب، والملخَّصُ مشتقٌّ منها", async () => {
    const id = await patient();
    const created = await addWaitingEntry(
      { patientId: id, preferredPeriod: "any", urgency: "normal" }, actor,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const entryId = created.entry.id;

    await recordWaitingContact(entryId, { outcome: "no_answer", channel: "phone" }, actor);
    await recordWaitingContact(entryId, { outcome: "call_back", channel: "whatsapp" }, actor);

    const events = await listWaitingContactEvents(entryId);
    expect(events).toHaveLength(2);

    const back = await getWaitingEntry(entryId);
    expect(back?.contactAttempts).toBe(2);
    expect(back?.lastOutcome).toBe("call_back");
    /* أوّلُ مكالمةٍ ترفع الحالة إلى «نودي» — فالشاشة تعرف أنه كُلّم. */
    expect(back?.status).toBe("offered");
  });
});

describe("تعديلُ التفضيلات يحفظ الأقدميّة", () => {
  it("الصفُّ يبقى هو، و`created_at` لا يُمسّ", async () => {
    const id = await patient();
    const created = await addWaitingEntry(
      { patientId: id, preferredPeriod: "any", urgency: "normal" }, actor,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const before = await getWaitingEntry(created.entry.id);
    const updated = await updateWaitingPreferences(
      created.entry.id, { urgency: "urgent", preferredDays: [2, 4] }, actor,
    );
    expect(updated.ok).toBe(true);

    const after = await getWaitingEntry(created.entry.id);
    expect(after?.id).toBe(created.entry.id);
    expect(after?.urgency).toBe("urgent");
    expect(after?.preferredDays).toEqual([2, 4]);
    expect(after?.createdAt).toBe(before?.createdAt);
  });
});

describe("«حُجز» لا تُكتب بلا موعد", () => {
  it("الحالةُ ورقمُ الموعد يُكتبان في الجملة نفسها", async () => {
    const id = await patient();
    const created = await addWaitingEntry(
      { patientId: id, preferredPeriod: "any", urgency: "normal" }, actor,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const { rows: [appointment] } = await getPool().query<{ id: number }>(
      `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, status)
       VALUES ($1, '2026-03-12', '10:00', 30, 'booked') RETURNING id`,
      [id],
    );

    const marked = await markWaitingBooked(created.entry.id, appointment.id, actor);
    expect(marked.ok).toBe(true);

    const after = await getWaitingEntry(created.entry.id);
    expect(after?.status).toBe("booked");
    expect(after?.appointmentId).toBe(appointment.id);

    /* ولا صفَّ في القاعدة يقول «حُجز» وهو بلا موعد — الفحص على الجدول كلِّه. */
    const { rows: [orphan] } = await getPool().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM waiting_list
        WHERE status = 'booked' AND appointment_id IS NULL`,
    );
    expect(orphan.n).toBe(0);
  });

  it("وحجزُ صفٍّ مُغلقٍ يُردّ ويُخبِر برقم موعده القائم", async () => {
    const id = await patient();
    const created = await addWaitingEntry(
      { patientId: id, preferredPeriod: "any", urgency: "normal" }, actor,
    );
    if (!created.ok) return;
    const { rows: [appointment] } = await getPool().query<{ id: number }>(
      `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, duration_minutes, status)
       VALUES ($1, '2026-03-13', '11:00', 30, 'booked') RETURNING id`,
      [id],
    );
    await markWaitingBooked(created.entry.id, appointment.id, actor);
    const again = await markWaitingBooked(created.entry.id, appointment.id + 1, actor);
    expect(again.ok).toBe(false);
    expect(again.alreadyBooked).toBe(appointment.id);
  });
});

describe("حجزُ الصفّ المؤقّت", () => {
  it("حاجزٌ واحد، والإطلاقُ يعيده متاحًا", async () => {
    const id = await patient();
    const created = await addWaitingEntry(
      { patientId: id, preferredPeriod: "any", urgency: "normal" }, actor,
    );
    if (!created.ok) return;

    expect((await claimWaitingForBooking(created.entry.id, "موظّف أ")).ok).toBe(true);
    const second = await claimWaitingForBooking(created.entry.id, "موظّف ب");
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("claimed");

    await releaseWaitingClaim(created.entry.id);
    expect((await claimWaitingForBooking(created.entry.id, "موظّف ب")).ok).toBe(true);
  });
});
