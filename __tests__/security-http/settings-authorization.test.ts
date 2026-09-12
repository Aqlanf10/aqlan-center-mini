import { beforeAll, describe, expect, it } from "vitest";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";

/**
 * تفويض الإعدادات على HTTP الحقيقي — لا إخفاءَ زرٍّ يُحاسَب عليه.
 *
 * الشاشة تُخفي ما لا يملكه المستخدم، وهذا لطفٌ لا حماية: `curl` واحدٌ يتجاوزه.
 * فالمُثبَت هنا أن **الخادم** يردّ — بلا جلسة، وبجلسةٍ لا تملك الفئة.
 */

let h: Awaited<ReturnType<typeof harness>>;

beforeAll(async () => {
  h = await harness();
}, 240_000);

type Session = Awaited<ReturnType<typeof harness>>["sessions"]["admin"];

const patch = (session: Session, body: unknown) =>
  authedMutation("/api/settings", session, "PATCH", JSON.stringify(body));

describe("تفويض الإعدادات في الخادم", () => {
  it("بلا جلسة: لا قراءة ولا كتابة ولا سجلّ", async () => {
    for (const path of ["/api/settings", "/api/settings/history"]) {
      const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
      expect(response.status, path).toBe(401);
    }
    const write = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "clinic.chairs": "9" }),
    });
    expect(write.status).toBe(401);
  });

  it("الاستقبال تقرأ ولا تكتب — ولو أرسلت الطلب مباشرةً", async () => {
    const read = await authedGet("/api/settings", h.sessions.reception);
    expect(read.status).toBe(200);
    const write = await patch(h.sessions.reception, { "clinic.name": "اسمٌ جديد" });
    expect(write.status).toBe(403);
  });

  it("والطبيب كذلك، ولا يفتح المالية", async () => {
    expect((await authedGet("/api/settings", h.sessions.doctorA)).status).toBe(200);
    expect((await patch(h.sessions.doctorA, { "finance.rate.USD": "600" })).status).toBe(403);
  });

  it("وسجلّ التغييرات للمدير وحده", async () => {
    expect((await authedGet("/api/settings/history", h.sessions.reception)).status).toBe(403);
    expect((await authedGet("/api/settings/history", h.sessions.admin)).status).toBe(200);
  });

  it("والقراءة لا تُعيد قيمة أي سرّ — تُعيد حالته", async () => {
    const response = await authedGet("/api/settings", h.sessions.admin);
    const payload = await response.json();
    expect(payload).toHaveProperty("__secrets");
    expect(payload).toHaveProperty("__versions");
    /* لا مفتاح سرّيّ مسجَّل اليوم — والمُثبَت أن القناة تحمل الحالة لا القيمة،
       فأولُ سرٍّ يُسجَّل يمرّ من هذا الطريق نفسه. */
    for (const [key, configured] of Object.entries(payload.__secrets as Record<string, boolean>)) {
      expect(typeof configured, key).toBe("boolean");
      expect(payload[key]).toBeUndefined();
    }
  });

  it("والقيمة المخالفة للنوع تُردّ باسم الحقل لا برسالة عامة", async () => {
    const response = await patch(h.sessions.admin, { "clinic.chairs": "ثلاثة" });
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.key).toBe("clinic.chairs");
    expect(String(payload.message)).toContain("عدد الكراسي");
  });

  it("والمفتاح المجهول يُردّ — لا كتابة لما ليس معرَّفًا", async () => {
    const response = await patch(h.sessions.admin, { "ops.injected_key": "1" });
    expect(response.status).toBe(400);
  });
});
