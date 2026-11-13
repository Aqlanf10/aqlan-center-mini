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
import { waitForBlockedBy } from "./_canonical-ready-fixture";
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
  catalogDoctor: { username: "SYN-S-CATALOG-DOCTOR", role: "doctor", grants: { "settings.view": true, "clinical.medication-catalog.manage": true } },
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
  it("keeps main's external patient-identity publication owner-only and photo fields locked", async () => {
    const key = "lab.patient_identity_mode";
    expect((await read("operational")).__canWrite).not.toContain(key);
    expect((await read("owner")).__canWrite).toContain(key);
    const before = await stored(key), beforeAudit = await audits(key);
    await expect(update("operational", { [key]: "name" }, { __reason: "Synthetic publication review" }))
      .rejects.toMatchObject({ code: "setting_not_granted" });
    expect(await stored(key)).toBe(before);
    expect(await audits(key)).toEqual(beforeAudit);
    await update("owner", { [key]: "name" }, { __reason: "Synthetic publication review" });
    expect(await stored(key)).toBe("name");
    expect((await audits(key)).at(-1)?.actor).toBe(ACCOUNTS.owner.username);
    for (const locked of ["clinic.login_photo_asset", "clinic.login_photo_visible"]) {
      await expect(update("owner", { [locked]: locked.endsWith("visible") ? "true" : "synthetic" }))
        .rejects.toMatchObject({ code: "setting_locked" });
    }
  });
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

/** Staging's medication catalog on the canonical writer: owner operation re-proved after the
 * settings locks, observed version and reason required, catalog transition rules, one audited
 * transaction. Synthetic catalogue entries only. */
describe("canonical medication catalog write (staging contract)", () => {
  const KEY = "clinical.medication_catalog";
  const entry = { id: "22222222-2222-4222-8222-222222222222", revision: 1, enabled: true, name: "SYN canonical medicine", arabicName: "", form: "tablet", strength: "1 mg", population: "adult", amount: "", frequency: "", duration: "", instructionsAr: "", instructionsEn: "", indication: "Synthetic only", cautions: "", sourceUrl: "" };
  const catalog = (entries: unknown[]) => JSON.stringify({ schemaVersion: 1, entries });
  it("a granted doctor saves with the observed version and a reason; one audit row; existing prescriptions keep their doses", async () => {
    const patient = (await fx.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-CATALOG-RX','SYN catalog patient') RETURNING id")).rows[0].id;
    const rx = (await fx.pool.query("INSERT INTO prescriptions(patient_id,items,created_by) VALUES($1,'[{\"drug\":\"SYN canonical medicine\",\"dose\":\"1 mg\"}]','SYN') RETURNING id,items::text items", [patient])).rows[0];
    await update("catalogDoctor", { [KEY]: catalog([entry]) }, { __reason: "SYN add synthetic medicine" });
    expect(JSON.parse((await stored(KEY))!).entries).toHaveLength(1);
    expect(await audits(KEY)).toEqual([expect.objectContaining({ actor: ACCOUNTS.catalogDoctor.username })]);
    expect((await fx.pool.query("SELECT items::text items FROM prescriptions WHERE id=$1", [rx.id])).rows[0].items).toBe(rx.items);
  });
  it("refuses without a reason, a delegate with every settings grant, an unsafe transition and a stale version, without effects", async () => {
    const before = await stored(KEY), beforeAudits = (await audits(KEY)).length;
    await expect(update("owner", { [KEY]: catalog([{ ...entry, revision: 2, enabled: false }]) })).rejects.toMatchObject({ status: expect.any(Number) });
    await expect(update("both", { [KEY]: catalog([{ ...entry, revision: 2, enabled: false }]) }, { __reason: "SYN settings grants are not the catalog grant" })).rejects.toMatchObject({ code: "setting_not_granted" });
    await expect(update("adminLabel", { [KEY]: catalog([{ ...entry, revision: 2, enabled: false }]) }, { __reason: "SYN admin label alone" })).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(update("owner", { [KEY]: catalog([]) }, { __reason: "SYN delete is not allowed" })).rejects.toMatchObject({ code: "setting_rule" });
    const stale = settings.parseCanonicalSettingsUpdate({ [KEY]: catalog([{ ...entry, revision: 2, enabled: false }]), __versions: { [KEY]: "2000-01-01T00:00:00.000Z" }, __reason: "SYN stale" });
    await expect(settings.commandCanonicalSettingsWrite(await fx.session("owner"), stale)).rejects.toMatchObject({ code: "setting_conflict" });
    expect(await stored(KEY)).toBe(before); expect(await audits(KEY)).toHaveLength(beforeAudits);
  });
  it("revocation committed behind the identity fence writes nothing for the stale session", async () => {
    const before = await stored(KEY), beforeAudits = (await audits(KEY)).length;
    // The session and the observed version are taken before the revocation, so the write is stale on arrival.
    const session = await fx.session("catalogDoctor"), current = await read("owner");
    const write = settings.parseCanonicalSettingsUpdate({ [KEY]: catalog([{ ...entry, revision: 2, enabled: false }]),
      __versions: { [KEY]: current.__versions[KEY] ?? null }, __reason: "SYN revoked while waiting" });
    const holder = new Client({ connectionString: fx.pool.options.connectionString as string }); await holder.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
      await holder.query("UPDATE users SET permissions=jsonb_set(jsonb_set(permissions::jsonb,'{revision}',to_jsonb((permissions::jsonb->>'revision')::int+1)),'{grants,clinical.medication-catalog.manage}','false')::text WHERE username=$1", [ACCOUNTS.catalogDoctor.username]);
      pending = settings.commandCanonicalSettingsWrite(session, write).then(() => "saved", error => error);
      await waitForBlockedBy(fx.pool, pid);
      await holder.query("COMMIT");
      expect(await pending).toBeInstanceOf(Error);
    } finally { await holder.query("ROLLBACK").catch(() => undefined); await holder.end(); await pending; }
    expect(await stored(KEY)).toBe(before); expect(await audits(KEY)).toHaveLength(beforeAudits);
  });
  it("a revisioned disable is accepted for the owner", async () => {
    await update("owner", { [KEY]: catalog([{ ...entry, revision: 2, enabled: false }]) }, { __reason: "SYN disable" });
    expect(JSON.parse((await stored(KEY))!).entries[0]).toMatchObject({ enabled: false, revision: 2 });
  });
  it("two concurrent dose edits from the same observed version: exactly one saves, the other is refused as stale without effects", async () => {
    const current = await read("owner"), observed = current.__versions[KEY] ?? null, beforeAudits = (await audits(KEY)).length;
    const edit = (amount: string) => settings.parseCanonicalSettingsUpdate({ [KEY]: catalog([{ ...entry, revision: 3, enabled: false, amount }]),
      __versions: { [KEY]: observed }, __reason: `SYN concurrent dose ${amount}` });
    const results = await Promise.allSettled([
      settings.commandCanonicalSettingsWrite(await fx.session("owner"), edit("SYN 1 tablet")),
      settings.commandCanonicalSettingsWrite(await fx.session("owner"), edit("SYN 2 tablets")),
    ]);
    const saved = results.filter(r => r.status === "fulfilled"), refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(saved).toHaveLength(1); expect(refused).toHaveLength(1);
    // The loser is refused either by the version check or by the revision rule (its revision is no longer the next one).
    expect(["setting_conflict", "setting_rule"]).toContain((refused[0].reason as { code?: string }).code);
    const winner = results[0].status === "fulfilled" ? "SYN 1 tablet" : "SYN 2 tablets";
    expect(JSON.parse((await stored(KEY))!).entries[0]).toMatchObject({ amount: winner, revision: 3 });
    expect(await audits(KEY)).toHaveLength(beforeAudits + 1);
  });
});
