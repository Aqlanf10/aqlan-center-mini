/**
 * P-01 AFTER proof — يزرع فواتير بثلاث عملات (A=100,000 YER، B=100,000 SAR،
 * C=10,000 USD) ويثبت الحالة المصححة: لا كمية `invoicedMinor` مختلطة أبدًا،
 * والقيم بكل عملة على حدة، والمديونية صفٌّ لكل (مريض × عملة).
 *
 *   node --import tsx scripts/p01-after-proof.mts
 */
import "../scripts/use-pglite.mjs";

const { getPool, ensureSchema, financeSummary, patientDebtReport, schemaReadyReset } =
  await import("../lib/db.ts");

const TODAY = new Date().toISOString().slice(0, 10);

await ensureSchema();
const pool = getPool();

const { rows: [patient] } = await pool.query(
  `INSERT INTO patients (patient_number, full_name) VALUES ('P01-AFTER', 'مريض P-01 AFTER') RETURNING id`,
);
const pid = patient.id;
await pool.query(
  `INSERT INTO invoices (invoice_number, patient_id, status, total_minor, discount_minor, base_currency, created_at) VALUES
     ('P01-A-INV-YER', $1, 'open', 100000, 0, 'YER', NOW()),
     ('P01-A-INV-SAR', $1, 'open', 100000, 0, 'SAR', NOW()),
     ('P01-A-INV-USD', $1, 'open', 10000, 0, 'USD', NOW())`,
  [pid],
);
await pool.query(
  `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor)
   SELECT id, NULL, 'تنظيف', 1, total_minor, total_minor FROM invoices WHERE patient_id = $1`,
  [pid],
);

const summary = await financeSummary(TODAY, TODAY);
const debts = await patientDebtReport();

console.log("=== AFTER: financeSummary (P-01) ===");
console.log("invoicedByCurrency:", JSON.stringify(summary.invoicedByCurrency));
console.log("'invoicedMinor' in payload:", "invoicedMinor" in summary, "  <-- يجب أن يكون false: العدد المختلط حُذف");
console.log("topServices:", JSON.stringify(summary.topServices));
console.log("invoiceCount:", summary.invoiceCount, "patientCount:", summary.patientCount);

console.log("\n=== AFTER: patientDebtReport (P-01) ===");
const patientRows = debts.filter((r) => r.patientId === pid);
console.log("debt rows for the patient:", JSON.stringify(patientRows.map((r) => ({
  currency: r.currency, billedMinor: r.billedMinor, dueMinor: r.dueMinor,
})), null, 2));
console.log("currencies:", patientRows.map((r) => r.currency).join(","), "  <-- ثلاثة دلاب، لا رقم واحد");

schemaReadyReset();
process.exit(0);
