import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  ensureSchema, getPool, resetPoolForTesting, openShift, addVisit, clearVisit, finishVisit,
  listTodayVisitReadinessFacts, patientVisitReadinessFacts,
} = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

const reception = { actor: "reception1", actorRole: "reception" };
const doctorActor = { actor: "dr.aqlan", actorRole: "doctor" };

let doctorId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  ({ id: doctorId } = (await q<{ id: number }>(
    `INSERT INTO parties (kind, name, commission_percent) VALUES ('doctor', 'د. الكرسي', 30) RETURNING id`))[0]);
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

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

