import { expect, it } from "vitest";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { openPeriodontalFixture } from "./_periodontal-fixture";

// Dot, #483 6867852606: upgrade from the integration line (chain ending at 0126) with existing sessions.
// No session gains a value: old rows read as "not recorded", never as "none". Re-running is a no-op.
it("upgrades a populated 0126 database without backfilling or changing existing sessions", async () => {
  const f = await openPeriodontalFixture(process.env, { pristine: true });
  try {
    const files = await loadMigrationFiles();
    expect(files.at(-1)?.version).toBe("0132");
    await migrate(f.pool, { apply: true, files: files.filter((file) => file.version <= "0126") });
    const patient = (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-AUX-UPGRADE','Synthetic upgrade') RETURNING id")).rows[0].id;
    const orthoCase = (await f.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'active','synthetic') RETURNING id", [patient])).rows[0].id;
    await f.pool.query(`INSERT INTO ortho_adjustments(case_id,done_on,upper_wire,elastics,done,next_weeks,recorded_by)
      VALUES($1,'2026-06-01','016 NiTi','class_ii','SYN historical session',4,'synthetic'),($1,'2026-07-01',NULL,'none',NULL,6,'synthetic')`, [orthoCase]);
    const before = (await f.pool.query("SELECT to_jsonb(a)::text AS row FROM ortho_adjustments a ORDER BY id")).rows;
    await migrate(f.pool, { apply: true, files });
    expect((await f.pool.query("SELECT (to_jsonb(a)-'auxiliaries'-'auxiliary_other')::text AS row FROM ortho_adjustments a ORDER BY id")).rows).toEqual(before);
    expect((await f.pool.query("SELECT auxiliaries, auxiliary_other FROM ortho_adjustments ORDER BY id")).rows)
      .toEqual([{ auxiliaries: null, auxiliary_other: null }, { auxiliaries: null, auxiliary_other: null }]);
    // 0128 (expense commands) applies on the way; 0127 and 0129–0131 stay empty: no placeholder version is recorded.
    expect((await f.pool.query("SELECT version FROM schema_migrations WHERE version BETWEEN '0126' AND '0139' ORDER BY version")).rows)
      .toEqual([{ version: "0126" }, { version: "0128" }, { version: "0132" }]);
    await migrate(f.pool, { apply: true, files });
    expect((await f.pool.query("SELECT count(*)::int AS n FROM schema_migrations WHERE version='0132'")).rows).toEqual([{ n: 1 }]);
    // An existing session can take a recorded value afterwards only in the normalized shape.
    await expect(f.pool.query("UPDATE ortho_adjustments SET auxiliaries='{forsus,herbst}' WHERE case_id=$1", [orthoCase])).rejects.toMatchObject({ code: "23514" });
  } finally { await f.close(); }
});
