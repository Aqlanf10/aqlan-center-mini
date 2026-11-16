/** M2 slice 26: the existing drawer rules under canonical admission, on an owned
 * synthetic PG database. No schema/runtime installation on a real target. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool, type PoolConfig } from "pg";
import type { CashierShift } from "../../lib/db";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { toInputAmount } from "../../lib/money";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-shifts-20261030");
const db = await import("../../lib/db");
const shifts = await import("../../lib/canonical-shifts");
const { runCanonicalReadSnapshot } = await import("../../lib/canonical-read-snapshot");
const { readReceiptProvenance, readReceiptProvenanceWith, readReceiptProvenanceInSnapshot } = await import("../../lib/receipt-provenance-db");
const GRANTS = { "finance.shifts.view": true, "finance.shifts.operate": true };
const ACCOUNTS = {
  owner: { username: "SYN-SHIFT-OWNER", role: "admin" },
  operator: { username: "SYN-SHIFT-OPERATOR", role: "reception", grants: GRANTS },
  doctor: { username: "SYN-SHIFT-DOCTOR", role: "doctor", doctor: true, patientScope: "own", grants: GRANTS },
  reader: { username: "SYN-SHIFT-READER", role: "accountant", grants: { "finance.shifts.view": true } },
  ungrantedAdmin: { username: "SYN-SHIFT-ADMIN", role: "admin", grants: {} },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let side: Pool;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const auditCount = async () => Number((await q("SELECT count(*) FROM audit_log WHERE action IN ('shift.open','shift.close')"))[0].count);
const moneySnapshot = async () => (await q(`SELECT
  (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p) AS payments,
  (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM expenses e) AS expenses`))[0];
const counted = (a: CashierShift["expected"]) => ({ YER: toInputAmount(a.YER, "YER"), SAR: toInputAmount(a.SAR, "SAR"), USD: toInputAmount(a.USD, "USD") });
const open = async (key: Key = "operator", opening = { YER: "1000", SAR: "0", USD: "0" }) =>
  shifts.commandCanonicalShiftOpen(await fx.session(key), { opening, openedBy: "forged-actor" });
const close = async (shift: CashierShift, key: Key = "operator") =>
  shifts.commandCanonicalShiftClose(await fx.session(key), { id: shift.id, counted: counted(shift.expected), closedBy: "forged-actor" });
async function provenanceFixture(number: string) {
  await open();
  const patientId = (await q("INSERT INTO patients(patient_number,full_name) VALUES ($1,'Synthetic provenance patient') RETURNING id", [number]))[0].id;
  const result = await db.recordPayment({ patientId, invoiceId: null, kind: "payment", amountMinor: 100, currency: "YER", exchangeRate: 1, baseCurrency: "YER", method: "cash", note: null, createdBy: "synthetic-provenance-fixture" });
  expect(result.reason).toBeNull();
  return [result.payment!.id];
}

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  side = new Pool({ ...(fx.pool as unknown as { options: PoolConfig }).options, max: 6 });
}, 180_000);
beforeEach(async () => {
  const current = await db.getOpenShiftWith(fx.pool);
  if (current) await shifts.commandCanonicalShiftClose(await fx.session("owner"), { id: current.id, counted: counted(current.expected), differenceReason: "synthetic cleanup" });
});
afterAll(async () => { await side?.end(); await fx?.close(); });

describe("canonical shift commands", () => {
  it("uses the exact grant, never the role label; captures the actor and three currencies atomically", async () => {
    for (const key of ["reader", "ungrantedAdmin"] as const) await expect(open(key)).rejects.toThrow(/CAPABILITY_DENIED/);
    const before = await auditCount();
    const shift = await open("doctor", { YER: "١٠٠٠", SAR: "12.34", USD: "56.78" });
    expect(shift).toMatchObject({ opening: { YER: 1000, SAR: 1234, USD: 5678 }, openedBy: ACCOUNTS.doctor.username });
    expect(await auditCount()).toBe(before + 1);
    expect((await q("SELECT actor, actor_role, details FROM audit_log WHERE action='shift.open' ORDER BY id DESC LIMIT 1"))[0])
      .toMatchObject({ actor: ACCOUNTS.doctor.username, actor_role: "doctor", details: { الافتتاحي: shift.opening } });
    expect(await close(shift, "doctor")).toMatchObject({ status: "closed", expected: shift.opening, difference: { YER: 0, SAR: 0, USD: 0 }, closedBy: ACCOUNTS.doctor.username });
    expect(await auditCount()).toBe(before + 2);
  });

  it("serializes double open and double close: one effect and one audit, other attempt conflicts", async () => {
    const session = await fx.session("operator"), before = await auditCount();
    const opened = await Promise.allSettled([shifts.commandCanonicalShiftOpen(session, {}), shifts.commandCanonicalShiftOpen(session, {})]);
    expect(opened.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(opened.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "shift_already_open", status: 409 } });
    expect(await auditCount()).toBe(before + 1);
    const shift = (await db.getOpenShiftWith(fx.pool))!;
    const closed = await Promise.allSettled([close(shift), close(shift)]);
    expect(closed.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(closed.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "shift_not_open", status: 409 } });
    expect(await auditCount()).toBe(before + 2);
  });

  it("preserves the drawer equation, excludes transfers, and never changes money rows while closing", async () => {
    const shift = await open();
    const patientId = (await q("INSERT INTO patients(patient_number,full_name) VALUES ('SYN-SHIFT-P1','Synthetic drawer patient') RETURNING id"))[0].id;
    const payment = await db.recordPayment({ patientId, invoiceId: null, kind: "payment", amountMinor: 100, currency: "YER", exchangeRate: 1, baseCurrency: "YER", method: "cash", note: null, createdBy: "synthetic-money-fixture" });
    expect(payment.reason).toBeNull();
    const refund = await db.recordPayment({ patientId, invoiceId: null, kind: "refund", reversalOfId: payment.payment!.id, amountMinor: 20, currency: "YER", exchangeRate: 1, baseCurrency: "YER", method: "cash", note: null, createdBy: "synthetic-money-fixture" });
    expect(refund.reason).toBeNull();
    expect((await db.recordPayment({ patientId, invoiceId: null, kind: "payment", amountMinor: 500, currency: "YER", exchangeRate: 1, baseCurrency: "YER", method: "transfer", note: null, createdBy: "synthetic-money-fixture" })).reason).toBeNull();
    expect((await db.recordExpense({ category: "other", partyId: null, payableId: null, payeeText: "Synthetic expense", amountMinor: 10, currency: "YER", exchangeRate: 1, baseCurrency: "YER", note: null, createdBy: "synthetic-money-fixture" })).reason).toBeNull();
    const before = await moneySnapshot(), audits = await auditCount();
    const body = { id: shift.id, counted: { YER: "1060" } };
    await expect(shifts.commandCanonicalShiftClose(await fx.session("operator"), body)).rejects.toMatchObject({
      code: "difference_reason_required", expected: { YER: 1070, SAR: 0, USD: 0 }, difference: { YER: -10, SAR: 0, USD: 0 } });
    expect(await auditCount()).toBe(audits);
    expect((await db.getOpenShiftWith(fx.pool))?.id).toBe(shift.id);
    const closed = await shifts.commandCanonicalShiftClose(await fx.session("operator"), { ...body, differenceReason: "سبب الفرق", expected: { YER: 0 } });
    expect(closed).toMatchObject({ expected: { YER: 1070, SAR: 0, USD: 0 }, expectedSource: "stored", difference: { YER: -10, SAR: 0, USD: 0 } });
    expect(await moneySnapshot()).toEqual(before);
    expect(await auditCount()).toBe(audits + 1);
    await expect(close(closed!)).rejects.toMatchObject({ code: "shift_not_open" });
    expect(await auditCount()).toBe(audits + 1);
  });

  it.each(["shift.open", "shift.close"])("rolls the whole %s effect back when its audit fails", async action => {
    const shift = action === "shift.close" ? await open() : null;
    const before = await q("SELECT * FROM cashier_shifts ORDER BY id"), audits = await auditCount();
    await q(`ALTER TABLE audit_log ADD CONSTRAINT synthetic_shift_audit_failure CHECK (action <> '${action}') NOT VALID`);
    try { await expect(shift ? close(shift) : open()).rejects.toThrow(); }
    finally { await q("ALTER TABLE audit_log DROP CONSTRAINT synthetic_shift_audit_failure"); }
    expect(await q("SELECT * FROM cashier_shifts ORDER BY id")).toEqual(before);
    expect(await auditCount()).toBe(audits);
  });

  it("waits for an actual in-flight payment writer and computes the drawer from its committed cash", async () => {
    const shift = await open();
    const patientId = (await q("INSERT INTO patients(patient_number,full_name) VALUES ('SYN-SHIFT-P2','Synthetic concurrent cash patient') RETURNING id"))[0].id;
    const pool = db.getPool(), connect = pool.connect.bind(pool);
    let releaseWriter!: () => void, reachedCommit!: () => void, writerPid = 0;
    const hold = new Promise<void>(resolve => { releaseWriter = resolve; });
    const reached = new Promise<void>(resolve => { reachedCommit = resolve; });
    const connectSpy = vi.spyOn(pool, "connect").mockImplementationOnce(async () => {
      const client = await connect(), query = client.query.bind(client), release = client.release.bind(client);
      writerPid = (await query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      let wrotePayment = false;
      const querySpy = vi.spyOn(client, "query").mockImplementation((async (sql: string, args?: unknown[]) => {
        if (sql.includes("INSERT INTO payments")) wrotePayment = true;
        if (sql === "COMMIT" && wrotePayment) { reachedCommit(); await hold; }
        return query(sql, args);
      }) as typeof client.query);
      const releaseSpy = vi.spyOn(client, "release").mockImplementation((destroy?: boolean) => {
        querySpy.mockRestore(); releaseSpy.mockRestore(); release(destroy);
      });
      return client;
    });
    const writing = db.recordPayment({ patientId, invoiceId: null, kind: "payment", amountMinor: 100, currency: "YER", exchangeRate: 1, baseCurrency: "YER", method: "cash", note: null, createdBy: "synthetic-concurrent-writer" });
    writing.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([reached, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("payment did not reach commit")), 10_000); })]);
      const closing = shifts.commandCanonicalShiftClose(await fx.session("operator"), { id: shift.id, counted: { YER: "1000" } });
      closing.catch(() => undefined);
      try { expect((await waitForBlockedBy(side, writerPid, 10_000)).length).toBeGreaterThan(0); }
      finally { releaseWriter(); }
      expect((await writing).reason).toBeNull();
      await expect(closing).rejects.toMatchObject({ code: "difference_reason_required", expected: { YER: 1100, SAR: 0, USD: 0 } });
      expect((await db.getOpenShiftWith(fx.pool))?.id).toBe(shift.id);
      expect(await close((await db.getOpenShiftWith(fx.pool))!)).toMatchObject({ expected: { YER: 1100, SAR: 0, USD: 0 }, difference: { YER: 0, SAR: 0, USD: 0 } });
    } finally { if (timer) clearTimeout(timer); releaseWriter(); await writing.catch(() => undefined); connectSpy.mockRestore(); }
  }, 20_000);

  it("denies expiry after a real shift-row lock wait before computing or writing the close", async () => {
    const shift = await open(), before = await auditCount(), holder = await side.connect();
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await holder.query("SELECT id FROM cashier_shifts WHERE id=$1 FOR UPDATE", [shift.id]);
      const pending = shifts.commandCanonicalShiftClose(await fx.session("operator", 1500), { id: shift.id, counted: counted(shift.expected) });
      pending.catch(() => undefined);
      try {
        expect((await waitForBlockedBy(side, pid, 10_000)).length).toBeGreaterThan(0);
        await new Promise(resolve => setTimeout(resolve, 1700));
      } finally { await holder.query("COMMIT"); }
      await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
      expect((await db.getOpenShiftWith(fx.pool))?.id).toBe(shift.id);
      expect(await auditCount()).toBe(before);
    } finally { await holder.query("ROLLBACK"); holder.release(); }
  }, 15_000);

  it("denies expiry after the no-row lifecycle lock wait before opening a shift", async () => {
    const before = await auditCount(), holder = await side.connect();
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.cashier-shift-lifecycle.v1"]);
      const pending = shifts.commandCanonicalShiftOpen(await fx.session("operator", 1500), {});
      pending.catch(() => undefined);
      try {
        expect((await waitForBlockedBy(side, pid, 10_000)).length).toBeGreaterThan(0);
        await new Promise(resolve => setTimeout(resolve, 1700));
      } finally { await holder.query("COMMIT"); }
      await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
      expect(await db.getOpenShiftWith(fx.pool)).toBeNull();
      expect(await auditCount()).toBe(before);
    } finally { await holder.query("ROLLBACK"); holder.release(); }
  }, 15_000);

  it("re-proves authority after waiting for an earlier revocation and refuses stale or now-ungranted sessions", async () => {
    const stale = await fx.session("operator"), before = await auditCount(), holder = await side.connect();
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
      await holder.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: {} }, 2)), fx.ids.operator]);
      const pending = shifts.commandCanonicalShiftOpen(stale, {});
      pending.catch(() => undefined);
      try { expect((await waitForBlockedBy(side, pid, 10_000)).length).toBeGreaterThan(0); }
      finally { await holder.query("COMMIT"); }
      await expect(pending).rejects.toThrow(/STAFF_OPERATION/);
      await expect(open()).rejects.toThrow(/CAPABILITY_DENIED/);
      expect(await db.getOpenShiftWith(fx.pool)).toBeNull();
      expect(await auditCount()).toBe(before);
    } finally { await holder.query("ROLLBACK"); holder.release(); await fx.setGrants("operator", GRANTS); }
  });

  it("rejects invalid monetary input without any shift or audit effect", async () => {
    const before = await q("SELECT * FROM cashier_shifts ORDER BY id"), audits = await auditCount();
    for (const opening of [[], "1", { YER: "-1" }, { SAR: "Infinity" }, { USD: true }, { USD: [] }, { USD: "999999999999999999999" }]) {
      await expect(shifts.commandCanonicalShiftOpen(await fx.session("operator"), { opening })).rejects.toMatchObject({ code: "invalid_shift", status: 400 });
    }
    for (const id of [true, [1], {}, 0, -1, 1.5, "invalid"]) {
      await expect(shifts.commandCanonicalShiftClose(await fx.session("operator"), { id })).rejects.toMatchObject({ code: "invalid_shift", status: 400 });
    }
    expect(await q("SELECT * FROM cashier_shifts ORDER BY id")).toEqual(before);
    expect(await auditCount()).toBe(audits);
  });

  it("keeps the snapshot control guard and reads identical provenance with SELECTs only", async () => {
    const owner = await fx.session("owner");
    const ids = await provenanceFixture("SYN-PROVENANCE-SNAPSHOT");
    const before = await moneySnapshot(), expected = await readReceiptProvenance(ids);
    // Negative control: the previously extracted helper tries SAVEPOINT and must
    // stay forbidden through the facade. Never relax that guard to wire shifts.
    await expect(runCanonicalReadSnapshot(owner, "finance.shifts.view", query => readReceiptProvenanceWith(query, ids),
      { errorPrefix: "STAFF_READ", maxBytes: 256 * 1024 })).rejects.toThrow(/READ_STATEMENT/);
    const statements: string[] = [];
    const answer = await runCanonicalReadSnapshot(owner, "finance.shifts.view", query => readReceiptProvenanceInSnapshot({
      query: ((sql: string, args?: unknown[]) => { statements.push(sql); return query.query(sql, args); }) as typeof query.query,
    }, ids), { errorPrefix: "STAFF_READ", maxBytes: 256 * 1024 });
    expect(answer).toEqual(expected);
    expect(statements).toHaveLength(2);
    expect(statements.every(sql => /^(WITH|SELECT)\b/.test(sql.trimStart()))).toBe(true);
    expect(await moneySnapshot()).toEqual(before);
  });

  it("a real audit-query failure aborts the owned snapshot and never publishes a partial success", async () => {
    const owner = await fx.session("owner"), ids = await provenanceFixture("SYN-PROVENANCE-FAILURE");
    const before = await moneySnapshot();
    await expect(runCanonicalReadSnapshot(owner, "finance.shifts.view", query => readReceiptProvenanceInSnapshot({
      query: ((sql: string, args?: unknown[]) => query.query(sql.includes("FROM audit_log") ? "SELECT 1/0" : sql, sql.includes("FROM audit_log") ? [] : args)) as typeof query.query,
    }, ids), { errorPrefix: "STAFF_READ", maxBytes: 256 * 1024 })).rejects.toThrow();
    expect(await runCanonicalReadSnapshot(owner, "finance.shifts.view", query => readReceiptProvenanceInSnapshot(query, ids),
      { errorPrefix: "STAFF_READ", maxBytes: 256 * 1024 })).toEqual(await readReceiptProvenance(ids));
    expect(await moneySnapshot()).toEqual(before);
  });
});
