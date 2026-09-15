import { beforeAll, describe, expect, it } from "vitest";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

/**
 * تفويضُ قائمة الانتظار على HTTP الحقيقي.
 *
 * والقاعدة التي تُختبر هنا حرفيًّا: **الجلسةُ الصالحة وحدها ليست تفويضًا.**
 * كان المساران يكتفيان بـ`requireSession()` في POST وPATCH: طبيبٌ موثَّق لا
 * يملك فتح ملفّ مريضٍ يستطيع — بمناداة المسار مباشرةً، لا بالضغط على زرّ —
 * أن يُدخله صفَّ انتظار، ويقرأ اسمه من ردّ التكرار، ويسجّل عليه مكالمات.
 * **وإخفاءُ الزرّ في الشاشة ليس تفويضًا.**
 *
 * والهجوم هنا يُشنّ بـfetch مباشرةً كما يفعل من يقرأ الشبكة، لا عبر الواجهة.
 */

let h: Awaited<ReturnType<typeof harness>>;

beforeAll(async () => { h = await harness(); }, 240_000);

/** يُنشئ صفَّ انتظارٍ لمريضٍ بجلسةٍ تملكه — نقطةُ البدء لهجمات الحدود. */
async function seedEntry(patientId: number): Promise<number | null> {
  const response = await authedMutation(
    "/api/waiting-list", h.sessions.reception, "POST",
    JSON.stringify({ patientId, urgency: "normal", preferredPeriod: "any" }),
  );
  if (response.status === 201) {
    const body = await response.json();
    return typeof body?.id === "number" ? body.id : null;
  }
  /* كان له صفٌّ مفتوح سلفًا — نقرأه من القائمة بجلسةٍ تملك المريض. */
  const list = await authedGet("/api/waiting-list", h.sessions.admin);
  const data = await list.json().catch(() => null);
  const found = Array.isArray(data?.entries)
    ? data.entries.find((entry: { patientId: number }) => entry.patientId === patientId)
    : null;
  return found?.id ?? null;
}

describe("POST — الإضافة تحترم حدود الملفّ", () => {
  it("الطبيب أ لا يُدخل مريض الطبيب ب قائمةَ الانتظار", async () => {
    const response = await authedMutation(
      "/api/waiting-list", h.sessions.doctorA, "POST",
      JSON.stringify({ patientId: h.seeded.patientBId, urgency: "urgent", preferredPeriod: "any" }),
    );
    expect(response.status).toBe(403);
    const body = await response.json().catch(() => null);
    expect(String(body?.message ?? "")).toMatch(/[؀-ۿ]/);
  });

  it("والاستقبال تُدخل مرضاها — السلوك المشروع لا يُكسر", async () => {
    const id = await seedEntry(h.seeded.patientAId);
    expect(id).toBeTruthy();
  });

  it("مجهولٌ بلا جلسة يُردّ قبل أيّ شيء — قراءةً وكتابة", async () => {
    const read = await fetch(`${baseUrl}/api/waiting-list`, { redirect: "manual" });
    expect(read.status).toBe(401);

    const write = await fetch(`${baseUrl}/api/waiting-list`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ patientId: h.seeded.patientAId, urgency: "normal", preferredPeriod: "any" }),
      redirect: "manual",
    });
    expect([401, 403]).toContain(write.status);
  });
});

describe("PATCH — تحريكُ صفٍّ لمريضٍ لا تملكه", () => {
  let entryB: number | null = null;

  beforeAll(async () => { entryB = await seedEntry(h.seeded.patientBId); }, 60_000);

  it("الطبيب أ لا يسجّل مكالمةً على صفّ مريض الطبيب ب", async () => {
    expect(entryB).toBeTruthy();
    const response = await authedMutation(
      `/api/waiting-list/${entryB}`, h.sessions.doctorA, "PATCH",
      JSON.stringify({ action: "contact", outcome: "no_answer", channel: "phone" }),
    );
    expect(response.status).toBe(404);
  });

  it("ولا يعدّل تفضيلاته", async () => {
    const response = await authedMutation(
      `/api/waiting-list/${entryB}`, h.sessions.doctorA, "PATCH",
      JSON.stringify({ action: "preferences", urgency: "urgent" }),
    );
    expect(response.status).toBe(404);
  });

  it("ولا يحجز له موعدًا", async () => {
    const response = await authedMutation(
      `/api/waiting-list/${entryB}`, h.sessions.doctorA, "PATCH",
      JSON.stringify({ action: "book", date: "2026-05-05", time: "10:00" }),
    );
    expect(response.status).toBe(404);
  });

  it("ولا يُغلقه", async () => {
    const response = await authedMutation(
      `/api/waiting-list/${entryB}`, h.sessions.doctorA, "PATCH",
      JSON.stringify({ action: "cancelled", reason: "محاولة عبر الحدود" }),
    );
    expect(response.status).toBe(404);
  });

  it("ولا يقرأ سجلّ اتصاله", async () => {
    const response = await authedGet(`/api/waiting-list/${entryB}`, h.sessions.doctorA);
    expect(response.status).toBe(404);
  });
});

describe("«حُجز» لا تُكتب بلا موعدٍ حقيقيّ ولو طلبها مخوَّل", () => {
  it("الاستقبال نفسها تُردّ حين ترسل booked بلا رقم موعد", async () => {
    const id = await seedEntry(h.seeded.patientAId);
    expect(id).toBeTruthy();
    const response = await authedMutation(
      `/api/waiting-list/${id}`, h.sessions.reception, "PATCH",
      JSON.stringify({ action: "booked" }),
    );
    expect(response.status).toBe(400);
    const body = await response.json().catch(() => null);
    expect(String(body?.message ?? "")).toMatch(/[؀-ۿ]/);
  });
});

describe("المدخلاتُ المرفوضة تُردّ بالعربية لا بتفاصيل استثناء", () => {
  it("يومٌ خارج ١..٧ يُردّ ٤٠٠ برسالةٍ للمستخدم", async () => {
    const id = await seedEntry(h.seeded.patientAId);
    const response = await authedMutation(
      `/api/waiting-list/${id}`, h.sessions.reception, "PATCH",
      JSON.stringify({ action: "preferences", preferredDays: [9] }),
    );
    expect(response.status).toBe(400);
    const body = await response.json().catch(() => null);
    const message = String(body?.message ?? "");
    expect(message).toMatch(/[؀-ۿ]/);
    /* ولا تسريبَ لداخل النظام: لا اسم عمود، ولا نصّ استثناء، ولا أثر مكدّس. */
    expect(message).not.toMatch(/constraint|SQLSTATE|at Object|Error:|waiting_list/i);
  });

  it("نتيجةُ اتصالٍ غير معروفة تُردّ ولا تُكتب", async () => {
    const id = await seedEntry(h.seeded.patientAId);
    const response = await authedMutation(
      `/api/waiting-list/${id}`, h.sessions.reception, "PATCH",
      JSON.stringify({ action: "contact", outcome: "أيًّا كان", channel: "phone" }),
    );
    expect(response.status).toBe(400);
  });
});
