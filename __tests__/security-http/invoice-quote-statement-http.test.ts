import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

// Browser-free witness for the hosted invoice-quote contract's saved statement.
// Use the real invoice writer and real SSR; no invoice rows are fabricated.
let h: Awaited<ReturnType<typeof harness>>, db: Client, serviceId: number, doctorId: number;
let prior: { key: string; value: string }[];
const keys = ["finance.rate.SAR", "finance.rate.USD"];
beforeAll(async () => {
  h = await harness();
  expect(new URL(h.seeded.dbUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  prior = (await db.query("SELECT key,value FROM settings WHERE key=ANY($1::text[])", [keys])).rows;
  await db.query("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','440'),('finance.rate.USD','2200') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
  doctorId = (await db.query("SELECT party_id FROM users WHERE username='secdoctora'")).rows[0].party_id;
  serviceId = (await db.query(`INSERT INTO services(name,category,price_minor,price_configured,is_active)
    VALUES ('Synthetic quote statement ortho','ortho',2200,TRUE,TRUE) RETURNING id`)).rows[0].id;
});
afterAll(async () => {
  if (db) {
    await db.query("DELETE FROM settings WHERE key=ANY($1::text[])", [keys]);
    for (const row of prior ?? []) await db.query("INSERT INTO settings(key,value) VALUES($1,$2)", [row.key, row.value]);
    await db.end();
  }
});
async function facts(patientId: number) {
  return (await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i WHERE patient_id=$1) AS invoices,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p WHERE patient_id=$1) AS payments,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM debt_repayment_arrangements a WHERE patient_id=$1) AS arrangements,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM debt_repayment_revisions r JOIN debt_repayment_arrangements a ON a.id=r.arrangement_id WHERE a.patient_id=$1) AS revisions`, [patientId])).rows[0];
}
describe("actual saved converted-quote invoice in statement SSR", () => {
  it.each(["admin", "reception"] as const)("%s reads the exact invoice header, amount and saved schedule without another write", async role => {
    const patientId = (await db.query(`INSERT INTO patients(patient_number,full_name)
      VALUES($1,'Synthetic quote statement patient') RETURNING id`, [`QUOTE-SSR-${role}-${Date.now()}`])).rows[0].id;
    const catalog = await (await authedGet("/api/services", h.sessions[role])).json();
    const quote = catalog.find((row: { id: number }) => row.id === serviceId).invoiceQuotes.SAR;
    expect(quote).toMatchObject({ source: "converted", rate: 440, minor: 500 });
    const body = JSON.stringify({ patientId, currency: "SAR", idempotencyKey: `quote-ssr-${patientId}`,
      items: [{ serviceId, doctorId, scope: "both", quantity: 1, price: "1500", catalogPriceMinor: null,
        priceQuote: quote, priceReason: "Synthetic explicit manual agreement" }],
      repaymentTerms: { mode: "installments", installments: [
        { dueDate: "2026-10-14", amountMinor: 49000, kind: "down_payment" },
        { dueDate: "2028-01-31", amountMinor: 33667, kind: "installment" },
        { dueDate: "2028-02-29", amountMinor: 33667, kind: "installment" },
        { dueDate: "2028-03-31", amountMinor: 33666, kind: "installment" },
      ] } });
    const created = await authedMutation("/api/invoices", h.sessions[role], "POST", body);
    expect(created.status).toBe(201);
    const invoice = await created.json();
    expect(invoice).toMatchObject({ totalMinor: 150000, baseCurrency: "SAR" });
    const replay = await authedMutation("/api/invoices", h.sessions[role], "POST", body);
    expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ id: invoice.id, replayed: true });
    const ledger = await (await authedGet(`/api/patients/${patientId}/ledger`, h.sessions[role])).json();
    expect(ledger.invoices).toHaveLength(1);
    expect(ledger.balances.SAR).toMatchObject({ billedMinor: 150000, collectedMinor: 0, dueMinor: 150000 });
    expect(ledger.balances.YER.dueMinor).toBe(0); expect(ledger.balances.USD.dueMinor).toBe(0);
    const before = await facts(patientId);
    expect(before.invoices).toHaveLength(1); expect(before.payments).toBeNull();
    expect(before.arrangements).toHaveLength(1); expect(before.revisions).toHaveLength(1);
    const statement = await authedGet(`/print/statement/${patientId}`, h.sessions[role]);
    expect(statement.status).toBe(200);
    const html = await statement.text();
    const tables = html.match(/<table\b[^>]*class="[^"]*statement-invoice[^"]*"[^>]*>[\s\S]*?<\/table>/g) ?? [];
    expect(tables).toHaveLength(1);
    const table = tables[0];
    if (!table) throw new Error("Missing saved invoice table");
    expect(table).toContain(`data-invoice-id="${invoice.id}"`);
    expect(table.match(/<thead>[\s\S]*?<\/thead>/)?.[0]).toContain(ledger.invoices[0].invoiceNumber);
    // Negative control: the old browser selector cannot find this real invoice.
    const bodyMarkup = table.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0];
    expect(bodyMarkup).toBeTypeOf("string");
    expect(bodyMarkup).not.toContain(ledger.invoices[0].invoiceNumber);
    expect(table).toContain("1,500.00"); expect(table).toContain("صافي الفاتورة بعد الخصم");
    expect(html).toContain("صافي المحصّل بعد الاستردادات وعكس السندات");
    const contract = await authedGet(`/print/plan/${before.arrangements[0].id}?source=debt-repayment&version=1`, h.sessions[role]);
    expect(contract.status).toBe(200);
    const contractHtml = await contract.text();
    expect(contractHtml).toContain('data-testid="saved-installment-contract"');
    for (const expected of ["490.00", "1,010.00", "SAR", "Synthetic quote statement patient"]) expect(contractHtml).toContain(expected);
    expect(await facts(patientId)).toEqual(before);
  });
});
