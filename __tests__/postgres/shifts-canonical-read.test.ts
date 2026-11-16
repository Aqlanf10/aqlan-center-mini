/** Slice 26 read proof, on an owned synthetic PostgreSQL database only. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool, type PoolConfig } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-shift-reads-20261030");
const db = await import("../../lib/db");
const shifts = await import("../../lib/canonical-shifts");
const VIEW = { "finance.shifts.view": true };
const RECEIPTS = { ...VIEW, "finance.payments.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-SHIFT-READ-OWNER", role: "admin" },
  own: { username: "SYN-SHIFT-READ-OWN", role: "doctor", doctor: true, patientScope: "own", grants: RECEIPTS },
  reader: { username: "SYN-SHIFT-READ-ONLY", role: "reception", grants: VIEW },
  expenses: { username: "SYN-SHIFT-READ-EXPENSE", role: "reception", grants: { ...VIEW, "finance.expenses.view": true } },
  none: { username: "SYN-SHIFT-READ-NONE", role: "doctor", doctor: true, patientScope: "none", appointmentScope: "all", grants: RECEIPTS },
  all: { username: "SYN-SHIFT-READ-ALL", role: "reception", patientScope: "all", grants: RECEIPTS },
  admin: { username: "SYN-SHIFT-READ-ADMIN", role: "admin", grants: {} },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool;
let ownPatient: number, outsidePatient: number, ownPayment: number, outsidePayment: number, shiftId: number;
const read = async (key: Key) => shifts.readCanonicalShifts(await fx.session(key));
const payment = async (patientId: number, amountMinor: number, method = "cash", currency: "YER" | "SAR" | "USD" = "YER") => {
  const result = await db.recordPayment({ patientId, invoiceId: null, kind: "payment", amountMinor, currency, exchangeRate: 1, baseCurrency: currency, method, note: patientId === ownPatient ? "SYN-OWN-NOTE" : "SYN-OUTSIDE-NOTE", createdBy: "synthetic-shift-read-fixture" });
  expect(result.reason).toBeNull(); return result.payment!;
};
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  side = new Pool({ ...(fx.pool as unknown as { options: PoolConfig }).options, max: 4 });
  ownPatient = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-SR-OWN','SYN-OWN-PATIENT',$1) RETURNING id", [fx.parties.own])).rows[0].id;
  outsidePatient = (await fx.pool.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-SR-OUT','SYN-OUTSIDE-PATIENT') RETURNING id")).rows[0].id;
  const history = await shifts.commandCanonicalShiftOpen(await fx.session("owner"), {});
  await shifts.commandCanonicalShiftClose(await fx.session("owner"), { id: history.id, counted: { YER: "1" }, note: "SYN-PRIVATE-SHIFT-NOTE", differenceReason: "SYN-PRIVATE-DIFFERENCE" });
  shiftId = (await shifts.commandCanonicalShiftOpen(await fx.session("owner"), { opening: { YER: "100", SAR: "2", USD: "3" } })).id;
  ownPayment = (await payment(ownPatient, 40)).id;
  outsidePayment = (await payment(outsidePatient, 70)).id;
  await payment(outsidePatient, 900, "transfer");
  // Existing foreign-currency rows are read as stored; do not invent a new
  // on-account foreign-payment target or relax its writer policy for this test.
  await fx.pool.query(`INSERT INTO payments(receipt_number,patient_id,shift_id,kind,amount_minor,currency,base_amount_minor,method)
    VALUES('SYN-SR-SAR',$1,$3,'payment',100,'SAR',100,'cash'),('SYN-SR-USD',$2,$3,'payment',200,'USD',200,'cash')`, [ownPatient, outsidePatient, shiftId]);
  expect((await db.recordExpense({ category: "other", partyId: null, payableId: null, payeeText: "SYN-PRIVATE-PAYEE", amountMinor: 10, currency: "YER", exchangeRate: 1, baseCurrency: "YER", note: "SYN-PRIVATE-EXPENSE", createdBy: "synthetic-shift-read-fixture" })).reason).toBeNull();
}, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });

it("keeps every currency aggregate identical for all viewers, while the protected owner retains every detail", async () => {
  const owner = await read("owner");
  expect(owner.drawer).toMatchObject({ expected: { YER: 200, SAR: 300, USD: 500 }, cashIn: { YER: 110, SAR: 100, USD: 200 }, nonCashIn: { YER: 900, SAR: 0, USD: 0 } });
  expect(owner.payments).toHaveLength(5);
  expect(owner.expenses).toHaveLength(1);
  expect(owner.recent.some(row => row.note === "SYN-PRIVATE-SHIFT-NOTE")).toBe(true);
  expect(owner.projection).toEqual({ payments: true, expenses: true, notes: true, patientScope: "all" });
  for (const key of ["own", "reader", "expenses", "none", "all"] as const) {
    const feed = await read(key);
    expect(feed.drawer).toEqual(owner.drawer);
    expect(feed.open?.expected).toEqual(owner.open?.expected);
    expect(feed.canOperate).toBe(false);
    expect(JSON.stringify(feed)).not.toContain("SYN-PRIVATE-SHIFT-NOTE");
    expect(JSON.stringify(feed)).not.toContain("SYN-PRIVATE-DIFFERENCE");
    for (const row of feed.recent) { expect(row).not.toHaveProperty("note"); expect(row).not.toHaveProperty("differenceReason"); }
  }
});

it("intersects receipts with patient scope in SQL and never widens it from role or appointment scope", async () => {
  const own = await read("own"), all = await read("all");
  expect(own.payments).toHaveLength(2);
  expect(own.payments?.every(row => row.patientId === ownPatient)).toBe(true);
  expect(own.receiptProvenance).toHaveProperty(String(ownPayment));
  expect(own.receiptProvenance).not.toHaveProperty(String(outsidePayment));
  expect(JSON.stringify(own)).not.toMatch(/SYN-OUTSIDE|SYN-PRIVATE-PAYEE|SYN-PRIVATE-EXPENSE/);
  expect(all.payments).toHaveLength(5); // reception role + explicit all scope
  for (const key of ["reader", "none"] as const) {
    const feed = await read(key);
    for (const field of ["payments", "paymentsTruncated", "receiptProvenance", "expenses", "expensesTruncated"]) expect(feed).not.toHaveProperty(field);
    expect(JSON.stringify(feed)).not.toMatch(/SYN-OWN|SYN-OUTSIDE|SYN-PRIVATE/);
  }
  const expenses = await read("expenses");
  expect(expenses.expenses?.[0]).toMatchObject({ payeeText: "SYN-PRIVATE-PAYEE" });
  expect(expenses).not.toHaveProperty("payments");
  await expect(read("admin")).rejects.toThrow(/CAPABILITY_DENIED/);
});

it("leases one connection for proof, complete totals, scoped details and provenance; never falls back to pool.query", async () => {
  const session = await fx.session("own"), pool = db.getPool();
  const connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query");
  try {
    const feed = await shifts.readCanonicalShifts(session);
    expect(feed.payments).toHaveLength(2);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  } finally { connect.mockRestore(); query.mockRestore(); }
});

it("discards the entire read when the receipt query fails, then releases a usable connection", async () => {
  const session = await fx.session("own"), pool = db.getPool(), connect = pool.connect.bind(pool);
  const spy = vi.spyOn(pool, "connect").mockImplementationOnce(async () => {
    const client = await connect(), query = client.query.bind(client), release = client.release.bind(client);
    const qs = vi.spyOn(client, "query").mockImplementation((async (sql: string, args?: unknown[]) => {
      if (sql.includes("WHERE y.shift_id = $1")) return query("SELECT 1/0 AS synthetic_failed_receipt_read");
      return query(sql, args);
    }) as typeof client.query);
    const rs = vi.spyOn(client, "release").mockImplementation((destroy?: boolean) => { qs.mockRestore(); rs.mockRestore(); release(destroy); });
    return client;
  });
  try { await expect(shifts.readCanonicalShifts(session)).rejects.toThrow(); }
  finally { spy.mockRestore(); }
  expect((await read("own")).payments).toHaveLength(2);
});

it("refuses a session that expires while waiting for the read lifecycle fence", async () => {
  const session = await fx.session("reader", 1500), holder = await side.connect();
  try {
    await holder.query("BEGIN");
    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    const pending = shifts.readCanonicalShifts(session); pending.catch(() => undefined);
    try {
      expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0);
      await new Promise(resolve => setTimeout(resolve, 1700));
    } finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); }
});

it("keeps the first snapshot coherent when another connection adds cash and closes its shift between reads", async () => {
  const session = await fx.session("owner"), pool = db.getPool(), connect = pool.connect.bind(pool);
  let resume!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { resume = resolve; });
  const ready = new Promise<void>(resolve => { reached = resolve; });
  const spy = vi.spyOn(pool, "connect").mockImplementationOnce(async () => {
    const client = await connect(), query = client.query.bind(client), release = client.release.bind(client);
    let stopped = false;
    const qs = vi.spyOn(client, "query").mockImplementation((async (sql: string, args?: unknown[]) => {
      const result = await query(sql, args);
      if (!stopped && sql.includes("WHERE s.status = 'open'")) { stopped = true; reached(); await held; }
      return result;
    }) as typeof client.query);
    const rs = vi.spyOn(client, "release").mockImplementation((destroy?: boolean) => { qs.mockRestore(); rs.mockRestore(); release(destroy); });
    return client;
  });
  const pending = shifts.readCanonicalShifts(session); pending.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("snapshot barrier not reached")), 7000); })]);
    await payment(outsidePatient, 25);
    await shifts.commandCanonicalShiftClose(await fx.session("owner"), { id: shiftId, counted: { YER: "225", SAR: "3", USD: "5" } });
    resume();
    const before = await pending;
    expect(before.open?.id).toBe(shiftId);
    expect(before.open?.status).toBe("open");
    expect(before.drawer?.expected.YER).toBe(200);
    expect(before.payments).toHaveLength(5);
    expect(before.recent.find(row => row.id === shiftId)?.status).toBe("open");
    const after = await read("owner");
    expect(after.open).toBeNull(); expect(after.drawer).toBeNull(); expect(after.payments).toEqual([]);
    expect(after.recent.find(row => row.id === shiftId)).toMatchObject({ status: "closed", expected: { YER: 225, SAR: 300, USD: 500 } });
  } finally { resume(); if (timer) clearTimeout(timer); await pending.catch(() => undefined); spy.mockRestore(); }
}, 20_000);

it("re-proves after waiting behind a committed revocation, then refuses both stale claims and a new ungranted session", async () => {
  const stale = await fx.session("reader"), holder = await side.connect();
  try {
    await holder.query("BEGIN");
    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    await holder.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: {} }, 2)), fx.ids.reader]);
    const pending = shifts.readCanonicalShifts(stale); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); }
    finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow("STAFF_OPERATION_CREDENTIAL_OR_ACCOUNT_STALE");
    await expect(read("reader")).rejects.toThrow(/CAPABILITY_DENIED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); await fx.setGrants("reader", VIEW); }
});

it("a changed patient scope invalidates the old token and suppresses details in the newly admitted read", async () => {
  const stale = await fx.session("own");
  await fx.setGrants("own", RECEIPTS, { patientScope: "none", appointmentScope: "all" });
  try {
    await expect(shifts.readCanonicalShifts(stale)).rejects.toThrow("STAFF_OPERATION_CREDENTIAL_OR_ACCOUNT_STALE");
    const feed = await read("own");
    expect(feed.projection.payments).toBe(false); expect(feed).not.toHaveProperty("receiptProvenance");
  } finally { await fx.setGrants("own", RECEIPTS, { patientScope: "own" }); }
});

it("bounds only visible detail rows, without publishing hidden counts or changing full drawer totals", async () => {
  const shift = await shifts.commandCanonicalShiftOpen(await fx.session("owner"), {});
  // Synthetic bulk fixture, not a live financial writer or a policy change.
  await fx.pool.query(`INSERT INTO payments(receipt_number,patient_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,method,created_by)
    SELECT 'SYN-BOUND-OUT-'||n,$1,$2,'payment',1,'YER',1,1,'cash','synthetic' FROM generate_series(1,1002) n`, [outsidePatient, shift.id]);
  const before = await read("own");
  expect(before.payments).toEqual([]); expect(before.paymentsTruncated).toBe(false); expect(before.drawer?.expected.YER).toBe(1002);
  await fx.pool.query(`INSERT INTO payments(receipt_number,patient_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,method,created_by)
    SELECT 'SYN-BOUND-OWN-'||n,$1,$2,'payment',1,'YER',1,1,'cash','synthetic' FROM generate_series(1,1001) n`, [ownPatient, shift.id]);
  const after = await read("own");
  expect(after.payments).toHaveLength(shifts.SHIFT_DETAIL_LIMIT); expect(after.paymentsTruncated).toBe(true);
  expect(after.payments?.every(row => row.patientId === ownPatient)).toBe(true);
  expect(after.drawer?.expected.YER).toBe(2003);
  expect(Object.keys(after.receiptProvenance!)).toHaveLength(shifts.SHIFT_DETAIL_LIMIT);
});
