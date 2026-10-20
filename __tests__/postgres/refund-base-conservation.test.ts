import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from './_setup';
assertRealPostgresUrl();
stubPostgresEnv();
const auth = vi.hoisted(() => ({ session: { username: 'ci-refund-budget', role: 'admin', userId: 1 } as {
        username: string;
        role: string;
        userId: number;
        financeAccess?: {
            collectPayments: boolean;
        };
    } | null }));
vi.mock('@/lib/session', () => ({ requireSession: async () => auth.session }));
const { getPool, ensureSchema, resetPoolForTesting, recordPayment, correctPayment, saveSettings, patientLedger, ledgerBalancesByCurrency } = await import('../../lib/db');
const { POST } = await import('../../app/api/payments/route');
const { POST: correctPOST } = await import('../../app/api/payments/[id]/correct/route');
const actor = 'ci-refund-budget';
let patientId: number, otherPatientId: number, shiftId: number, sequence = 0;
const rawRate = 140.1234567;
beforeAll(async () => {
    await dropPublicSchema(process.env.DATABASE_URL!);
    await ensureSchema();
    ({ rows: [{ id: patientId }] } = await getPool().query("INSERT INTO patients(patient_number,full_name) VALUES('CI-REFUND','Synthetic refund budget patient') RETURNING id"));
    ({ rows: [{ id: otherPatientId }] } = await getPool().query("INSERT INTO patients(patient_number,full_name) VALUES('CI-REFUND-OTHER','Synthetic other patient') RETURNING id"));
    ({ rows: [{ id: shiftId }] } = await getPool().query("INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd) VALUES($1,0,0,0) RETURNING id", [actor]));
    await saveSettings({ 'finance.rate.SAR': String(rawRate) });
}, 180000);
afterAll(async () => { await resetPoolForTesting(); });
async function fixture(amountMinor = 81, rate = rawRate) {
    const key = `ci-refund-budget-${++sequence}`;
    const { rows: [invoice] } = await getPool().query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency) VALUES($1,$2,1000000,0,'YER') RETURNING id", [key, patientId]);
    const input = { patientId, invoiceId: invoice.id as number, kind: 'payment' as const, amountMinor, currency: 'SAR' as const, baseCurrency: 'YER' as const, exchangeRate: rate, method: 'cash', note: null, createdBy: actor, idempotencyKey: key };
    const made = await recordPayment(input);
    expect(made.reason).toBeNull();
    expect(made.payment).not.toBeNull();
    return { input, payment: made.payment! };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function refundInput(f: Fixture, amountMinor: number, key: string, extra: Record<string, unknown> = {}) {
    return { ...f.input, invoiceId: null, kind: 'refund' as const, amountMinor, exchangeRate: 999, idempotencyKey: key, reversalOfId: f.payment.id, ...extra };
}
async function refund(f: Fixture, amount: number, suffix: string, extra: Record<string, unknown> = {}) { return recordPayment(refundInput(f, amount, `${f.input.idempotencyKey}-${suffix}`, extra)); }
function request(f: Fixture, key: string, amountMinor = f.payment.amountMinor, extra: Record<string, unknown> = {}) {
    return new Request('http://localhost/api/payments', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ patientId, kind: 'refund', amount: (amountMinor / 100).toFixed(2), currency: 'SAR', method: 'cash', reversalOfId: f.payment.id, ...extra }) });
}
function fingerprint(f: Fixture, amountMinor: number, extra: Record<string, unknown> = {}) {
    return createHash('sha256').update(JSON.stringify({ v: 1, actor, patientId, invoiceId: f.payment.invoiceId, kind: 'refund', amountMinor, currency: 'SAR', baseCurrency: 'YER', exchangeRate: f.payment.exchangeRate, method: 'cash', reversalOfId: f.payment.id, ...extra })).digest('hex');
}
async function snapshots() {
    const { rows: [row] } = await getPool().query("SELECT (SELECT count(*)::int FROM payments) AS payments,(SELECT count(*)::int FROM audit_log) AS audits,(SELECT sum(amount_minor)::text FROM payments) AS native,(SELECT sum(base_amount_minor)::text FROM payments) AS base");
    return row;
}
async function totals(id: number) { const { rows: [row] } = await getPool().query("SELECT COALESCE(sum(amount_minor),0)::text AS native,COALESCE(sum(base_amount_minor),0)::text AS base,count(*)::int AS count FROM payments WHERE reversal_of_id=$1 AND kind='refund'", [id]); return row; }
async function sourceRow(id: number) { return (await getPool().query('SELECT * FROM payments WHERE id=$1', [id])).rows[0]; }
async function legacyRefund(f: Fixture, amount: number, base: number, suffix: string, extra: Record<string, unknown> = {}) {
    const row = { patientId, invoiceId: f.payment.invoiceId, planId: null, openingCurrency: null, kind: 'refund', currency: 'SAR', baseCurrency: 'YER', exchangeRate: f.payment.exchangeRate, ...extra };
    const key = `${f.input.idempotencyKey}-${suffix}`;
    const { rows: [made] } = await getPool().query(`INSERT INTO payments(receipt_number,patient_id,invoice_id,plan_id,opening_currency,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by,reversal_of_id,idempotency_key,idempotency_request_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'cash',$13,$14,$15,$16) RETURNING id`, [`LEGACY-${key}`, row.patientId, row.invoiceId, row.planId, row.openingCurrency, shiftId, row.kind, amount, row.currency, row.exchangeRate, base, row.baseCurrency, actor, f.payment.id, key, fingerprint(f, amount)]);
    return { id: made.id as number, key };
}
async function expectReviewWithoutWrites(action: () => Promise<{
    reason: string | null;
}>) {
    const before = await snapshots();
    expect((await action()).reason).toBe('refund_snapshot_review_required');
    expect(await snapshots()).toEqual(before);
}
describe('original stored refund base budget', () => {
    it('fully refunds an old raw-rate source 81 SAR minor / 113 YER without repricing to 114', async () => {
        const f = await fixture();
        const old = await sourceRow(f.payment.id);
        expect(f.payment).toMatchObject({ amountMinor: 81, baseAmountMinor: 113, exchangeRate: 140.123457 });
        expect(old.idempotency_request_hash).toBe(createHash('sha256').update(JSON.stringify({ v: 1, actor, patientId, invoiceId: f.payment.invoiceId, kind: 'payment', amountMinor: 81, currency: 'SAR', baseCurrency: 'YER', exchangeRate: rawRate, method: 'cash', reversalOfId: null })).digest('hex'));
        const beforeStatement = ledgerBalancesByCurrency(patientId, await patientLedger(patientId), new Map());
        expect(beforeStatement.YER).toMatchObject({ billedMinor: 1000000, collectedMinor: 113, dueMinor: 999887 });
        expect(beforeStatement.SAR.collectedMinor).toBe(0);
        const result = await refund(f, 81, 'full');
        expect(result.reason).toBeNull();
        expect(result.payment).toMatchObject({ amountMinor: 81, baseAmountMinor: 113, exchangeRate: 140.123457, currency: 'SAR', baseCurrency: 'YER' });
        expect((await sourceRow(result.payment!.id)).reversal_of_id).toBe(f.payment.id);
        expect(await sourceRow(f.payment.id)).toEqual(old);
        expect(await totals(f.payment.id)).toEqual({ native: '81', base: '113', count: 1 });
        const afterStatement = ledgerBalancesByCurrency(patientId, await patientLedger(patientId), new Map());
        expect(afterStatement.YER).toMatchObject({ billedMinor: 1000000, collectedMinor: 0, dueMinor: 1000000 });
        expect(afterStatement.SAR.collectedMinor).toBe(0);
    });
    it('conserves split refunds 1+1+1 SAR minor against the original 4 YER', async () => {
        const f = await fixture(3, 140);
        expect(f.payment.baseAmountMinor).toBe(4);
        const a = await refund(f, 1, 'a'), b = await refund(f, 1, 'b'), c = await refund(f, 1, 'c');
        expect([a.payment?.baseAmountMinor, b.payment?.baseAmountMinor, c.payment?.baseAmountMinor]).toEqual([1, 2, 1]);
        expect(await totals(f.payment.id)).toEqual({ native: '3', base: '4', count: 3 });
    });
    it('finishes an existing legacy partial sequence without rewriting its low base allocation', async () => {
        const f = await fixture(3, 140);
        const a = await legacyRefund(f, 1, 1, 'old-a'), b = await legacyRefund(f, 1, 1, 'old-b');
        const oldA = await sourceRow(a.id), oldB = await sourceRow(b.id);
        const final = await refund(f, 1, 'last');
        expect(final.payment?.baseAmountMinor).toBe(2);
        expect(await sourceRow(a.id)).toEqual(oldA);
        expect(await sourceRow(b.id)).toEqual(oldB);
        expect(await totals(f.payment.id)).toEqual({ native: '3', base: '4', count: 3 });
    });
    it('allocates remaining base after an old partial rounded above its proportional share', async () => {
        const f = await fixture();
        await legacyRefund(f, 40, 57, 'old');
        const final = await refund(f, 41, 'last');
        expect(final.reason).toBeNull();
        expect(final.payment?.baseAmountMinor).toBe(56);
        expect(await totals(f.payment.id)).toEqual({ native: '81', base: '113', count: 2 });
    });
    it('unchanged rounded-rate source 81/114 and changed settings both use the original base budget', async () => {
        const f = await fixture(81, 140.123457);
        await saveSettings({ 'finance.rate.SAR': '175.9876543' });
        const response = await POST(request(f, f.input.idempotencyKey + '-http'));
        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({ baseAmountMinor: 114, exchangeRate: 140.123457 });
    });
    it('allows zero base for positive native refund, but never creates a zero-native repair', async () => {
        const f = await fixture(100, 1);
        expect(f.payment.baseAmountMinor).toBe(1);
        const a = await refund(f, 1, 'a');
        expect(a.payment?.baseAmountMinor).toBe(0);
        const b = await refund(f, 99, 'b');
        expect(b.payment?.baseAmountMinor).toBe(1);
        const before = await snapshots();
        await expect(refund(f, 0, 'zero')).rejects.toThrow();
        expect(await snapshots()).toEqual(before);
    });
});
describe('unchanged exact-key replay and concurrency', () => {
    it('preserves v1 fingerprint bytes and replays the same partial receipt after all later refunds', async () => {
        const f = await fixture(3, 140);
        const a = await refund(f, 1, 'a');
        expect(a.reason).toBeNull();
        expect((await sourceRow(a.payment!.id)).idempotency_request_hash).toBe(fingerprint(f, 1));
        const beforeLater = await refund(f, 1, 'a');
        expect(beforeLater.replayed).toBe(true);
        expect(beforeLater.payment?.id).toBe(a.payment?.id);
        await refund(f, 1, 'b');
        await refund(f, 1, 'c');
        const before = await snapshots();
        const after = await refund(f, 1, 'a');
        expect(after.replayed).toBe(true);
        expect(after.payment?.id).toBe(a.payment?.id);
        expect(after.payment?.baseAmountMinor).toBe(1);
        expect(await snapshots()).toEqual(before);
    });
    it('replays a legacy v1 refund before checking later fully-refunded inconsistent history', async () => {
        const f = await fixture(3, 140);
        const a = await legacyRefund(f, 1, 1, 'a');
        await legacyRefund(f, 1, 1, 'b');
        await legacyRefund(f, 1, 1, 'c');
        const before = await snapshots();
        const replay = await refund(f, 1, 'a');
        expect(replay.replayed).toBe(true);
        expect(replay.payment?.id).toBe(a.id);
        expect(await snapshots()).toEqual(before);
        await expectReviewWithoutWrites(() => refund(f, 1, 'new'));
    });
    it('keeps changed actor/patient/amount/currency/target/method/origin and permission gates closed', async () => {
        const f = await fixture(3, 140);
        await refund(f, 1, 'a');
        const other = await fixture(3, 140);
        await refund(f, 2, 'b');
        for (const extra of [{ createdBy: 'another-actor' }, { amountMinor: 2 }, { method: 'transfer' }, { reversalOfId: other.payment.id }]) {
            const before = await snapshots();
            expect((await refund(f, 1, 'a', extra)).reason).toBe('idempotency_conflict');
            expect(await snapshots()).toEqual(before);
        }
        for (const [extra, reason] of [[{ patientId: otherPatientId }, 'invalid_reversal'], [{ currency: 'USD' }, 'reversal_currency_mismatch'], [{ invoiceId: other.payment.invoiceId }, 'reversal_target_conflict'], [{ planId: 999999 }, 'reversal_target_conflict'], [{ openingCurrency: 'SAR' }, 'reversal_target_conflict']] as const)
            expect((await refund(f, 1, 'a', extra)).reason).toBe(reason);
        auth.session = { username: actor, role: 'cashier', userId: 1, financeAccess: { collectPayments: true } };
        expect((await POST(request(f, f.input.idempotencyKey + '-a', 1))).status).toBe(403);
        auth.session = null;
        expect((await POST(request(f, f.input.idempotencyKey + '-a', 1))).status).toBe(401);
        auth.session = { username: actor, role: 'admin', userId: 1 };
    });
    it('serializes distinct concurrent refunds and conserves both totals', async () => {
        const f = await fixture(3, 140);
        const results = await Promise.all([refund(f, 1, 'a'), refund(f, 1, 'b'), refund(f, 1, 'c')]);
        expect(results.every(r => r.reason === null)).toBe(true);
        expect(results.map(r => r.payment!.baseAmountMinor).sort()).toEqual([1, 1, 2]);
        expect(await totals(f.payment.id)).toEqual({ native: '3', base: '4', count: 3 });
    });
    it('serializes competing over-limit refunds, then replays the one committed result', async () => {
        const f = await fixture(3, 140);
        const results = await Promise.all([refund(f, 2, 'a'), refund(f, 2, 'b')]);
        expect(results.filter(r => r.payment)).toHaveLength(1);
        expect(results.filter(r => r.reason === 'reversal_exceeds_remaining')).toHaveLength(1);
        expect(await totals(f.payment.id)).toEqual({ native: '2', base: '3', count: 1 });
        await refund(f, 1, 'last');
        expect(await totals(f.payment.id)).toEqual({ native: '3', base: '4', count: 2 });
    });
    it('same-key concurrent retries remain a single receipt, not separate base allocations', async () => {
        const f = await fixture(3, 140);
        const results = await Promise.all(Array.from({ length: 5 }, () => refund(f, 1, 'same')));
        expect(new Set(results.map(r => r.payment?.id)).size).toBe(1);
        expect(results.filter(r => r.replayed)).toHaveLength(4);
        expect(await totals(f.payment.id)).toEqual({ native: '1', base: '1', count: 1 });
    });
});
describe('historical inconsistency requires review with no mutation', () => {
    it.each([{ cash: 40, base: 114 }, { cash: 82, base: 113 }, { cash: 81, base: 114 }, { cash: 81, base: 112 }])('rejects old excess or fully-refunded discrepancy %j', async ({ cash, base }) => {
        const f = await fixture();
        await legacyRefund(f, cash, base, 'bad');
        await expectReviewWithoutWrites(() => refund(f, 1, 'new'));
    });
    it('rejects negative prospective allocation rather than clamping it to zero', async () => {
        const f = await fixture(100, 10);
        await legacyRefund(f, 10, 9, 'ahead');
        await expectReviewWithoutWrites(() => refund(f, 10, 'new'));
    });
    it.each([{ patientId: 0 }, { invoiceId: null }, { currency: 'USD' }, { baseCurrency: 'SAR' }, { exchangeRate: 141 }, { kind: 'payment' }, { invoiceId: null, openingCurrency: 'SAR' }])('rejects contradictory linked refund snapshot %j', async (override) => {
        const f = await fixture();
        const extra = 'patientId' in override && override.patientId === 0 ? { patientId: otherPatientId } : override;
        await legacyRefund(f, 1, 1, 'bad', extra);
        await expectReviewWithoutWrites(() => refund(f, 1, 'new'));
    });
    it('rejects a negative linked refund base rather than hiding it in the sum', async () => {
        const f = await fixture();
        await legacyRefund(f, 1, -1, 'bad');
        await expectReviewWithoutWrites(() => refund(f, 1, 'new'));
    });
    it('rejects contradictory native/base values in a base-currency historical refund', async () => {
        const f = await fixture();
        const source = await recordPayment({ ...f.input, idempotencyKey: f.input.idempotencyKey + '-yer', currency: 'YER', exchangeRate: 1, amountMinor: 100 });
        expect(source.reason).toBeNull();
        const yer = { ...f, payment: source.payment! };
        await legacyRefund(yer, 10, 9, 'bad-yer', { currency: 'YER' });
        await expectReviewWithoutWrites(() => refund(yer, 10, 'new-yer', { currency: 'YER' }));
    });
    it('rejects negative stored base or unsafe native/base budgets without rewriting them', async () => {
        for (const [amount, base] of [[81, -1], ['9007199254740992', 113], [81, '9007199254740992']] as const) {
            const f = await fixture();
            const key = f.input.idempotencyKey + '-invalid-source';
            const { rows: [row] } = await getPool().query("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by) VALUES($1,$2,$3,$4,'payment',$5,'SAR',140.123457,$6,'YER','cash',$7) RETURNING id", [key, patientId, f.payment.invoiceId, shiftId, amount, base, actor]);
            await expectReviewWithoutWrites(() => refund(f, 1, 'new', { reversalOfId: row.id }));
        }
    });
    it('HTTP refund review is explicit 409 and does not write receipt or audit', async () => {
        const f = await fixture();
        await legacyRefund(f, 40, 114, 'bad');
        const before = await snapshots();
        const response = await POST(request(f, f.input.idempotencyKey + '-http', 1));
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ reason: 'refund_snapshot_review_required' });
        expect(await snapshots()).toEqual(before);
    });
});
describe('atomic correction-generated refunds', () => {
    it('voids the remaining original base exactly after a legacy partial', async () => {
        const f = await fixture();
        await legacyRefund(f, 40, 57, 'old');
        const result = await correctPayment({ paymentId: f.payment.id, reason: 'Synthetic refund budget void', actor, actorRole: 'admin', idempotencyKey: f.input.idempotencyKey + '-void', replacement: null });
        expect(result.reason).toBeNull();
        if (result.reason !== null)
            return;
        expect(result.reversal).toMatchObject({ amountMinor: 41, baseAmountMinor: 56 });
        const before = await snapshots();
        const replay = await correctPayment({ paymentId: f.payment.id, reason: 'Synthetic refund budget void', actor, actorRole: 'admin', idempotencyKey: f.input.idempotencyKey + '-void', replacement: null });
        expect(replay.reason).toBeNull();
        if (replay.reason === null)
            expect(replay.replayed).toBe(true);
        expect(await snapshots()).toEqual(before);
    });
    it('correction replacement keeps ordinary write precision but reversal consumes 113, not 114', async () => {
        const f = await fixture();
        const result = await correctPayment({ paymentId: f.payment.id, reason: 'Synthetic refund budget replacement', actor, actorRole: 'admin', idempotencyKey: f.input.idempotencyKey + '-correct', replacement: { amountMinor: 81, currency: 'SAR', exchangeRate: rawRate, method: 'cash', target: { kind: 'original' } } });
        expect(result.reason).toBeNull();
        if (result.reason !== null)
            return;
        expect(result.reversal).toMatchObject({ amountMinor: 81, baseAmountMinor: 113 });
        expect(result.replacement).toMatchObject({ amountMinor: 81, baseAmountMinor: 113, exchangeRate: 140.123457 });
    });
    it('refuses a full historical native/base discrepancy through correction without new money or audit', async () => {
        const f = await fixture();
        await legacyRefund(f, 81, 114, 'bad');
        await expectReviewWithoutWrites(() => correctPayment({ paymentId: f.payment.id, reason: 'Synthetic inconsistent void', actor, actorRole: 'admin', idempotencyKey: f.input.idempotencyKey + '-void', replacement: null }));
    });
    it('rolls back correction replacement on review and maps the HTTP response safely', async () => {
        const f = await fixture();
        await legacyRefund(f, 40, 114, 'bad');
        const before = await snapshots();
        const response = await correctPOST(new Request(`http://localhost/api/payments/${f.payment.id}/correct`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': f.input.idempotencyKey + '-correct' }, body: JSON.stringify({ mode: 'correct', reason: 'Synthetic inconsistency review', amount: '0.81', currency: 'SAR', method: 'cash', target: 'original' }) }), { params: Promise.resolve({ id: String(f.payment.id) }) });
        expect(response.status).toBe(409);
        expect((await response.json()).message).toContain('مراجعة');
        expect(await snapshots()).toEqual(before);
    });
});
