import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { loadMigrationFiles } from "../../lib/migration-files";
import { migrate } from "../../lib/migrations";
import { createPersistedAssessmentV2, assessmentJsonHash, type PersistedAssessmentContentV2 } from "../../lib/ortho-assessment-persisted-v2";
import { historicalTanakaPayload } from "../fixtures/ortho-assessment-historical-tanaka";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import { tanakaCommandV2 } from "../fixtures/ortho-assessment-tanaka";


describe("0110 Tanaka canonical decimal verifier upgrade", () => {
  it.each(["numbered", "runtime"] as const)("upgrades an already registered current chain through %s without downgrading on replay", async path => {
    const f = await openPeriodontalFixture(process.env, { pristine: true });
    let pool = f.pool;
    try {
      const files = await loadMigrationFiles();
      const base = files.filter(file => !["0106", "0110"].includes(file.version));
      await migrate(pool, { apply: true, files: base });
      const registry = async () => (await pool.query("SELECT version,name,checksum,adopted FROM schema_migrations WHERE version NOT IN ('0106','0110') ORDER BY version")).rows;
      const before = await registry();
      expect(before.at(-1).version).toBe(base.at(-1)!.version);
      const definition = async () => (await pool.query("SELECT pg_get_functiondef('check_ortho_assessment_revision_final_state()'::regprocedure) AS body")).rows[0].body as string;
      expect(await definition()).not.toContain("ortho-assessment-payload-2.2.1");
      if (path === "numbered")
        expect((await migrate(pool, { apply: true, files })).appliedVersions).toEqual(["0106", "0110"]);
      else
        await f.db.ensureSchema();
      const upgraded = await definition();
      expect(upgraded).toContain("ortho-assessment-payload-2.2.1");
      expect(await registry()).toEqual(before);
      expect((await pool.query("SELECT version,adopted FROM schema_migrations WHERE version IN ('0106','0110') ORDER BY version")).rows)
        .toEqual([{ version: "0106", adopted: false }, { version: "0110", adopted: false }]);
      await f.db.resetPoolForTesting();
      await f.db.ensureSchema();
      pool = f.db.getPool();
      expect((await migrate(pool, { apply: true, files })).appliedVersions).toEqual([]);
      expect(await definition()).toBe(upgraded);
      expect(await registry()).toEqual(before);
    } finally { await f.close(); }
  });

  it("preserves both historical verifiers, gates new payloads and remains append-only and idempotent", async () => {
    const { ORTHO_ASSESSMENT_VERIFIER_2_2_1_SQL } = await import("../../lib/ortho-assessment-verifier-2_2_1-schema");
    expect(await readFile("migrations/0110_ortho_assessment_verifier_2_2_1.sql", "utf8")).toBe(ORTHO_ASSESSMENT_VERIFIER_2_2_1_SQL);
    const f = await openPeriodontalFixture(process.env, { pristine: true });
    try {
      const files = (await loadMigrationFiles()).filter(file => file.version <= "0110");
      await migrate(f.pool, { apply: true, files: files.filter(file => file.version < "0110") });
      const patient = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-0110','Synthetic boundary upgrade') RETURNING id")).rows[0].id;
      const user = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic0110','Synthetic examiner','synthetic hash','admin') RETURNING id")).rows[0].id;
      const ortho = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,appliance,arches,slot,start_date,planned_months,created_by) VALUES($1,'assessment','assessment',NULL,NULL,NULL,NULL,NULL,'synthetic') RETURNING id", [patient])).rows[0].id;
      const clinical = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic') RETURNING id", [patient, ortho])).rows[0].id;
      const old = createPersistedAssessmentV2(assessmentCommandV2().content);
      const command = tanakaCommandV2();
      [4,4.06,5.97,6.47].forEach((value, i) => { command.content.observations.observations.find(r => r.id === `width_${[31,32,41,42][i]}`)!.value = { state: "measured", value }; });
      const current = createPersistedAssessmentV2(command.content);
      if (!old.ok || !current.ok) throw Error("invalid fixture");
      expect(current.value.verifierVersion).toBe("ortho-assessment-payload-2.2.1");
      expect(current.value.results.every(r => r.result.state === "ready")).toBe(true);
      const insert = async (content: PersistedAssessmentContentV2, version: number, predecessor: number | null) => (await f.pool.query(`INSERT INTO ortho_assessment_revisions
        (patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,schema_version,version,supersedes_revision_id,actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,content_sha256,content)
        VALUES($1,$1,$2,$3,2,$4,$5,$6,'Synthetic examiner','Synthetic upgrade','current',$7,$8,$9,$10::jsonb) RETURNING id`,
      [patient, ortho, clinical, version, predecessor, user, randomUUID(), "a".repeat(64), assessmentJsonHash(content), JSON.stringify(content)])).rows[0].id as number;
      const oldId = await insert(old.value, 1, null), frozenId = await insert(historicalTanakaPayload(tanakaCommandV2().content), 2, oldId);
      const snapshot = async () => (await f.pool.query("SELECT to_jsonb(r)::text AS facts FROM ortho_assessment_revisions r WHERE id=ANY($1::int[]) ORDER BY version", [[oldId, frozenId]])).rows;
      const before = await snapshot();
      await expect(insert(current.value, 3, frozenId)).rejects.toThrow("Assessment payload version mismatch");
      expect((await migrate(f.pool, { apply: true, files })).appliedVersions).toContain("0110");
      expect(await snapshot()).toEqual(before);
      const currentId = await insert(current.value, 3, frozenId);
      for (const verifierVersion of ["ortho-assessment-payload-2.1.0", "ortho-assessment-payload-2.2.0", null, undefined]) {
        await expect(insert({ ...current.value, verifierVersion } as PersistedAssessmentContentV2, 4, currentId)).rejects.toThrow();
      }
      for (const witness of [undefined, null, {}, { formula: {}, reference: {}, result: {} }]) {
        const malformed = structuredClone(current.value);
        const result = malformed.results[0].result as unknown as Record<string, unknown>;
        if (witness === undefined) delete result.witness;
        else result.witness = witness;
        await expect(insert(malformed, 4, currentId)).rejects.toThrow("Assessment Tanaka witness verifier mismatch");
      }
      for (const draft of [tanakaCommandV2().content, command.content]) {
        // A verifier upgrade cannot relabel either an old ready witness or its
        // old outside-domain policy, even when each result hash is intact.
        const frozen = historicalTanakaPayload(draft);
        await expect(insert({ ...frozen, verifierVersion: "ortho-assessment-payload-2.2.1" }, 4, currentId)).rejects.toThrow();
      }
      await expect(f.pool.query("UPDATE ortho_assessment_revisions SET reason='overwrite' WHERE id=$1", [oldId])).rejects.toThrow("append-only");
      await expect(f.pool.query("DELETE FROM ortho_assessment_revisions WHERE id=$1", [currentId])).rejects.toThrow("append-only");
      expect((await migrate(f.pool, { apply: true, files })).appliedVersions).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect((await f.pool.query("SELECT count(*)::int n FROM ortho_assessment_revisions")).rows).toEqual([{ n: 3 }]);
      expect((await f.pool.query("SELECT adopted FROM schema_migrations WHERE version='0110'")).rows).toEqual([{ adopted: false }]);
    } finally { await f.close(); }
  });
});
