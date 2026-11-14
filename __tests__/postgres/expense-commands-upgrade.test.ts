import { expect, it } from "vitest";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { openPeriodontalFixture } from "./_periodontal-fixture";

// docs/finance/EXPENSE_COMMANDS_0128.md §3 (owner #483 6831365228; number allocated in 6833690789).
// Upgrade from the head pushed before 0128 existed (0126 then 0132) with existing vouchers. Nothing is
// backfilled: an old voucher keeps NULL in every new column and still reads as fully paid from the drawer.
it("adds 0128 to a populated database that already has 0132, leaving existing vouchers unchanged", async () => {
  const f = await openPeriodontalFixture(process.env, { pristine: true });
  try {
    const files = await loadMigrationFiles();
    await migrate(f.pool, { apply: true, files: files.filter((file) => file.version !== "0128") });
    const [{ id: shift }] = (await f.pool.query(`INSERT INTO cashier_shifts(opened_by, opening_yer, opening_sar, opening_usd)
      VALUES('synthetic', 1000, 0, 0) RETURNING id`)).rows;
    await f.pool.query(`INSERT INTO expenses(voucher_number, category, payee_text, shift_id, amount_minor, currency, base_amount_minor, created_by)
      VALUES('SYN-UPG-1','other','SYN payee',$1,250,'YER',250,'synthetic'),('SYN-UPG-2','other','SYN payee',$1,40,'YER',40,'synthetic')`, [shift]);
    const before = (await f.pool.query("SELECT to_jsonb(e)::text AS row FROM expenses e ORDER BY id")).rows;
    await migrate(f.pool, { apply: true, files });
    const added = ["idempotency_key", "idempotency_request_hash", "payment_source", "drawer_amount_minor",
      "owner_private_amount_minor", "owner_private_reason", "owner_private_user_id", "owner_private_account_code"];
    expect((await f.pool.query(`SELECT (to_jsonb(e) - $1::text[])::text AS row FROM expenses e ORDER BY id`, [added])).rows).toEqual(before);
    expect((await f.pool.query(`SELECT ${added.join(", ")} FROM expenses ORDER BY id`)).rows)
      .toEqual([0, 1].map(() => Object.fromEntries(added.map((column) => [column, null]))));
    expect((await f.pool.query("SELECT version FROM schema_migrations WHERE version BETWEEN '0126' AND '0139' ORDER BY version")).rows)
      .toEqual([{ version: "0126" }, { version: "0128" }, { version: "0132" }]);
    await migrate(f.pool, { apply: true, files });
    expect((await f.pool.query("SELECT count(*)::int AS n FROM schema_migrations WHERE version='0128'")).rows).toEqual([{ n: 1 }]);
    // An old voucher cannot be given a key or a source afterwards.
    await expect(f.pool.query("UPDATE expenses SET payment_source='drawer', drawer_amount_minor=amount_minor, owner_private_amount_minor=0 WHERE voucher_number='SYN-UPG-1'"))
      .rejects.toThrow(/append-only/);
  } finally { await f.close(); }
});
