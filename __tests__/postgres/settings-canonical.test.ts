/** Owner decision 5 (Dot 6484846432): canonical clinic settings on real PostgreSQL,
 * synthetic data only. The read is one owning snapshot admitted by `settings.view`; a
 * write is ONE admitted transaction per batch where every key's requirement (delegable
 * capability or owner-only operation, lib/settings-capabilities.ts) is proved through
 * the same handle, and the CAS, the writes and their audit rows commit together.
 * Revocation is tested during a session and during a pending request. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-settings-secret-2026");
const db = await import("../../lib/db");
const settings = await import("../../lib/canonical-settings");

const OPERATIONAL = { "settings.view": true, "settings.operational.edit": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-S-OWNER", role: "admin" },
  viewer: { username: "SYN-S-VIEWER", role: "reception", grants: { "settings.view": true } },
  operational: { username: "SYN-S-OPERATIONAL", role: "reception", grants: OPERATIONAL },
  finance: { username: "SYN-S-FINANCE", role: "accountant", grants: { "settings.view": true, "settings.finance.edit": true } },
  both: { username: "SYN-S-BOTH", role: "reception", grants: { "settings.view": true, "settings.operational.edit": true, "settings.finance.edit": true } },
  adminLabel: { username: "SYN-S-ADMIN-LABEL", role: "admin", grants: { "patients.create": true } },
  revoked: { username: "SYN-S-REVOKED", role: "reception", grants: OPERATIONAL },
  pending: { username: "SYN-S-PENDING", role: "reception", grants: OPERATIONAL },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;

const read = async (k: Key) => settings.readCanonicalSettings(await fx.session(k));
const update = async (k: Key, values: Record<string, string>, extra: Record<string, unknown> = {}) => {
  const current = await read("owner");
  const versions = Object.fromEntries(Object.keys(values).map(key => [key, current.__versions[key] ?? null]));
  return settings.commandCanonicalSettingsWrite(await fx.session(k), settings.parseCanonicalSettingsUpdate({ ...values, __versions: versions, ...extra }));
};
const stored = async (key: string) => (await fx.pool.query<{ value: string }>("SELECT value FROM settings WHERE key=$1", [key])).rows[0]?.value ?? null;
const audits = async (key: string) => (await fx.pool.query<{ action: string; actor: string }>("SELECT action, actor FROM audit_log WHERE entity='clinic_setting' AND entity_id=$1 ORDER BY id", [key])).rows;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("read", () => {
  it("settings.view reads the values and stamps, and learns which keys it may write: none", async () => {
    const body = await read("viewer");
    expect(body["clinic.chairs"]).toBe("2");
    expect(body.__versions).toHaveProperty("clinic.chairs");
    expect(body.__canWrite).toEqual([]);
  });
  it("an operational editor may write operational keys only; never finance, authority, integration, backup or locked keys", async () => {
    const writable = new Set((await read("operational")).__canWrite);
    expect(writable.has("clinic.chairs")).toBe(true);
    for (const key of ["finance.rate.SAR", "workflow.doctor_financial_view", "reminders.auto_enabled", "backup.enabled", "messaging.consent_mode"]) expect(writable.has(key)).toBe(false);
  });
  it("the protected owner may write every class, never a system-locked key", async () => {
    const writable = new Set((await read("owner")).__canWrite);
    for (const key of ["clinic.chairs", "finance.rate.SAR", "workflow.doctor_financial_view", "reminders.auto_enabled", "backup.retention_daily_count"]) expect(writable.has(key)).toBe(true);
    const { SETTING_DEFINITIONS } = await import("../../lib/settings-definitions");
    for (const definition of SETTING_DEFINITIONS.filter(definition => definition.systemLocked)) expect(writable.has(definition.key)).toBe(false);
  });
  it("without settings.view the read refuses; an admin role label never widens it", async () => {
    await expect(read("adminLabel")).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
  });
});

describe("write: the batch rule", () => {
  it("an operational editor saves an operational key; the audit row carries the canonical actor", async () => {
    const body = await update("operational", { "clinic.chairs": "4" });
    expect(body.__changed).toEqual(["clinic.chairs"]);
    expect(body["clinic.chairs"]).toBe("4");
    expect(await stored("clinic.chairs")).toBe("4");
    expect(await audits("clinic.chairs")).toEqual([{ action: "clinic_settings.update", actor: "SYN-S-OPERATIONAL" }]);
  });
  it("one key outside the actor's grants refuses the whole batch with no partial write", async () => {
    await expect(update("operational", { "clinic.chairs": "5", "finance.rate_max_age_days": "9" })).rejects.toMatchObject({ code: "setting_not_granted", status: 403, key: "finance.rate_max_age_days" });
    expect(await stored("clinic.chairs")).toBe("4");
    expect(await stored("finance.rate_max_age_days")).toBeNull();
    await expect(update("finance", { "clinic.chairs": "5" })).rejects.toMatchObject({ code: "setting_not_granted" });
  });
  it("a mixed batch passes only when every requirement holds", async () => {
    const body = await update("both", { "clinic.chairs": "5", "finance.rate_max_age_days": "9" });
    expect(body.__changed.sort()).toEqual(["clinic.chairs", "finance.rate_max_age_days"]);
  });
  it("owner-only keys: refused for every delegate, written by the owner", async () => {
    const reason = { __reason: "synthetic owner decision" };
    await expect(update("both", { "workflow.doctor_financial_view": "true" }, reason)).rejects.toMatchObject({ code: "setting_not_granted" });
    await expect(update("both", { "clinic.chairs": "6", "backup.retention_daily_count": "20" })).rejects.toMatchObject({ code: "setting_not_granted", key: "backup.retention_daily_count" });
    expect(await stored("clinic.chairs")).toBe("5");
    await expect(update("owner", { "workflow.doctor_financial_view": "true" }, reason)).resolves.toMatchObject({ __changed: ["workflow.doctor_financial_view"] });
    expect(await stored("workflow.doctor_financial_view")).toBe("true");
  });
  it("view without an edit grant refuses naming the key; no settings.view refuses at admission; unknown keys and invalid values refuse before admission", async () => {
    await expect(update("viewer", { "clinic.chairs": "3" })).rejects.toMatchObject({ code: "setting_not_granted", key: "clinic.chairs" });
    await expect(update("adminLabel", { "clinic.chairs": "3" })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    expect(() => settings.parseCanonicalSettingsUpdate({ "no.such.key": "1", __versions: {} })).toThrow(expect.objectContaining({ code: "unknown_setting_key" }));
    expect(() => settings.parseCanonicalSettingsUpdate({ "clinic.chairs": "500", __versions: { "clinic.chairs": null } })).toThrow(expect.objectContaining({ code: "invalid_setting_value" }));
    expect(() => settings.parseCanonicalSettingsUpdate({ "clinic.chairs": "3" })).toThrow(expect.objectContaining({ code: "setting_version_missing", status: 409 }));
  });
  it("a stale stamp is a conflict naming the key: nothing written, nothing audited", async () => {
    const before = (await audits("clinic.chairs")).length;
    const write = settings.parseCanonicalSettingsUpdate({ "clinic.chairs": "7", __versions: { "clinic.chairs": "2000-01-01T00:00:00.000Z" } });
    await expect(settings.commandCanonicalSettingsWrite(await fx.session("operational"), write)).rejects.toMatchObject({ code: "setting_conflict", status: 409, key: "clinic.chairs" });
    expect(await stored("clinic.chairs")).toBe("5");
    expect((await audits("clinic.chairs")).length).toBe(before);
  });
  it("a reset is a new audited write of the default", async () => {
    const current = await read("owner");
    const write = settings.parseCanonicalSettingsReset({ action: "reset", keys: ["clinic.chairs"], __versions: { "clinic.chairs": current.__versions["clinic.chairs"] } });
    await expect(settings.commandCanonicalSettingsWrite(await fx.session("operational"), write)).resolves.toMatchObject({ __changed: ["clinic.chairs"], "clinic.chairs": "2" });
    expect((await audits("clinic.chairs")).at(-1)).toEqual({ action: "clinic_settings.reset", actor: "SYN-S-OPERATIONAL" });
  });
  it("the audit row is part of the write: an audit failure leaves no setting change", async () => {
    await fx.pool.query("ALTER TABLE audit_log ADD CONSTRAINT syn_settings_audit_refuses CHECK (actor <> 'SYN-S-BOTH') NOT VALID");
    try {
      await expect(update("both", { "clinic.chairs": "8" })).rejects.toThrow();
      expect(await stored("clinic.chairs")).toBe("2");
    } finally {
      await fx.pool.query("ALTER TABLE audit_log DROP CONSTRAINT syn_settings_audit_refuses");
    }
  });
});

describe("revocation (owner decision 4)", () => {
  it("revoking during a session: the old session is refused, a new one has no grant", async () => {
    const session = await fx.session("revoked");
    await expect(settings.readCanonicalSettings(session)).resolves.toBeTruthy();
    await fx.setGrants("revoked", { "settings.view": true });
    const write = settings.parseCanonicalSettingsUpdate({ "clinic.chairs": "3", __versions: { "clinic.chairs": (await read("owner")).__versions["clinic.chairs"] } });
    await expect(settings.commandCanonicalSettingsWrite(session, write)).rejects.toThrow(/^STAFF_OPERATION_/);
    await expect(settings.commandCanonicalSettingsWrite(await fx.session("revoked"), write)).rejects.toMatchObject({ code: "setting_not_granted" });
    expect(await stored("clinic.chairs")).toBe("2");
  });
  it("revoking during a pending request is serialized: the admitted write finishes, the revocation waits for it, then the session is refused", async () => {
    const session = await fx.session("pending");
    const versions = { "clinic.chairs": (await read("owner")).__versions["clinic.chairs"] };
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext('clinic-setting:' || 'clinic.chairs'))");
      const write = settings.commandCanonicalSettingsWrite(session, settings.parseCanonicalSettingsUpdate({ "clinic.chairs": "9", __versions: versions }));
      write.catch(() => undefined);
      const waitingFor = async (type: string) => {
        for (let i = 0; i < 200; i++) {
          // The fixture pool has one connection (the revocation may hold it): poll on the blocker.
          const { rows } = await blocker.query("SELECT 1 FROM pg_locks WHERE NOT granted AND locktype=$1", [type]);
          if (rows.length > 0) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error(`no waiter on ${type}`);
      };
      await waitingFor("advisory"); // admitted (proof rows held FOR SHARE), now waiting on the key lock
      let revokedAt = 0;
      const revoke = fx.setGrants("pending", { "settings.view": true }).then(() => { revokedAt = Date.now(); });
      await waitingFor("transactionid"); // the revocation waits for the admitted write's proof rows
      expect(revokedAt).toBe(0);
      await blocker.query("COMMIT");
      await expect(write).resolves.toMatchObject({ __changed: ["clinic.chairs"] });
      await revoke;
      expect(revokedAt).toBeGreaterThan(0);
      expect(await stored("clinic.chairs")).toBe("9");
      const next = settings.parseCanonicalSettingsUpdate({ "clinic.chairs": "3", __versions: { "clinic.chairs": (await read("owner")).__versions["clinic.chairs"] } });
      await expect(settings.commandCanonicalSettingsWrite(session, next)).rejects.toThrow(/^STAFF_OPERATION_/);
      expect(await stored("clinic.chairs")).toBe("9");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await blocker.end();
    }
  });
});
