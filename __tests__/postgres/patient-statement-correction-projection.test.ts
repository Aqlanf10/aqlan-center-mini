import { afterAll, beforeAll, expect, it } from 'vitest';
import type { SessionPayload } from '../../lib/auth';
import { toInputAmount } from '../../lib/money';
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from './_setup';

assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase('aqlan_statement_correction_projection');
const db = await import('../../lib/db');
const { projectPatientStatement } = await import('../../lib/patient-statement-projection');
const { clinicDateString } = await import('../../lib/schedule');
const auth = await import('../../lib/auth');
const revision = await import('../../lib/invoice-revision-db');
let session: SessionPayload;
beforeAll(async () => {
  await db.ensureSchema();
  const password = await auth.hashPassword('synthetic-statement-revision');
  const { rows: [user] } = await db.getPool().query("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('statement-revision','Synthetic statement revision',$1,'admin',TRUE) RETURNING id", [password]);
  session = { userId: user.id, username: 'statement-revision', role: 'admin', credentialVersion: auth.sessionCredentialVersion(password), expiresAt: Date.now() + 3_600_000 };
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


it.each([
  { target: 'YER' as const, paidMinor: 3000, refundMinor: 500, priceMinor: 9000, rate: 1 },
  { target: 'SAR' as const, paidMinor: 1000, refundMinor: 100, priceMinor: 30000, rate: 410 },
])('reads full and period patient statements after a modern YER -> $target revision without rewriting receipts', async ({ target, paidMinor, refundMinor, priceMinor, rate }) => {
  const { rows: [patient] } = await db.getPool().query("INSERT INTO patients(patient_number, full_name) VALUES($1,'Synthetic modern statement') RETURNING id", [`STATEMENT-MODERN-${target}`]);
  const invoice = await db.createInvoice({ patientId: patient.id, baseCurrency: 'YER', discountMinor: 0, note: 'PRIVATE-MODERN-NOTE', createdBy: session.username,
    items: [{ serviceId: null, doctorId: null, description: 'Synthetic modern treatment', quantity: 1, unitPriceMinor: 10000 }] });
  if (!invoice) throw new Error('Synthetic invoice missing');
  await db.getPool().query("UPDATE invoices SET created_at='2026-01-15T09:00:00Z' WHERE id=$1", [invoice.id]);
  const paid = await db.recordPayment({ patientId: patient.id, invoiceId: invoice.id, kind: 'payment', amountMinor: paidMinor, currency: target, baseCurrency: 'YER', exchangeRate: rate, method: 'cash', note: 'PRIVATE-MODERN-PAYMENT', createdBy: session.username });
  expect(paid.reason).toBeNull();
  const refund = await db.recordPayment({ patientId: patient.id, invoiceId: invoice.id, kind: 'refund', reversalOfId: paid.payment!.id,
    amountMinor: refundMinor, currency: target, baseCurrency: 'YER', exchangeRate: rate, method: 'cash', note: 'PRIVATE-REAL-REFUND', createdBy: session.username });
  expect(refund.reason).toBeNull();
  const receiptsBefore = (await db.getPool().query('SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1 ORDER BY id', [patient.id])).rows;
  const cashBefore = (await db.getOpenShift())!.expected;
  const view = await revision.readInvoiceRevision(invoice.id, session);
  const remainingMinor = priceMinor - paidMinor + refundMinor;
  await revision.reviseInvoice(invoice.id, {
    idempotencyKey: `statement-modern-${target}`, expectedSourceHash: view.sourceHash, reason: 'PRIVATE-MODERN-CORRECTION',
    ...(target === 'SAR' ? { currency: target } : {}),
    lines: [{ itemId: invoice.items[0].id, quantity: 1, unitPrice: toInputAmount(priceMinor, target) }],
    discount: '0', repaymentTerms: { mode: 'full', installments: [] }, expectedRemainingMinor: remainingMinor,
  }, session);
  const { rows: [audit] } = await db.getPool().query("SELECT details FROM audit_log WHERE action='invoice.correct' AND entity='invoice' AND entity_id=$1", [String(invoice.id)]);
  expect(audit.details).toMatchObject({ correctionId: expect.any(Number), correctedInvoiceId: expect.any(Number) });
  expect(audit.details).not.toHaveProperty('المريض');
  const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);
  // This is the same snapshot/evidence path used by /print/statement, not a hand-built proof.
  const snapshot = await db.patientStatementSnapshot(patient.id, today, { patientFacing: true });
  const input = { patientId: patient.id, ledger: snapshot.ledger, planCurrencies: snapshot.planCurrencies, evidence: snapshot.statementEvidence! };
  const projected = projectPatientStatement(input);
  expect(projected.balances).toEqual(db.ledgerBalancesByCurrency(patient.id, snapshot.ledger, snapshot.planCurrencies));
  expect(projected.balances[target].dueMinor).toBe(remainingMinor);
  if (target === 'SAR') expect(projected.balances.YER.dueMinor).toBe(0);
  expect(projected.invoices).toEqual([expect.objectContaining({ baseCurrency: target, netMinor: priceMinor })]);
  expect(projected.invoices[0].invoiceNumber).not.toBe(invoice.invoiceNumber);
  expect(projected.payments.map(row => row.receiptNumber).sort()).toEqual([paid.payment!.receiptNumber, refund.payment!.receiptNumber].sort());
  expect(projected.payments.find(row => row.receiptNumber === refund.payment!.receiptNumber)).toMatchObject({ label: 'استرداد', kind: 'refund', amountMinor: refundMinor });
  const period = projectPatientStatement(input, { from: '2026-01-01', to: today });
  expect(period.balances).toEqual(projected.balances);
  expect(period.period!.closing[target]).toBe(remainingMinor);
  expect(period.payments).toEqual(projected.payments);
  const before = projectPatientStatement(input, { from: '2026-01-01', to: '2026-01-31' });
  expect(before.invoices.map(row => row.invoiceNumber)).toEqual([invoice.invoiceNumber]);
  expect(before.balances.YER.dueMinor).toBe(10000);
  expect(before.payments).toEqual([]);
  expect(snapshot.ledger.invoices).toHaveLength(2);
  expect(snapshot.ledger.payments).toHaveLength(2);
  expect(snapshot.statementEvidence!.invoiceCorrections).toHaveLength(1);
  expect((await db.getPool().query('SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1 ORDER BY id', [patient.id])).rows).toEqual(receiptsBefore);
  expect((await db.getOpenShift())!.expected).toEqual(cashBefore);
  expect(JSON.stringify(projected)).not.toContain('PRIVATE-');
});
