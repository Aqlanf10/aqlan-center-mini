import { beforeAll, describe, expect, it, vi } from 'vitest';
import { asPaymentLikes, backupSqlLines, consumeStaffLoginAttempt, ensureSchema, getPool, openShift, patientDebtReport, patientLedger, recordPayment } from '../lib/db';
import { patientBalance } from '../lib/money';

beforeAll(async () => {
  vi.stubEnv('USE_LOCAL_DB', 'true');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('RAILWAY_PROJECT_ID', '');
  await ensureSchema();
}, 30000);

describe('release financial integrity', () => {
  it('keeps complete balances beyond the former invoice and payment limits', async () => {
    const pool = getPool();
    const { rows: [p] } = await pool.query(`INSERT INTO patients(patient_number,full_name) VALUES ('FIN-A','Synthetic A') RETURNING id`);
    await pool.query(`INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency)
      SELECT 'FIN-'||n,$1,100,0,'YER' FROM generate_series(1,101) n`, [p.id]);
    await openShift({ openedBy: 'test', opening: { YER: 0, SAR: 0, USD: 0 } });
    await pool.query(`INSERT INTO payments(receipt_number,patient_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by)
      SELECT 'FIN-R-'||n,$1,s.id,'payment',1,'YER',1,1,'YER','cash','test'
      FROM generate_series(1,201) n CROSS JOIN cashier_shifts s WHERE s.status='open'`, [p.id]);
    const ledger = await patientLedger(p.id);
    expect(ledger.invoices).toHaveLength(101);
    expect(ledger.payments).toHaveLength(201);
    const balance = patientBalance(ledger.invoices, asPaymentLikes(ledger.payments));
    expect(balance.dueMinor).toBe(9899);
    expect((await patientDebtReport()).find(x => x.patientId === p.id)?.dueMinor).toBe(balance.dueMinor);
  });
  it('rejects cross-patient and cancelled invoice payments without writing a receipt', async () => {
    const pool = getPool();
    const { rows: [p] } = await pool.query(`INSERT INTO patients(patient_number,full_name) VALUES ('FIN-B','Synthetic B') RETURNING id`);
    const { rows: [invoice] } = await pool.query(`SELECT id,patient_id FROM invoices ORDER BY id LIMIT 1`);
    const payment = { patientId: p.id, invoiceId: invoice.id, kind: 'payment' as const, amountMinor: 100, currency: 'YER' as const, baseCurrency: 'YER' as const, exchangeRate: 1, method: 'cash', note: null, createdBy: 'test' };
    expect(await recordPayment(payment)).toEqual({ payment: null, reason: 'invalid_invoice' });
    await pool.query(`UPDATE invoices SET status='cancelled' WHERE id=$1`, [invoice.id]);
    expect(await recordPayment({ ...payment, patientId: invoice.patient_id })).toEqual({ payment: null, reason: 'invalid_invoice' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1`, [invoice.id])).rows[0].n).toBe(0);
  });
  it('limits login attempts atomically and permits attempts after the window expires', async () => {
    for (let n=0; n<5; n++) expect((await consumeStaffLoginAttempt('synthetic')).allowed).toBe(true);
    expect((await consumeStaffLoginAttempt('synthetic')).allowed).toBe(false);
    await getPool().query(`UPDATE staff_login_limits SET window_started_at=NOW()-INTERVAL '16 minutes' WHERE account_key='synthetic'`);
    expect((await consumeStaffLoginAttempt('synthetic')).allowed).toBe(true);
  });
});

describe('backup source transaction lifecycle', () => {
  it('starts one read snapshot and commits only after the export completes', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const lines: string[] = [];
    for await (const line of backupSqlLines({ query })) lines.push(line);
    expect(query.mock.calls[0]?.[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(lines.join('')).toContain('COMMIT;');
  });
  it('rolls back the source snapshot when a download is abandoned', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    for await (const _line of backupSqlLines({ query })) break;
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
