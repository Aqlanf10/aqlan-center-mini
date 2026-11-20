import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { parsePublicDisplayFeed } from "../../lib/display-feed";
import { projectWaitingRoomDisplay } from "../../lib/waiting-room";

assertRealPostgresUrl();
stubPostgresEnv();
const {
  addVisit, callVisitAgain, callVisitGated, currentPublicDisplayCallWith, ensureSchema, getPool,
  getSettingsWith, resetPoolForTesting, returnVisitToWaiting, seatVisitGated, writeSettingsInTransaction,
} = await import("../../lib/db");
const actor = { actor: "synthetic-reception", actorRole: "reception" }, noEmergency = { requested: false, reason: null };
const cfg = "clinic.chairs";
const waiting = async (patientName: string) => (await addVisit({ patientName, patientPhone: null, note: null })).id;
const state = async (id: number) => (await getPool().query("SELECT status,chair,called_at FROM visits WHERE id=$1", [id])).rows[0];
const audits = async (id: number) => (await getPool().query("SELECT action FROM audit_log WHERE entity='visit' AND entity_id=$1 ORDER BY id", [String(id)])).rows.map(r => r.action);
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  // Explicitly test the implicit default (no row) in this owned database.
  await getPool().query("DELETE FROM settings WHERE key=$1", [cfg]);
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

it("rejects unconfigured globally valid room and over-maximum without status, destination or audit mutation; default room 2 still works", async () => {
  expect((await getPool().query("SELECT key FROM settings WHERE key=$1", [cfg])).rowCount).toBe(0);
  const id = await waiting("مريض الغرفة الافتراضية الاصطناعي");
  expect(await callVisitGated(id, 3, actor, noEmergency)).toEqual({ ok: false, reason: "invalid-chair" });
  expect(await seatVisitGated(id, 21, actor, noEmergency)).toEqual({ ok: false, reason: "invalid-chair" });
  expect(await state(id)).toEqual({ status: "waiting", chair: null, called_at: null });
  expect(await audits(id)).not.toContain("visit.call");
  expect(await audits(id)).not.toContain("visit.seat");
  expect(await callVisitGated(id, 2, actor, noEmergency)).toMatchObject({ ok: true, visit: { chair: 2, status: "called" } });
  expect(await returnVisitToWaiting(id, actor)).toMatchObject({ id, status: "waiting", chair: null });
});

it("serializes a real move with the first configured-chair settings insert; validates freshly after commit", async () => {
  const id = await waiting("مريض انتظار تهيئة الاصطناعي");
  const writer = await getPool().connect();
  let move: ReturnType<typeof callVisitGated> | undefined;
  try {
    await writer.query("BEGIN");
    const { rows: [{ pid }] } = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    expect(await writeSettingsInTransaction(writer, { values: { [cfg]: "4" }, expected: { [cfg]: null } })).toMatchObject({ ok: true });
    move = callVisitGated(id, 4, actor, noEmergency);
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      const { rows: [row] } = await getPool().query<{ blocked: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked", [pid]);
      blocked = row.blocked;
      if (!blocked) await delay(10);
    }
    expect(blocked).toBe(true);
    expect(await state(id)).toMatchObject({ status: "waiting", chair: null });
    await writer.query("COMMIT");
    expect(await move).toMatchObject({ ok: true, visit: { chair: 4, status: "called" } });
    expect(await returnVisitToWaiting(id, actor)).toMatchObject({ id, status: "waiting", chair: null });
  } finally { await writer.query("ROLLBACK").finally(() => writer.release()); await move; }
});

it("room count reduction suppresses only the latest over-range call, keeps editorial output, and lets staff return/reassign safely", async () => {
  const old = await waiting("زيارة أقدم اصطناعية"), latest = await waiting("زيارة أحدث اصطناعية");
  const pool = getPool(), c = await pool.connect();
  try {
    expect(await callVisitGated(old, 1, actor, noEmergency)).toMatchObject({ ok: true });
    expect(await callVisitGated(latest, 4, actor, noEmergency)).toMatchObject({ ok: true });
    await c.query("BEGIN");
    expect(await writeSettingsInTransaction(c, { values: { [cfg]: "2" } })).toMatchObject({ ok: true });
    await c.query("COMMIT");
    const before = await state(latest), trail = await audits(latest);
    expect(await callVisitAgain(latest, actor)).toBeNull();
    expect(await state(latest)).toEqual(before); expect(await audits(latest)).toEqual(trail);
    const latestPublic = await currentPublicDisplayCallWith(c);
    expect(latestPublic).toMatchObject([{ chair: 4 }]);
    const notice = { title: "إعلان اصطناعي", body: "بيان عام اصطناعي" };
    const feed = parsePublicDisplayFeed(projectWaitingRoomDisplay({
      now: new Date(), calls: latestPublic, settings: await getSettingsWith(c), announcements: [notice],
    }));
    expect(feed.called).toEqual([]); expect(feed.announcements).toEqual([notice]);
    expect(await returnVisitToWaiting(latest, actor)).toMatchObject({ status: "waiting", chair: null });
    expect(await callVisitGated(latest, 2, actor, noEmergency)).toMatchObject({ ok: true, visit: { chair: 2 } });
  } finally { await c.query("ROLLBACK").finally(() => c.release()); }
});
