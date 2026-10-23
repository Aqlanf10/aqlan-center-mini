import { createHash } from 'node:crypto';
import { beforeAll, afterAll, afterEach, it, expect, vi } from 'vitest';
import type { DbClient, QueryResult } from '../../lib/db';
import { assertRealPostgresUrl, stubPostgresEnv, dropPublicSchema } from './_setup';
assertRealPostgresUrl();
stubPostgresEnv();
const auth = vi.hoisted(() => ({ session: { username: 'ci', role: 'admin', userId: 1 } as {
        username: string;
        role: string;
        userId: number;
        financeAccess?: { collectPayments: boolean };
    } | null }));
vi.mock('@/lib/session', () => ({ requireSession: async () => auth.session }));
const { getPool, ensureSchema, resetPoolForTesting, correctInvoice, recordPayment, getOpenShift, correctPayment, invalidateSettingsCache } = await import('../../lib/db');
const { POST } = await import('../../app/api/payments/route');
const { answeringSimilarReview } = await import('./_similar-review');
// FX/audit replay is this suite's subject; equal amounts for one synthetic patient answer the advisory review as the operator would.
const reviewedPOST = (request: Request) => answeringSimilarReview(POST, request);
let patientId: number;
let seq = 0;
beforeAll(async () => {
    await dropPublicSchema(process.env.DATABASE_URL!);
    await ensureSchema();
    ({ rows: [{ id: patientId }] } = await getPool().query("INSERT INTO patients(patient_number,full_name) VALUES('CI-AUDIT','Synthetic audit patient') RETURNING id"));
    await getPool().query("INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd) VALUES('ci',0,0,0)");
}, 180000);
afterAll(async () => { await resetPoolForTesting(); });
afterEach(() => { vi.restoreAllMocks(); auth.session = { username: 'ci', role: 'admin', userId: 1 }; });
async function fixture() { seq++; const { rows: [inv] } = await getPool().query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency) VALUES($1,$2,10000,0,'YER') RETURNING id", ['CI-INV-' + seq, patientId]); const { rows: [line] } = await getPool().query("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'Synthetic service',1,10000,10000) RETURNING id", [inv.id]); return { invoiceId: inv.id, itemId: line.id, key: 'ci-audit-replay-' + seq }; }
function request(f: {
    invoiceId: number;
    key: string;
}, overrides: Record<string, unknown> = {}) { return new Request('http://localhost/api/payments', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': f.key }, body: JSON.stringify({ patientId, invoiceId: f.invoiceId, amount: '100', currency: 'YER', method: 'cash', ...overrides }) }); }
async function auditRows(paymentId: number, action = 'payment.create') {
    return (await getPool().query<{ actor: string; actor_role: string | null; details: Record<string, unknown> }>(
        "SELECT actor,actor_role,details FROM audit_log WHERE action=$1 AND entity='payment' AND entity_id=$2 ORDER BY id",
        [action, String(paymentId)])).rows;
}
async function counts(key: string) {
    return (await getPool().query<{ payments: number; audits: number }>(
        "SELECT count(*)::int AS payments,(SELECT count(*)::int FROM audit_log a WHERE a.action IN ('payment.create','payment.refund') AND a.entity='payment' AND a.entity_id IN (SELECT id::text FROM payments WHERE idempotency_key=$1)) AS audits FROM payments WHERE idempotency_key=$1",
        [key])).rows[0];
}
async function blockAudit(action: 'payment.create' | 'payment.refund' | 'payment.idempotent_replay') {
    await getPool().query(`CREATE FUNCTION ci_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ci_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ci_fail_audit()`);
}
async function unblockAudit() {
    await getPool().query('DROP TRIGGER ci_fail_audit ON audit_log; DROP FUNCTION ci_fail_audit()');
}
function direct(f: { invoiceId: number; key: string }) {
    return { patientId, invoiceId: f.invoiceId, kind: 'payment' as const, amountMinor: 100,
        currency: 'YER' as const, baseCurrency: 'YER' as const, exchangeRate: 1, method: 'cash', note: null,
        createdBy: 'ci', actorRole: 'admin', idempotencyKey: f.key };
}
it('audit insertion failure rolls back the receipt and drawer; retry can then create one audited receipt', async () => {
    const f = await fixture();
    const before = (await getOpenShift())!.expected;
    await blockAudit('payment.create');
    try {
        expect((await reviewedPOST(request(f))).status).toBe(500);
        expect(await counts(f.key)).toEqual({ payments: 0, audits: 0 });
        expect((await getOpenShift())!.expected).toEqual(before);
    } finally { await unblockAudit(); }
    const created = await reviewedPOST(request(f));
    expect(created.status).toBe(201);
    const receipt = await created.json();
    expect(await counts(f.key)).toEqual({ payments: 1, audits: 1 });
    const retry = await reviewedPOST(request(f));
    expect(retry.status).toBe(200);
    expect((await retry.json()).id).toBe(receipt.id);
    expect(await counts(f.key)).toEqual({ payments: 1, audits: 1 });
});
it('normal receipt audit has the stored values and session role, without changing the existing v1 fingerprint', async () => {
    const f = await fixture();
    auth.session = { username: 'ci', role: 'reception', userId: 1 };
    const response = await reviewedPOST(request(f)); expect(response.status).toBe(201);
    const receipt = await response.json();
    expect(await auditRows(receipt.id)).toEqual([{ actor: 'ci', actor_role: 'reception', details: {
        المريض: patientId, المبلغ: receipt.amountMinor, العملة: receipt.currency,
        سعر_الصرف: receipt.exchangeRate, المكافئ: receipt.baseAmountMinor, الطريقة: receipt.method,
    } }]);
    const expectedHash = createHash('sha256').update(JSON.stringify({ v: 1, actor: 'ci', patientId,
        invoiceId: f.invoiceId, kind: 'payment', amountMinor: 100, currency: 'YER', baseCurrency: 'YER',
        exchangeRate: 1, method: 'cash', reversalOfId: null }), 'utf8').digest('hex');
    expect((await getPool().query('SELECT idempotency_request_hash FROM payments WHERE id=$1', [receipt.id])).rows[0].idempotency_request_hash).toBe(expectedHash);
    // Role attribution is not financial intent: a currently authorized role change
    // still replays the saved success, retaining its original creation attribution.
    auth.session = { username: 'ci', role: 'admin', userId: 1 };
    expect((await reviewedPOST(request(f))).status).toBe(200);
    expect(await auditRows(receipt.id)).toHaveLength(1);
    expect((await auditRows(receipt.id))[0].actor_role).toBe('reception');
});
it('refund audit failure rolls back cash and leaves the full original amount refundable', async () => {
    const f = await fixture(); const origin = await (await reviewedPOST(request(f))).json();
    const refund = { ...f, key: f.key + '-refund' };
    const overrides = { kind: 'refund', invoiceId: null, reversalOfId: origin.id };
    const before = (await getOpenShift())!.expected;
    await blockAudit('payment.refund');
    try {
        expect((await reviewedPOST(request(refund, overrides))).status).toBe(500);
        expect(await counts(refund.key)).toEqual({ payments: 0, audits: 0 });
        expect((await getOpenShift())!.expected).toEqual(before);
        expect((await getPool().query('SELECT count(*)::int AS n FROM payments WHERE reversal_of_id=$1', [origin.id])).rows[0].n).toBe(0);
    } finally { await unblockAudit(); }
    const response = await reviewedPOST(request(refund, overrides)); expect(response.status).toBe(201);
    const receipt = await response.json();
    expect((await auditRows(receipt.id, 'payment.refund'))[0]).toMatchObject({ actor: 'ci', actor_role: 'admin',
        details: { ردٌّ_لسند: origin.id, المبلغ: origin.amountMinor, سعر_الصرف: origin.exchangeRate } });
    expect((await reviewedPOST(request(refund, overrides))).status).toBe(200);
    expect(await counts(refund.key)).toEqual({ payments: 1, audits: 1 });
});
it('refund evidence uses inherited opening target and stored FX, not omitted target/current settings', async () => {
    const f = await fixture();
    await getPool().query("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date,created_by) VALUES($1,'SAR',100000,'2026-10-01','ci')", [patientId]);
    await getPool().query("INSERT INTO settings(key,value) VALUES('finance.rate.SAR','140.1234567') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
    invalidateSettingsCache();
    const created = await reviewedPOST(request(f, { invoiceId: null, openingCurrency: 'SAR', currency: 'SAR', amount: '12.34' }));
    expect(created.status).toBe(201); const origin = await created.json();
    expect(origin.exchangeRate).toBe(140.123457);
    expect((await auditRows(origin.id))[0].details).toMatchObject({ سعر_الصرف: origin.exchangeRate, رصيد_سابق: 'SAR' });
    await getPool().query("UPDATE settings SET value='900' WHERE key='finance.rate.SAR'"); invalidateSettingsCache();
    const refund = { ...f, key: f.key + '-refund' };
    const overrides = { invoiceId: null, kind: 'refund', reversalOfId: origin.id, currency: 'SAR', amount: '12.34' };
    const response = await reviewedPOST(request(refund, overrides)); expect(response.status).toBe(201);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ openingCurrency: 'SAR', exchangeRate: origin.exchangeRate });
    expect((await auditRows(receipt.id, 'payment.refund'))[0].details).toMatchObject({
        رصيد_سابق: 'SAR', ردٌّ_لسند: origin.id, سعر_الصرف: receipt.exchangeRate, المكافئ: receipt.baseAmountMinor,
    });
    expect((await reviewedPOST(request(refund, overrides))).status).toBe(200);
    expect(await counts(refund.key)).toEqual({ payments: 1, audits: 1 });
});
it('concurrent exact requests commit one receipt and one creation event', async () => {
    const f = await fixture();
    const responses = await Promise.all(Array.from({ length: 10 }, () => reviewedPOST(request(f))));
    expect(responses.filter(r => r.status === 201)).toHaveLength(1);
    expect(responses.filter(r => r.status === 200)).toHaveLength(9);
    const bodies = await Promise.all(responses.map(r => r.json()));
    expect(new Set(bodies.map(b => b.id)).size).toBe(1);
    expect(await counts(f.key)).toEqual({ payments: 1, audits: 1 });
});
it.each([false, true])('unknown COMMIT outcome preserves atomicity and same-key reconciliation: actually committed=%s', async committed => {
    const f = await fixture(); const pool = getPool(); const connect = pool.connect.bind(pool);
    let injected = false; let releases = 0;
    const spy = vi.spyOn(pool, 'connect').mockImplementationOnce(async () => {
        const client = await connect(); const query = client.query.bind(client);
        const wrapped: DbClient = {
            async query<T>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
                if (!injected && /^COMMIT$/i.test(sql.trim())) {
                    if (committed) await query<T>(sql, values);
                    injected = true;
                    throw new Error('synthetic missing commit acknowledgement');
                }
                return query<T>(sql, values);
            },
            release() { releases++; client.release(); },
        };
        return wrapped;
    });
    try { await expect(recordPayment(direct(f))).rejects.toThrow('synthetic missing commit acknowledgement'); }
    finally { spy.mockRestore(); }
    expect(injected).toBe(true); expect(releases).toBe(1);
    expect(await counts(f.key)).toEqual({ payments: committed ? 1 : 0, audits: committed ? 1 : 0 });
    const retry = await reviewedPOST(request(f)); expect(retry.status).toBe(committed ? 200 : 201);
    expect(await counts(f.key)).toEqual({ payments: 1, audits: 1 });
    expect((await reviewedPOST(request(f))).status).toBe(200);
    expect(await counts(f.key)).toEqual({ payments: 1, audits: 1 });
});
it('failed replay telemetry does not deny an existing audited success', async () => {
    const f = await fixture(); const origin = await (await reviewedPOST(request(f))).json();
    await blockAudit('payment.idempotent_replay');
    try {
        const response = await reviewedPOST(request(f)); expect(response.status).toBe(200);
        expect((await response.json()).id).toBe(origin.id);
        expect(await counts(f.key)).toEqual({ payments: 1, audits: 1 });
    } finally { await unblockAudit(); }
});
it('a historical exact replay is not backfilled with invented creation evidence', async () => {
    const f = await fixture(); const input = direct(f);
    const hash = createHash('sha256').update(JSON.stringify({ v: 1, actor: 'ci', patientId, invoiceId: f.invoiceId,
        kind: 'payment', amountMinor: 100, currency: 'YER', baseCurrency: 'YER', exchangeRate: 1, method: 'cash', reversalOfId: null }), 'utf8').digest('hex');
    // Synthetic legacy row only: no deployed receipt or append-only evidence is changed.
    const { rows: [legacy] } = await getPool().query("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by,idempotency_key,idempotency_request_hash) SELECT $1,$2,$3,id,'payment',100,'YER',1,100,'YER','cash','ci',$4,$5 FROM cashier_shifts WHERE status='open' RETURNING id", [f.key, patientId, f.invoiceId, input.idempotencyKey, hash]);
    const response = await reviewedPOST(request(f)); expect(response.status).toBe(200);
    expect((await response.json()).id).toBe(legacy.id);
    expect(await counts(f.key)).toEqual({ payments: 1, audits: 0 });
});
it('caller-owned correction keeps only its one purpose audit, not generic receipt/refund events', async () => {
    const f = await fixture(); const origin = await (await reviewedPOST(request(f))).json();
    const input = { paymentId: origin.id, reason: 'Synthetic audited correction', actor: 'ci', actorRole: 'admin',
        idempotencyKey: f.key + '-correct', replacement: { amountMinor: 9000, currency: 'YER' as const,
            exchangeRate: 1, method: 'cash', target: { kind: 'original' as const } } };
    const corrected = await correctPayment(input); expect(corrected.reason).toBeNull();
    if (corrected.reason !== null) throw new Error(corrected.reason);
    expect(corrected.reversal).not.toBeNull(); expect(corrected.replacement).not.toBeNull();
    expect(await auditRows(corrected.reversal!.id, 'payment.refund')).toHaveLength(0);
    expect(await auditRows(corrected.replacement!.id)).toHaveLength(0);
    expect(await auditRows(origin.id, 'payment.correct')).toHaveLength(1);
    expect((await correctPayment(input))).toMatchObject({ reason: null, replayed: true });
    expect(await auditRows(origin.id, 'payment.correct')).toHaveLength(1);
    expect(await auditRows(origin.id)).toHaveLength(1);
});
it('the contained assistant adapter (no retry key, no similar review) writes no receipt and no receipt event', async () => {
    // CORE-SAFETY containment (lib/ai-tools/contained-tools.ts): this alternate adapter used to emit one
    // canonical receipt event; it is now withdrawn and collection happens only on the guarded screen.
    const f = await fixture();
    const { recordPatientPaymentAction } = await import('../../lib/ai-tools/action-tools');
    const audits = async () => Number((await getPool().query('SELECT count(*) AS n FROM audit_log')).rows[0].n);
    const auditsBefore = await audits();
    const result = await recordPatientPaymentAction({ patientId, invoiceId: f.invoiceId, amount: '100', currency: 'YER' },
        { username: 'ci', role: 'admin', isDbConnected: true });
    expect(result.success).toBe(false);
    expect((await getPool().query('SELECT id FROM payments WHERE invoice_id=$1', [f.invoiceId])).rows).toEqual([]);
    expect(await audits()).toBe(auditsBefore);
});
it('identical successful payment request should replay after canonical invoice correction', async () => { const f = await fixture(); const first = await reviewedPOST(request(f)); expect(first.status).toBe(201); const receipt = await first.json(); const correction = await correctInvoice({ invoiceId: f.invoiceId, reason: 'Synthetic invoice correction', actor: 'ci', actorRole: 'admin', lines: [{ itemId: f.itemId, quantity: 1, unitPriceMinor: 9000 }] }); expect(correction.ok).toBe(true); const retry = await reviewedPOST(request(f)); const body = await retry.json(); console.log('REPLAY_AFTER_CORRECTION', JSON.stringify({ firstStatus: first.status, retryStatus: retry.status, body, originalReceiptId: receipt.id })); expect(retry.status).toBe(200); expect(body.id).toBe(receipt.id); });
it('cancelled invoice retry preserves actor, patient, payload and current authorization gates', async () => {
    const f = await fixture();
    const first = await reviewedPOST(request(f));
    expect(first.status).toBe(201);
    const correction = await correctInvoice({ invoiceId: f.invoiceId, reason: 'Synthetic correction controls', actor: 'ci', actorRole: 'admin', lines: [{ itemId: f.itemId, quantity: 1, unitPriceMinor: 9000 }] });
    expect(correction.ok).toBe(true);
    if (!correction.ok)
        return;
    const { rows: [other] } = await getPool().query("INSERT INTO patients(patient_number,full_name) VALUES('CI-OTHER','Synthetic other patient') RETURNING id");
    for (const override of [{ amount: '101' }, { patientId: other.id }, { invoiceId: correction.corrected.id }, { currency: 'SAR' }, { method: 'transfer' }])
        expect((await reviewedPOST(request(f, override))).status).toBe(409);
    auth.session = { username: 'ci-other', role: 'admin', userId: 2 };
    expect((await reviewedPOST(request(f))).status).toBe(409);
    auth.session = { username: 'ci', role: 'accountant', userId: 1 };
    expect((await reviewedPOST(request(f))).status).toBe(403);
    auth.session = { username: 'ci', role: 'cashier', userId: 1, financeAccess: { collectPayments: false } };
    expect((await reviewedPOST(request(f))).status).toBe(403);
    auth.session = null;
    expect((await reviewedPOST(request(f))).status).toBe(401);
    auth.session = { username: 'ci', role: 'admin', userId: 1 };
    expect((await reviewedPOST(request({ ...f, key: f.key + '-new' }))).status).toBe(409);
    const noKey = request(f);
    noKey.headers.delete('idempotency-key');
    const beforeUnkeyed = await counts(f.key);
    const drawerBeforeUnkeyed = (await getOpenShift())!.expected;
    const refused = await reviewedPOST(noKey);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ reason: 'idempotency_key_required' });
    expect(await counts(f.key)).toEqual(beforeUnkeyed);
    expect((await getOpenShift())!.expected).toEqual(drawerBeforeUnkeyed);
    const { rows: [count] } = await getPool().query("SELECT count(*)::int AS n FROM payments WHERE invoice_id=ANY($1::int[])", [[f.invoiceId, correction.corrected.id]]);
    expect(count.n).toBe(1);
});
