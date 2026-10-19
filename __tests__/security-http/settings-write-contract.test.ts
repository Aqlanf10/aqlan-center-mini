import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
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


describe("FIN011 explicit FX defaults over HTTP", () => {
  it.each([
    ["finance.rate.SAR", "140", "finance.rate.USD"],
    ["finance.rate.USD", "530", "finance.rate.SAR"],
  ] as const)("protects and persists %s through PATCH and reset", async (key, value, otherKey) => {
    const url = new URL(h.seeded.dbUrl);
    expect(["postgres:", "postgresql:"]).toContain(url.protocol);
    expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname);
    expect(url.pathname).toBe("/aqlan_sec_http");
    const db = new Client({ host: url.hostname === "[::1]" ? "::1" : url.hostname,
      port: Number(url.port || "5432"), database: "aqlan_sec_http",
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: false });
    await db.connect();
    const { rows: saved } = await db.query("SELECT key,value,updated_at FROM settings WHERE key=$1", [key]);
    const { rows: untouched } = await db.query("SELECT key,value,updated_at FROM settings WHERE key=$1", [otherKey]);
    try {
      for (const mode of ["patch", "reset"] as const) {
        await db.query("DELETE FROM settings WHERE key=$1", [key]);
        expect(versionOf(await snapshot(h.sessions.admin), key)).toBeNull();
        const body = { [key]: value, __versions: { [key]: null } };
        for (const session of [h.sessions.reception, h.sessions.doctorA]) {
          expect((await patch(session, body)).status).toBe(403);
          expect((await post(session, { action: "reset", keys: [key], __versions: { [key]: null } })).status).toBe(403);
        }
        expect((await patch(h.sessions.admin, { [key]: value })).status).toBe(409);
        for (const invalid of ["", "0", "-1", "1000001"]) {
          expect((await patch(h.sessions.admin, { [key]: invalid, __versions: { [key]: null } })).status).toBe(400);
        }
        expect((await db.query("SELECT key FROM settings WHERE key=$1", [key])).rows).toEqual([]);
        const response = mode === "patch" ? await patch(h.sessions.admin, body) :
          await post(h.sessions.admin, { action: "reset", keys: [key], __versions: { [key]: null } });
        expect(response.status).toBe(200);
        const payload = await response.json() as Record<string, unknown>;
        expect(versionOf(payload, key)).toBeTruthy();
        expect(payload[key]).toBe(value);
        expect((await db.query("SELECT value FROM settings WHERE key=$1", [key])).rows).toEqual([{ value }]);
        expect((await patch(h.sessions.admin, body)).status).toBe(409);
        expect((await db.query("SELECT key,value,updated_at FROM settings WHERE key=$1", [otherKey])).rows).toEqual(untouched);
      }
    } finally {
      await db.query("DELETE FROM settings WHERE key=$1", [key]);
      for (const row of saved) await db.query("INSERT INTO settings(key,value,updated_at) VALUES($1,$2,$3)",
        [row.key, row.value, row.updated_at]);
      await db.end();
    }
  });
});
