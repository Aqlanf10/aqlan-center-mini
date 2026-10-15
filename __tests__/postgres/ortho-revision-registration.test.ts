import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import runtime from "../../lib/ortho-assessment-runtime.generated.json";
import { applyOrthoAssessmentRuntime } from "../../lib/ortho-assessment-runtime";

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let files: Awaited<ReturnType<typeof loadMigrationFiles>>;
beforeEach(async () => {
  fixture = await openBackupTimestampFixture(process.env);
  files = await loadMigrationFiles();
  await migrate(fixture.source, { apply: true, files: files.filter(file => !["0051", "0052"].includes(file.version)) });
});
afterEach(async () => { await fixture?.close(); });
const registry = async () => (await fixture.source.query("SELECT version,name,checksum,adopted FROM schema_migrations ORDER BY version")).rows;

describe("0051/0052 registration on a real fresh main/HR/finance predecessor", () => {
  it("serializes runtime startup and then admits the exact CLI union without another application", async () => {
    const competitor = new Pool({ connectionString: fixture.source.options.connectionString!, ssl: false });
    let results: string[][];
    try { results = await Promise.all([applyOrthoAssessmentRuntime(fixture.source), applyOrthoAssessmentRuntime(competitor)]); }
    finally { await competitor.end(); }
    expect(results.map(result => result.length).sort()).toEqual([0, 2]);
    const before = await registry();
    expect(before.filter(row => ["0051", "0052"].includes(row.version))).toEqual(runtime.map(file => ({ version: file.version, name: file.name, checksum: file.checksum, adopted: false })));
    expect(await migrate(fixture.source, { apply: true, files })).toMatchObject({ appliedVersions: [], alreadyUpToDate: true });
    expect(await registry()).toEqual(before);
  });

  it("serializes a real CLI/runtime race on separate connections without duplicate registration", async () => {
    const competitor = new Pool({ connectionString: fixture.source.options.connectionString!, ssl: false });
    try {
      const [runtimeResult, cli] = await Promise.all([applyOrthoAssessmentRuntime(fixture.source), migrate(competitor, { apply: true, files })]);
      expect([...runtimeResult, ...cli.appliedVersions].sort()).toEqual(["0051", "0052"]);
      expect((await registry()).map(row => row.version)).toEqual(files.map(file => file.version));
      expect(await applyOrthoAssessmentRuntime(competitor)).toEqual([]);
    } finally { await competitor.end(); }
  });

  it.each(["runtime", "cli"])("refuses an unregistered legacy table through %s without adopting or replacing it", async mode => {
    await fixture.source.query("CREATE TABLE ortho_strategy_revisions(id INTEGER PRIMARY KEY, legacy_marker TEXT)");
    await fixture.source.query("INSERT INTO ortho_strategy_revisions VALUES(7,'preserve exact legacy object')");
    const before = await registry();
    const execute = mode === "runtime" ? applyOrthoAssessmentRuntime(fixture.source) : migrate(fixture.source, { apply: true, files });
    await expect(execute).rejects.toThrow("ORTHO_UNREGISTERED_OBJECT_COLLISION");
    expect((await fixture.source.query("SELECT * FROM ortho_strategy_revisions")).rows).toEqual([{ id: 7, legacy_marker: "preserve exact legacy object" }]);
    expect(await registry()).toEqual(before);
  });

  it.each(["runtime", "cli"])("refuses an orphan legacy routine through %s rather than replacing its body", async mode => {
    await fixture.source.query("CREATE FUNCTION reject_ortho_assessment_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic old routine'; END $$");
    const definition = async () => (await fixture.source.query("SELECT pg_get_functiondef('reject_ortho_assessment_revision_mutation()'::regprocedure) definition")).rows;
    const before = await definition();
    await expect(mode === "runtime" ? applyOrthoAssessmentRuntime(fixture.source) : migrate(fixture.source, { apply: true, files })).rejects.toThrow("ORTHO_UNREGISTERED_OBJECT_COLLISION");
    expect(await definition()).toEqual(before);
    expect((await registry()).some(row => row.version === "0052")).toBe(false);
  });

  it.each(["runtime", "cli"].flatMap(mode => ["name", "checksum", "adopted"].map(field => ({ mode, field }))))("refuses conflicting registered $field through $mode without changes", async ({ mode, field }) => {
    await fixture.source.query("INSERT INTO schema_migrations(version,name,checksum,adopted) VALUES('0051',$1,$2,$3)",
      [field === "name" ? "wrong_contract" : runtime[0].name, field === "checksum" ? "0".repeat(64) : runtime[0].checksum, field === "adopted"]);
    const before = await registry();
    await expect(mode === "runtime" ? applyOrthoAssessmentRuntime(fixture.source) : migrate(fixture.source, { apply: true, files })).rejects.toThrow(/MIGRATION_REGISTRY_MISMATCH/);
    expect(await registry()).toEqual(before);
    expect((await fixture.source.query("SELECT to_regclass('public.ortho_strategy_revisions') object")).rows[0].object).toBeNull();
    expect((await fixture.source.query("SELECT to_regclass('public.ortho_assessment_revisions') object")).rows[0].object).toBeNull();
  });

  it.each(["runtime", "cli"])("refuses missing registry ownership through %s even for exact legacy SQL objects", async mode => {
    await applyOrthoAssessmentRuntime(fixture.source);
    await fixture.source.query("DELETE FROM schema_migrations WHERE version='0052'");
    const before = await registry();
    const definitions = async () => (await fixture.source.query("SELECT pg_get_functiondef('check_ortho_assessment_revision_final_state()'::regprocedure) definition")).rows;
    const original = await definitions();
    await expect(mode === "runtime" ? applyOrthoAssessmentRuntime(fixture.source) : migrate(fixture.source, { apply: true, files })).rejects.toThrow("ORTHO_UNREGISTERED_OBJECT_COLLISION");
    expect(await registry()).toEqual(before); expect(await definitions()).toEqual(original);
    expect((await fixture.source.query("SELECT COUNT(*)::int count FROM ortho_assessment_revisions")).rows[0].count).toBe(0);
  });

  it.each(["runtime", "cli"])("rolls back rejected %s DDL with its registry row and safely retries the same exact file", async mode => {
    await fixture.source.query(`CREATE FUNCTION synthetic_reject_ortho_ddl() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN IF EXISTS(SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE object_identity='public.ortho_assessment_revisions')
        THEN RAISE EXCEPTION 'synthetic assessment DDL rejection'; END IF; END $$`);
    await fixture.source.query("CREATE EVENT TRIGGER synthetic_reject_ortho_ddl ON ddl_command_end EXECUTE FUNCTION synthetic_reject_ortho_ddl()");
    const execute = () => mode === "runtime" ? applyOrthoAssessmentRuntime(fixture.source) : migrate(fixture.source, { apply: true, files });
    try { await expect(execute()).rejects.toThrow("synthetic assessment DDL rejection"); }
    finally { await fixture.source.query("DROP EVENT TRIGGER synthetic_reject_ortho_ddl"); await fixture.source.query("DROP FUNCTION synthetic_reject_ortho_ddl()"); }
    expect((await registry()).filter(row => ["0051", "0052"].includes(row.version)).map(row => row.version)).toEqual(["0051"]);
    expect((await fixture.source.query("SELECT to_regclass('public.ortho_assessment_revisions') object")).rows[0].object).toBeNull();
    const retried = await execute();
    expect(mode === "runtime" ? retried : (retried as Awaited<ReturnType<typeof migrate>>).appliedVersions).toEqual(["0052"]);
    expect((await registry()).filter(row => ["0051", "0052"].includes(row.version)).map(row => row.version)).toEqual(["0051", "0052"]);
  });
});
