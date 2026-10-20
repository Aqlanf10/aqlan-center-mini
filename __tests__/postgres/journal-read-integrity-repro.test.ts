import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
assertRealPostgresUrl();
stubPostgresEnv();
const auth = vi.hoisted(() => ({ session: { username: "ci", role: "admin", userId: 1 } as { username: string; role: string; userId: number } | null }));
vi.mock("@/lib/session", () => ({ requireSession: async () => auth.session }));
const { ensureSchema, getPool, journalEntries, resetPoolForTesting } = await import("../../lib/db");
const { JournalReadIntegrityError, JOURNAL_REVIEW_RESPONSE } = await import("../../lib/journal-read-integrity");
const { GET: accounting } = await import("../../app/api/accounting/route");
const { GET: fx } = await import("../../app/api/finance/fx/route");
const { GET: executive } = await import("../../app/api/executive/route");
const { GET: exportJournal } = await import("../../app/api/export/route");
let manualId: number;
let ambiguousId: number;
let flagCollisionId: number;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const pool = getPool();
  const { rows: [shift] } = await pool.query("INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd) VALUES('ci',0,0,0) RETURNING id");
  await pool.query(`INSERT INTO expense_categories(key,name,account_code,auto_post_journal) VALUES
    ('ci-ambiguous','Synthetic category one','5901',TRUE),('ci-other','ci-ambiguous','5901',TRUE),
    ('ci-both','ci-both','5901',TRUE),('ci-flag','Synthetic flag category','5901',FALSE),('ci-other-flag','ci-flag','5901',TRUE)`);
  async function expense(voucher: string, category: string, currency: string, date: string) {
    const { rows: [row] } = await pool.query(`INSERT INTO expenses(voucher_number,category,shift_id,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,created_by,created_at)
      VALUES($1,$2,$3,100,$4,1,100,'YER','ci',$5) RETURNING id`, [voucher,category,shift.id,currency,date+'T10:00:00Z']);
    return row.id;
  }
  ambiguousId = await expense('CI-AMBIGUOUS-VOUCHER','ci-ambiguous','YER','2026-08-10');
  flagCollisionId = await expense('CI-FLAG-COLLISION','ci-flag','YER','2026-08-12');
  // Distinct vouchers with equal amounts must survive; one category row matching both aliases is one match.
  await expense('CI-VALID-ONE','ci-both','YER','2026-08-07');
  await expense('CI-VALID-TWO','ci-both','YER','2026-08-07');
  await expense('CI-VALID-SAR','ci-unknown-historical','SAR','2026-08-07');
  await expense('CI-VALID-USD','ci-both','USD','2026-08-07');
  ({ rows: [{ id: manualId }] } = await pool.query("INSERT INTO journal_manual(entry_date,description,created_by) VALUES('2026-08-08','Synthetic historical malformed journal','ci') RETURNING id"));
  await pool.query("INSERT INTO journal_manual_lines(entry_id,account_code,currency,amount_minor,side) VALUES($1,'1101','YER',100,'debit'),($1,'5901','YER',90,'credit')",[manualId]);
}, 180000);
afterAll(async () => { await resetPoolForTesting(); });
it("refuses a balanced duplicate projection with internal source identity", async () => {
  await expect(journalEntries("2026-08-10","2026-08-10")).rejects.toMatchObject({
    name: 'JournalReadIntegrityError', reason: 'ambiguous_expense_category', source: 'expense', reference: `expense:${ambiguousId}`,
  });
});
it("refuses category ambiguity before auto-post filtering", async () => {
  await expect(journalEntries("2026-08-12","2026-08-12")).rejects.toMatchObject({
    reason: 'ambiguous_expense_category', reference: `expense:${flagCollisionId}`,
  });
});
it("refuses an unbalanced historical manual journal without omitting its source", async () => {
  await expect(journalEntries("2026-08-08","2026-08-08")).rejects.toMatchObject({
    name: 'JournalReadIntegrityError', reason: 'unbalanced_journal', source: 'manual', reference: `JM-${manualId}`,
  });
});
it("preserves distinct equal vouchers, single-row double-alias matches, legacy unmapped fallback and native currencies", async () => {
  const entries = await journalEntries('2026-08-07','2026-08-07');
  expect(entries.map(entry=>entry.reference).sort()).toEqual(['CI-VALID-ONE','CI-VALID-SAR','CI-VALID-TWO','CI-VALID-USD']);
  for (const [currency,total] of [['YER',200],['SAR',100],['USD',100]] as const) {
    expect(entries.flatMap(entry=>entry.lines).filter(line=>line.side==='credit'&&line.currency===currency).reduce((n,line)=>n+line.amountMinor,0)).toBe(total);
  }
});
const consumers = [
  ['accounting',accounting,'http://localhost/api/accounting?from=2026-08-07&to=DATE'],
  ['account ledger',accounting,'http://localhost/api/accounting?from=2026-08-07&to=DATE&account=1101&currency=YER'],
  ['fx',fx,'http://localhost/api/finance/fx?asOf=DATE'],
  ['executive',executive,'http://localhost/api/executive?from=2026-08-07&to=DATE'],
  ['executive CSV',executive,'http://localhost/api/executive?from=2026-08-07&to=DATE&format=csv'],
  ['journal CSV',exportJournal,'http://localhost/api/export?table=journal&from=2026-08-07&to=DATE'],
] as const;
for (const [label,handler,url] of consumers) {
  it(`${label} refuses both anomalies without totals, source details or downloadable CSV`, async () => {
    for (const date of ['2026-08-08','2026-08-10']) {
      const response = await handler(new Request(url.replace('DATE',date)));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(JOURNAL_REVIEW_RESPONSE);
      expect(response.headers.get('content-disposition')).toBeNull();
    }
  });
  it(`${label} preserves valid report/export success`, async () => {
    const response = await handler(new Request(url.replace('DATE','2026-08-07')));
    expect(response.status).toBe(200);
    if (label.includes('CSV')) expect(response.headers.get('content-type')).toContain('text/csv');
    else expect(await response.json()).not.toHaveProperty('code','journal_review_required');
  });
  it(`${label} preserves authentication and authorization`, async () => {
    try {
      auth.session=null;
      expect((await handler(new Request(url.replace('DATE','2026-08-10')))).status).toBe(401);
      auth.session={username:'ci',role:'reception',userId:1};
      expect((await handler(new Request(url.replace('DATE','2026-08-10')))).status).toBe(403);
    } finally { auth.session={username:'ci',role:'admin',userId:1}; }
  });
}
it("true empty remains successful while invalid source is unavailable", async () => {
  expect(await journalEntries('2026-07-01','2026-07-01')).toEqual([]);
  const response = await accounting(new Request('http://localhost/api/accounting?from=2026-07-01&to=2026-07-01'));
  expect(response.status).toBe(200);
  expect((await response.json()).entryCount).toBe(0);
});
it("internal identifiers are bounded and never interpolate source free text into public errors", () => {
  const error=new JournalReadIntegrityError('unbalanced_journal','manual\n'+ 'x'.repeat(100),'private patient\n'+ 'x'.repeat(200));
  expect(error.source.length).toBeLessThanOrEqual(32);
  expect(error.reference.length).toBeLessThanOrEqual(80);
  expect(error.message).toBe('Journal source requires review');
});
