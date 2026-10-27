import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { LAB_WORK_INTENT_SQL } from "../../lib/lab-work-intent-schema";
import { ProtectedLabHistoryError, LAB_HISTORY_TABLES, RESET_KEEP_TABLES } from "../../lib/clinic-reset";
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
const names = ["aqlan_lab_history_no_truncate"];
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>, db: typeof import("../../lib/db");
const originalUrl = process.env.DATABASE_URL, originalSeed = process.env.SKIP_SEED;
async function definitions() {
  return (await fixture.source.query<{ definition: string }>("SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname", [names])).rows.map(row => row.definition);
}
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  await migrate(fixture.source, { apply: true, files: (await loadMigrationFiles()).filter(file => file.version < "0074") });
  process.env.DATABASE_URL = fixture.source.options.connectionString!;
  process.env.SKIP_SEED = "true";
  db = await import("../../lib/db"); await db.resetPoolForTesting(); await db.ensureSchema();
}, 180_000);
afterAll(async () => {
  await db?.resetPoolForTesting();
  if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl;
  if (originalSeed === undefined) delete process.env.SKIP_SEED; else process.env.SKIP_SEED = originalSeed;
  await fixture?.close();
}, 60_000);
describe("registered lab-only schema bootstrap", () => {
  it("registers exact 0074 bytes without deferred 0073/0075 and retains all lab history plus target marker", async () => {
    const rows = (await fixture.source.query("SELECT version,name,checksum,adopted FROM schema_migrations WHERE version IN ('0073','0074','0075') ORDER BY version")).rows;
    expect(rows).toEqual([
      { version: "0074", name: "lab_work_intents", checksum: createHash("sha256").update(LAB_WORK_INTENT_SQL).digest("hex"), adopted: false },
    ]);
    for (const table of [...LAB_HISTORY_TABLES, "lab_work_intent_schema"]) expect(RESET_KEEP_TABLES).toContain(table);
  });
  it("cold restart preserves lab-only guards and never installs deferred clinical authority", async () => {
    const expected = await definitions(); expect(expected).toHaveLength(1);
    expect(expected[0]).toContain("lab history reset requires READ COMMITTED isolation");
    await db.resetPoolForTesting(); await db.ensureSchema();
    expect(await definitions()).toEqual(expected);
    await db.resetPoolForTesting(); await db.ensureSchema();
    expect(await definitions()).toEqual(expected);
    expect((await fixture.source.query("SELECT count(*)::int AS n FROM schema_migrations WHERE version='0074'")).rows[0].n).toBe(1);
    expect((await fixture.source.query("SELECT to_regclass('public.agreement_clinical_authorization_events')::text AS name")).rows[0].name).toBeNull();
    expect((await fixture.source.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='lab_prescription_source_memberships' AND column_name='clinical_authorization_event_id'")).rows).toEqual([]);
  });
  it("empty lab history preserves normal reset and target capability", async () => {
    const backup = vi.fn(async () => ({ ok: true as const, backupId: "synthetic-owned-fixture" }));
    const result = await db.resetClinicData({ actor: "synthetic", actorRole: "admin" }, backup);
    expect(result.ok).toBe(true); expect(backup).toHaveBeenCalledTimes(1);
    expect((await fixture.source.query("SELECT version FROM lab_work_intent_schema WHERE singleton")).rows).toEqual([{ version: 1 }]);
  });
  it("durable terminal lab command refuses reset before backup or deletion", async () => {
    const user = (await fixture.source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-lab-reset','Synthetic','synthetic-hash','admin') RETURNING id")).rows[0].id;
    const patient = (await fixture.source.query("INSERT INTO patients(patient_number,full_name) VALUES('LAB-RESET-SYNTHETIC','Synthetic') RETURNING id")).rows[0].id;
    await fixture.source.query("INSERT INTO lab_work_commands(actor_user_id,request_key,patient_id,source_kind,source_id,request_hash,result) VALUES($1,'synthetic-lab-reset-key',$2,'visit',1,$3,'{\"outcome\":\"rejected\",\"code\":\"stale_intent\"}')", [user, patient, "a".repeat(64)]);
    const backup = vi.fn(async () => ({ ok: true as const, backupId: "must-not-run" }));
    await expect(db.resetClinicData({ actor: "synthetic", actorRole: "admin" }, backup)).rejects.toBeInstanceOf(ProtectedLabHistoryError);
    expect(backup).not.toHaveBeenCalled();
    expect((await fixture.source.query("SELECT count(*)::int AS n FROM lab_work_commands")).rows[0].n).toBe(1);
  });

});
