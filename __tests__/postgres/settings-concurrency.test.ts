import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = assertRealPostgresUrl();

const { ensureSchema, getPool, resetPoolForTesting, saveSettingsAudited, getSettingsInTransaction } = await import("../../lib/db");

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});

afterAll(async () => {
  await resetPoolForTesting();
});

describe("تزامن أول كتابة لإعداد على PostgreSQL", () => {
  it("طلبان رأيا الافتراضي نفسه: ينجح واحد ويرد الآخر كتعارض", async () => {
    const key = "ops.follow_up_lookback_days";
    await getPool().query("DELETE FROM settings WHERE key = $1", [key]);

    const write = (value: string, actor: string) => saveSettingsAudited({
      values: { [key]: value },
      expected: { [key]: null },
      actor,
    });
    const results = await Promise.all([write("10", "first-writer-a"), write("60", "first-writer-b")]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const { rows } = await getPool().query<{ value: string }>(
      "SELECT value FROM settings WHERE key = $1",
      [key],
    );
    expect(["10", "60"]).toContain(rows[0].value);
  });
});



describe.each([
  ["finance.rate.SAR", "140", "finance.rate.USD"],
  ["finance.rate.USD", "530", "finance.rate.SAR"],
] as const)("FIN011 explicit default FX persistence: %s", (key, defaultValue, otherKey) => {

  async function clearRates() {
    // This existing suite runs exclusively against its disposable test schema.
    await getPool().query("DELETE FROM settings WHERE key = ANY($1::text[])", [[key, otherKey]]);
  }
  async function storedRate() {
    const { rows } = await getPool().query<{ value: string; updated_at: Date }>(
      "SELECT value, updated_at FROM settings WHERE key = $1", [key]);
    return rows[0];
  }
  async function auditRows(actor: string) {
    return (await getPool().query<{ details: Record<string, unknown> }>(
      "SELECT details FROM audit_log WHERE entity = 'clinic_setting' AND entity_id = $1 AND actor = $2",
      [key, actor])).rows;
  }

  it("persists an explicit default with a null version, audit provenance, and no other currency", async () => {
    await clearRates();
    const actor = `fin011-default-first-save-${key}`;
    const result = await saveSettingsAudited({ values: { [key]: defaultValue }, expected: { [key]: null }, actor });
    expect(result).toMatchObject({ ok: true, changed: [key] });
    const row = await storedRate();
    expect(row.value).toBe(defaultValue);
    expect(row.updated_at.toISOString()).toEqual(expect.any(String));
    expect(await auditRows(actor)).toEqual([{ details: expect.objectContaining({
      firstPersist: true, previousSource: "default", قبل: defaultValue, بعد: defaultValue,
    }) }]);
    const client = await getPool().connect();
    try {
      const strict = await getSettingsInTransaction(client, { requireStoredExchangeRates: true });
      expect(strict[key]).toBe(defaultValue);
      expect(strict[otherKey]).toBe("");
    } finally { client.release(); }
    expect((await getPool().query("SELECT key FROM settings WHERE key = $1", [otherKey])).rows).toEqual([]);

    const retry = await saveSettingsAudited({ values: { [key]: defaultValue },
      expected: { [key]: row.updated_at.toISOString() }, actor });
    expect(retry).toMatchObject({ ok: true, changed: [] });
    expect((await storedRate()).updated_at.toISOString()).toBe(row.updated_at.toISOString());
    expect(await auditRows(actor)).toHaveLength(1);
    expect(await saveSettingsAudited({ values: { [key]: defaultValue }, expected: { [key]: null }, actor }))
      .toMatchObject({ ok: false, conflict: { key } });
    expect((await storedRate()).value).toBe(defaultValue);
  });

  it("serializes two equal-default null-version first saves", async () => {
    await clearRates();
    const actors = [`fin011-race-a-${key}`, `fin011-race-b-${key}`];
    const results = await Promise.all(actors.map((actor) => saveSettingsAudited({
      values: { [key]: defaultValue }, expected: { [key]: null }, actor,
    })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect((await storedRate()).value).toBe(defaultValue);
    expect((await Promise.all(actors.map(auditRows))).flat()).toHaveLength(1);
  });
});


it("FIN011 explicitly persists a nonfinancial default through reset", async () => {
  const key = "ops.follow_up_lookback_days";
  await getPool().query("DELETE FROM settings WHERE key = $1", [key]);
  const result = await saveSettingsAudited({ values: { [key]: "30" }, expected: { [key]: null },
    actor: "fin011-nonfinance-reset", mode: "reset" });
  expect(result).toMatchObject({ ok: true, changed: [key] });
  expect((await getPool().query("SELECT value FROM settings WHERE key = $1", [key])).rows).toEqual([{ value: "30" }]);
  const { rows } = await getPool().query("SELECT action, details FROM audit_log WHERE entity_id = $1 AND actor = $2",
    [key, "fin011-nonfinance-reset"]);
  expect(rows).toEqual([{ action: "clinic_settings.reset", details: expect.objectContaining({ firstPersist: true }) }]);
});
