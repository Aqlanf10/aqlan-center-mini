import { historicalTanakaPayload } from "../fixtures/ortho-assessment-historical-tanaka";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { loadMigrationFiles } from "../../lib/migration-files";
import { migrate } from "../../lib/migrations";
import { ORTHO_ASSESSMENT_VERIFIER_2_2_SQL } from "../../lib/ortho-assessment-verifier-schema";
import { createPersistedAssessmentV2, assessmentJsonHash, type PersistedAssessmentContentV2 } from "../../lib/ortho-assessment-persisted-v2";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import { tanakaCommandV2 } from "../fixtures/ortho-assessment-tanaka";

describe("0106 forward assessment verifier admission", () => {
  it("matches its runtime SQL and preserves all historical payload bytes through repeated upgrade", async () => {
    expect(await readFile("migrations/0106_ortho_assessment_verifier_2_2.sql", "utf8")).toBe(ORTHO_ASSESSMENT_VERIFIER_2_2_SQL);
    const f = await openPeriodontalFixture(process.env, { pristine: true });
    try {
      const files = (await loadMigrationFiles()).filter(file => file.version <= "0106"); await migrate(f.pool, { apply: true, files: files.filter(file => file.version < "0106") });
      const patient = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-0106','Synthetic verifier upgrade') RETURNING id")).rows[0].id;
      const user = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic0106','Synthetic examiner','synthetic hash','admin') RETURNING id")).rows[0].id;
      const ortho = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,phase,appliance,arches,slot,start_date,planned_months,created_by) VALUES($1,'active','alignment','fixed','both','022','2026-01-01',24,'synthetic') RETURNING id", [patient])).rows[0].id;
      const clinical = (await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic bridge',$2,'synthetic') RETURNING id", [patient, ortho])).rows[0].id;
      const old = createPersistedAssessmentV2(assessmentCommandV2().content), current = { ok: true as const, value: historicalTanakaPayload(tanakaCommandV2().content) };
      if (!old.ok || !current.ok) throw Error("invalid fixture");
      const insert = async (content: PersistedAssessmentContentV2, version: number, predecessor: number | null) => (await f.pool.query(`INSERT INTO ortho_assessment_revisions
        (patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,schema_version,version,supersedes_revision_id,actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,content_sha256,content)
        VALUES($1,$1,$2,$3,2,$4,$5,$6,'Synthetic examiner','Synthetic upgrade','current',$7,$8,$9,$10::jsonb) RETURNING id`,
      [patient, ortho, clinical, version, predecessor, user, randomUUID(), "a".repeat(64), assessmentJsonHash(content), JSON.stringify(content)])).rows[0].id as number;
      const oldId = await insert(old.value, 1, null);
      const snapshot = async () => (await f.pool.query("SELECT to_jsonb(r)::text AS facts FROM ortho_assessment_revisions r WHERE id=$1", [oldId])).rows;
      const before = await snapshot();
      await expect(insert(current.value, 2, oldId)).rejects.toThrow("Assessment payload version mismatch");
      expect((await migrate(f.pool, { apply: true, files })).appliedVersions).toEqual(["0106"]);
      expect(await snapshot()).toEqual(before);
      const currentId = await insert(current.value, 2, oldId);
      await expect(insert({ ...current.value, verifierVersion: "ortho-assessment-payload-2.1.0" }, 3, currentId))
        .rejects.toThrow("Assessment method requires payload verifier2.2.0");
      await expect(insert({ ...current.value, verifierVersion: null } as unknown as PersistedAssessmentContentV2, 3, currentId))
        .rejects.toThrow("Assessment payload version mismatch");
      await expect(f.pool.query("UPDATE ortho_assessment_revisions SET reason='overwrite' WHERE id=$1", [oldId])).rejects.toThrow("append-only");
      expect((await migrate(f.pool, { apply: true, files })).appliedVersions).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect((await f.pool.query("SELECT count(*)::int n FROM ortho_assessment_revisions")).rows).toEqual([{ n: 2 }]);
      expect((await f.pool.query("SELECT adopted FROM schema_migrations WHERE version='0106'")).rows).toEqual([{ adopted: false }]);
    } finally { await f.close(); }
  });
});
