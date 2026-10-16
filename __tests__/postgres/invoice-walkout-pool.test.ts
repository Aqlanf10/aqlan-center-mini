import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db");
const originalMax = process.env.DB_POOL_MAX;
let patientId: number, visitId: number, invoiceId: number;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!); await db.ensureSchema();
  patientId = (await db.getPool().query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-WALKOUT-POOL','Synthetic walkout small pool') RETURNING id")).rows[0].id;
  const invoice = await db.createInvoice({ patientId, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "synthetic-pool",
    items: [{ serviceId: null, doctorId: null, description: "Synthetic small-pool invoice", quantity: 1, unitPriceMinor: 1000 }] });
  if (!invoice) throw new Error("Synthetic invoice missing"); invoiceId = invoice.id;
  visitId = (await db.getPool().query("INSERT INTO visits(patient_id,patient_name,invoice_id,signed_at,status) VALUES($1,'Synthetic walkout small pool',$2,NOW(),'done') RETURNING id", [patientId, invoiceId])).rows[0].id;
}, 180000);
afterAll(async () => { vi.restoreAllMocks(); await db.resetPoolForTesting(); if (originalMax === undefined) delete process.env.DB_POOL_MAX; else process.env.DB_POOL_MAX = originalMax; });

it.each([1, 3])("finishes %i concurrent actual walkouts with no second connection at pool capacity", async capacity => {
  await db.resetPoolForTesting();
  if (capacity === 1) process.env.DB_POOL_MAX = "1"; else delete process.env.DB_POOL_MAX; // supported default is3
  await db.ensureSchema();
  const pool = db.getPool() as ReturnType<typeof db.getPool> & { options: { max: number }; waitingCount: number };
  expect(pool.options.max).toBe(capacity);
  // Hold only delivery of the real owner SELECT results until every requested
  // snapshot owns its pool connection. This deterministically fills max3 too.
  let reads = 0, release!: () => void;
  const allOwnersRead = new Promise<void>(resolve => { release = resolve; }), original = Client.prototype.query;
  const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function(this: Client, ...args: unknown[]) {
    const text = typeof args[0] === "string" ? args[0].replace(/\s+/g, " ") : "", values = Array.isArray(args[1]) ? args[1] : [];
    if (values[0] !== visitId || !text.includes("FROM visits v") || !text.includes("WHERE v.id = $1")) return Reflect.apply(original, this, args);
    const delivered = () => { if (++reads === capacity) release(); return allOwnersRead; };
    const callback = typeof args.at(-1) === "function" ? args.at(-1) as (error: unknown, result?: unknown) => void : null;
    if (callback) return Reflect.apply(original, this, [...args.slice(0, -1), (error: unknown, result: unknown) => {
      if (error) callback(error); else void delivered().then(() => callback(null, result));
    }]);
    return Promise.resolve(Reflect.apply(original, this, args)).then(async result => { await delivered(); return result; });
  } as typeof original);
  const started = Date.now();
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: capacity }, () => db.visitWalkout(visitId)));
    console.info("SYNTHETIC_WALKOUT_POOL_WITNESS", JSON.stringify({ capacity, ownerReads: reads, milliseconds: Date.now() - started, outcomes: outcomes.map(row => row.status === "fulfilled" ? "fulfilled" : String(row.reason)), waitingCount: pool.waitingCount }));
    expect(reads).toBe(capacity); expect(outcomes.map(row => row.status)).toEqual(Array(capacity).fill("fulfilled"));
    for (const row of outcomes) if (row.status === "fulfilled") expect(row.value).toMatchObject({ visitId, patientId, invoice: { id: invoiceId, netMinor: 1000 }, checkout: { invoicePaidMinor: 0, current: { YER: 1000 } } });
    expect(pool.waitingCount).toBe(0);
  } finally { release(); spy.mockRestore(); }
});
