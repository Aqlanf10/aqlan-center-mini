// Synthetic clinical/financial fixtures written by the DEPLOYED runtime's own writers (f2b5eef9),
// before any candidate code runs. Synthetic data only. Usage: tsx fixtures.mjs <deployed root>
const root = process.argv[2];
const tag = process.argv[3] ?? "";  // a second fixture set (e.g. after the upgrade) uses distinct synthetic numbers
if (!root) throw new Error("deployed runtime root required");
const db = await import(`${root}/lib/db.ts`);
const pool = db.getPool();
const q = async (sql, values = []) => (await pool.query(sql, values)).rows;
const actor = "synthetic-upgrade-proof";
let serial = 0;
const key = (label) => `upgrade-proof${tag}-${label}-${++serial}`;

await db.saveSettings({ "finance.rate.SAR": "140", "finance.rate.USD": "530" });
if (!(await q("SELECT 1 FROM cashier_shifts WHERE status='open'")).length) await db.openShift({ openedBy: actor, opening: { YER: 0, SAR: 0, USD: 0 } });
await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES($1,'crown',50000,TRUE,TRUE)", [`Synthetic upgrade crown${tag}`]);
const [{ id: doctorId }] = await q("INSERT INTO parties(kind,name) VALUES('doctor',$1) RETURNING id", [`Synthetic upgrade doctor${tag}`]);
const patients = [];
for (const n of [1, 2, 3]) patients.push((await q("INSERT INTO patients(patient_number,full_name) VALUES($1,$2) RETURNING id", [`UPG${tag}-${n}`, `Synthetic upgrade patient ${n}`]))[0].id);

const pay = async (input) => {
  const result = await db.recordPayment({ invoiceId: null, planId: null, openingCurrency: null, kind: "payment", baseCurrency: "YER",
    method: "cash", note: null, createdBy: actor, idempotencyKey: key("pay"), ...input });
  if (result.reason || !result.payment) throw new Error(`synthetic payment refused: ${result.reason}`);
  return result.payment;
};

// Invoices in each currency, with receipts and a genuine reversal.
for (const [currency, rate] of [["YER", 1], ["SAR", 140], ["USD", 530]]) {
  const invoice = await db.createInvoice({ patientId: patients[0], baseCurrency: currency, discountMinor: 1000, note: null, createdBy: actor,
    items: [{ serviceId: null, doctorId: null, description: `Synthetic ${currency} treatment`, quantity: 2, unitPriceMinor: 20000 }] });
  if (!invoice) throw new Error("synthetic invoice refused");
  const receipt = await pay({ patientId: patients[0], invoiceId: invoice.id, amountMinor: 15000, currency, exchangeRate: rate });
  await pay({ patientId: patients[0], invoiceId: invoice.id, kind: "refund", reversalOfId: receipt.id, amountMinor: 2000, currency, exchangeRate: rate });
}

// A consented treatment agreement with an installment and an on-account plan payment.
const planId = await db.createPlan({ patientId: patients[1], title: "Synthetic upgrade agreement", totalMinor: 300000, baseCurrency: "YER",
  startDate: "2026-10-01", note: null, createdBy: actor, installments: [{ number: 1, dueDate: "2026-11-01", amountMinor: 300000 }] });
if (planId === null) throw new Error("synthetic plan refused");
if (!(await db.recordPlanConsent({ planId, actor, note: null })).ok) throw new Error("synthetic consent refused");
await pay({ patientId: patients[1], planId, amountMinor: 50000, currency: "YER", exchangeRate: 1 });

// An opening balance with a current opening collection.
await db.setPatientOpeningBalance({ patientId: patients[2], currency: "YER", amountMinor: 120000, asOfDate: "2026-09-01",
  note: "Synthetic legacy balance", createdBy: actor, reason: "Synthetic upgrade proof" });
await pay({ patientId: patients[2], openingCurrency: "YER", amountMinor: 20000, currency: "YER", exchangeRate: 1 });

// Appointments (the table 0067 indexes), across patients, dates and times.
for (const [index, patientId] of patients.entries()) for (const day of ["2026-10-20", "2026-10-27"]) {
  await q("INSERT INTO appointments(patient_id,scheduled_date,scheduled_time,doctor_id,note) VALUES($1,$2,$3,$4,'Synthetic upgrade appointment')",
    [patientId, day, `${String(9 + index).padStart(2, "0")}:30`, doctorId]);
}

// An existing 0063 YER→SAR reclassification document with its event (validated by 0069's new CHECK),
// built exactly as the deployed runtime's own trigger-validated currency tests build it.
{
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const k = key("reclass");
    const [{ id: patientId }] = (await client.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic reclassified patient') RETURNING id", [k])).rows;
    const [{ id: originalId }] = (await client.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by) VALUES($1,$2,1400,0,'YER','cancelled',$3) RETURNING id", [`${k}-old`, patientId, actor])).rows;
    const [{ id: correctedId }] = (await client.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by) VALUES($1,$2,1000,0,'SAR','open',$3) RETURNING id", [`${k}-new`, patientId, actor])).rows;
    const [{ id: shiftId }] = (await client.query("SELECT id FROM cashier_shifts WHERE status='open'")).rows;
    const [{ id: paymentId }] = (await client.query(`INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by)
      VALUES($1,$2,$3,$4,'payment',1000,'SAR',140,1400,'YER','cash',$5) RETURNING id`, [`${k}-source`, patientId, originalId, shiftId, actor])).rows;
    const [{ id: correctionId }] = (await client.query(`INSERT INTO invoice_corrections(patient_id,currency,original_currency,original_invoice_id,corrected_invoice_id,idempotency_key,request_hash,reason,created_by)
      VALUES($1,'SAR','YER',$2,$3,$4,$5,'Synthetic currency correction',$6) RETURNING id`, [patientId, originalId, correctedId, `${k}-correction`, "a".repeat(64), actor])).rows;
    await client.query("INSERT INTO invoice_correction_receipts(correction_id,receipt) VALUES($1,$2::jsonb)", [correctionId, JSON.stringify({
      patientId, currency: "SAR", idempotencyKey: `${k}-correction`, createdBy: actor,
      original: { id: originalId, patientId, baseCurrency: "YER" }, corrected: { id: correctedId, patientId, baseCurrency: "SAR" } })]);
    const [{ id: documentId }] = (await client.query(`INSERT INTO invoice_settlement_reclassifications(correction_id,patient_id,source_currency,target_currency,source_invoice_ids)
      VALUES($1,$2,'YER','SAR',$3) RETURNING id`, [correctionId, patientId, [originalId]])).rows;
    await client.query(`INSERT INTO invoice_settlement_reclassification_events(reclassification_id,payment_id,direction,source_minor,target_minor,payment_snapshot)
      SELECT $1,id,1,base_amount_minor,amount_minor,to_jsonb(p) FROM payments p WHERE id=$2`, [documentId, paymentId]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

const counts = (await q(`SELECT (SELECT count(*)::int FROM patients) AS patients, (SELECT count(*)::int FROM invoices) AS invoices,
  (SELECT count(*)::int FROM invoice_items) AS invoice_items, (SELECT count(*)::int FROM payments) AS payments,
  (SELECT count(*)::int FROM treatment_plans) AS plans, (SELECT count(*)::int FROM patient_opening_balances) AS openings,
  (SELECT count(*)::int FROM appointments) AS appointments, (SELECT count(*)::int FROM invoice_settlement_reclassifications) AS reclassifications,
  (SELECT count(*)::int FROM audit_log) AS audit`))[0];
await db.resetPoolForTesting?.();
console.log(JSON.stringify({ fixtures: counts }));
process.exit(0);
