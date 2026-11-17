import { expect, it } from "vitest";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { loadMigrationFiles, migrate, migrationStatus } from "../../lib/migrations";

it("upgrades a populated historical 0079 database to 0090–0093 without rewriting old data or registry", async () => {
  const fixture = await openBackupTimestampFixture(process.env);
  const old = fixture.source;
  try {
    const files = await loadMigrationFiles();
    const added = new Set(["0090", "0091", "0092", "0093"]);
    const historicalFiles = files.filter(file => !added.has(file.version));
    await migrate(old, { apply: true, files: historicalFiles, historical0079: true });
    const patient = (await old.query("INSERT INTO patients(patient_number, full_name) VALUES ('SYN-RX-UPGRADE', 'Synthetic Patient') RETURNING id")).rows[0].id;
    await old.query("INSERT INTO booking_requests(full_name, phone, reason) VALUES ('Synthetic booking', '00000000', 'synthetic reason')");
    await old.query("INSERT INTO prescriptions(patient_id, diagnosis, notes, items, created_by) VALUES ($1, 'synthetic diagnosis', 'synthetic note', $2::jsonb, 'synthetic clinician')", [patient, JSON.stringify([{name: "Synthetic medicine", dose: "10 mg"}])]);
    const registry = async () => (await old.query("SELECT to_jsonb(m)::text AS row FROM schema_migrations m ORDER BY version")).rows;
    const booking = async () => (await old.query("SELECT (to_jsonb(b) - 'request_key' - 'request_hash' - 'preferences')::text AS row FROM booking_requests b ORDER BY id")).rows;
    const prescriptions = async () => (await old.query("SELECT (to_jsonb(p) - 'prescribing_doctor_party_id' - 'prescribing_doctor_name')::text AS row FROM prescriptions p ORDER BY id")).rows;
    const beforeRegistry = await registry(), beforeBooking = await booking(), beforePrescriptions = await prescriptions();
    expect(beforeRegistry.some(row => JSON.parse(row.row).version === "0079")).toBe(true);
    expect(beforeBooking).toHaveLength(1);
    expect(beforePrescriptions).toHaveLength(1);

    const result = await migrate(old, { apply: true, files });
    expect(result.appliedVersions).toEqual(["0090", "0091", "0092", "0093"]);
    expect((await registry()).filter(row => !added.has(JSON.parse(row.row).version))).toEqual(beforeRegistry);
    expect(await booking()).toEqual(beforeBooking);
    expect(await prescriptions()).toEqual(beforePrescriptions);
    expect((await old.query("SELECT request_key, request_hash, preferences FROM booking_requests")).rows).toEqual([{ request_key: null, request_hash: null, preferences: {} }]);
    expect((await old.query("SELECT prescribing_doctor_party_id, prescribing_doctor_name FROM prescriptions")).rows).toEqual([{ prescribing_doctor_party_id: null, prescribing_doctor_name: null }]);
    expect((await migrationStatus(old, files)).consistent).toBe(true);
    expect((await migrate(old, { apply: true, files })).alreadyUpToDate).toBe(true);
  } finally { await fixture.close(); }
}, 180000);
