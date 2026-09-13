import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = assertRealPostgresUrl();

const { ensureSchema, getPool, resetPoolForTesting, saveSettingsAudited } = await import("../../lib/db");

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
