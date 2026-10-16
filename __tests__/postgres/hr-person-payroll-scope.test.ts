import { expect, it } from 'vitest';
import { identityDatabaseState } from '../helpers/hr-identity-state';
import { openPersonIdentityReviewFixture } from './_hr-person-review-fixture';

for (const identity of ['legacy', 'valid', 'missing', 'inactive'] as const) {
  for (const status of ['active', 'ended'] as const) it(`${identity} financial identity / ${status}: period and currency govern all three payroll calculations`, async () => {
    const f = await openPersonIdentityReviewFixture();
    try {
      const account = await f.account('reception');
      const staffId = (await f.source.query(`INSERT INTO hr_staff(full_name,user_id,created_by,work_status,contract_kind,hire_date,end_date,
        salary_amount_minor,salary_currency,salary_period,salary_effective_on)
        VALUES('Synthetic scope worker',$1,'synthetic',$2,'salary','2025-01-01',$3,125000,'YER','monthly','2025-01-01') RETURNING id`,
      [account.userId, status, status === 'ended' ? '2025-12-31' : null])).rows[0].id;
      let partyId: number | null = null;
      if (identity === 'valid' || identity === 'inactive') partyId = (await f.source.query("INSERT INTO parties(name,kind) VALUES('Synthetic scope party','employee') RETURNING id")).rows[0].id;
      if (identity !== 'legacy') await f.convert(staffId, [account.userId], partyId);
      if (identity === 'inactive') await f.source.query('UPDATE parties SET is_active=FALSE WHERE id=$1', [partyId]);
      const payroll = await import('../../lib/hr-payroll'), period = await payroll.getOrCreatePayrollPeriod('2026-10', f.reviewer);
      for (const currency of ['YER', 'SAR', 'USD'] as const) {
        const before = await identityDatabaseState(f.source);
        const eligible = status === 'active' && currency === 'YER';
        if (eligible && (identity === 'missing' || identity === 'inactive')) {
          await expect(payroll.calculatePayrollRun(period.id, currency, f.reviewer)).rejects.toMatchObject({ status: 409, code: 'identity_conflict' });
          const after = await identityDatabaseState(f.source);
          for (const key of Object.keys(before).filter(key => key !== 'sequence:hr_payroll_runs_id_seq')) expect(after[key], `${identity}/${status}/${currency}/${key}`).toEqual(before[key]);
        } else {
          const run = await payroll.calculatePayrollRun(period.id, currency, f.reviewer);
          expect(run.totalNetDueMinor).toBe(eligible ? 125000 : 0);
          const items = (await f.source.query('SELECT staff_id FROM hr_payroll_items WHERE run_id=$1', [run.id])).rows;
          expect(items).toEqual(eligible ? [{ staff_id: staffId }] : []);
          const after = await identityDatabaseState(f.source);
          for (const table of ['users', 'parties', 'hr_contracts', 'payables', 'expenses', 'hr_payroll_disbursements']) {
            expect(after[`table:${table}`], `${identity}/${status}/${currency}/${table}`).toEqual(before[`table:${table}`]);
          }
        }
      }
    } finally { await f.close(); }
  });
}
