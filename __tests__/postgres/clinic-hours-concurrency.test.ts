import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { CLINIC_HOURS_KEYS, validateSettingSet } from "../../lib/settings-validate";
assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = assertRealPostgresUrl();
const { ensureSchema, getPool, resetPoolForTesting, saveSettingsAudited } = await import("../../lib/db");
beforeAll(async () => { await dropPublicSchema(process.env.DATABASE_URL!); await ensureSchema(); });
afterAll(async () => { await resetPoolForTesting(); });
const split = { "clinic.day_start": "09:00", "clinic.day_end": "13:00", "clinic.shift2_start": "16:00", "clinic.shift2_end": "21:00" };
const continuous = { "clinic.day_start": "10:00", "clinic.day_end": "20:00", "clinic.shift2_start": "", "clinic.shift2_end": "" };
async function snapshot() {
  const { rows } = await getPool().query<{ key: string; value: string; updated_at: Date }>(
    "SELECT key, value, updated_at FROM settings WHERE key = ANY($1::text[])", [CLINIC_HOURS_KEYS]);
  return { values: Object.fromEntries(rows.map((r) => [r.key, r.value])),
    versions: Object.fromEntries(rows.map((r) => [r.key, r.updated_at.toISOString()])) };
}
describe("clinic hours audited batch concurrency on real PostgreSQL", () => {
  it("serializes first writes, then rejects a stale existing batch without mixing periods", async () => {
    await getPool().query("DELETE FROM settings WHERE key = ANY($1::text[])", [CLINIC_HOURS_KEYS]);
    const expected = Object.fromEntries(CLINIC_HOURS_KEYS.map((key) => [key, null]));
    const choices = [split, continuous];
    const results = await Promise.all(choices.map((values, index) => saveSettingsAudited({ values, expected, actor: `hours-first-${index}` })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    const first = await snapshot();
    expect(first.values).toEqual(choices[results.findIndex((r) => r.ok)]);
    expect(validateSettingSet(first.values, {})).toBeNull();
    // A later complete edit changes every tuple field; the other browser still
    // holds the previous four versions and must not overwrite any of them.
    const replacement = first.values["clinic.shift2_start"] ? continuous : split;
    expect(await saveSettingsAudited({ values: replacement, expected: first.versions, actor: "hours-newer" })).toMatchObject({ ok: true });
    const after = await snapshot();
    expect(after.values).toEqual(replacement);
    expect(await saveSettingsAudited({ values: first.values, expected: first.versions, actor: "hours-stale" })).toMatchObject({ ok: false });
    expect(await snapshot()).toEqual(after);
    const audit = await getPool().query("SELECT entity_id FROM audit_log WHERE actor = 'hours-stale'");
    expect(audit.rows).toEqual([]);
  });
});
