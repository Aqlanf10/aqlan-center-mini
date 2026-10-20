import { beforeAll, afterAll, it, expect, vi } from 'vitest';
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
const { getPool, ensureSchema, resetPoolForTesting, correctInvoice } = await import('../../lib/db');
const { POST } = await import('../../app/api/payments/route');
let patientId: number;
let seq = 0;
beforeAll(async () => {
    await dropPublicSchema(process.env.DATABASE_URL!);
    await ensureSchema();
    ({ rows: [{ id: patientId }] } = await getPool().query("INSERT INTO patients(patient_number,full_name) VALUES('CI-AUDIT','Synthetic audit patient') RETURNING id"));
    await getPool().query("INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd) VALUES('ci',0,0,0)");
}, 180000);
afterAll(async () => { await resetPoolForTesting(); });
async function fixture() { seq++; const { rows: [inv] } = await getPool().query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency) VALUES($1,$2,10000,0,'YER') RETURNING id", ['CI-INV-' + seq, patientId]); const { rows: [line] } = await getPool().query("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'Synthetic service',1,10000,10000) RETURNING id", [inv.id]); return { invoiceId: inv.id, itemId: line.id, key: 'ci-audit-replay-' + seq }; }
function request(f: {
    invoiceId: number;
    key: string;
}, overrides: Record<string, unknown> = {}) { return new Request('http://localhost/api/payments', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': f.key }, body: JSON.stringify({ patientId, invoiceId: f.invoiceId, amount: '100', currency: 'YER', method: 'cash', ...overrides }) }); }
it('audit insertion failure is deliberately swallowed: 201 receipt, no create audit; retry remains single receipt', async () => {
    const f = await fixture();
    await getPool().query("CREATE FUNCTION ci_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='payment.create' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER ci_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ci_fail_audit()");
    try {
        const response = await POST(request(f));
        expect(response.status).toBe(201);
        const receipt = await response.json();
        const { rows: [counts] } = await getPool().query("SELECT (SELECT count(*)::int FROM payments WHERE idempotency_key=$1) payments,(SELECT count(*)::int FROM audit_log WHERE action='payment.create' AND entity_id=$2) audits", [f.key, String(receipt.id)]);
        expect(counts).toEqual({ payments: 1, audits: 0 });
        const retry = await POST(request(f));
        expect(retry.status).toBe(200);
        expect((await retry.json()).id).toBe(receipt.id);
    }
    finally {
        await getPool().query('DROP TRIGGER ci_fail_audit ON audit_log; DROP FUNCTION ci_fail_audit()');
    }
});
it('identical successful payment request should replay after canonical invoice correction', async () => { const f = await fixture(); const first = await POST(request(f)); expect(first.status).toBe(201); const receipt = await first.json(); const correction = await correctInvoice({ invoiceId: f.invoiceId, reason: 'Synthetic invoice correction', actor: 'ci', actorRole: 'admin', lines: [{ itemId: f.itemId, quantity: 1, unitPriceMinor: 9000 }] }); expect(correction.ok).toBe(true); const retry = await POST(request(f)); const body = await retry.json(); console.log('REPLAY_AFTER_CORRECTION', JSON.stringify({ firstStatus: first.status, retryStatus: retry.status, body, originalReceiptId: receipt.id })); expect(retry.status).toBe(200); expect(body.id).toBe(receipt.id); });
it('cancelled invoice retry preserves actor, patient, payload and current authorization gates', async () => {
    const f = await fixture();
    const first = await POST(request(f));
    expect(first.status).toBe(201);
    const correction = await correctInvoice({ invoiceId: f.invoiceId, reason: 'Synthetic correction controls', actor: 'ci', actorRole: 'admin', lines: [{ itemId: f.itemId, quantity: 1, unitPriceMinor: 9000 }] });
    expect(correction.ok).toBe(true);
    if (!correction.ok)
        return;
    const { rows: [other] } = await getPool().query("INSERT INTO patients(patient_number,full_name) VALUES('CI-OTHER','Synthetic other patient') RETURNING id");
    for (const override of [{ amount: '101' }, { patientId: other.id }, { invoiceId: correction.corrected.id }, { currency: 'SAR' }, { method: 'transfer' }])
        expect((await POST(request(f, override))).status).toBe(409);
    auth.session = { username: 'ci-other', role: 'admin', userId: 2 };
    expect((await POST(request(f))).status).toBe(409);
    auth.session = { username: 'ci', role: 'accountant', userId: 1 };
    expect((await POST(request(f))).status).toBe(403);
    auth.session = { username: 'ci', role: 'cashier', userId: 1, financeAccess: { collectPayments: false } };
    expect((await POST(request(f))).status).toBe(403);
    auth.session = null;
    expect((await POST(request(f))).status).toBe(401);
    auth.session = { username: 'ci', role: 'admin', userId: 1 };
    expect((await POST(request({ ...f, key: f.key + '-new' }))).status).toBe(409);
    const noKey = request(f);
    noKey.headers.delete('idempotency-key');
    expect((await POST(noKey)).status).toBe(409);
    const { rows: [count] } = await getPool().query("SELECT count(*)::int AS n FROM payments WHERE invoice_id=ANY($1::int[])", [[f.invoiceId, correction.corrected.id]]);
    expect(count.n).toBe(1);
});
