import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * حراسةُ الموارد التشغيلية على HTTP الحقيقي.
 *
 * الفجوة التي تُغلق: `PATCH /api/appointments/[id]` و`PATCH /api/visits/[id]`
 * كانتا تسألان «هل معك جلسة؟» ولا تسألان «هل هذا المريض لك؟». فطبيبٌ موثَّق
 * يستطيع — بمناداة المسار مباشرةً — أن يُسجّل وصولَ مريض زميله، أو يُلغي موعده،
 * أو يُنهي زيارته، أو يربط زيارةً بملفٍّ لا يملكه.
 *
 * والهجومُ هنا يُشنّ بـfetch لا بالواجهة: **إخفاءُ الزرّ ليس تفويضًا.**
 */

let h: Awaited<ReturnType<typeof harness>>;

let db: Client;
beforeAll(async () => {
  h = await harness();
  const target = new URL(h.seeded.dbUrl);
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(target.hostname);
  expect(target.pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
}, 240_000);
afterAll(async () => { await db?.end(); });

// Appointment authorization must not depend on another suite's bookings or on
// a prior action in this suite. Preserve the real seeded doctor's ownership.
async function appointmentPatient(owner: "A" | "B"): Promise<number> {
  const sourceId = owner === "A" ? h.seeded.patientAId : h.seeded.patientBId;
  const result = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id)
     SELECT $1, $2, primary_doctor_id FROM patients WHERE id=$3 RETURNING id`,
    [`RBAC-APPT-${randomUUID()}`, "مريض صلاحية موعد اصطناعي", sourceId],
  );
  expect(result.rowCount).toBe(1);
  return result.rows[0].id;
}

/** موعدٌ حقيقيّ للمريض ب — يُنشأ بجلسةٍ تملكه، فالرقم صالحٌ وموجود. */
async function appointmentForB(time: string): Promise<number> {
  const patientId = await appointmentPatient("B");
  const response = await authedMutation(
    "/api/appointments", h.sessions.reception, "POST",
    JSON.stringify({
      patientId,
      date: "2026-11-17", time, durationMinutes: 30, appointmentType: "consultation",
    }),
  );
  expect(response.status).toBe(201);
  const body = await response.json().catch(() => null);
  expect(typeof body?.id, "تعذّر تهيئة موعد المريض ب").toBe("number");
  return body.id as number;
}

/** Read the same bounded displayed context as the manual reminder control. */
async function reminderSnapshotFor(id: number, date: string) {
  const response = await authedGet(`/api/appointments?date=${date}`, h.sessions.reception);
  expect(response.status).toBe(200);
  const rows = await response.json();
  const item = rows.find((row: { id: number }) => row.id === id);
  expect(item).toBeDefined();
  return { patientId: item.patientId, patientName: item.patientName, patientPhone: item.patientPhone,
    scheduledDate: item.scheduledDate, scheduledTime: item.scheduledTime, status: item.status };
}

describe("مواعيد مريضٍ لا يملكه الطبيب", () => {
  const actions = [
    { action: "arrive", label: "تسجيل الوصول" },
    { action: "reminded", label: "تعليم التذكير" },
    { action: "cancel", label: "الإلغاء" },
    { action: "no_show", label: "لم يحضر" },
    { action: "close_done", label: "إغلاق كمنجَز" },
    { action: "close_no_show", label: "إغلاق كغياب" },
  ];

  actions.forEach(({ action, label }, index) => {
    it(`الطبيب أ لا ينفّذ «${label}» على موعد مريض الطبيب ب`, async () => {
      const id = await appointmentForB(`${String(9 + index).padStart(2, "0")}:00`);
      const response = await authedMutation(
        `/api/appointments/${id}`, h.sessions.doctorA, "PATCH",
        JSON.stringify({ action, reason: "محاولة عبر الحدود",
          ...(action === "reminded" ? { snapshot: await reminderSnapshotFor(id, "2026-11-17") } : {}) }),
      );
      expect(response.status).toBe(404);

      /* والإثباتُ في الحالة لا في رمز الردّ: الموعد لم يتغيّر. */
      const after = await authedGet(`/api/appointments?date=2026-11-17`, h.sessions.reception);
      const list = await after.json().catch(() => []);
      const row = Array.isArray(list) ? list.find((one: { id: number }) => one.id === id) : null;
      expect(row?.status).toBe("booked");
    });
  });

  /* النقل جسدُه أغنى من بقيّة الإجراءات (تاريخ ووقت وسبب)، فيُجرَّب وحده بجسدٍ
     صحيحٍ تمامًا: لو ردّ ٤٠٤ بسبب تحقّقٍ من الجسد لا بسبب الحارس، لَما أثبت شيئًا.
     والردّ يأتي قبل قراءة الجسد أصلًا — الحارس فوق المسار لا داخل فرعٍ منه. */
  it("والطبيب أ لا ينقل موعد مريض الطبيب ب — حتى بجسدِ نقلٍ صحيح", async () => {
    const id = await appointmentForB("16:00");
    const response = await authedMutation(
      `/api/appointments/${id}`, h.sessions.doctorA, "PATCH",
      JSON.stringify({
        action: "reschedule", date: "2026-11-19", time: "10:00",
        reason: "محاولة نقلٍ عبر الحدود",
      }),
    );
    expect(response.status).toBe(404);

    const after = await authedGet("/api/appointments?date=2026-11-17", h.sessions.reception);
    const list = await after.json().catch(() => []);
    const row = Array.isArray(list)
      ? list.find((one: { id: number }) => one.id === id) as
          { status: string; scheduledTime: string } | undefined
      : undefined;
    expect(row?.status).toBe("booked");
    /* والموعد لم يتزحزح: رمزُ الردّ وحده لا يكفي. */
    expect(row?.scheduledTime?.slice(0, 5)).toBe("16:00");
  });

  it("والطبيب أ ينفّذ على موعد مريضه — السلوك المشروع لا يُكسر", async () => {
    const patientId = await appointmentPatient("A");
    const created = await authedMutation(
      "/api/appointments", h.sessions.reception, "POST",
      JSON.stringify({
        patientId,
        date: "2026-11-18", time: "09:00", durationMinutes: 30, appointmentType: "consultation",
      }),
    );
    expect(created.status).toBe(201);
    const body = await created.json().catch(() => null);
    expect(typeof body?.id).toBe("number");

    const response = await authedMutation(
      `/api/appointments/${body.id}`, h.sessions.doctorA, "PATCH",
      JSON.stringify({ action: "reminded", snapshot: await reminderSnapshotFor(body.id, "2026-11-18") }),
    );
    expect(response.status).toBe(200);
  });

  it("وحذفُ موعدٍ لمريضٍ لا يملكه المدير مسموح — الحارس لا يكسر صلاحية أعلى", async () => {
    const id = await appointmentForB("15:00");
    const response = await authedMutation(
      `/api/appointments/${id}`, h.sessions.admin, "DELETE",
      JSON.stringify({ reason: "تنظيف اختبار" }),
    );
    expect([200, 409]).toContain(response.status);
  });
});

describe("زيارات الطابور", () => {
  /** زيارةٌ مربوطة بملفّ المريض ب — تُنشأ بجلسةٍ تملكه. (LIVE-4) وإن كان في الطابور أصلًا
      فالخادم يرفض صفًّا ثانيًا (409) ويعيد زيارته القائمة — وهي ما يُختبر عليه. */
  async function visitForB(): Promise<number> {
    const response = await authedMutation(
      "/api/visits", h.sessions.reception, "POST",
      JSON.stringify({ patientId: h.seeded.patientBId, patientName: "مريض الأمن ب" }),
    );
    const body = await response.json().catch(() => null);
    const id = response.status === 409 ? body?.visitId : body?.id;
    expect([201, 409]).toContain(response.status);
    expect(typeof id, "تعذّر تهيئة زيارة المريض ب").toBe("number");
    return id as number;
  }

  it("الطبيب أ لا يُجلس مريض الطبيب ب على كرسيّ", async () => {
    const id = await visitForB();
    const response = await authedMutation(
      `/api/visits/${id}`, h.sessions.doctorA, "PATCH",
      JSON.stringify({ action: "seat", chair: 1 }),
    );
    expect(response.status).toBe(404);
  });

  it("ولا يُنهي زيارته", async () => {
    const id = await visitForB();
    const response = await authedMutation(
      `/api/visits/${id}`, h.sessions.doctorA, "PATCH",
      JSON.stringify({ action: "finish" }),
    );
    expect(response.status).toBe(404);
  });

  it("ولا يناديه", async () => {
    const id = await visitForB();
    const response = await authedMutation(
      `/api/visits/${id}`, h.sessions.doctorA, "PATCH",
      JSON.stringify({ action: "call", chair: 2 }),
    );
    expect(response.status).toBe(404);
  });

  /* الربطُ محروسٌ من الطرفين: زيارةٌ حرّة لا تفتح بابًا لملفٍّ محروس. */
  it("الطبيب أ لا يربط زيارةً بملفّ مريض الطبيب ب", async () => {
    const created = await authedMutation(
      "/api/visits", h.sessions.reception, "POST",
      JSON.stringify({ patientName: "مريض مشى بلا ملفّ" }),
    );
    const walkIn = await created.json().catch(() => null);
    expect(typeof walkIn?.id).toBe("number");

    const response = await authedMutation(
      `/api/visits/${walkIn.id}`, h.sessions.doctorA, "PATCH",
      JSON.stringify({ action: "link", patientId: h.seeded.patientBId }),
    );
    expect(response.status).toBe(404);
  });

  /* وطابورُ الصالة يبقى مشتركًا: زيارةٌ بلا ملفّ ليست ملكًا لطبيب. */
  it("وزيارةٌ غير مربوطة بملفّ يعمل عليها الطاقم — الصالة مشتركة", async () => {
    const created = await authedMutation(
      "/api/visits", h.sessions.reception, "POST",
      JSON.stringify({ patientName: "مريض الطابور المشترك" }),
    );
    const walkIn = await created.json().catch(() => null);
    expect(typeof walkIn?.id).toBe("number");

    const response = await authedMutation(
      `/api/visits/${walkIn.id}`, h.sessions.doctorA, "PATCH",
      JSON.stringify({ action: "seat", chair: 3 }),
    );
    expect([200, 409]).toContain(response.status);
  });
});

describe("(LIVE-4) مريضٌ واحد لا يظهر مرتين في الطابور", () => {
  it("تسجيل وصولٍ ثانٍ لمريضٍ في الطابور يُرفض برسالة عربية ويعيد زيارته القائمة", async () => {
    const first = await authedMutation(
      "/api/visits", h.sessions.reception, "POST",
      JSON.stringify({ patientId: h.seeded.patientAId, patientName: "مريض الأمن أ" }),
    );
    const firstBody = await first.json().catch(() => null);
    const existingId = first.status === 409 ? firstBody?.visitId : firstBody?.id;
    const second = await authedMutation(
      "/api/visits", h.sessions.reception, "POST",
      JSON.stringify({ patientId: h.seeded.patientAId, patientName: "مريض الأمن أ" }),
    );
    expect(second.status).toBe(409);
    const body = await second.json() as { message: string; visitId: number };
    expect(body.message).toMatch(/[؀-ۿ]/);
    expect(body.visitId).toBe(existingId);
  });
});
