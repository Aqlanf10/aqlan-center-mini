import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = assertRealPostgresUrl();

const {
  createAppointment, createPatient, ensureSchema, getPool,
  listAppointmentStatusLog, resetPoolForTesting, transitionAppointment,
} = await import("../../lib/db");

/**
 * سباق الحالة على PostgreSQL حقيقيّ.
 *
 * لا يصحّ إثبات هذا على PGlite: هي محرّكٌ باتصالٍ واحد، فمعاملتان «متزامنتان»
 * تتداخلان على الاتصال نفسه ويُلغي تراجعُ إحداهما عمل الأخرى. وهذا سلوك المحاكي
 * لا سلوك الإنتاج — والفرق بينهما هو بالضبط ما يجب أن يُختبر على المحرّك الحقيقيّ.
 *
 * فالمُثبَت هنا أنّ `FOR UPDATE` يُسلسل المتنافسين فعلًا: جهازان يضغطان على الموعد
 * نفسه في اللحظة نفسها — «وصل» و«لم يحضر» — فيفوز واحدٌ ويُردّ الآخر برسالةٍ تقول
 * الحال الحاضر، ويبقى في السجلّ سطرٌ واحد لا اثنان ولا صفر.
 */

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
}, 120_000);

afterAll(async () => {
  await resetPoolForTesting();
});

async function bookedAppointment(): Promise<number> {
  const patient = await createPatient({
    fullName: `سباق ${Date.now()}`, phone: `77${Date.now().toString().slice(-7)}`,
    altPhone: null, gender: "male", birthYear: 1990,
    address: null, medicalAlert: null, note: null,
  });
  const appointment = await createAppointment({
    patientId: patient.id, date: "2026-01-15", time: "10:00",
    durationMinutes: 30, appointmentType: null, note: null,
  });
  if (!appointment) throw new Error("تعذّر إنشاء الموعد للاختبار");
  return appointment.id;
}

describe("سباق انتقال حالة الموعد", () => {
  it("جهازان معًا: واحدٌ يفوز، والآخر يُردّ ويعرف الحال", async () => {
    const id = await bookedAppointment();

    const [a, b] = await Promise.all([
      transitionAppointment(id, "arrived", { actor: "جهاز أ", actorRole: "reception" }),
      transitionAppointment(id, "no_show", { actor: "جهاز ب", actorRole: "reception" }),
    ]);

    const winners = [a, b].filter((result) => result.ok);
    const losers = [a, b].filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    /* الخاسر لا يُردّ بـ«خطأ» مبهم: يُخبَر بالحال التي صار إليها الموعد. */
    const loser = losers[0] as Extract<typeof a, { ok: false }>;
    expect(loser.current).toBeTruthy();
    expect(loser.message.length).toBeGreaterThan(0);

    /* والسجلّ يحمل انتقال الفائز وحده — لا سطرَ للخاسر ولا ضياعَ لسطر الفائز. */
    const log = await listAppointmentStatusLog(id);
    expect(log).toHaveLength(1);
    expect(log[0].from).toBe("booked");
    expect(log[0].actor).toBe(winners[0].ok ? (log[0].to === "arrived" ? "جهاز أ" : "جهاز ب") : "");

    const { rows } = await getPool().query<{ status: string }>(
      "SELECT status FROM appointments WHERE id = $1", [id],
    );
    expect(rows[0].status).toBe(log[0].to);
  }, 60_000);

  it("خمسة معًا على موعدٍ واحد: واحدٌ فقط يمرّ", async () => {
    const id = await bookedAppointment();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        transitionAppointment(id, "cancelled", {
          actor: `جهاز ${index}`, actorRole: "reception", reason: "اتصل المريض واعتذر",
        })),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await listAppointmentStatusLog(id)).toHaveLength(1);
  }, 60_000);

  it("وسطر السجلّ يُكتب في معاملة الانتقال — لا انتقالَ بلا شاهد", async () => {
    const id = await bookedAppointment();
    await transitionAppointment(id, "arrived", { actor: "سارة", actorRole: "reception" });
    await transitionAppointment(id, "done", { actor: "د. عقلان", actorRole: "doctor" });

    const log = await listAppointmentStatusLog(id);
    expect(log.map((row) => `${row.from}→${row.to}`)).toEqual(["booked→arrived", "arrived→done"]);
    expect(log.map((row) => row.actor)).toEqual(["سارة", "د. عقلان"]);

    /* والنهائيّ لا يُفتح — ولا يُضاف له سطر. */
    const reopened = await transitionAppointment(id, "booked", { actor: "أحد" });
    expect(reopened.ok).toBe(false);
    expect(await listAppointmentStatusLog(id)).toHaveLength(2);
  }, 60_000);
});
