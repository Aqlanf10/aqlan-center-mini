vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl(); stubPostgresEnv(); vi.stubEnv("SESSION_SECRET", "synthetic-display-notice-secret-20261030");
const db = await import("../../lib/db");
const notice = await import("../../lib/canonical-display-notice");
const GRANTS = { "settings.view": true, "settings.operational.edit": true };
const accounts = {
  owner: { username: "SYN-DN-OWNER", role: "admin" },
  viewer: { username: "SYN-DN-VIEWER", role: "reception", grants: { "settings.view": true }, patientScope: "none" },
  editor: { username: "SYN-DN-EDITOR", role: "reception", grants: GRANTS, patientScope: "none" },
  own: { username: "SYN-DN-OWN", role: "doctor", grants: { "patients.create": true }, patientScope: "own", doctor: true },
  all: { username: "SYN-DN-ALL", role: "admin", grants: { "patients.create": true }, patientScope: "all" },
  revoked: { username: "SYN-DN-REVOKED", role: "reception", grants: GRANTS },
  pending: { username: "SYN-DN-PENDING", role: "reception", grants: GRANTS },
} as const;
type Key = keyof typeof accounts;
let fx: CanonicalInventoryDatabase<Key>;
const read = async (key: Key) => notice.readCanonicalDisplayNotice(await fx.session(key));
const change = async (key: Key, on: boolean) => notice.commandCanonicalDisplayNotice(await fx.session(key), { on, version: (await read("owner")).version });
const auditCount = async () => Number((await fx.pool.query("SELECT count(*) FROM audit_log WHERE entity='clinic_setting' AND entity_id='display.delay_notice'")).rows[0].count);
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, accounts, "owner"); }, 180_000);
afterAll(async () => { await fx?.close(); });
it("settings.view needs no patient scope and reveals only notice/version/editability", async () => expect(await read("viewer")).toEqual({ on: false, version: null, canEdit: false }));
it.each(["own", "all"] as const)("patient scope %s and admin/doctor labels never grant notice management", async key => { await expect(read(key)).rejects.toThrow("CAPABILITY_DENIED"); });
it("operational editor writes with a canonical actor audit and CAS stamp", async () => {
  const result = await change("editor", true); expect(result).toMatchObject({ ok: true, on: true, canEdit: true }); expect(result.version).toEqual(expect.any(String));
  expect((await fx.pool.query("SELECT actor,action FROM audit_log WHERE entity_id='display.delay_notice'")).rows).toEqual([{ actor: "SYN-DN-EDITOR", action: "clinic_settings.update" }]);
});
it("replay/stale request cannot overwrite a subsequent intent and does not add an audit", async () => {
  const first = await read("owner"); await change("editor", false); const count = await auditCount();
  await expect(notice.commandCanonicalDisplayNotice(await fx.session("editor"), { on: true, version: first.version })).rejects.toMatchObject({ status: 409 });
  expect((await read("owner")).on).toBe(false); expect(await auditCount()).toBe(count);
});
it("viewer write is refused; missing/invalid input never writes", async () => {
  await expect(change("viewer", true)).rejects.toMatchObject({ status: 403 });
  for (const body of [{ on: "true", version: null }, { on: true }, { on: true, version: {} }]) await expect(notice.commandCanonicalDisplayNotice(await fx.session("editor"), body)).rejects.toThrow();
  expect((await read("owner")).on).toBe(false);
});
it("failed audit rolls back the notice atomically", async () => {
  await fx.pool.query("ALTER TABLE audit_log ADD CONSTRAINT syn_notice_audit CHECK(entity_id <> 'display.delay_notice') NOT VALID");
  try { await expect(change("editor", true)).rejects.toThrow(); expect((await read("owner")).on).toBe(false); }
  finally { await fx.pool.query("ALTER TABLE audit_log DROP CONSTRAINT syn_notice_audit"); }
});
it("revocation refuses the existing session and a new session loses editing", async () => {
  const session = await fx.session("revoked"); await fx.setGrants("revoked", { "settings.view": true });
  await expect(notice.readCanonicalDisplayNotice(session)).rejects.toThrow(/^STAFF_/);
  await expect(notice.commandCanonicalDisplayNotice(session, { on: true, version: (await read("owner")).version })).rejects.toThrow(/^STAFF_/);
  expect((await read("revoked")).canEdit).toBe(false);
});
it("expiry while waiting on the setting lock rechecks the session and leaves no write/audit", async () => {
  const version = (await read("owner")).version, count = await auditCount();
  const lock = new Client({ connectionString: process.env.DATABASE_URL }); await lock.connect();
  try {
    await lock.query("BEGIN"); await lock.query("SELECT pg_advisory_xact_lock(hashtext('clinic-setting:display.delay_notice'))");
    const session = await fx.session("pending", 1500);
    const pending = notice.commandCanonicalDisplayNotice(session, { on: true, version }); pending.catch(() => undefined);
    // Prove admission reached the held domain lock; expiring before admission
    // must not accidentally make this a passing post-wait expiry test.
    let waiting = false;
    for (let i = 0; i < 160; i++) {
      if ((await lock.query("SELECT 1 FROM pg_locks WHERE NOT granted AND locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rowCount) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(waiting).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1600)); await lock.query("COMMIT");
    await expect(pending).rejects.toThrow(/^STAFF_/);
    expect((await read("owner")).on).toBe(false); expect(await auditCount()).toBe(count);
  } finally { await lock.query("ROLLBACK").catch(() => {}); await lock.end(); }
});
it("an admitted write serializes grant revocation behind the authority fence; following reads refuse", async () => {
  const session = await fx.session("pending"), version = (await read("owner")).version;
  const lock = new Client({ connectionString: process.env.DATABASE_URL }); await lock.connect();
  const waitFor = async (type: string) => { for (let i = 0; i < 160; i++) { if ((await lock.query("SELECT 1 FROM pg_locks WHERE NOT granted AND locktype=$1", [type])).rowCount) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error(`no ${type} waiter`); };
  try {
    await lock.query("BEGIN"); await lock.query("SELECT pg_advisory_xact_lock(hashtext('clinic-setting:display.delay_notice'))");
    const pending = notice.commandCanonicalDisplayNotice(session, { on: true, version }); pending.catch(() => undefined); await waitFor("advisory");
    let revoked = false; const revoke = fx.setGrants("pending", {}).then(() => { revoked = true; }); await waitFor("transactionid"); expect(revoked).toBe(false);
    await lock.query("COMMIT"); await expect(pending).resolves.toMatchObject({ on: true }); await revoke;
    await expect(notice.readCanonicalDisplayNotice(session)).rejects.toThrow(/^STAFF_/);
  } finally { await lock.query("ROLLBACK").catch(() => {}); await lock.end(); }
});
