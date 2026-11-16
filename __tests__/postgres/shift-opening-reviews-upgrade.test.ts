import { expect, it } from "vitest";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { openPeriodontalFixture } from "./_periodontal-fixture";

// docs/finance/SHIFT_OPENING_REVIEWS_0129.md §3 (owner #483 6831365228 item 1; number allocated in 6833690789).
// Upgrade from the head pushed before 0129 existed (0128 then 0132) with closed shifts. Nothing is backfilled,
// no shift row changes, and the new table is append-only from its first row.
it("adds 0129 to a populated database that already has 0128 and 0132, leaving every shift unchanged", async () => {
  const f = await openPeriodontalFixture(process.env, { pristine: true });
  try {
    const files = await loadMigrationFiles();
    await migrate(f.pool, { apply: true, files: files.filter((file) => file.version !== "0129") });
    await f.pool.query(`INSERT INTO cashier_shifts (opened_by, status, closed_by, closed_at, opening_yer, counted_yer, counted_sar, counted_usd)
      VALUES ('synthetic', 'closed', 'synthetic', now() - interval '1 day', 1000, 900, 0, 0),
             ('synthetic', 'closed', 'synthetic', now(), 900, NULL, NULL, NULL)`);
    const before = (await f.pool.query("SELECT to_jsonb(s)::text AS row FROM cashier_shifts s ORDER BY id")).rows;
    await migrate(f.pool, { apply: true, files });
    expect((await f.pool.query("SELECT to_jsonb(s)::text AS row FROM cashier_shifts s ORDER BY id")).rows).toEqual(before);
    expect((await f.pool.query("SELECT count(*)::int AS n FROM shift_opening_reviews")).rows).toEqual([{ n: 0 }]);
    expect((await f.pool.query("SELECT version FROM schema_migrations WHERE version BETWEEN '0126' AND '0139' ORDER BY version")).rows)
      .toEqual([{ version: "0126" }, { version: "0128" }, { version: "0129" }, { version: "0132" }, { version: "0133" }]);
    await migrate(f.pool, { apply: true, files });
    expect((await f.pool.query("SELECT count(*)::int AS n FROM schema_migrations WHERE version='0129'")).rows).toEqual([{ n: 1 }]);
    // A row can reference a pre-upgrade close and is append-only from the start.
    const [{ id: shift }] = (await f.pool.query("INSERT INTO cashier_shifts (opened_by, opening_yer) VALUES ('synthetic', 500) RETURNING id")).rows;
    const [{ id: previous }] = (await f.pool.query("SELECT id FROM cashier_shifts WHERE status='closed' ORDER BY closed_at DESC LIMIT 1")).rows;
    const [{ id: row }] = (await f.pool.query(`INSERT INTO shift_opening_reviews (shift_id, currency, previous_shift_id, previous_counted_minor, opening_minor, difference_minor, detected_by)
      VALUES ($1, 'YER', $2, NULL, 500, NULL, 'synthetic') RETURNING id`, [shift, previous])).rows;
    await expect(f.pool.query("DELETE FROM shift_opening_reviews WHERE id=$1", [row])).rejects.toThrow(/لا تُحذف/);
    await expect(f.pool.query(`INSERT INTO shift_opening_reviews (shift_id, currency, previous_shift_id, previous_counted_minor, opening_minor, difference_minor, detected_by)
      VALUES ($1, 'SAR', $2, 100, 100, 0, 'synthetic')`, [shift, previous])).rejects.toThrow(/shift_opening_reviews_difference_valid/);
  } finally { await f.close(); }
});
