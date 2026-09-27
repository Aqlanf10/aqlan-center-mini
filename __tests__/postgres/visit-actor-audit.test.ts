import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (LIVE-3) من نادى المريض؟ من أعاد النداء؟ من أجلسه؟ من أعاده للانتظار؟ من أنهى التشغيل؟
 *
 * كانت حركات الطابور تُنفَّذ بلا فاعل: الجلسة تُقرأ في المسار ثم لا تصل إلى القاعدة، فلا
 * جواب لأيٍّ من الأسئلة أعلاه. الآن كل حركة تكتب سطر تدقيقٍ **في معاملتها نفسها**: الفاعل
 * ودوره، والحالة قبل وبعد، والكرسي — والحركة المرفوضة (409) لا تترك سطرًا.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  addVisit, callVisit, callVisitAgain, seatVisit, returnVisitToWaiting, finishVisit,
  ensureSchema, getPool, resetPoolForTesting,
} = await import("../../lib/db");

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

const reception = { actor: "reception1", actorRole: "reception" };
const doctor = { actor: "dr.aqlan", actorRole: "doctor" };

let seq = 0;
async function waitingVisit(): Promise<number> {
  seq += 1;
  return (await addVisit({ patientName: `مريض التدقيق ${seq}`, patientPhone: null, note: null })).id;
}

async function trail(visitId: number) {
  const { rows } = await getPool().query<{
    action: string; actor: string; actor_role: string | null; details: Record<string, unknown>;
  }>(
    `SELECT action, actor, actor_role, details FROM audit_log
      WHERE entity = 'visit' AND entity_id = $1 ORDER BY id`,
    [String(visitId)],
  );
  return rows.map((row) => ({ action: row.action, actor: row.actor, role: row.actor_role, ...row.details }));
}

describe("(LIVE-3) visit queue transitions record who did them", () => {
  it("call → call again → return → call → seat → finish: each step names its actor, role, from/to status and chair", async () => {
    const id = await waitingVisit();
    expect(await callVisit(id, 1, reception)).not.toBeNull();
    expect(await callVisitAgain(id, reception)).not.toBeNull();
    expect(await returnVisitToWaiting(id, reception)).not.toBeNull();
    expect(await callVisit(id, 2, reception)).not.toBeNull();
    expect(await seatVisit(id, 2, doctor)).not.toBeNull();
    expect(await finishVisit(id, doctor)).not.toBeNull();

    expect(await trail(id)).toEqual([
      { action: "visit.call", actor: "reception1", role: "reception", من: "waiting", إلى: "called", الكرسي: 1 },
      { action: "visit.call_again", actor: "reception1", role: "reception", من: "called", إلى: "called", الكرسي: 1 },
      { action: "visit.return_to_waiting", actor: "reception1", role: "reception", من: "called", إلى: "waiting", الكرسي: 1 },
      { action: "visit.call", actor: "reception1", role: "reception", من: "waiting", إلى: "called", الكرسي: 2 },
      { action: "visit.seat", actor: "dr.aqlan", role: "doctor", من: "called", إلى: "in_chair", الكرسي: 2 },
      { action: "visit.finish", actor: "dr.aqlan", role: "doctor", من: "in_chair", إلى: "done", الكرسي: 2 },
    ]);
  });

  it("seating straight from waiting records «waiting → in_chair»", async () => {
    const id = await waitingVisit();
    await seatVisit(id, 3, reception);
    expect(await trail(id)).toEqual([
      { action: "visit.seat", actor: "reception1", role: "reception", من: "waiting", إلى: "in_chair", الكرسي: 3 },
    ]);
  });

  it("a refused transition (409 in the route) writes no audit row", async () => {
    const occupant = await waitingVisit();
    const other = await waitingVisit();
    await seatVisit(occupant, 4, reception);
    expect(await seatVisit(other, 4, doctor)).toBeNull();         // الكرسي مشغول
    expect(await callVisitAgain(other, reception)).toBeNull();     // لا نداء قائم
    expect(await returnVisitToWaiting(other, reception)).toBeNull(); // ليس في حالة نداء
    await finishVisit(occupant, doctor);
    expect(await finishVisit(occupant, doctor)).toBeNull();        // منتهية بالفعل
    expect(await trail(other)).toEqual([]);
    expect((await trail(occupant)).map((row) => row.action)).toEqual(["visit.seat", "visit.finish"]);
  });

  it("the transition and its audit row commit together: if the audit write fails, the status does not change", async () => {
    const id = await waitingVisit();
    const pool = getPool();
    await pool.query(`CREATE OR REPLACE FUNCTION live3_fail_audit() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'audit unavailable'; END; $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER live3_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION live3_fail_audit()`);
    try {
      await expect(callVisit(id, 5, reception)).rejects.toThrow();
    } finally {
      await pool.query(`DROP TRIGGER live3_fail_audit ON audit_log`);
    }
    const { rows: [visit] } = await pool.query<{ status: string; chair: number | null }>(
      `SELECT status, chair FROM visits WHERE id = $1`, [id]);
    expect(visit).toEqual({ status: "waiting", chair: null });
    // وبعد عودة السجل تمضي الحركة ويُسجَّل فاعلها.
    expect(await callVisit(id, 5, reception)).not.toBeNull();
    expect((await trail(id)).map((row) => row.action)).toEqual(["visit.call"]);
  });
});
