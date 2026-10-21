import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, harness } from "./_server";

// Real HTTP only. No browser, permission changes or non-synthetic data.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let doctorA: number, doctorB: number;
const FROM = "2024-03-01", TO = "2024-03-31";

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  async function id(sql: string, values: unknown[] = []) {
    return Number((await db.query<{ id: number }>(sql, values)).rows[0].id);
  }
  doctorA = await id("INSERT INTO parties(name,kind,commission_percent) VALUES('SYNTHETIC FIFO A','doctor',30) RETURNING id");
  doctorB = await id("INSERT INTO parties(name,kind,commission_percent) VALUES('SYNTHETIC FIFO B','doctor',40) RETURNING id");
  const patientId = await id("INSERT INTO patients(patient_number,full_name) VALUES('HTTP-PERFORMER-FIFO','SYNTHETIC FIFO patient') RETURNING id");
  const shift = await id("INSERT INTO cashier_shifts(opened_by) VALUES('secadmin') RETURNING id");
  for (const [index, performer, currency, collected] of [[1, doctorA, "YER", 4000], [2, doctorB, "YER", 0], [3, doctorB, "USD", 2000]] as const) {
    const invoice = await id(`INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by,created_at)
      VALUES($1,$2,10000,$3,'secadmin','2024-03-10T07:00:00Z') RETURNING id`, [`HTTP-PERFORMER-${index}`, patientId, currency]);
    await db.query(`INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor,doctor_id)
      VALUES($1,'SYNTHETIC FIFO work',1,10000,10000,$2)`, [invoice, performer]);
    if (collected) await db.query(`INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,
      exchange_rate,base_amount_minor,base_currency,method,created_by,created_at)
      VALUES($1,$2,$3,$4,'payment',$5,$6,1,$5,$6,'cash','secadmin','2024-03-11T07:00:00Z')`,
      [`HTTP-PERFORMER-R-${index}`, patientId, invoice, shift, collected, currency]);
  }
});
afterAll(async () => { await db?.end(); });

describe("performer commission HTTP projection", () => {
  it("returns stable per-performer per-currency totals", async () => {
    const response = await authedGet(`/api/finance/commissions?from=${FROM}&to=${TO}`, h.sessions.admin);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rows.filter((row: { doctorId: number }) => [doctorA, doctorB].includes(row.doctorId)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ doctorId: doctorA, currency: "YER", earnedMinor: 1200, dueMinor: 1200, balanceMinor: 1200 }),
        expect.objectContaining({ doctorId: doctorB, currency: "YER", earnedMinor: 0, dueMinor: 0 }),
        expect.objectContaining({ doctorId: doctorB, currency: "USD", earnedMinor: 800, dueMinor: 800 }),
      ]));
  });

  it("detail identifies the performer and declared policy and reconciles to the summary", async () => {
    const response = await authedGet(`/api/finance/commissions?detail=1&doctorId=${doctorA}&from=${FROM}&to=${TO}`, h.sessions.admin);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ doctorId: doctorA, currency: "YER", basis: "collected_cash",
      ruleSource: "default", percent: 30, invoiceCoveredMinor: 4000, earnedMinor: 1200 });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].earnedMinor).toBe(body.lines[0].earnedMinor);
  });
});
