import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, expect, it } from "vitest";
import { admitNumberingRecovery, type NumberingRecoveryManifest } from "../../lib/patient-numbering-recovery";
import { executeNumberingCommand } from "../../lib/patient-numbering-command";
import { ownerContextFromTrustedBinding, resolveStaffCapabilities } from "../../lib/staff-capabilities";
import { validatePostgresTestTarget } from "./_safe-target";
import { NumberingPgFixture } from "./fixtures/patient-numbering-adapter";

const target = validatePostgresTestTarget(process.env);
const lineage = "ba3f640b-1234-4b62-9c16-d9f49f5c8d09";
let pool: Pool, fixture: NumberingPgFixture;
const owner = () => resolveStaffCapabilities({
  subject: { userId: 99, role: "admin", isActive: true, clinicianPartyId: null },
  permissionDocument: { schemaVersion: 1, revision: 1, patientScope: "none", appointmentScope: "none", grants: {} },
}, ownerContextFromTrustedBinding({ ownerUserId: 99, bindingVersion: "synthetic-recovery-only" }));
beforeEach(async () => {
  pool = new Pool({ connectionString: target.testUrl.toString(), ssl: false, max: 4 });
  fixture = new NumberingPgFixture(pool, `numbering_fixture_${randomUUID().replaceAll("-", "")}`, async () => owner());
  await fixture.initialize();
});
afterEach(async () => {
  try { await fixture?.dispose(); } finally { await pool?.end(); }
});
async function prepareFixture() {
  await pool.query(`CREATE TABLE ${fixture.schema}.retired_aliases (number text PRIMARY KEY, patient_id bigint NOT NULL);
    UPDATE ${fixture.schema}.history SET historical=123 WHERE prefix='P';
    SELECT setval('${fixture.schema}.seq_p',900000,true);
    INSERT INTO ${fixture.schema}.retired_aliases VALUES ('P-00000123',9007199254740993);`);
  const result = await executeNumberingCommand({
    prefix: "B", next: "37", expectedRevision: (await fixture.preview("B")).revision,
    requestId: "synthetic_recovery_01", reason: "Synthetic setting",
  }, fixture);
  expect(result.ok).toBe(true);
}
const witness = (manifest: NumberingRecoveryManifest) => ({
  expectedLineage: lineage, readCurrent: async () => ({ version: 1 as const, lineage, stateSha256: manifest.sha256 }),
});

it("does not fake an empty retired alias registry when storage is not installed", async () => {
  await expect(fixture.exportRecoverySidecar(lineage)).rejects.toMatchObject({ code: "42P01" });
});
it("exports the actual locked adapter projection and rejects older prior issuance", async () => {
  await prepareFixture();
  const older = await fixture.exportRecoverySidecar(lineage);
  const admission = await admitNumberingRecovery(older.bytes, older.manifest, witness(older.manifest));
  expect(admission).toMatchObject({
    ok: true, payload: {
      version: 1, activePrefix: "B", configRevision: "2",
      retiredAliases: [{ number: "P-00000123", patientId: "9007199254740993" }],
      audit: [{ id: "1", actor: "99", reason: "Synthetic setting" }],
      auditSequence: { lastValue: "1", isCalled: true },
      receipts: [{ actor: "99", request: "synthetic_recovery_01", result: { preview: "B-00037" } }],
    },
  });
  if (!admission.ok) throw new Error("Expected synthetic admission");
  expect(admission.payload.counters).toHaveLength(26);
  expect(admission.payload.counters.find((c) => c.prefix === "P")).toMatchObject({ lastValue: "900000", isCalled: true, historicalThrough: "123" });
  expect(admission.payload.counters.find((c) => c.prefix === "B")).toMatchObject({ lastValue: "37", isCalled: false });

  expect(await fixture.issue()).toBe("B-00037");
  const current = await fixture.exportRecoverySidecar(lineage);
  expect(await admitNumberingRecovery(older.bytes, older.manifest, witness(current.manifest)))
    .toEqual({ ok: false, reason: "freshness-mismatch" });
  expect(await admitNumberingRecovery(current.bytes, current.manifest, witness(current.manifest))).toMatchObject({ ok: true });
});
it("serializes exporter against allocator and observes a consumed allocation even after rollback", async () => {
  await prepareFixture();
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const allocation = fixture.withAllocationTransaction(async (_client, allocate) => {
    await allocate(); entered(); await hold; throw new Error("synthetic rollback");
  });
  const aborted = expect(allocation).rejects.toThrow("synthetic rollback");
  await inside;
  const capture = fixture.exportRecoverySidecar(lineage);
  release();
  await aborted;
  const encoded = await capture;
  const state = await admitNumberingRecovery(encoded.bytes, encoded.manifest, witness(encoded.manifest));
  if (!state.ok) throw new Error("Expected synthetic admission");
  expect(state.payload.counters.find((c) => c.prefix === "B")).toMatchObject({ lastValue: "37", isCalled: true });
});
it("refuses incomplete or omitted history, audit, or idempotent receipts", async () => {
  await prepareFixture();
  await pool.query(`UPDATE ${fixture.schema}.history SET complete=false WHERE prefix='Z'`);
  await expect(fixture.exportRecoverySidecar(lineage)).rejects.toThrow("Invalid or incomplete");
  await pool.query(`UPDATE ${fixture.schema}.history SET complete=true WHERE prefix='Z';
    DELETE FROM ${fixture.schema}.receipts;`);
  await expect(fixture.exportRecoverySidecar(lineage)).rejects.toThrow("Invalid or incomplete");
});
