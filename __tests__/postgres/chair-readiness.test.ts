import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (CHAIR-1) الاستقبال ← الكرسي ← الشبّاك — على PostgreSQL 18.
 *
 * - الإقرار بالجاهزية يكتب `cleared_at/cleared_by` وسطر تدقيقه في معاملةٍ واحدة، ولا يمسّ الحالة.
 * - البوابة: مغلقة (الافتراضي) ⇒ تحذير لا منع؛ مفعَّلة ⇒ منعٌ بلا أثر، إلا طوارئ بسببٍ يُدقَّق.
 * - تأجيل الدفع: سطر تدقيق وحده — الرصيد والدفاتر لا تتغيّر.
 * - ملخّص المغادرة: الجلسة المشمولة بخطة الأقساط سعرها صفر وعليها علامتها.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, invalidateSettingsCache, openShift, addVisit, callVisitGated,
  seatVisitGated, clearVisit, finishVisit, setVisitProcedures, signClinicalVisit, listTodayVisitReadinessFacts,
  patientVisitReadinessFacts, patientDuesByCurrency, recordPayment,
} = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

const reception = { actor: "reception1", actorRole: "reception" };
const doctorActor = { actor: "dr.aqlan", actorRole: "doctor" };
const noEmergency = { requested: false, reason: null };

let doctorId = 0;
let serviceId = 0;
let chairSeq = 0;
/** كرسيٌّ جديد لكل حالة — قفل الكرسي ومنع الازدحام لا يتداخلان بين الحالات. */
const nextChair = () => { chairSeq += 1; return chairSeq; };

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  ({ id: doctorId } = (await q<{ id: number }>(
    `INSERT INTO parties (kind, name, commission_percent) VALUES ('doctor', 'د. الكرسي', 30) RETURNING id`))[0]);
  ({ id: serviceId } = (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('حشوة', 15000, TRUE, TRUE, 'filling') RETURNING id`))[0]);
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function setGate(on: boolean) {
  await q(`INSERT INTO settings (key, value) VALUES ('ops.require_clearance_before_call', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [on ? "true" : "false"]);
  invalidateSettingsCache();
}
beforeEach(async () => { await setGate(false); });

let patientSeq = 0;
async function patient(over: { alert?: string | null; flags?: string[] } = {}): Promise<number> {
  patientSeq += 1;
  return (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, medical_alert, flags) VALUES ($1, $1, $2, $3::text[]) RETURNING id`,
    [`كرسي-${patientSeq}`, over.alert ?? null, over.flags ?? []],
  ))[0].id;
}

async function arrive(patientId: number): Promise<number> {
  return (await addVisit({ patientName: "مريض الكرسي", patientPhone: null, note: null, patientId, doctorId })).id;
}

async function trail(visitId: number) {
  return q<{ action: string; actor: string; details: Record<string, unknown> }>(
    `SELECT action, actor, details FROM audit_log WHERE entity = 'visit' AND entity_id = $1 ORDER BY id`, [String(visitId)]);
}

async function visitRow(visitId: number) {
  return (await q<{ status: string; chair: number | null; cleared_at: Date | null; cleared_by: string | null }>(
    `SELECT status, chair, cleared_at, cleared_by FROM visits WHERE id = $1`, [visitId]))[0];
}

async function signWithFilling(visitId: number) {
  await q(`UPDATE visits SET diagnosis = 'تسوّس' WHERE id = $1`, [visitId]);
  await setVisitProcedures({
    visitId,
    procedures: [{ serviceId, toothCode: 16, surfaces: null, quantity: 1, unitPriceMinor: 15000, priceReason: null, doctorId, note: null, planItemId: null }],
  });
  const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "dr.aqlan" });
  expect(signed.reason).toBeNull();
  return signed;
}

describe("(CHAIR-1 Slice 1) clearance acknowledgement", () => {
  it("clear writes cleared_at/by and its audit row in one transaction, snapshots the checklist, keeps the status", async () => {
    const p = await patient({ alert: "حساسية بنسلين", flags: ["VIP"] });
    const v = await arrive(p);
    const cleared = await clearVisit(v, reception);
    expect(cleared).toMatchObject({ ok: true, clearedBy: "reception1", already: false });

    const row = await visitRow(v);
    expect(row.status).toBe("waiting");
    expect(row.cleared_at).toBeInstanceOf(Date);
    expect(row.cleared_by).toBe("reception1");
    expect(await trail(v)).toEqual([{
      action: "visit.clear", actor: "reception1",
      details: { الحالة: "waiting", "يحتاج اطلاعًا": ["لا تاريخ طبي مسجَّل", "تنبيه طبي: حساسية بنسلين"] },
    }]);
  });

  it("a second clear is a no-op (returns the first, writes no second row); a finished visit cannot be cleared", async () => {
    const v = await arrive(await patient());
    const first = await clearVisit(v, reception);
    const second = await clearVisit(v, doctorActor);
    expect(second).toMatchObject({ ok: true, already: true, clearedBy: "reception1" });
    expect(first.ok && second.ok && second.clearedAt === first.clearedAt).toBe(true);
    expect((await trail(v)).map((row) => row.action)).toEqual(["visit.clear"]);

    const done = await arrive(await patient());
    await finishVisit(done, reception);
    expect(await clearVisit(done, reception)).toEqual({ ok: false, reason: "closed" });
    expect(await clearVisit(999_999, reception)).toEqual({ ok: false, reason: "not_found" });
  });

  it("the derived facts carry clearance, alerts, flags and today's intake; visits.status values are unchanged", async () => {
    const p = await patient({ alert: "سكري", flags: ["يحتاج مرافقًا"] });
    await q(`INSERT INTO patient_intake_forms (patient_id, answers) VALUES ($1, '{"conditions":[]}'::jsonb)`, [p]);
    const v = await arrive(p);
    await clearVisit(v, reception);
    const facts = (await listTodayVisitReadinessFacts()).find((row) => row.visitId === v);
    expect(facts).toMatchObject({
      patientId: p, status: "waiting", clearedBy: "reception1", medicalAlert: "سكري", flags: ["يحتاج مرافقًا"],
      history: null, deferred: false,
    });
    expect(facts?.intakeAt).not.toBeNull();
    expect((await patientVisitReadinessFacts(p))?.visitId).toBe(v);
    const statuses = await q<{ status: string }>(`SELECT DISTINCT status FROM visits`);
    expect(statuses.every((row) => ["waiting", "called", "in_chair", "done"].includes(row.status))).toBe(true);
  });
});

describe("(CHAIR-1 Slice 3) ready-for-chair gate", () => {
  it("setting OFF (default): an uncleared call passes with a warning and no bypass row", async () => {
    const v = await arrive(await patient());
    const chair = nextChair();
    const called = await callVisitGated(v, chair, reception, noEmergency);
    expect(called).toMatchObject({ ok: true, bypassed: false, warning: expect.stringMatching(/لم تُقَرّ/) });
    expect((await visitRow(v)).status).toBe("called");
    expect((await trail(v)).map((row) => row.action)).toEqual(["visit.call"]);
  });

  it("a cleared visit is called and seated with no warning, setting on", async () => {
    await setGate(true);
    const v = await arrive(await patient());
    await clearVisit(v, reception);
    const chair = nextChair();
    expect(await callVisitGated(v, chair, reception, noEmergency)).toMatchObject({ ok: true, warning: null });
    expect(await seatVisitGated(v, chair, doctorActor, noEmergency)).toMatchObject({ ok: true, warning: null });
    expect((await visitRow(v)).status).toBe("in_chair");
  });

  it("setting ON: an uncleared call / direct seat is refused and leaves no trace", async () => {
    await setGate(true);
    const v = await arrive(await patient());
    const chair = nextChair();
    expect(await callVisitGated(v, chair, reception, noEmergency)).toMatchObject({ ok: false, reason: "gate", code: "clearance_required" });
    expect(await seatVisitGated(v, chair, reception, noEmergency)).toMatchObject({ ok: false, reason: "gate", code: "clearance_required" });
    expect(await callVisitGated(v, chair, reception, { requested: true, reason: null }))
      .toMatchObject({ ok: false, reason: "gate", code: "emergency_reason_required" });
    const row = await visitRow(v);
    expect({ status: row.status, chair: row.chair }).toEqual({ status: "waiting", chair: null });
    expect(await trail(v)).toEqual([]);
  });

  it("setting ON: an emergency with a reason bypasses — the move and the bypass are audited together", async () => {
    await setGate(true);
    const v = await arrive(await patient());
    const chair = nextChair();
    const seated = await seatVisitGated(v, chair, doctorActor, { requested: true, reason: "نزيف بعد خلع" });
    expect(seated).toMatchObject({ ok: true, bypassed: true });
    expect((await visitRow(v)).status).toBe("in_chair");
    expect(await trail(v)).toEqual([
      { action: "visit.seat", actor: "dr.aqlan", details: { من: "waiting", إلى: "in_chair", الكرسي: chair } },
      { action: "visit.clearance_bypass", actor: "dr.aqlan", details: { الحركة: "إدخال إلى الكرسي", الكرسي: chair, السبب: "نزيف بعد خلع" } },
    ]);
  });

  it("setting ON: seating a patient already called (by emergency) is not refused a second time", async () => {
    await setGate(true);
    const v = await arrive(await patient());
    const chair = nextChair();
    expect(await callVisitGated(v, chair, reception, { requested: true, reason: "ألم حاد" })).toMatchObject({ ok: true, bypassed: true });
    expect(await seatVisitGated(v, chair, doctorActor, noEmergency)).toMatchObject({ ok: true, bypassed: false });
    expect((await trail(v)).map((row) => row.action)).toEqual(["visit.call", "visit.clearance_bypass", "visit.seat"]);
  });

  it("the chair guard still wins: a busy chair is a conflict, not a gate refusal", async () => {
    const chair = nextChair();
    const first = await arrive(await patient());
    const second = await arrive(await patient());
    expect((await seatVisitGated(first, chair, reception, noEmergency)).ok).toBe(true);
    expect(await seatVisitGated(second, chair, reception, noEmergency)).toEqual({ ok: false, reason: "conflict" });
  });
});

describe("(CHAIR-1 Slice 2) balance information at arrival", () => {
  it("dues per currency come from the canonical engine; a prepayment stays credit (not revenue)", async () => {
    const p = await patient();
    const v = await arrive(p);
    await signWithFilling(v);
    expect((await patientDuesByCurrency([p])).get(p)).toEqual([{ currency: "YER", dueMinor: 15000 }]);

    const credit = await patient();
    await recordPayment({
      patientId: credit, invoiceId: null, kind: "payment", amountMinor: 5000, currency: "YER", exchangeRate: 1,
      baseCurrency: "YER", method: "cash", note: "مقدّم", createdBy: "cashier",
    });
    expect((await patientDuesByCurrency([credit])).get(credit)).toBeUndefined();
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [credit])).toEqual([]);
  });

});

