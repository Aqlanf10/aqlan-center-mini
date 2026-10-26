import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from './_setup';

assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase('aqlan_statement_correction_projection');
const db = await import('../../lib/db');
const { projectPatientStatement } = await import('../../lib/patient-statement-projection');
const { clinicDateString } = await import('../../lib/schedule');
beforeAll(async () => {
  await db.ensureSchema();
  await db.openShift({ openedBy: 'synthetic-statement', opening: { YER: 0, SAR: 0, USD: 0 } });
});
afterAll(async () => db.resetPoolForTesting());

it('hides actual correction chains only in patient copies, retains real refunds and canonical balances', async () => {
  const { rows: [patient] } = await db.getPool().query("INSERT INTO patients(patient_number, full_name) VALUES('STATEMENT-CORRECTION','Synthetic statement correction') RETURNING id");
  const invoice = await db.createInvoice({ patientId: patient.id, baseCurrency: 'YER', discountMinor: 0, note: 'PRIVATE-NOTE', createdBy: 'synthetic',
    items: [{ serviceId: null, doctorId: null, description: 'Synthetic treatment', quantity: 1, unitPriceMinor: 10000 }] });
  expect(invoice).not.toBeNull();
  // Synthetic-only fixture: model an invoice issued before today's correction.
  await db.getPool().query("UPDATE invoices SET created_at='2026-01-15T09:00:00Z' WHERE id=$1", [invoice!.id]);
  const paid = await db.recordPayment({ patientId: patient.id, invoiceId: invoice!.id, kind: 'payment', amountMinor: 5000, currency: 'YER', baseCurrency: 'YER', exchangeRate: 1, method: 'cash', note: 'PRIVATE-NOTE', createdBy: 'synthetic' });
  expect(paid.reason).toBeNull();
  const corrected = await db.correctPayment({ paymentId: paid.payment!.id, reason: 'PRIVATE-CORRECTION-REASON', actor: 'synthetic', actorRole: 'admin',
    replacement: { amountMinor: 3000, currency: 'YER', exchangeRate: 1, method: 'cash', target: { kind: 'original' } } });
  expect(corrected.reason).toBeNull();
  if (corrected.reason !== null) throw new Error('Synthetic correction failed');
  const refund = await db.recordPayment({ patientId: patient.id, invoiceId: invoice!.id, kind: 'refund', reversalOfId: corrected.replacement!.id, amountMinor: 500, currency: 'YER', baseCurrency: 'YER', exchangeRate: 1, method: 'cash', note: 'PRIVATE-REFUND-NOTE', createdBy: 'synthetic' });
  expect(refund.reason).toBeNull();
  const invoiceCorrection = await db.correctInvoice({ invoiceId: invoice!.id, actor: 'synthetic', actorRole: 'admin', reason: 'PRIVATE-INVOICE-REASON',
    lines: [{ itemId: invoice!.items[0].id, quantity: 1, unitPriceMinor: 9000 }] });
  expect(invoiceCorrection.ok).toBe(true);
  const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);
  const snapshot = await db.patientStatementSnapshot(patient.id, today, { patientFacing: true });
  const projected = projectPatientStatement({ patientId: patient.id, ledger: snapshot.ledger, planCurrencies: snapshot.planCurrencies, evidence: snapshot.statementEvidence! });
  expect(projected.balances).toEqual(db.ledgerBalancesByCurrency(patient.id, snapshot.ledger, snapshot.planCurrencies));
  expect(projected.balances.YER.dueMinor).toBe(6500);
  const beforeCorrection = projectPatientStatement({ patientId: patient.id, ledger: snapshot.ledger, planCurrencies: snapshot.planCurrencies, evidence: snapshot.statementEvidence! }, { from: '2026-01-01', to: '2026-01-31' });
  expect(beforeCorrection.invoices.map(row => row.invoiceNumber)).toEqual([invoice!.invoiceNumber]);
  expect(beforeCorrection.balances.YER.dueMinor).toBe(10000);
  expect(beforeCorrection.period!.movements).toEqual([{ date: '2026-01-15', currency: 'YER', description: 'قيمة العلاج', debitMinor: 10000, creditMinor: 0, balanceMinor: 10000 }]);
  const afterCorrection = projectPatientStatement({ patientId: patient.id, ledger: snapshot.ledger, planCurrencies: snapshot.planCurrencies, evidence: snapshot.statementEvidence! }, { to: today });
  expect(afterCorrection.balances).toEqual(projected.balances);
  expect(projected.payments.map(row => row.receiptNumber).sort()).toEqual([corrected.replacement!.receiptNumber, refund.payment!.receiptNumber].sort());
  expect(projected.payments.find(row => row.receiptNumber === refund.payment!.receiptNumber)).toMatchObject({ label: 'استرداد', kind: 'refund', amountMinor: 500 });
  expect(projected.invoices).toHaveLength(1);
  expect(projected.invoices[0].invoiceNumber).not.toBe(invoice!.invoiceNumber);
  expect(projected.invoices[0].netMinor).toBe(9000);
  expect(snapshot.ledger.invoices).toHaveLength(2);
  expect(snapshot.ledger.payments).toHaveLength(4);
  expect(snapshot.statementEvidence!.paymentCorrections).toHaveLength(1);
  expect(snapshot.statementEvidence!.invoiceCorrections).toHaveLength(1);
  expect(JSON.stringify(projected)).not.toContain('PRIVATE-');
});
