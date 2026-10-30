import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dropPublicSchema, stubPostgresEnv } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";
import { LOGIN_PHOTO_ASSET, LOGIN_PHOTO_VISIBLE } from "../../lib/login-photo";

const target = validatePostgresTestTarget(process.env);
const disposableUrl = target.testUrl;
if (!["postgres:", "postgresql:"].includes(disposableUrl.protocol)
  || !["127.0.0.1", "localhost", "[::1]"].includes(disposableUrl.hostname)
  || disposableUrl.pathname !== "/aqlan_p1_test") {
  throw new Error("Login-photo PostgreSQL tests require the disposable loopback aqlan_p1_test database");
}
stubPostgresEnv(); process.env.DATABASE_URL = disposableUrl.toString();
const { ensureSchema, getPool, resetPoolForTesting, saveSettingsAudited } = await import("../../lib/db");
const keys = [LOGIN_PHOTO_ASSET, LOGIN_PHOTO_VISIBLE];
const values = { [LOGIN_PHOTO_ASSET]: "synthetic-private-metadata", [LOGIN_PHOTO_VISIBLE]: "false" };
const expected = Object.fromEntries(keys.map(k => [k, null]));
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!); await ensureSchema();
  await getPool().query(`CREATE FUNCTION reject_synthetic_photo_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.actor = 'synthetic-photo-fail' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_synthetic_photo_audit BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION reject_synthetic_photo_audit()`);
});
beforeEach(async () => {
  await getPool().query("DELETE FROM settings WHERE key = ANY($1::text[])", [keys]);
});
afterAll(async () => { await resetPoolForTesting(); });
async function rowCount() {
  return Number((await getPool().query<{ n: string }>("SELECT count(*)::text AS n FROM settings WHERE key = ANY($1::text[])", [keys])).rows[0].n);
}
describe("login-photo opt-in transactional settings audit", () => {
  it("rolls back both setting rows when the audit insert fails", async () => {
    await expect(saveSettingsAudited({ values, expected, actor: "synthetic-photo-fail", actorRole: "admin", transactionalAudit: true }))
      .rejects.toThrow("synthetic audit failure");
    expect(await rowCount()).toBe(0);
  });
  it("commits both rows and exactly two audit records atomically", async () => {
    const result = await saveSettingsAudited({ values, expected, actor: "synthetic-photo-ok", actorRole: "admin", transactionalAudit: true });
    expect(result.ok).toBe(true);
    expect(await rowCount()).toBe(2);
    const audits = await getPool().query("SELECT entity_id FROM audit_log WHERE actor = 'synthetic-photo-ok' ORDER BY entity_id");
    expect(audits.rows.map(r => r.entity_id)).toEqual([...keys].sort());
  });
  it("keeps legacy best-effort semantics for callers that did not opt in", async () => {
    const result = await saveSettingsAudited({ values, expected, actor: "synthetic-photo-fail", actorRole: "admin" });
    expect(result.ok).toBe(true);
    expect(await rowCount()).toBe(2);
  });
  it("allows only one simultaneous first writer with both null stamps", async () => {
    const results = await Promise.all(["a", "b"].map(n => saveSettingsAudited({
      values: { ...values, [LOGIN_PHOTO_ASSET]: `synthetic-${n}` }, expected,
      actor: `synthetic-photo-${n}`, actorRole: "admin", transactionalAudit: true,
    })));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok)).toHaveLength(1);
    expect(await rowCount()).toBe(2);
  });
});
