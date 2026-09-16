import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = assertRealPostgresUrl();

const {
  createParty, ensureSchema, getPool, listAppointmentServices, resetPoolForTesting,
  saveSettings, seedAppointmentServices,
} = await import("../../lib/db");
const { evaluateCapacity, loadCapacityContext } = await import("../../lib/capacity-context");

/**
 * حجبُ الطبيب — يُقاس بتوقيت المركز، ولا يُفتح صامتًا حين يتعذّر قراءته.
 *
 * عطبان في بقعةٍ واحدة:
 *
 * ١) **الإزاحة:** الحجب يُخزَّن `TIMESTAMPTZ` أي لحظةً مطلقة، وكان يُحوَّل إلى
 *    «دقائق اليوم» بقسمةٍ على منتصف ليلٍ **محلّيّ العملية**
 *    (`new Date(date + "T00:00:00")`). وخادمُ الإنتاج يعمل بـUTC والمركز في
 *    `Asia/Aden` (+٣) — فنافذةُ حجبٍ من ٠٩:٠٠ إلى ١٢:٠٠ بتوقيت المركز تُقرأ
 *    ٠٦:٠٠–٠٩:٠٠. والأثر مضاعف: يُقبل حجزٌ داخل إجازة الطبيب فعلًا، ويُرفض حجزٌ
 *    في وقتٍ هو فيه متاح.
 *
 * ٢) **الانفتاح عند الفشل:** قراءةُ الحجب كانت `.catch(() => [])` — فانقطاعٌ
 *    عابر في القاعدة يجعل الطبيب «متاحًا دائمًا»، فيُحجز فوق إجازته أو عمليّته
 *    بلا أن يشكو شيء. والحارس الذي يفشل مفتوحًا ليس حارسًا.
 *
 * والفحص هنا يقيس بتوقيت المركز صراحةً، ويعمل على صندوقٍ توقيتُ عمليّته UTC —
 * وهو ما يجعله يرى الإزاحة بدل أن يخفيها.
 */

const DATE = "2026-10-05";
const actor = { actor: "اختبار", actorRole: "admin" };

let providerId = 0;
let serviceId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await saveSettings({
    "clinic.chairs": "3", "clinic.day_start": "08:00", "clinic.day_end": "20:00",
  });
  await seedAppointmentServices().catch(() => {});

  const doctor = await createParty({
    name: "د. المحجوب", kind: "doctor", phone: null, commissionPercent: 0, note: null,
  });
  providerId = doctor.id;

  const services = await listAppointmentServices();
  const withProvider = services.find((one) => one.requiresProvider && one.isActive);
  expect(withProvider, "لا توجد خدمة تشترط طبيبًا في الكتالوج").toBeTruthy();
  serviceId = withProvider!.id;

  /* حجبٌ من ٠٩:٠٠ إلى ١٢:٠٠ **بتوقيت المركز** — تُكتب اللحظة المطلقة كما تكتبها
     الواجهة، ويُترك لـPostgreSQL تحويلُ المنطقة. */
  await getPool().query(
    `INSERT INTO provider_blocks (provider_id, starts_at, ends_at, reason, created_by)
     VALUES ($1, ($2::timestamp AT TIME ZONE 'Asia/Aden'), ($3::timestamp AT TIME ZONE 'Asia/Aden'), $4, $5)`,
    [providerId, `${DATE} 09:00:00`, `${DATE} 12:00:00`, "إجازة الطبيب", "اختبار"],
  );
}, 180_000);

afterAll(async () => { await resetPoolForTesting(); });

async function verdictAt(time: string) {
  const services = await listAppointmentServices();
  const service = services.find((one) => one.id === serviceId) ?? null;
  return evaluateCapacity({
    sameDay: [], date: DATE, time, durationMinutes: 30,
    service, context: await loadCapacityContext(), providerId,
  });
}

describe("نافذة الحجب تُقاس بتوقيت المركز", () => {
  it("حجزٌ داخل الحجب (١٠:٠٠ بتوقيت المركز) يُرفض", async () => {
    const verdict = await verdictAt("10:00");
    expect(verdict.state).toBe("OVER_CAPACITY");
    expect(verdict.reasons.join(" ")).toMatch(/[؀-ۿ]/);
  }, 120_000);

  it("وحجزٌ بعد الحجب (١٣:٠٠) يمرّ — الحارس لا يُقصي ما لم يُحجب", async () => {
    const verdict = await verdictAt("13:00");
    expect(verdict.state).not.toBe("OVER_CAPACITY");
  }, 120_000);

  it("وحجزٌ قبل الحجب (٠٨:٣٠) يمرّ", async () => {
    const verdict = await verdictAt("08:30");
    expect(verdict.state).not.toBe("OVER_CAPACITY");
  }, 120_000);

  /* وتاريخٌ **تقبله القاعدة ويرفضه JavaScript** — وهو البابُ الثاني للانفتاح
     نفسه، وأخطرُ من الأوّل لأنّه لا يُسقط قراءةً ولا يرفع خطأ.
     `2026-10-5` (بلا صفرٍ في اليوم) تقرؤها PostgreSQL تاريخًا صحيحًا فتُعيد
     نوافذ الحجب سليمة، بينما `Date.parse` تردّها `NaN` — فتصير حدودُ النوافذ
     `NaN`، وكلُّ مقارنةِ تداخلٍ معها `false`، فيختفي الحجبُ كلُّه بلا شكوى.
     والتاريخُ المرفوض من القاعدة (`2026-13-45`) لا يصلح لهذا الفحص: يُمسكه
     حارسُ فشل القراءة قبل أن يصل إلى هنا، فيمرّ الفحصُ وهو لا يُثبت شيئًا. */
  it("تاريخٌ تقبله القاعدة ويرفضه JavaScript لا يُسقط نوافذ الحجب", async () => {
    const services = await listAppointmentServices();
    const service = services.find((one) => one.id === serviceId) ?? null;
    const verdict = await evaluateCapacity({
      sameDay: [], date: "2026-10-5", time: "10:00", durationMinutes: 30,
      service, context: await loadCapacityContext(), providerId,
    });
    expect(verdict.state).toBe("OVER_CAPACITY");
    expect(verdict.message).toMatch(/[؀-ۿ]/);
    expect(verdict.message).not.toMatch(/NaN|Invalid/i);
  }, 120_000);

  /* والحارس يفشل مغلقًا: ما لا يُتحقَّق منه لا يُحجز. */
  it("تعذُّرُ قراءة الحجب يردّ الحجز برسالةٍ عربية — لا يفتحه", async () => {
    const original = await getPool().query("SELECT 1");
    expect(original.rowCount).toBe(1);

    /* يُمنع الوصولُ إلى الجدول فعلًا بدل محاكاة الفشل في الشيفرة. */
    await getPool().query("ALTER TABLE provider_blocks RENAME TO provider_blocks_hidden");
    try {
      const verdict = await verdictAt("13:00");
      expect(verdict.state).toBe("OVER_CAPACITY");
      expect(verdict.message).toMatch(/[؀-ۿ]/);
      expect(verdict.message).not.toMatch(/relation|does not exist|error/i);
    } finally {
      await getPool().query("ALTER TABLE provider_blocks_hidden RENAME TO provider_blocks");
    }
  }, 120_000);
});
