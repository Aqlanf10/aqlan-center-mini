import { afterAll, beforeAll, expect, it } from 'vitest';
import type { SessionPayload } from '../../lib/auth';
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from './_setup';
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase('aqlan_statement_invoice_actions');
const db = await import('../../lib/db'), auth = await import('../../lib/auth');
const archive = await import('../../lib/invoice-archive-db');
const addition = await import('../../lib/invoice-add-service-db');
const { projectPatientStatement } = await import('../../lib/patient-statement-projection');
const { clinicDateString } = await import('../../lib/schedule');
const { toInputAmount } = await import('../../lib/money');
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let session: SessionPayload, serviceId: number, doctorId: number, serial = 0;
beforeAll(async () => {
  await db.ensureSchema();
  expect((await q("SELECT version FROM schema_migrations WHERE version IN ('0081','0082') ORDER BY version")).map(row => row.version)).toEqual(['0081', '0082']);
  const hash = await auth.hashPassword('synthetic-statement-actions');
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES('statement-actions','Synthetic statement actions',$1,'admin') RETURNING id", [hash]);
  session = { userId: user.id, username: 'statement-actions', role: 'admin', credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now() + 3600000 };
  doctorId = (await q("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic statement doctor') RETURNING id"))[0].id;
  serviceId = (await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('Synthetic added consultation','consultation',2000,TRUE,TRUE) RETURNING id"))[0].id;
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
});
afterAll(async () => db.resetPoolForTesting());
async function fixture(paid = 0) {
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic statement actions') RETURNING id", [`STATEMENT-ACTIONS-${++serial}`]);
  const invoice = await db.createInvoice({ patientId: patient.id, baseCurrency: 'YER', discountMinor: 0, note: null, createdBy: session.username,
    items: [{ serviceId: null, doctorId, description: 'Synthetic original treatment', quantity: 1, unitPriceMinor: 10000 }] });
  if (!invoice) throw new Error('Synthetic invoice missing');
  await q("UPDATE invoices SET created_at='2026-01-15T09:00:00Z' WHERE id=$1", [invoice.id]);
  let paymentId: number | undefined;
  if (paid) {
    const result = await db.recordPayment({ patientId: patient.id, invoiceId: invoice.id, kind: 'payment', amountMinor: paid, currency: 'YER', baseCurrency: 'YER', exchangeRate: 1, method: 'cash', note: null, createdBy: session.username });
    expect(result.reason).toBeNull(); paymentId = result.payment!.id;
  }
  return { invoice, paymentId };
}
async function view(patientId: number) {
  const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);
  const snapshot = await db.patientStatementSnapshot(patientId, today, { patientFacing: true });
  const input = { patientId, ledger: snapshot.ledger, planCurrencies: snapshot.planCurrencies, evidence: snapshot.statementEvidence! };
  return { today, snapshot, input, projected: projectPatientStatement(input) };
}
it('paid-policy archive remains in statement totals when a later real refund creates debt', async () => {
  const { invoice, paymentId } = await fixture(10000);
  await archive.changeInvoiceArchive(invoice.id, { action: 'archive', expectedVersion: 0, reason: 'Synthetic documentary archive', idempotencyKey: 'statement-archive-once' }, session);
  const paid = await view(invoice.patientId);
  expect(paid.projected.invoices.map(row => row.invoiceNumber)).toEqual([invoice.invoiceNumber]);
  expect(paid.projected.balances.YER).toMatchObject({ billedMinor: 10000, collectedMinor: 10000, dueMinor: 0 });
  const refund = await db.recordPayment({ patientId: invoice.patientId, invoiceId: invoice.id, reversalOfId: paymentId, kind: 'refund', amountMinor: 1000, currency: 'YER', baseCurrency: 'YER', exchangeRate: 1, method: 'cash', note: null, createdBy: session.username });
  expect(refund.reason).toBeNull();
  expect(await archive.readInvoiceArchive(invoice.id, session)).toMatchObject({ archived: true });
  const after = await view(invoice.patientId);
  expect(after.projected.invoices).toHaveLength(1);
  expect(after.projected.balances.YER).toMatchObject({ billedMinor: 10000, collectedMinor: 9000, dueMinor: 1000 });
  expect(after.projected.payments.find(row => row.receiptNumber === refund.payment!.receiptNumber)).toMatchObject({ kind: 'refund', label: 'استرداد', amountMinor: 1000 });
  expect(after.projected.balances).toEqual(db.ledgerBalancesByCurrency(invoice.patientId, after.snapshot.ledger, after.snapshot.planCurrencies));
});
it('dated service supplement adds only new principal and leaves prior-period original unchanged', async () => {
  const { invoice } = await fixture();
  const source = await addition.readInvoiceAddService(invoice.id, session);
  const added = await addition.addInvoiceService(invoice.id, { idempotencyKey: 'statement-supplement-once', expectedSourceHash: source.sourceHash, reason: 'Synthetic new treatment', serviceId, doctorId, price: toInputAmount(2000, 'YER'), priceReason: null, discount: '0', discountReason: null, currency: 'YER' }, session);
  const after = await view(invoice.patientId);
  expect(after.projected.invoices.map(row => row.invoiceNumber).sort()).toEqual([invoice.invoiceNumber, added.additionalInvoiceNumber].sort());
  expect(after.projected.balances.YER).toMatchObject({ billedMinor: 12000, collectedMinor: 0, dueMinor: 12000 });
  const past = projectPatientStatement(after.input, { from: '2026-01-01', to: '2026-01-31' });
  expect(past.invoices.map(row => row.invoiceNumber)).toEqual([invoice.invoiceNumber]);
  expect(past.balances.YER.dueMinor).toBe(10000);
  const currentDay = projectPatientStatement(after.input, { from: after.today, to: after.today });
  expect(currentDay.period!.opening.YER).toBe(10000);
  expect(currentDay.period!.closing.YER).toBe(12000);
  expect(currentDay.period!.movements).toEqual([{ date: after.today, currency: 'YER', description: 'قيمة العلاج', debitMinor: 2000, creditMinor: 0, balanceMinor: 12000 }]);
  expect(after.snapshot.ledger.payments).toHaveLength(0);
  expect(after.snapshot.statementEvidence!.invoiceCorrections).toHaveLength(0);
  expect(after.projected.balances).toEqual(db.ledgerBalancesByCurrency(invoice.patientId, after.snapshot.ledger, after.snapshot.planCurrencies));
});
