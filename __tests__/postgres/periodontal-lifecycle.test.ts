import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPeriodontalDomain } from "../../lib/periodontal-db";
import { emptyPeriodontalSites } from "../../lib/periodontal";
import { openPeriodontalFixture } from "./_periodontal-fixture";

// CI-only synthetic data. Complements the sequential merge in the foundation
// suite with a witnessed real save/merge lock race; no runtime registration.
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>> | undefined;
const ACTOR = "synthetic-periodontal-lifecycle";
const pool = () => fixture!.pool;
const command = (requestKey: string, toothCode: number, expectedHeadId: number | null = null) => {
  const sites = emptyPeriodontalSites();
  sites[0].depthMm = "0.00000000000001";
  sites[1].depthMm = "0"; sites[1].bleeding = false; sites[2].bleeding = true;
  return { requestKey, toothCode, expectedHeadId, sites };
};
const domain = () => createPeriodontalDomain({ pool: pool(),
  authorizePatient: async () => ({ username: ACTOR, role: "admin" }),
  insertAudit: (client, input) => fixture!.db.insertAuditRow(client, input) });
async function state() {
  return {
    records: (await pool().query(`SELECT r.*, recorded_at::text AS recorded_at FROM periodontal_records r ORDER BY id`)).rows,
    sites: (await pool().query("SELECT *, depth_mm::text AS depth_mm FROM periodontal_sites ORDER BY record_id,surface,position")).rows,
    audits: (await pool().query(`SELECT a.*, created_at::text AS created_at FROM audit_log a
      WHERE action='perio.record' ORDER BY id`)).rows,
  };
}
const observed = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
function unwrap<T>(result: { value: T } | { error: unknown }): T {
  if ("error" in result) throw result.error;
  return result.value;
}

beforeAll(async () => { fixture = await openPeriodontalFixture(); }, 180_000);
afterAll(async () => { await fixture?.close(); }, 30_000);

describe("inactive periodontal lifecycle on owned PostgreSQL", () => {
  it("a canonical merge waits for an admitted save and moves the committed history intact", async () => {
    const { rows: patients } = await pool().query<{ id: number }>(`INSERT INTO patients (patient_number,full_name)
      VALUES ('SYN-PERIO-RACE-A','Synthetic race A'),('SYN-PERIO-RACE-B','Synthetic race B') RETURNING id`);
    const source = patients[0].id, target = patients[1].id;
    const original = command("perio:race-first", 16);
    const first = await domain().save(source, original);
    if (!first.ok) throw new Error(first.message);
    const other = await domain().save(target, command("perio:race-target", 17));
    if (!other.ok) throw new Error(other.message);
    const before = await state();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const admission = new Promise<void>((resolve) => { entered = resolve; });
    let savePid: number | undefined;
    const saving = createPeriodontalDomain({ pool: pool(),
      authorizePatient: async (client) => {
        savePid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await client.query("SET LOCAL statement_timeout='8s'");
        entered(); await gate;
        return { username: ACTOR, role: "admin" };
      },
      insertAudit: (client, input) => fixture!.db.insertAuditRow(client, input),
    });
    const correction = command("perio:race-correction", 16, first.record.id);
    correction.sites[0].depthMm = "99999999999999.9";
    const save = observed(saving.save(source, correction));
    type MergeResult = Awaited<ReturnType<NonNullable<typeof fixture>["db"]["mergeDuplicatePatient"]>>;
    let merge: ReturnType<typeof observed<MergeResult>> | undefined;
    try {
      // If save fails before admission, fail promptly instead of waiting forever.
      await Promise.race([admission, save.then((outcome) => { unwrap(outcome); throw new Error("Save did not reach admission gate."); })]);
      merge = observed(fixture!.db.mergeDuplicatePatient(source, target,
        { actor: ACTOR, actorRole: "admin", reason: "synthetic lock-race rehearsal" }));
      const deadline = performance.now() + 6_000;
      let witnessed = false;
      while (performance.now() < deadline) {
        const { rows: [row] } = await pool().query<{ waiting: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND $1::int = ANY(pg_blocking_pids(pid))
            AND query LIKE '%FROM patients WHERE id = ANY%FOR UPDATE%') AS waiting`, [savePid]);
        if (row.waiting) { witnessed = true; break; }
        await delay(10);
      }
      expect(witnessed).toBe(true);
      release();
      const saved = unwrap(await save);
      if (!saved.ok) throw new Error(saved.message);
      expect(unwrap(await merge)).toMatchObject({ ok: true, moved: { "periodontal_records.patient_id": 2 } });
      const after = await state();
      expect(after.records).toHaveLength(3);
      expect(after.sites).toHaveLength(18);
      expect(after.audits).toHaveLength(3);
      for (const row of before.records) {
        expect(after.records.find((record) => record.id === row.id)).toEqual({ ...row, patient_id: target });
      }
      expect(after.sites.filter((site) => site.record_id !== saved.record.id)).toEqual(before.sites);
      expect(after.audits.slice(0, 2)).toEqual(before.audits);
      expect(after.audits[2]).toMatchObject({ entity_id: String(source), actor: ACTOR,
        details: expect.objectContaining({ recordId: saved.record.id, priorRecordId: first.record.id }) });
      expect(after.records.find((record) => record.id === saved.record.id)).toMatchObject({
        patient_id: target, tooth_code: 16, prior_record_id: first.record.id, recorded_by: ACTOR,
      });
      const read = await domain().read(target, { toothCode: 16, beforeId: null });
      expect(read).toMatchObject({ ok: true, records: [
        { ...saved.record, patientId: target }, { ...first.record, patientId: target },
      ] });
      expect(await domain().save(source, correction)).toMatchObject({ reason: "not_found" });
      expect(await domain().save(target, correction)).toMatchObject({ reason: "request_conflict" });
      expect(await state()).toEqual(after);
    } finally {
      release(); await save; if (merge) await merge;
    }
  });
});
