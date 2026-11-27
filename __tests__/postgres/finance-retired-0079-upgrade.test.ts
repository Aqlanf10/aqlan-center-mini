import { expect, it } from "vitest";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { loadMigrationFiles, migrate, migrationStatus, validateRuntimeHistorical0079 } from "../../lib/migrations";

it("adds the financial contracts to a populated 0079 history without changing its registry or existing facts", async () => {
  const fixture = await openBackupTimestampFixture(process.env);
  try {
    const files = await loadMigrationFiles();
    const coverage = files.find(file => file.version === "0079")!;
    const old = fixture.source;
    await migrate(old, { apply: true, files: files.filter(file => !["0128", "0129", "0133"].includes(file.version)), historical0079: true });
    const patient = (await old.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-FIN-0079','Synthetic history') RETURNING id")).rows[0].id;
    const shift = (await old.query("INSERT INTO cashier_shifts(opened_by,opening_yer) VALUES('synthetic',1000) RETURNING id")).rows[0].id;
    await old.query("INSERT INTO invoices(patient_id,invoice_number,total_minor) VALUES($1,'SYN-FIN-0079-INV',250)", [patient]);
    await old.query("INSERT INTO expenses(voucher_number,category,payee_text,shift_id,amount_minor,currency,base_amount_minor,created_by) VALUES('SYN-FIN-0079-EXP','other','Synthetic', $1, 100, 'YER', 100, 'synthetic')", [shift]);
    const registryBefore = (await old.query("SELECT version,name,checksum,adopted,applied_at::text FROM schema_migrations ORDER BY version")).rows;
    const patientBefore = (await old.query("SELECT to_jsonb(p) AS row FROM patients p ORDER BY id")).rows;
    const shiftBefore = (await old.query("SELECT to_jsonb(s) AS row FROM cashier_shifts s ORDER BY id")).rows;
    const expenseBefore = (await old.query("SELECT to_jsonb(e) AS row FROM expenses e ORDER BY id")).rows;
    const result = await migrate(old, { apply: true, files });
    expect(result.appliedVersions).toEqual(["0128", "0129", "0133"]);
    expect((await old.query("SELECT version,name,checksum,adopted,applied_at::text FROM schema_migrations WHERE version NOT IN ('0128','0129','0133') ORDER BY version")).rows).toEqual(registryBefore);
    expect((await old.query("SELECT to_jsonb(p) AS row FROM patients p ORDER BY id")).rows).toEqual(patientBefore);
    expect((await old.query("SELECT to_jsonb(s) - ARRAY['opening_correction_version']::text[] AS row FROM cashier_shifts s ORDER BY id")).rows).toEqual(shiftBefore);
    const added = ["idempotency_key", "idempotency_request_hash", "payment_source", "drawer_amount_minor", "owner_private_amount_minor", "owner_private_reason", "owner_private_user_id", "owner_private_account_code"];
    expect((await old.query("SELECT to_jsonb(e) - $1::text[] AS row FROM expenses e ORDER BY id", [added])).rows).toEqual(expenseBefore);
    await validateRuntimeHistorical0079(old, coverage);
    expect((await migrationStatus(old, files)).consistent).toBe(true);
    expect((await migrate(old, { apply: true, files })).alreadyUpToDate).toBe(true);
    const fresh = fixture.sqlTarget;
    await migrate(fresh, { apply: true, files });
    expect((await fresh.query("SELECT version FROM schema_migrations WHERE version IN ('0079','0128','0129','0133','0136') ORDER BY version")).rows)
      .toEqual([{version:"0128"},{version:"0129"},{version:"0133"},{version:"0136"}]);
    expect((await fresh.query("SELECT to_regclass('public.ortho_followup_coverage_revisions') AS name")).rows[0].name).toBeNull();
  } finally { await fixture.close(); }
}, 180000);
