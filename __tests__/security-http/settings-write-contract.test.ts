import { beforeAll, describe, expect, it } from "vitest";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * تعاقد الكتابة على الإعدادات — الطلب والجواب معًا.
 *
 * المسار يشترط `__versions` في كل كتابة. وما لم يُعِدها في الجواب، بقي المتصفّح
 * على طابعٍ صار قديمًا بفعل حفظه هو، فارتدّ حفظُه التالي بـ409 على تغييرٍ أحدثه
 * بنفسه. وهذا ما عطّل شاشة «نسب إهلاك المواد» بعد المرحلة ١ب: كانت ترسل الحمولة
 * بلا طابعٍ ولا سبب، فيردّها الخادم، والزرّ لا يفعل شيئًا.
 *
 * فهنا يُثبَت الطرفان على خادمٍ حقيقيّ: الجواب يحمل الطوابع، والطوابع تصلح
 * للحفظ التالي بلا إعادة تحميل.
 */

let h: Awaited<ReturnType<typeof harness>>;

beforeAll(async () => {
  h = await harness();
}, 240_000);

type Session = Awaited<ReturnType<typeof harness>>["sessions"]["admin"];

const patch = (session: Session, body: unknown) =>
  authedMutation("/api/settings", session, "PATCH", JSON.stringify(body));

const post = (session: Session, body: unknown) =>
  authedMutation("/api/settings", session, "POST", JSON.stringify(body));

const snapshot = async (session: Session) =>
  await (await authedGet("/api/settings", session)).json() as Record<string, unknown>;

const versionOf = (payload: Record<string, unknown>, key: string) =>
  (payload.__versions as Record<string, string | null>)[key] ?? null;

describe("الجواب يحمل ما يشترطه الطلب", () => {
  it("الحفظ الناجح يعيد الطوابع الجديدة", async () => {
    const before = await snapshot(h.sessions.admin);
    const response = await patch(h.sessions.admin, {
      "clinic.address": "تعز — الحوبان",
      __versions: { "clinic.address": versionOf(before, "clinic.address") },
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.__versions, "الجواب بلا طوابع يجعل الحفظ التالي يرتدّ").toBeTruthy();
    expect(versionOf(payload, "clinic.address")).toBeTruthy();
    expect(versionOf(payload, "clinic.address")).not.toBe(versionOf(before, "clinic.address"));
  });

  it("طابعُ الجواب يصلح للحفظ التالي بلا إعادة تحميل", async () => {
    const before = await snapshot(h.sessions.admin);
    const first = await patch(h.sessions.admin, {
      "clinic.address": "عنوان أوّل",
      __versions: { "clinic.address": versionOf(before, "clinic.address") },
    });
    expect(first.status).toBe(200);
    const firstPayload = await first.json() as Record<string, unknown>;

    const second = await patch(h.sessions.admin, {
      "clinic.address": "عنوان ثانٍ",
      __versions: { "clinic.address": versionOf(firstPayload, "clinic.address") },
    });
    expect(second.status, "حفظان متتاليان بلا GET بينهما").toBe(200);
    expect((await snapshot(h.sessions.admin))["clinic.address"]).toBe("عنوان ثانٍ");
  });

  it("الإعادة إلى الافتراضي تعيد الطوابع كذلك", async () => {
    const before = await snapshot(h.sessions.admin);
    const response = await post(h.sessions.admin, {
      action: "reset",
      keys: ["clinic.address"],
      __versions: { "clinic.address": versionOf(before, "clinic.address") },
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(versionOf(payload, "clinic.address")).toBeTruthy();
  });

  it("ولا يتسرّب سرٌّ في جواب الكتابة — حالةٌ لا قيمة", async () => {
    const before = await snapshot(h.sessions.admin);
    const response = await patch(h.sessions.admin, {
      "clinic.phone": "770123456",
      __versions: { "clinic.phone": versionOf(before, "clinic.phone") },
    });
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.__secrets).toBeTruthy();
    for (const value of Object.values(payload.__secrets as Record<string, unknown>)) {
      expect(typeof value).toBe("boolean");
    }
  });
});

describe("شاشة نسب إهلاك المواد تكتب فعلًا", () => {
  it("حمولتها بعد الإصلاح تُقبل وتُسجَّل بسببها", async () => {
    const before = await snapshot(h.sessions.admin);
    /* نفس ما ترسله الشاشة اليوم: القيمة، والطابع، والسبب. */
    const response = await patch(h.sessions.admin, {
      "finance.commission_material_rate": "on",
      __versions: {
        "finance.commission_material_rate": versionOf(before, "finance.commission_material_rate"),
      },
      __reason: "قرار المالك — تفعيل خصم الإهلاك",
    });
    expect(response.status).toBe(200);
    expect((await snapshot(h.sessions.admin))["finance.commission_material_rate"]).toBe("on");

    const history = await (await authedGet(
      "/api/settings/history?key=finance.commission_material_rate", h.sessions.admin,
    )).json() as { after: string | null; reason: string | null }[];
    expect(history[0].after).toBe("on");
    expect(history[0].reason).toBe("قرار المالك — تفعيل خصم الإهلاك");
  });

  it("وبلا سببٍ تُردّ — فالسياسة لا تُقلب بنقرةٍ صامتة", async () => {
    const before = await snapshot(h.sessions.admin);
    const response = await patch(h.sessions.admin, {
      "finance.commission_material_rate": "off",
      __versions: {
        "finance.commission_material_rate": versionOf(before, "finance.commission_material_rate"),
      },
    });
    expect(response.status).toBe(400);
  });
});
