import { beforeAll, describe, expect, it } from "vitest";
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

beforeAll(async () => { h = await harness(); }, 240_000);

/** موعدٌ حقيقيّ للمريض ب — يُنشأ بجلسةٍ تملكه، فالرقم صالحٌ وموجود. */
async function appointmentForB(time: string): Promise<number> {
  const response = await authedMutation(
    "/api/appointments", h.sessions.reception, "POST",
    JSON.stringify({
      patientId: h.seeded.patientBId,
      date: "2026-08-11", time, durationMinutes: 30, appointmentType: "consultation",
    }),
  );
  const body = await response.json().catch(() => null);
  expect(typeof body?.id, "تعذّر تهيئة موعد المريض ب").toBe("number");
  return body.id as number;
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
        JSON.stringify({ action, reason: "محاولة عبر الحدود" }),
      );
      expect(response.status).toBe(404);

      /* والإثباتُ في الحالة لا في رمز الردّ: الموعد لم يتغيّر. */
      const after = await authedGet(`/api/appointments?date=2026-08-11`, h.sessions.reception);
      const list = await after.json().catch(() => []);
      const row = Array.isArray(list) ? list.find((one: { id: number }) => one.id === id) : null;
      expect(row?.status).toBe("booked");
    });
  });

  it("والطبيب أ ينفّذ على موعد مريضه — السلوك المشروع لا يُكسر", async () => {
    const created = await authedMutation(
      "/api/appointments", h.sessions.reception, "POST",
      JSON.stringify({
        patientId: h.seeded.patientAId,
        date: "2026-08-12", time: "09:00", durationMinutes: 30, appointmentType: "consultation",
      }),
    );
    const body = await created.json().catch(() => null);
    expect(typeof body?.id).toBe("number");

    const response = await authedMutation(
      `/api/appointments/${body.id}`, h.sessions.doctorA, "PATCH",
      JSON.stringify({ action: "reminded" }),
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
  /** زيارةٌ مربوطة بملفّ المريض ب — تُنشأ بجلسةٍ تملكه. */
  async function visitForB(): Promise<number> {
    const response = await authedMutation(
      "/api/visits", h.sessions.reception, "POST",
      JSON.stringify({ patientId: h.seeded.patientBId, patientName: "مريض الأمن ب" }),
    );
    const body = await response.json().catch(() => null);
    expect(typeof body?.id, "تعذّر تهيئة زيارة المريض ب").toBe("number");
    return body.id as number;
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
