/** 0137 upgrade and fresh create on synthetic databases: an existing database at 0126 with a historical completed
 * analysis upgrades additively; the historical study stays unversioned and editable as before; re-running is a
 * no-op; a fresh database gets the table and every trigger. No published migration is modified. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { seedCanonicalCeph } from "../fixtures/canonical-ceph";
import { readCephProvenanceState } from "../../lib/ceph-provenance/capture";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
let upgrade: Pool, fresh: Pool;
beforeAll(async () => {
  upgrade = new Pool({ connectionString: await createIsolatedDatabase("aqlan_cpv_upgrade_synthetic"), max: 3 });
  fresh = new Pool({ connectionString: await createIsolatedDatabase("aqlan_cpv_fresh_synthetic"), max: 3 });
}, 120000);
afterAll(async () => { await upgrade?.end(); await fresh?.end(); });
const TRIGGERS = ["ceph_completion_provenance_immutable", "ceph_completion_provenance_no_truncate", "ceph_witnessed_analysis_immutable",
  "ceph_witnessed_landmarks_immutable", "ceph_witnessed_measurements_immutable", "ceph_witnessed_diagnoses_immutable",
  "ceph_completion_provenance_final_state", "ceph_analysis_provenance_final_state"];
const triggers = async (p: Pool) => (await p.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1) ORDER BY tgname", [TRIGGERS])).rows.map((r) => r.tgname);

it("upgrades a 0126 database with a historical completion additively", async () => {
  const files = await loadMigrationFiles();
  expect(files.at(-1)?.version).toBe("0137");
  await migrate(upgrade, { apply: true, files: files.filter((f) => f.version !== "0137") });
  expect((await upgrade.query("SELECT to_regclass('public.ceph_completion_provenance')::text AS t")).rows[0].t).toBeNull();
  const patientId = (await upgrade.query("INSERT INTO patients(patient_number,full_name) VALUES('CPV-UP','Synthetic upgrade') RETURNING id")).rows[0].id;
  const historical = await seedCanonicalCeph(upgrade, { patientId, status: "completed" });
  const before = (await upgrade.query("SELECT to_jsonb(a) AS a FROM ceph_analyses a WHERE id=$1", [historical.id])).rows[0].a;
  await migrate(upgrade, { apply: true, files });
  expect((await upgrade.query("SELECT version FROM schema_migrations WHERE version='0137'")).rows).toHaveLength(1);
  expect(await triggers(upgrade)).toEqual([...TRIGGERS].sort());
  expect((await upgrade.query("SELECT to_jsonb(a) AS a FROM ceph_analyses a WHERE id=$1", [historical.id])).rows[0].a).toEqual(before);
  expect(await readCephProvenanceState(upgrade, historical.id)).toEqual({ state: "unversioned" });
  expect((await upgrade.query("SELECT count(*)::int n FROM ceph_completion_provenance")).rows[0].n).toBe(0);
  // Historical (unwitnessed) studies keep their previous behaviour.
  await upgrade.query("UPDATE ceph_analyses SET note='SYN historical note' WHERE id=$1", [historical.id]);
  // Re-running is a no-op.
  const rows = (await upgrade.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
  await migrate(upgrade, { apply: true, files });
  expect((await upgrade.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n).toBe(rows);
});

it("creates the table and every trigger on a fresh database", async () => {
  await migrate(fresh, { apply: true, files: await loadMigrationFiles() });
  expect(await triggers(fresh)).toEqual([...TRIGGERS].sort());
  const cols = (await fresh.query("SELECT column_name FROM information_schema.columns WHERE table_name='ceph_completion_provenance' ORDER BY ordinal_position")).rows.map((r) => r.column_name);
  expect(cols).toEqual(["analysis_id", "schema_version", "witness", "witness_sha256", "approved_draft_version", "actor_user_id", "sealed_by", "sealed_at"]);
});
