/** Slice 27: the waiting-room projection is public, never mutation admission.
 * Synthetic PostgreSQL only; no patient, account or setting in a live clinic. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-display-snapshot-20261030-only");
const db = await import("../../lib/db");
const route = await import("../../app/api/display/route");
let fx: CanonicalInventoryDatabase<"owner">;
const legacy = "SYN public title | SYN public text";
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, { owner: { username: "SYN-DISPLAY-OWNER", role: "admin" } }, "owner");
  await fx.pool.query("DELETE FROM display_announcements");
  await fx.pool.query("DELETE FROM settings WHERE key='display.announcements_migrated'");
  await fx.pool.query("INSERT INTO settings(key,value) VALUES('display.announcements',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [legacy]);
  db.invalidateSettingsCache();
}, 180_000);
afterAll(async () => { await fx?.close(); });

it("public GET preserves stored announcements and migration state on a canonical clinic", async () => {
  const before = (await fx.pool.query("SELECT key,value,updated_at FROM settings WHERE key LIKE 'display.%' ORDER BY key")).rows;
  const response = await route.GET();
  expect(response.status).toBe(200);
  expect((await response.json()).announcements).toEqual([{ title: "SYN public title", body: "SYN public text" }]);
  expect((await fx.pool.query("SELECT key,value,updated_at FROM settings WHERE key LIKE 'display.%' ORDER BY key")).rows).toEqual(before);
  expect((await fx.pool.query("SELECT count(*)::int AS count FROM display_announcements")).rows[0].count).toBe(0);
});

it("public response excludes production statistics, chair occupancy and upcoming patient lists", async () => {
  const response = await route.GET();
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(Object.keys(payload).sort()).toEqual(["now", "called", "delayNotice", "voice", "speech", "announcements", "welcomeText", "tagline"].sort());
});

it("reads privacy, current call and announcements on one read-only snapshot during a concurrent change", async () => {
  await fx.pool.query("INSERT INTO visits(patient_name,status,chair,called_at) VALUES('قديم مخفي','called',1,NOW())");
  await fx.pool.query("INSERT INTO settings(key,value) VALUES('display.privacy_mode','first_initial') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  const original = db.getSettingsWith;
  const spy = vi.spyOn(db, "getSettingsWith").mockImplementationOnce(async client => {
    const result = await original(client);
    expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    expect((await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
    await fx.pool.query("BEGIN");
    await fx.pool.query("UPDATE settings SET value='first_only' WHERE key='display.privacy_mode'");
    await fx.pool.query("UPDATE visits SET patient_name='جديد سري' WHERE status='called'");
    await fx.pool.query("COMMIT");
    return result;
  });
  try {
    const body = await (await route.GET()).json();
    expect(body.called).toEqual([expect.objectContaining({ name: "قديم م.", speechName: "قديم" })]);
  } finally { spy.mockRestore(); }
  expect((await (await route.GET()).json()).called[0].name).toBe("جديد");
});

it("changing completed visits, queue, chair occupancy, orthos and staff financial settings never changes the public projection", async () => {
  const before = await (await route.GET()).json(); delete before.now;
  await fx.pool.query("INSERT INTO visits(patient_name,status,chair) VALUES('SYN-DONE-HIDDEN','done',NULL),('SYN-WAITING-HIDDEN','waiting',NULL),('SYN-SEATED-HIDDEN','in_chair',2)");
  await fx.pool.query("INSERT INTO settings(key,value) VALUES('display.show_ortho','true'),('finance.rate.SAR','999'),('clinic.chairs','20') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  const patient = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,phone) VALUES('SYN-DISPLAY-ORTHO','SYN-ORTHO-HIDDEN','0559999999') RETURNING id")).rows[0].id;
  await fx.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,'active','SYN-DISPLAY-OWNER')", [patient]);
  await fx.pool.query("UPDATE users SET display_name='SYN-HIDDEN-STAFF-NAME' WHERE id=$1", [fx.ids.owner]);
  const after = await (await route.GET()).json(); delete after.now;
  expect(after).toEqual(before);
  expect(JSON.stringify(after)).not.toMatch(/SYN-(DONE|WAITING|SEATED)|999|inTreatment|avgWait|ortho|stats|queue|chairs/);
});

it("a canonical snapshot failure is generic and never falls back to migrating legacy readers", async () => {
  const spy = vi.spyOn(db, "currentPublicDisplayCallWith").mockRejectedValueOnce(new Error("SYN-PRIVATE-DB-DETAIL"));
  try {
    const response = await route.GET(); expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
    expect(await response.text()).not.toContain("SYN-PRIVATE-DB-DETAIL");
    expect((await fx.pool.query("SELECT value FROM settings WHERE key='display.announcements'")).rows[0].value).toBe(legacy);
  } finally { spy.mockRestore(); }
});
