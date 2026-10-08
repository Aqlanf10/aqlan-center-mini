import type { DbPool, DbClient } from "../../lib/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { legacyCoverageStateFromSnapshot } from "../../lib/legacy-treatment-coverage";
import { openPeriodontalFixture } from "./_periodontal-fixture";

/**
 * SOURCE-ONLY proposal, not executed. Reuses only the verified fresh-UUID ownership harness
 * in pristine mode: no periodontal schema/domain is applied and no pre-existing database reset.
 * Builds the actual0042 migration chain, records an old agreement, then applies additive0043.
 */
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>> | undefined;
const pool = () => fixture!.pool;
let sequence = 0;
type Agreement = { id: number; patient_id: number; service_id: number; tooth_code: number | null };
let old: Agreement;
let oldFacts: unknown;

async function seedAgreement(client: DbPool | DbClient, anchor: number | null = 15, category = "bridge"): Promise<Agreement> {
  const { rows: [patient] } = await client.query<{ id: number }>(
    "INSERT INTO patients (patient_number,full_name) VALUES ($1,'Synthetic coverage patient') RETURNING id", [`SYN-COVERAGE-${++sequence}`]);
  const { rows: [service] } = await client.query<{ id: number }>(
    "INSERT INTO services (name,category,price_minor) VALUES ('Synthetic coverage service',$1,300000) RETURNING id", [category]);
  const { rows: [plan] } = await client.query<{ id: number }>(
    "INSERT INTO treatment_plans (patient_id,title,total_minor) VALUES ($1,'Synthetic historical plan',300000) RETURNING id", [patient.id]);
  const { rows: [item] } = await client.query<{ id: number }>(
    "INSERT INTO plan_items (plan_id,service_id,service_name,category,tooth_code,unit_price_minor) VALUES ($1,$2,'Synthetic historical work',$3,$4,300000) RETURNING id",
    [plan.id, service.id, category, anchor]);
  const { rows: [agreement] } = await client.query<Agreement>(`INSERT INTO legacy_treatment_agreements
    (patient_id,plan_item_id,service_id,service_name,specialty,tooth_code,currency,agreed_minor,
     previously_paid_minor,remaining_minor,historical_as_of,opening_effect,created_by)
    VALUES ($1,$2,$3,'Synthetic historical service','prosthodontics',$4,'YER',300000,300000,0,'2020-01-01','none','synthetic-owner')
    RETURNING id,patient_id,service_id,tooth_code`, [patient.id, item.id, service.id, anchor]);
  return agreement;
}
const expected = (agreement: Agreement) => ({ agreementId: agreement.id, serviceId: agreement.service_id, anchorToothCode: agreement.tooth_code });
async function insertSnapshot(client: DbPool | DbClient, agreement: Agreement, patch: Record<string, unknown> = {}) {
  const row = { agreement_id: agreement.id, format_version: 1, service_id: agreement.service_id,
    service_category: "bridge", anchor_tooth_code: agreement.tooth_code, snapshot_mode: "multi_tooth_episode",
    snapshot_tooth_codes: [14,15,16], snapshot_scope: null, snapshot_surfaces: null, recorded_by: "synthetic-owner", ...patch };
  const { rows: [saved] } = await client.query(`INSERT INTO legacy_treatment_coverage_snapshots
    (agreement_id,format_version,service_id,service_category,anchor_tooth_code,snapshot_mode,
     snapshot_tooth_codes,snapshot_scope,snapshot_surfaces,recorded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *, recorded_at::text AS recorded_at`, Object.values(row));
  return saved;
}

beforeAll(async () => {
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  const files = await loadMigrationFiles();
  expect(files).toHaveLength(43);
  expect(files.slice(40).map((file) => file.filename)).toEqual([
    "0041_invoice_clinical_linkage.sql", "0042_legacy_treatment_agreements.sql", "0043_legacy_treatment_coverage.sql",
  ]);
  await migrate(pool(), { apply: true, files: files.slice(0, 42) });
  old = await seedAgreement(pool());
  oldFacts = (await pool().query("SELECT to_jsonb(a) AS facts FROM legacy_treatment_agreements a WHERE id=$1", [old.id])).rows[0].facts;
  await migrate(pool(), { apply: true, files });
}, 180_000);
afterAll(async () => { await fixture?.close(); }, 30_000);

describe("additive immutable coverage on an owned PostgreSQL18 fixture", () => {
  it("does not backfill or alter existing facts; old coverage remains unknown", async () => {
    const { rows: [row] } = await pool().query(`SELECT to_jsonb(a) AS facts, to_jsonb(c) AS snapshot
      FROM legacy_treatment_agreements a LEFT JOIN legacy_treatment_coverage_snapshots c ON c.agreement_id=a.id WHERE a.id=$1`, [old.id]);
    expect(row.facts).toEqual(oldFacts);
    expect(row.snapshot).toBeNull();
    expect(legacyCoverageStateFromSnapshot(row.snapshot, expected(old))).toEqual({ kind: "unknown", reason: "missing_snapshot" });
    expect((await pool().query("SELECT COUNT(*)::int AS count FROM schema_migrations")).rows[0].count).toBe(43);
    expect((await pool().query("SELECT to_regclass('public.periodontal_records')::text AS relation")).rows[0].relation).toBeNull();
  });
  it("keeps one complete snapshot with an actual recording time and no additional financial rows", async () => {
    const agreement = await seedAgreement(pool());
    const before = (await pool().query(`SELECT (SELECT COUNT(*) FROM invoices) AS invoices,
      (SELECT COUNT(*) FROM payments) AS payments, (SELECT COUNT(*) FROM patient_opening_balance_history) AS openings`)).rows;
    const saved = await insertSnapshot(pool(), agreement);
    expect(legacyCoverageStateFromSnapshot(saved, expected(agreement))).toMatchObject({ kind: "verified",
      coverage: { storedCategory: "bridge", anchorToothCode: 15, site: { episodeTeeth: [14,15,16] }, recordedBy: "synthetic-owner" } });
    expect((await pool().query(`SELECT (SELECT COUNT(*) FROM invoices) AS invoices,
      (SELECT COUNT(*) FROM payments) AS payments, (SELECT COUNT(*) FROM patient_opening_balance_history) AS openings`)).rows).toEqual(before);
    expect((await pool().query("SELECT recorded_at <= clock_timestamp() AND recorded_at > clock_timestamp() - INTERVAL '5 minutes' AS actual FROM legacy_treatment_coverage_snapshots WHERE agreement_id=$1", [agreement.id])).rows[0].actual).toBe(true);
    await expect(insertSnapshot(pool(), agreement)).rejects.toMatchObject({ code: "23505" });
    await expect(pool().query("UPDATE legacy_treatment_coverage_snapshots SET snapshot_tooth_codes=ARRAY[15]::smallint[] WHERE agreement_id=$1", [agreement.id])).rejects.toThrow("append-only");
    await expect(pool().query("DELETE FROM legacy_treatment_coverage_snapshots WHERE agreement_id=$1", [agreement.id])).rejects.toThrow("append-only");
    await expect(pool().query("DELETE FROM legacy_treatment_agreements WHERE id=$1", [agreement.id])).rejects.toThrow("append-only");
    expect((await pool().query("SELECT * FROM legacy_treatment_coverage_snapshots WHERE agreement_id=$1", [agreement.id])).rows).toHaveLength(1);
  });
  it("rejects service and anchor mismatches rather than rewriting the original agreement", async () => {
    const agreement = await seedAgreement(pool());
    await expect(insertSnapshot(pool(), agreement, { service_id: old.service_id })).rejects.toThrow("immutable agreement");
    await expect(insertSnapshot(pool(), agreement, { anchor_tooth_code: 14 })).rejects.toThrow("immutable agreement");
    expect((await pool().query("SELECT * FROM legacy_treatment_coverage_snapshots WHERE agreement_id=$1", [agreement.id])).rows).toHaveLength(0);
  });
  it.each([
    { format_version: 2 }, { snapshot_tooth_codes: [16,15,14] }, { snapshot_tooth_codes: [14,15,15,16] },
    { snapshot_tooth_codes: [14,15,19] }, { snapshot_tooth_codes: [14,15,null] }, { snapshot_tooth_codes: [14,16] },
    { snapshot_tooth_codes: [] }, { snapshot_scope: "upper" }, { snapshot_surfaces: "M" },
    { snapshot_mode: "unsupported" }, { recorded_by: "" }, { recorded_by: " synthetic-owner " },
  ])("rejects malformed/noncanonical stored snapshots: %j", async (patch) => {
    const agreement = await seedAgreement(pool());
    await expect(insertSnapshot(pool(), agreement, patch)).rejects.toMatchObject({ code: "23514" });
  });
  it.each([
    ["rct","per_tooth_episode",36,[36],null,null,true],
    ["rct","per_tooth_episode",36,[36,37],null,null,false],
    ["bridge","multi_tooth_episode",15,[14,15,16],null,null,true],
    ["filling","tooth_surfaces",26,[26],null,"MDO",true],
    ["filling","tooth_surfaces",26,[26],null,"MOD",false],
    ["filling","tooth_surfaces",26,[26],null,null,true],
    ["ortho","arch",null,[],"both",null,true],
    ["ortho","arch",null,[],"full_mouth",null,false],
    ["cleaning","region",null,[],"upper",null,true],
    ["cleaning","region",51,[51],null,null,true],
    ["cleaning","region",null,[],"both",null,false],
    ["whitening","none",null,[],"full_mouth",null,true],
    ["consultation","none",null,[],null,null,false],
  ])("keeps SQL and shared parser evidence validation aligned: %j %j", async (category, mode, anchor, teeth, scope, surfaces, valid) => {
    const { rows: [result] } = await pool().query("SELECT aqlan_legacy_coverage_site_valid($1::text,$2::text,$3::smallint,$4::smallint[],$5::text,$6::text) AS valid",
      [category,mode,anchor,teeth,scope,surfaces]);
    expect(result.valid).toBe(valid);
    expect(legacyCoverageStateFromSnapshot({ agreement_id: 1, service_id: 2, format_version: 1, service_category: category,
      anchor_tooth_code: anchor, snapshot_mode: mode, snapshot_tooth_codes: teeth, snapshot_scope: scope, snapshot_surfaces: surfaces,
      recorded_by: "synthetic-owner", recorded_at: "2001-02-03T04:05:06.123456Z" },
    { agreementId: 1, serviceId: 2, anchorToothCode: anchor as number | null }).kind === "verified").toBe(valid);
  });
  it("rejects nonstandard array dimensions/lower bounds and preserves current catalog independence", async () => {
    for (const sqlArray of ["'[0:2]={14,15,16}'::smallint[]", "'{{14,15,16}}'::smallint[]"]) {
      expect((await pool().query(`SELECT aqlan_legacy_coverage_site_valid('bridge','multi_tooth_episode',15::smallint,${sqlArray},NULL,NULL) AS valid`)).rows[0].valid).toBe(false);
    }
    const agreement = await seedAgreement(pool());
    const saved = await insertSnapshot(pool(), agreement);
    await pool().query("UPDATE services SET category='consultation' WHERE id=$1", [agreement.service_id]);
    const reread = (await pool().query("SELECT *,recorded_at::text AS recorded_at FROM legacy_treatment_coverage_snapshots WHERE agreement_id=$1", [agreement.id])).rows[0];
    expect(reread).toEqual(saved);
    expect(legacyCoverageStateFromSnapshot(reread, expected(agreement)).kind).toBe("verified");
  });
  it("includes immutable coverage in dependency-ordered backup without losing arrays or recorded timestamp precision", async () => {
    const agreement = await seedAgreement(pool());
    await insertSnapshot(pool(), agreement);
    const { rows: [recorded] } = await pool().query<{ stamp: string }>(
      "SELECT recorded_at::text AS stamp FROM legacy_treatment_coverage_snapshots WHERE agreement_id=$1", [agreement.id]);
    const lines: string[] = [];
    for await (const line of fixture!.db.backupSnapshotSqlLines(pool())) lines.push(line);
    const sql = lines.join("");
    const agreementTable = sql.indexOf("-- legacy_treatment_agreements (");
    const coverageTable = sql.indexOf("-- legacy_treatment_coverage_snapshots (");
    expect(agreementTable).toBeGreaterThanOrEqual(0);
    expect(coverageTable).toBeGreaterThan(agreementTable);
    const coverageSection = sql.slice(coverageTable).split(/\n-- /)[0];
    expect(coverageSection).toContain(recorded.stamp);
    expect(coverageSection).toContain("{14,15,16}");
    expect(coverageSection).toContain("recorded_at");
    expect(coverageSection).not.toMatch(/setval\(/);
  });
  it("preserves the existing patient-owned cascade without permitting standalone coverage deletion", async () => {
    const agreement = await seedAgreement(pool());
    await insertSnapshot(pool(), agreement);
    await expect(pool().query("DELETE FROM legacy_treatment_coverage_snapshots WHERE agreement_id=$1", [agreement.id])).rejects.toThrow("append-only");
    // The pristine fresh-UUID fixture contains synthetic records only. No reset or real-data deletion is used.
    await pool().query("DELETE FROM patients WHERE id=$1", [agreement.patient_id]);
    expect((await pool().query("SELECT 1 FROM legacy_treatment_agreements WHERE id=$1", [agreement.id])).rows).toHaveLength(0);
    expect((await pool().query("SELECT 1 FROM legacy_treatment_coverage_snapshots WHERE agreement_id=$1", [agreement.id])).rows).toHaveLength(0);
  });
  it("rolls back agreement and snapshot together if the encompassing writer transaction fails", async () => {
    const client = await pool().connect();
    let agreement: Agreement | undefined;
    try {
      await client.query("BEGIN");
      agreement = await seedAgreement(client);
      await insertSnapshot(client, agreement);
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect((await pool().query("SELECT id FROM legacy_treatment_agreements WHERE id=$1", [agreement!.id])).rows).toHaveLength(0);
    expect((await pool().query("SELECT agreement_id FROM legacy_treatment_coverage_snapshots WHERE agreement_id=$1", [agreement!.id])).rows).toHaveLength(0);
  });
});
