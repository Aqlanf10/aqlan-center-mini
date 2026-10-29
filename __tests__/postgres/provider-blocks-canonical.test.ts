/** M2 slice 25: canonical provider blocks (GET/POST /api/provider-blocks, DELETE
 * /api/provider-blocks/[id]) on real PostgreSQL, synthetic data only. Reads follow the
 * appointment scope; writes are one admitted appointments.schedule.manage transaction
 * under the booking engine's day locks, with the audit row atomic. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { waitForBlockedBy } from "./_canonical-ready-fixture";
import { Pool, type PoolConfig } from "pg";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-provider-blocks-2026");
const db = await import("../../lib/db");
const blocks = await import("../../lib/canonical-provider-blocks");

const ACCOUNTS = {
  owner: { username: "SYN-PB-OWNER", role: "admin" },
  manager: { username: "SYN-PB-MANAGER", role: "reception", appointmentScope: "all", grants: { "appointments.schedule.manage": true } },
  reader: { username: "SYN-PB-READER", role: "reception", appointmentScope: "all", grants: {} },
  doctor: { username: "SYN-PB-DOCTOR", role: "doctor", doctor: true, appointmentScope: "own", grants: { "appointments.schedule.manage": true } },
  other: { username: "SYN-PB-OTHER", role: "doctor", doctor: true, appointmentScope: "own", grants: {} },
  noScope: { username: "SYN-PB-NOSCOPE", role: "reception", grants: { "appointments.schedule.manage": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const DAY = "2031-03-10";
/** A clinic-local wall time on DAY as an ISO instant (the clinic zone of the test run). */
const at = async (time: string, day = DAY) => ((await q("SELECT (($1::date + $2::time) AT TIME ZONE $3) AS t", [day, time, db.CLINIC_TIME_ZONE]))[0].t as Date).toISOString();
const refusal = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected refusal"); }, error => error);
const blockRows = async () => Number((await q("SELECT count(*) FROM provider_blocks"))[0].count);
const audits = async (action: string) => Number((await q("SELECT count(*) FROM audit_log WHERE action=$1", [action]))[0].count);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = (await q("INSERT INTO patients(patient_number,full_name,phone) VALUES ('SYN-PB-1','SYN Block Patient','0500000500') RETURNING id"))[0].id;
  await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,duration_minutes,status,doctor_id) VALUES ($1,$2,'10:00',30,'booked',$3),($1,$2,'13:00',30,'cancelled',$3)", [patient, DAY, fx.parties.doctor!]);
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("create", () => {
  it("a manager blocks any doctor: audited atomically with the overlap warning; the legacy list sees it", async () => {
    const before = await audits("provider_block.create");
    const created = await blocks.commandCanonicalProviderBlockCreate(await fx.session("manager"), { providerId: fx.parties.doctor, startsAt: await at("09:00"), endsAt: await at("12:00"), reason: "عملية في المستشفى" });
    expect(created).toMatchObject({ overlappingAppointments: 1 });
    expect(await audits("provider_block.create")).toBe(before + 1);
    const [audit] = await q("SELECT actor, details FROM audit_log WHERE action='provider_block.create' ORDER BY id DESC LIMIT 1");
    expect(audit).toMatchObject({ actor: "SYN-PB-MANAGER", details: { مواعيد_متداخلة: 1, السبب: "عملية في المستشفى" } });
    expect((await db.listProviderBlocks(fx.parties.doctor!, DAY)).map(block => block.id)).toContain(created.id);
  });
  it("an own-scope doctor blocks only itself; another doctor is refused; nothing is written", async () => {
    const mine = await blocks.commandCanonicalProviderBlockCreate(await fx.session("doctor"), { providerId: fx.parties.doctor, startsAt: await at("15:00"), endsAt: await at("16:00"), reason: "اجتماع" });
    expect(mine.overlappingAppointments).toBe(0);
    const count = await blockRows();
    expect(await refusal(blocks.commandCanonicalProviderBlockCreate(await fx.session("doctor"), { providerId: fx.parties.other, startsAt: await at("15:00"), endsAt: await at("16:00"), reason: "x" })))
      .toMatchObject({ code: "invalid_provider_block", status: 400 });
    expect(await blockRows()).toBe(count);
  });
  it("refuses bad input, an inactive or unknown doctor, an over-long block, and actors without the grant or a scope", async () => {
    const manager = await fx.session("manager"), count = await blockRows();
    const base = { providerId: fx.parties.other, startsAt: await at("09:00"), endsAt: await at("10:00"), reason: "سبب" };
    for (const body of [{ ...base, reason: "  " }, { ...base, endsAt: base.startsAt }, { ...base, startsAt: "not-a-time" }, { ...base, providerId: 0 },
      { ...base, providerId: 999_999 }, { ...base, endsAt: await at("09:00", "2031-07-01") }, { ...base, reason: "x".repeat(301) }]) {
      const error = await refusal(blocks.commandCanonicalProviderBlockCreate(manager, body));
      expect(error).toMatchObject({ code: "invalid_provider_block", status: 400 });
      expect(error.message).toMatch(/[؀-ۿ]/);
    }
    await q("UPDATE parties SET is_active=FALSE WHERE id=$1", [fx.parties.other!]);
    try {
      expect(await refusal(blocks.commandCanonicalProviderBlockCreate(manager, base))).toMatchObject({ code: "invalid_provider_block" });
    } finally { await q("UPDATE parties SET is_active=TRUE WHERE id=$1", [fx.parties.other!]); }
    await expect(blocks.commandCanonicalProviderBlockCreate(await fx.session("reader"), base)).rejects.toThrow("CAPABILITY_DENIED");
    await expect(blocks.commandCanonicalProviderBlockCreate(await fx.session("noScope"), base)).rejects.toThrow("RECORD_SCOPE_DENIED");
    expect(await blockRows()).toBe(count);
  });
  it("waits on the booking engine's day lock: a booking in flight for that day finishes first", async () => {
    // A side pool: the runtime pool is small, and the holder and the observer must not starve the writer.
    const side = new Pool({ ...(fx.pool as unknown as { options: PoolConfig }).options, max: 3 });
    const manager = await fx.session("manager");
    const body = { providerId: fx.parties.other, startsAt: await at("08:00", "2031-03-11"), endsAt: await at("09:00", "2031-03-11"), reason: "حجب" };
    const before = await blockRows();
    const holder = await side.connect();
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('appointments-day:' || $1))", ["2031-03-11"]);
      const pending = blocks.commandCanonicalProviderBlockCreate(manager, body);
      pending.catch(() => undefined);
      try {
        expect((await waitForBlockedBy(side, pid, 10_000)).length).toBeGreaterThan(0);
        expect(Number((await side.query("SELECT count(*) FROM provider_blocks")).rows[0].count)).toBe(before);
      } finally { await holder.query("COMMIT"); }
      expect(await pending).toMatchObject({ overlappingAppointments: 0 });
    } finally { holder.release(); await side.end(); }
  });
});

describe("read", () => {
  it("all scope reads any doctor; own reads itself only (another answers like a doctor without blocks); no scope is refused", async () => {
    const all = await blocks.readCanonicalProviderBlocks(await fx.session("reader"), fx.parties.doctor, DAY);
    expect(all.blocks.length).toBe(2);
    expect(all.canManage).toBe(false);
    expect(await blocks.readCanonicalProviderBlocks(await fx.session("doctor"), fx.parties.doctor, DAY)).toMatchObject({ canManage: true });
    expect((await blocks.readCanonicalProviderBlocks(await fx.session("doctor"), fx.parties.doctor, DAY)).blocks).toEqual(all.blocks);
    expect((await blocks.readCanonicalProviderBlocks(await fx.session("other"), fx.parties.doctor, DAY)).blocks).toEqual([]);
    expect((await blocks.readCanonicalProviderBlocks(await fx.session("other"), 999_999, DAY)).blocks).toEqual([]);
    await expect(blocks.readCanonicalProviderBlocks(await fx.session("noScope"), fx.parties.doctor, DAY)).rejects.toThrow(/SCOPE/);
    await expect(blocks.readCanonicalProviderBlocks(await fx.session("reader"), "x", DAY)).rejects.toMatchObject({ code: "invalid_provider_block" });
    await expect(blocks.readCanonicalProviderBlocks(await fx.session("reader"), fx.parties.doctor, "10-03-2031")).rejects.toMatchObject({ code: "invalid_provider_block" });
    // The same rows as the legacy read.
    expect(all.blocks).toEqual(await db.listProviderBlocks(fx.parties.doctor!, DAY));
  });
});

describe("day panel (no doctor given)", () => {
  it("lists every in-scope active doctor with its blocks; own scope lists only itself", async () => {
    const all = await blocks.readCanonicalProviderBlocks(await fx.session("manager"), null, DAY);
    expect(all.doctors?.map(doctor => doctor.id)).toEqual(expect.arrayContaining([fx.parties.doctor, fx.parties.other]));
    expect(all.blocks.every(block => block.providerId === fx.parties.doctor || block.providerId === fx.parties.other)).toBe(true);
    expect(all.blocks.length).toBe((await db.listProviderBlocks(fx.parties.doctor!, DAY)).length + (await db.listProviderBlocks(fx.parties.other!, DAY)).length);
    const own = await blocks.readCanonicalProviderBlocks(await fx.session("doctor"), "", DAY);
    expect(own.doctors?.map(doctor => doctor.id)).toEqual([fx.parties.doctor]);
    expect(own.blocks.every(block => block.providerId === fx.parties.doctor)).toBe(true);
  });
});

describe("cancel", () => {
  it("cancels once (a second is 409), audits atomically; another doctor's block reads like a missing one for own scope", async () => {
    const [{ id }] = await q("SELECT id::text FROM provider_blocks WHERE provider_id=$1 AND cancelled_at IS NULL ORDER BY id LIMIT 1", [fx.parties.doctor!]);
    const [{ id: otherId }] = await q("SELECT id::text FROM provider_blocks WHERE provider_id=$1 ORDER BY id LIMIT 1", [fx.parties.other!]);
    const outside = await refusal(blocks.commandCanonicalProviderBlockCancel(await fx.session("doctor"), otherId));
    const missing = await refusal(blocks.commandCanonicalProviderBlockCancel(await fx.session("doctor"), "999999"));
    expect(outside).toMatchObject({ code: "provider_block_not_found", status: 404 });
    expect([outside.code, outside.message]).toEqual([missing.code, missing.message]);
    const before = await audits("provider_block.cancel");
    expect(await blocks.commandCanonicalProviderBlockCancel(await fx.session("doctor"), id)).toEqual({ ok: true });
    expect(await refusal(blocks.commandCanonicalProviderBlockCancel(await fx.session("manager"), id))).toMatchObject({ code: "provider_block_conflict", status: 409 });
    expect(await audits("provider_block.cancel")).toBe(before + 1);
    expect((await q("SELECT cancelled_by FROM provider_blocks WHERE id=$1::bigint", [id]))[0].cancelled_by).toBe("SYN-PB-DOCTOR");
    expect(await refusal(blocks.commandCanonicalProviderBlockCancel(await fx.session("manager"), "abc"))).toMatchObject({ code: "invalid_provider_block" });
  });
  it("audit failure rolls the cancel back", async () => {
    const [{ id }] = await q("SELECT id::text FROM provider_blocks WHERE cancelled_at IS NULL ORDER BY id LIMIT 1");
    await q("ALTER TABLE audit_log ADD CONSTRAINT synthetic_pb_audit_block CHECK (action <> 'provider_block.cancel') NOT VALID");
    try {
      await expect(blocks.commandCanonicalProviderBlockCancel(await fx.session("manager"), id)).rejects.toThrow();
    } finally { await q("ALTER TABLE audit_log DROP CONSTRAINT synthetic_pb_audit_block"); }
    expect((await q("SELECT cancelled_at FROM provider_blocks WHERE id=$1::bigint", [id]))[0].cancelled_at).toBeNull();
  });
});
