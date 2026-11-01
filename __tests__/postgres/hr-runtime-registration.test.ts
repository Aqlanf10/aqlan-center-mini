import { BOOKING_REQUEST_PREFERENCES_SQL } from "../../lib/prescription-migration-lineage";
import { PRESCRIBING_DOCTOR_SNAPSHOT_SQL, PRESCRIBING_DOCTOR_IDENTITY_SQL } from "../../lib/prescribing-doctor-schema";
import { LAB_SHADE_SPECIFICATION_SQL } from "../../lib/lab-shade-schema";
import { AGREEMENT_REMINDER_GUARD_SQL } from "../../lib/agreement-reminder-guard-schema";
import { AGREEMENT_RECONCILIATION_SQL } from "../../lib/agreement-reconciliation-schema";
import { PATIENT_APPOINTMENT_HISTORY_SQL } from "../../lib/patient-appointment-history-schema";
import {APPROVED_AGREEMENT_SQL} from "../../lib/approved-agreement-schema";
import { INVENTORY_PURCHASE_RECEIPTS_SQL } from "../../lib/inventory-purchase-schema";
import { COLLECTION_ATTEMPT_RETIREMENT_SQL } from "../../lib/collection-attempt-schema";
import { UNPAID_CURRENCY_TRANSITION_SQL } from "../../lib/unpaid-currency-schema";
import { AGREEMENT_DELTA_SQL } from "../../lib/agreement-delta-schema";
import {INVOICE_CURRENCY_MIGRATION} from "../../lib/invoice-currency-runtime";
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { applyRuntimeMigrationFiles, loadMigrationFiles, migrate } from '../../lib/migrations';
import bundled from '../../lib/hr-temporal-schema.generated.json';
import ortho from '../../lib/ortho-assessment-runtime.generated.json';

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db: typeof import('../../lib/db');
const originalUrl = process.env.DATABASE_URL, originalSeed = process.env.SKIP_SEED;
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  process.env.DATABASE_URL = fixture.source.options.connectionString!;
  process.env.SKIP_SEED = 'true';
  db = await import('../../lib/db');
  await db.resetPoolForTesting(); await db.ensureSchema();
});
afterAll(async () => {
  try { await db?.resetPoolForTesting(); } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl;
    if (originalSeed === undefined) delete process.env.SKIP_SEED; else process.env.SKIP_SEED = originalSeed;
    await fixture?.close();
  }
});
it('runtime registers exact additive contracts without fabricating facts, receipts, or old migration ownership', async () => {
  const approved = (await loadMigrationFiles()).find(file => file.version === "0064")!;
  expect(approved).toMatchObject({name:"approved_agreement_principal",filename:"0064_approved_agreement_principal.sql",checksum:"aefc040a29c8b887a8eeca073103ce4268a8851b89e0025b406941e48f247655"});
  expect(approved.sql).toBe(APPROVED_AGREEMENT_SQL);
  const registered = (await fixture.source.query('SELECT version,name,checksum,adopted FROM schema_migrations ORDER BY version')).rows;
  expect(registered).toEqual([...ortho, ...bundled,INVOICE_CURRENCY_MIGRATION,{version:"0064",name:"approved_agreement_principal",checksum:createHash("sha256").update(APPROVED_AGREEMENT_SQL).digest("hex")},
    { version: "0065", name: "inventory_purchase_receipts", checksum: createHash("sha256").update(INVENTORY_PURCHASE_RECEIPTS_SQL).digest("hex") },
    { version: "0066", name: "agreement_delta_amendments", checksum: createHash("sha256").update(AGREEMENT_DELTA_SQL).digest("hex") },
    { version: "0067", name: "patient_appointment_history_index", checksum: createHash("sha256").update(PATIENT_APPOINTMENT_HISTORY_SQL).digest("hex") },
    { version: "0068", name: "collection_attempt_retirements", checksum: createHash("sha256").update(COLLECTION_ATTEMPT_RETIREMENT_SQL).digest("hex") },
    { version: "0069", name: "unpaid_currency_transitions", checksum: createHash("sha256").update(UNPAID_CURRENCY_TRANSITION_SQL).digest("hex") },
    { version: "0078", name: "agreement_reconciliation", checksum: createHash("sha256").update(AGREEMENT_RECONCILIATION_SQL).digest("hex") },
    { version: "0087", name: "agreement_reminder_metadata", checksum: createHash("sha256").update(AGREEMENT_REMINDER_GUARD_SQL).digest("hex") },
    { version: "0089", name: "lab_shade_specification", checksum: createHash("sha256").update(LAB_SHADE_SPECIFICATION_SQL).digest("hex") },
    { version: "0090", name: "booking_request_preferences", checksum: createHash("sha256").update(BOOKING_REQUEST_PREFERENCES_SQL).digest("hex") },
    { version: "0091", name: "prescribing_doctor_identity", checksum: createHash("sha256").update(PRESCRIBING_DOCTOR_IDENTITY_SQL).digest("hex") },
    { version: "0092", name: "prescribing_doctor_snapshot", checksum: createHash("sha256").update(PRESCRIBING_DOCTOR_SNAPSHOT_SQL).digest("hex") },
  ].map(file => ({ version: file.version, name: file.name, checksum: file.checksum, adopted: false })));
  for (const table of ['hr_effective_streams', 'hr_effective_revisions', 'hr_temporal_write_receipts', 'hr_staff', 'hr_settings', 'inventory_purchase_receipts']) {
    expect((await fixture.source.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
  }
  expect(await applyRuntimeMigrationFiles(fixture.source, bundled)).toEqual([]);
  expect(await applyRuntimeMigrationFiles(fixture.source, bundled)).toEqual([]);
});
it('runtime and full migrator serialize on one lock across actual gaps, with one record per version', async () => {
  const files = await loadMigrationFiles();
  await migrate(fixture.sqlTarget, { apply: true, files: files.filter(file => file.version < '0056') });
  // Separate pools/connections, so an application-local lock cannot satisfy this invariant.
  const { Pool } = await import('pg');
  const competitor = new Pool({ connectionString: fixture.sqlTarget.options.connectionString!, ssl: false });
  try {
    await Promise.all([applyRuntimeMigrationFiles(fixture.sqlTarget, bundled), migrate(competitor, { apply: true, files })]);
    const registered = (await fixture.sqlTarget.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows;
    expect(registered).toEqual(files.map(file => ({ version: file.version, checksum: file.checksum })));
    expect((await migrate(competitor, { apply: true, files })).appliedVersions).toEqual([]);
    expect(await applyRuntimeMigrationFiles(fixture.sqlTarget, bundled)).toEqual([]);
  } finally { await competitor.end(); }
});
it('rejects an older or corrupted0057 registry before changing any other extension', async () => {
  const bad = 'd0586f05f3421d40243cff642edb7f02e38ab2aacc640c0492d6bb5c0395c3b9';
  await fixture.source.query("UPDATE schema_migrations SET checksum=$1 WHERE version='0057'", [bad]);
  const before = (await fixture.source.query('SELECT to_jsonb(t)::text AS row FROM schema_migrations t ORDER BY version')).rows;
  try {
    await expect(applyRuntimeMigrationFiles(fixture.source, bundled)).rejects.toThrow('RUNTIME_MIGRATION_REGISTRY_MISMATCH: 0057');
    expect((await fixture.source.query('SELECT to_jsonb(t)::text AS row FROM schema_migrations t ORDER BY version')).rows).toEqual(before);
  } finally { await fixture.source.query("UPDATE schema_migrations SET checksum=$1 WHERE version='0057'", [bundled[1].checksum]); }
});
it('rolls back failed0058 DDL and its registry row, then retries the exact allocated source successfully', async () => {
  const files = await loadMigrationFiles();
  await migrate(fixture.archiveTarget, { apply: true, files: files.filter(file => file.version < '0058') });
  const sql = bundled[2].sql + '\nSELECT 1 / 0;\n';
  const failing = { ...bundled[2], sql, checksum: createHash('sha256').update(sql).digest('hex') };
  await expect(applyRuntimeMigrationFiles(fixture.archiveTarget, [failing])).rejects.toThrow('division by zero');
  expect((await fixture.archiveTarget.query("SELECT to_regclass('public.hr_temporal_write_receipts') AS name")).rows[0].name).toBeNull();
  expect((await fixture.archiveTarget.query("SELECT version FROM schema_migrations WHERE version='0058'")).rows).toEqual([]);
  expect(await applyRuntimeMigrationFiles(fixture.archiveTarget, bundled)).toEqual(['0058']);
  expect((await fixture.archiveTarget.query("SELECT checksum FROM schema_migrations WHERE version='0058'")).rows[0].checksum).toBe(bundled[2].checksum);
});
