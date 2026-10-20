/** Exact inserted-item handoff on the frozen supplier-statement baseline.
 * Real PostgreSQL and canonical callers; fault injection only corrupts internal
 * return values, never financial history or schema. No new currency eligibility. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { SessionPayload } from '../../lib/auth';
import { toInputAmount } from '../../lib/money';
import { validatePostgresTestTarget } from './_safe-target';

const sessionHolder = vi.hoisted(() => ({ value: null as SessionPayload | null }));
// Only request-cookie extraction is replaced. Real transaction authority and
// credential-version checks remain the released implementations.
vi.mock('@/lib/session', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/session')>(),
  requireSession: async () => sessionHolder.value,
}));
const target = validatePostgresTestTarget();
if (process.env.USE_LOCAL_DB === 'true') throw new Error('Real PostgreSQL required');
const name = `aqlan_item_handoff_test_${randomUUID().replaceAll('-', '')}`;
const namePattern = /^aqlan_item_handoff_test_[a-f0-9]{32}$/;
const isolated = new URL(target.testUrl); isolated.pathname = `/${name}`;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const env = process.env as Record<string, string | undefined>;
const keys = ['DATABASE_URL','TEST_DATABASE_URL','POSTGRES_URL','POSTGRES_PRISMA_URL','POSTGRES_URL_NON_POOLING','NODE_ENV','DATABASE_ENVIRONMENT','USE_LOCAL_DB','SKIP_SEED','SESSION_SECRET'] as const;
const previous = Object.fromEntries(keys.map(key => [key, env[key]]));
const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
let connected = false, created = false, identity: { oid: string; owner: string } | undefined;
let db: typeof import('../../lib/db');
let revision: typeof import('../../lib/invoice-revision-db');
let linked: typeof import('../../lib/invoice-linkage-db');
let route: typeof import('../../app/api/invoices/[id]/correct/route');
let templates: typeof import('../../lib/specialty-templates').DEFAULT_SPECIALTY_TEMPLATES;
let session: SessionPayload;
let serial = 0, tables: string[] = [], sequences: string[] = [];
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.getPool().query(sql, values)).rows as T[];

beforeAll(async () => {
  if (!namePattern.test(name)) throw new Error('Unsafe owned database name');
  await admin.connect(); connected = true;
  await admin.query(`CREATE DATABASE ${quote(name)} TEMPLATE template0`); created = true;
  identity = (await admin.query<{ oid: string; owner: string }>('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1', [name])).rows[0];
  if (!identity) throw new Error('Owned database identity missing');
  for (const key of ['POSTGRES_URL','POSTGRES_PRISMA_URL','POSTGRES_URL_NON_POOLING','USE_LOCAL_DB']) delete env[key];
  env.DATABASE_URL = isolated.toString(); env.TEST_DATABASE_URL = isolated.toString();
  env.NODE_ENV = 'test'; env.DATABASE_ENVIRONMENT = 'test'; env.SKIP_SEED = 'true';
  env.SESSION_SECRET = 'synthetic-item-handoff-test-only-not-a-real-secret';
  db = await import('../../lib/db'); await db.resetPoolForTesting();
  expect((await q('SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=current_database()'))[0]).toEqual({ name, ...identity });
  await db.ensureSchema();
  revision = await import('../../lib/invoice-revision-db'); linked = await import('../../lib/invoice-linkage-db');
  route = await import('../../app/api/invoices/[id]/correct/route');
  templates = (await import('../../lib/specialty-templates')).DEFAULT_SPECIALTY_TEMPLATES;
  const auth = await import('../../lib/auth');
  const password = await auth.hashPassword('synthetic-item-handoff-only');
  const [user] = await q<{ id: number }>("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('item-handoff-owner','Synthetic handoff owner',$1,'admin',TRUE) RETURNING id", [password]);
  session = { userId: user.id, username: 'item-handoff-owner', role: 'admin', credentialVersion: auth.sessionCredentialVersion(password), expiresAt: Date.now() + 3_600_000 };
  sessionHolder.value = session;
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
  tables = (await q<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).map(row => row.name);
  sequences = (await q<{ name: string }>("SELECT sequencename AS name FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).map(row => row.name);
}, 180_000);
afterAll(async () => {
  const errors: unknown[] = [];
  try { await db?.resetPoolForTesting(); } catch (error) { errors.push(error); }
  try {
    if (created) {
      const current = (await admin.query<{ oid: string; owner: string }>('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1', [name])).rows[0];
      if (!identity || !current || !namePattern.test(name) || isolated.pathname !== `/${name}` || isolated.pathname === target.testUrl.pathname
        || current.oid !== identity.oid || current.owner !== identity.owner) throw new Error('Unowned database cleanup refused');
      await admin.query(`DROP DATABASE ${quote(name)}`);
    }
  } catch (error) { errors.push(error); }
  finally {
    if (connected) try { await admin.end(); } catch (error) { errors.push(error); }
    for (const key of keys) { if (previous[key] === undefined) delete env[key]; else env[key] = previous[key]; }
  }
  if (errors.length) throw new AggregateError(errors, 'Owned handoff cleanup incomplete');
});

async function snapshot() {
  const rows: Record<string, unknown> = {}, counters: Record<string, unknown> = {};
  for (const table of tables) rows[table] = (await q<{ value: unknown }>(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM public.${quote(table)} t`))[0].value;
  for (const sequence of sequences) counters[sequence] = (await q(`SELECT last_value::text,is_called FROM public.${quote(sequence)}`))[0];
  return { rows, counters };
}
async function fixture(plan = true) {
  const key = `handoff-${++serial}`;
  const [patient] = await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYNTHETIC handoff') RETURNING id", [key]);
  const [doctor] = await q<{ id: number }>("INSERT INTO parties(name,kind) VALUES('SYNTHETIC same doctor','doctor') RETURNING id");
  const [service] = await q<{ id: number }>("INSERT INTO services(name,category,price_minor,is_active) VALUES('SYNTHETIC indistinguishable service','rct',10000,TRUE) RETURNING id");
  const items = [36,46].map(toothCode => ({ serviceId: service.id, doctorId: doctor.id, category: 'rct', description: 'SYNTHETIC identical description', quantity: 1,
    unitPriceMinor: 10000, toothCode, caseId: null, sessions: null }));
  if (plan) {
    const result = await linked.createLinkedInvoice({ patientId: patient.id, baseCurrency: 'YER', discountMinor: 0, note: null, createdBy: session.username,
      actorRole: 'admin', items, templates, idempotencyKey: null, requestHash: null, auditDetails: {} });
    if (!result.ok) throw new Error(`Synthetic linked invoice refused: ${result.reason}`);
    return { key, invoice: result.invoice, doctorId: doctor.id, serviceId: service.id };
  }
  const invoice = await db.createInvoice({ patientId: patient.id, baseCurrency: 'YER', discountMinor: 0, note: null, createdBy: session.username, items });
  if (!invoice) throw new Error('Synthetic invoice missing');
  return { key, invoice, doctorId: doctor.id, serviceId: service.id };
}
async function command(invoiceId: number, lines: Array<{ itemId: number; quantity: number; amount: number }>) {
  const view = await revision.readInvoiceRevision(invoiceId, session);
  const total = lines.reduce((sum, line) => sum + line.quantity * line.amount, 0);
  return { idempotencyKey: `handoff-command-${++serial}`, expectedSourceHash: view.sourceHash, reason: 'SYNTHETIC exact item handoff',
    lines: lines.map(line => ({ itemId: line.itemId, quantity: line.quantity, unitPrice: toInputAmount(line.amount, view.invoice.baseCurrency) })),
    discount: '0', repaymentTerms: { mode: 'full', installments: [] }, expectedRemainingMinor: Math.max(0, total - view.settledMinor) };
}
async function mapping(invoiceId: number) {
  return q<{ original: number; corrected: number; plan: number; target_plan: number; amount: string; source_type: string | null; source_id: string | null }>(`SELECT m.original_item_id AS original,m.corrected_item_id AS corrected,m.plan_item_id AS plan,
    i.plan_item_id AS target_plan,i.unit_price_minor::text AS amount,i.source_type,i.source_id::text FROM invoice_correction_lines m
    JOIN invoice_corrections c ON c.id=m.correction_id JOIN invoice_items i ON i.id=m.corrected_item_id
    WHERE c.original_invoice_id=$1 ORDER BY m.original_item_id`, [invoiceId]);
}

describe('exact correction item handoff and atomic mapping', () => {
  it('keeps distinct source IDs for duplicate-looking plan lines, reversed input, changed prices, successive revisions and exact replay', async () => {
    const f = await fixture();
    const [a,b] = f.invoice.items;
    expect([a.serviceId,a.doctorId,a.description,a.quantity,a.unitPriceMinor]).toEqual([b.serviceId,b.doctorId,b.description,b.quantity,b.unitPriceMinor]);
    expect(a.planItemId).not.toBe(b.planItemId);
    const original = await q('SELECT to_jsonb(i) AS value FROM invoice_items i WHERE invoice_id=$1 ORDER BY id', [f.invoice.id]);
    const input = await command(f.invoice.id, [{ itemId: b.id, quantity: 1, amount: 12000 }, { itemId: a.id, quantity: 1, amount: 11000 }]);
    const canonical = db.correctInvoiceInTransaction;
    let pairs: Array<{ originalItemId: number; correctedItemId: number }> = [];
    // Deliberately return reverse pair order: the consumer must use exact IDs,
    // not correlate two arrays by position or rediscover items by their plan.
    const handoff = vi.spyOn(db, 'correctInvoiceInTransaction').mockImplementationOnce(async (...args) => {
      const written = await canonical(...args);
      if (!written.ok) return written;
      pairs = written.itemPairs;
      return { ...written, itemPairs: [...pairs].reverse() };
    });
    let result: Awaited<ReturnType<typeof revision.reviseInvoice>>;
    try { result = await revision.reviseInvoice(f.invoice.id, input, session); }
    finally { handoff.mockRestore(); }
    expect(pairs.map(pair => pair.originalItemId)).toEqual([b.id,a.id]);
    expect(result).not.toHaveProperty('itemPairs');
    const rows = await mapping(f.invoice.id);
    expect(rows.map(row => ({ originalItemId: row.original, correctedItemId: row.corrected })))
      .toEqual([...pairs].sort((x,y) => x.originalItemId - y.originalItemId));
    expect(rows).toEqual([expect.objectContaining({ original: a.id, plan: a.planItemId, target_plan: a.planItemId, amount: '11000', source_type: null, source_id: null }),
      expect.objectContaining({ original: b.id, plan: b.planItemId, target_plan: b.planItemId, amount: '12000', source_type: null, source_id: null })]);
    expect(new Set(rows.map(row => row.corrected)).size).toBe(2);
    expect(await q('SELECT to_jsonb(i) AS value FROM invoice_items i WHERE invoice_id=$1 ORDER BY id', [f.invoice.id])).toEqual(original);
    const beforeReplay = await snapshot();
    expect(await revision.reviseInvoice(f.invoice.id, input, session)).toEqual({ ...result, replayed: true });
    expect(await snapshot()).toEqual(beforeReplay);
    const [{ id: currentId }] = await q<{ id: number }>('SELECT corrected_invoice_id AS id FROM invoice_corrections WHERE original_invoice_id=$1', [f.invoice.id]);
    await revision.reviseInvoice(currentId, await command(currentId, rows.map(row => ({ itemId: row.corrected, quantity: 1, amount: Number(row.amount) + 1000 })).reverse()), session);
    expect((await mapping(currentId)).map(row => ({ original: row.original, plan: row.plan, target_plan: row.target_plan })))
      .toEqual(rows.map(row => ({ original: row.corrected, plan: row.plan, target_plan: row.plan })).sort((x,y) => x.original - y.original));
  });
  it('maps only a kept planned line and preserves the removed original line', async () => {
    const f = await fixture(); const [removed,kept] = f.invoice.items;
    const original = await q('SELECT to_jsonb(i) AS value FROM invoice_items i WHERE invoice_id=$1 ORDER BY id', [f.invoice.id]);
    await revision.reviseInvoice(f.invoice.id, await command(f.invoice.id, [{ itemId: kept.id, quantity: 1, amount: 9000 }]), session);
    expect(await mapping(f.invoice.id)).toEqual([expect.objectContaining({ original: kept.id, plan: kept.planItemId, amount: '9000' })]);
    expect(await q('SELECT status FROM plan_items WHERE id=$1', [removed.planItemId])).toEqual([{ status: 'cancelled' }]);
    expect(await q('SELECT to_jsonb(i) AS value FROM invoice_items i WHERE invoice_id=$1 ORDER BY id', [f.invoice.id])).toEqual(original);
  });
  it('legacy correction preserves identical unlinked source lines without inventing plan mappings', async () => {
    const f = await fixture(false); const [a,b] = f.invoice.items;
    const original = await q('SELECT to_jsonb(i) AS value FROM invoice_items i WHERE invoice_id=$1 ORDER BY id', [f.invoice.id]);
    const result = await db.correctInvoice({ invoiceId: f.invoice.id, actor: session.username, actorRole: 'admin', reason: 'SYNTHETIC legacy handoff',
      lines: [{ itemId: b.id, quantity: 1, unitPriceMinor: 8000 }, { itemId: a.id, quantity: 1, unitPriceMinor: 9000 }] });
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.message);
    expect(Object.keys(result).sort()).toEqual(['corrected','ok','original']);
    expect(result.corrected.items.map(item => item.unitPriceMinor).sort()).toEqual([8000,9000]);
    expect(result.corrected.items.every(item => item.planItemId === null)).toBe(true);
    expect(await mapping(f.invoice.id)).toEqual([]);
    expect(await q('SELECT to_jsonb(i) AS value FROM invoice_items i WHERE invoice_id=$1 ORDER BY id', [f.invoice.id])).toEqual(original);
  });
  it('duplicate or foreign item requests refuse before any table or sequence mutation', async () => {
    const f = await fixture(); const other = await fixture(); const a = f.invoice.items[0];
    for (const second of [a.id,other.invoice.items[0].id]) {
      const input = await command(f.invoice.id, [{ itemId: a.id, quantity: 1, amount: 10000 }, { itemId: second, quantity: 1, amount: 10000 }]);
      const before = await snapshot();
      await expect(revision.reviseInvoice(f.invoice.id, input, session)).rejects.toMatchObject({ code: 'invalid' });
      expect(await snapshot()).toEqual(before);
    }
  });
  it('actual HTTP retains the independent-source currency refusal without clinical evidence creation', async () => {
    const f = await fixture(false);
    const [visit] = await q<{ id: number }>("INSERT INTO visits(patient_id,patient_name,status,invoice_id,billing_currency) VALUES($1,'SYNTHETIC signed visit','waiting',$2,'YER') RETURNING id", [f.invoice.patientId,f.invoice.id]);
    for (const item of f.invoice.items) {
      const [procedure] = await q<{ id: string }>('INSERT INTO visit_procedures(visit_id,service_id,doctor_id,quantity,unit_price_minor) VALUES($1,$2,$3,1,10000) RETURNING id::text', [visit.id,f.serviceId,f.doctorId]);
      await q("UPDATE invoice_items SET source_type='visit_procedure',source_id=$2 WHERE id=$1", [item.id,procedure.id]);
    }
    await q("UPDATE visits SET status='done',signed_at=clock_timestamp(),signed_by=$2 WHERE id=$1", [visit.id,session.username]);
    const view = await revision.readInvoiceRevision(f.invoice.id, session);
    expect(view.currencyCorrection).toMatchObject({ available: false, reasonCodes: ['INDEPENDENT_ITEM_SOURCE'] });
    const body = { ...await command(f.invoice.id, f.invoice.items.map(item => ({ itemId: item.id, quantity: 1, amount: 10000 }))), currency: 'SAR' };
    const before = await snapshot();
    const response = await route.POST(new Request(`http://localhost/api/invoices/${f.invoice.id}/correct`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(f.invoice.id) }) });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: 'conflict' });
    expect(await snapshot()).toEqual(before);
  });
  it('a real patient-lock wait rechecks the changed source snapshot and refuses stale intent atomically', async () => {
    const f = await fixture();
    const input = await command(f.invoice.id, f.invoice.items.map(item => ({ itemId: item.id, quantity: 1, amount: 9000 })));
    const before = await snapshot();
    const blocker = new Client({ connectionString: isolated.toString(), ssl: false, statement_timeout: 12_000 });
    const observer = new Client({ connectionString: isolated.toString(), ssl: false, statement_timeout: 5_000 });
    await blocker.connect(); await observer.connect();
    let pending: Promise<unknown> | undefined, settled = false;
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE', [f.invoice.patientId]);
      const owner = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = revision.reviseInvoice(f.invoice.id, input, session).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
      const deadline = Date.now() + 10_000; let observed = false;
      while (Date.now() < deadline && !settled) {
        await observer.query('SELECT pg_stat_clear_snapshot()');
        const { rows } = await observer.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND state='active' AND $1=ANY(pg_blocking_pids(pid)) AND query='SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE'", [owner]);
        if (rows.length === 1) { observed = true; break; }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(observed).toBe(true); expect(settled).toBe(false);
      await blocker.query("UPDATE invoices SET note='SYNTHETIC changed during real lock wait' WHERE id=$1", [f.invoice.id]);
      await blocker.query('COMMIT');
      expect(await pending).toMatchObject({ error: { code: 'stale' } });
      const after = await snapshot();
      const beforeInvoices = before.rows.invoices as Array<Record<string, unknown>>;
      expect((after.rows.invoices as Array<Record<string, unknown>>).find(row => row.id === f.invoice.id)?.note).toBe('SYNTHETIC changed during real lock wait');
      after.rows.invoices = (after.rows.invoices as Array<Record<string, unknown>>).map(row => row.id === f.invoice.id ? { ...row, note: beforeInvoices.find(old => old.id === row.id)!.note } : row);
      expect(after).toEqual(before);
    } finally {
      await blocker.query('ROLLBACK');
      if (pending) await pending;
      await blocker.end(); await observer.end();
    }
  });
  it.each((['legacy','revision'] as const).flatMap(mode => [false,true].map(retainTwo => ({ mode, retainTwo }))))('canonical $mode writer returns exact unlinked IDs (retainTwo=$retainTwo)', async ({ mode, retainTwo }) => {
    const f = await fixture(false); const [removed,kept] = f.invoice.items;
    const before = await snapshot();
    const lines = [{ itemId: kept.id, quantity: 1, unitPriceMinor: 9000 }, ...(retainTwo ? [{ itemId: removed.id, quantity: 1, unitPriceMinor: 8000 }] : [])];
    const client = await db.getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await db.correctInvoiceInTransaction(client, { invoiceId: f.invoice.id, actor: session.username, actorRole: 'admin',
        reason: 'SYNTHETIC direct inserted pair', lines }, mode === 'revision' ? { discountMinor: 0 } : undefined);
      expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.message);
      const targets = (await client.query<{ id: number; amount: string }>('SELECT id,unit_price_minor::text AS amount FROM invoice_items WHERE invoice_id=$1 ORDER BY id', [result.correctedId])).rows;
      expect(targets).toHaveLength(lines.length);
      expect(result.itemPairs).toEqual(lines.map((line,index) => ({ originalItemId: line.itemId, correctedItemId: targets[index].id })));
      expect(targets.map(row => row.amount)).toEqual(lines.map(line => String(line.unitPriceMinor)));
      expect(new Set(result.itemPairs.map(pair => pair.correctedItemId)).size).toBe(lines.length);
      expect(result.itemPairs.some(pair => pair.originalItemId === removed.id)).toBe(retainTwo);
      expect((await client.query('SELECT created_at FROM invoices WHERE id=ANY($1::int[]) ORDER BY id', [[f.invoice.id,result.correctedId]])).rows)
        .toEqual([expect.objectContaining({ created_at: new Date(f.invoice.createdAt) }), expect.objectContaining({ created_at: new Date(f.invoice.createdAt) })]);
    } finally { await client.query('ROLLBACK'); client.release(); }
    // PostgreSQL sequences may advance on rollback; all financial/clinical rows must not.
    expect((await snapshot()).rows).toEqual(before.rows);
  });
  it.each(['missing','duplicate-source','duplicate-target','unexpected-source','invalid-target','nonexistent-target','foreign-target','swapped-plan-targets','mapping-row-count'] as const)('rejects %s handoff corruption and rolls back every table after real canonical writes', async fault => {
      const f = await fixture(), foreign = await fixture();
      const input = await command(f.invoice.id, f.invoice.items.map(item => ({ itemId: item.id, quantity: 1, amount: 9000 })));
      const before = await snapshot(), canonical = db.correctInvoiceInTransaction;
      let injected = false, restoreQuery: (() => void) | undefined;
      const handoff = vi.spyOn(db, 'correctInvoiceInTransaction').mockImplementationOnce(async (...args) => {
        const result = await canonical(...args);
        if (!result.ok) throw new Error('Synthetic canonical write unexpectedly refused');
        const pairs = result.itemPairs.map(pair => ({ ...pair }));
        if (fault === 'mapping-row-count') {
          const client = args[0], query = client.query.bind(client);
          const probe = vi.spyOn(client, 'query').mockImplementation(async (sql: string, values?: unknown[]) => {
            const result = await query(sql, values);
            if (sql.startsWith('INSERT INTO invoice_correction_lines(')) { injected = true; return { ...result, rowCount: 0 }; }
            return result;
          });
          restoreQuery = () => probe.mockRestore();
        } else {
          injected = true;
          if (fault === 'missing') pairs.pop();
          if (fault === 'duplicate-source') pairs[1].originalItemId = pairs[0].originalItemId;
          if (fault === 'duplicate-target') pairs[1].correctedItemId = pairs[0].correctedItemId;
          if (fault === 'unexpected-source') pairs[0].originalItemId = foreign.invoice.items[0].id;
          if (fault === 'invalid-target') pairs[0].correctedItemId = 0;
          if (fault === 'nonexistent-target') pairs[0].correctedItemId = 2147483647;
          if (fault === 'foreign-target') pairs[0].correctedItemId = foreign.invoice.items[0].id;
          if (fault === 'swapped-plan-targets') [pairs[0].correctedItemId,pairs[1].correctedItemId] = [pairs[1].correctedItemId,pairs[0].correctedItemId];
        }
        return { ...result, itemPairs: pairs };
      });
      try { await expect(revision.reviseInvoice(f.invoice.id, input, session)).rejects.toMatchObject({ code: 'conflict' }); }
      finally { handoff.mockRestore(); restoreQuery?.(); }
      expect(injected).toBe(true);
      expect((await snapshot()).rows).toEqual(before.rows);
    });
  it.each(['missing','multiple','invalid'] as const)('canonical writer refuses %s INSERT RETURNING identities and the caller rolls back', async fault => {
    const f = await fixture();
    const input = await command(f.invoice.id, f.invoice.items.map(item => ({ itemId: item.id, quantity: 1, amount: 9000 })));
    const before = await snapshot(), canonical = db.correctInvoiceInTransaction;
    let injected = false;
    const handoff = vi.spyOn(db, 'correctInvoiceInTransaction').mockImplementationOnce(async (client, ...args) => {
      const probe = new Proxy(client, { get(target, key) {
        if (key !== 'query') return Reflect.get(target, key);
        return async (sql: string, values?: unknown[]) => {
          const result = await target.query(sql, values);
          if (sql.includes('INSERT INTO invoice_items (invoice_id, service_id, doctor_id, description, quantity, unit_price_minor, total_minor,') && sql.includes('RETURNING id')) {
            injected = true;
            if (fault === 'missing') return { ...result, rows: [], rowCount: 0 };
            if (fault === 'multiple') return { ...result, rows: [...result.rows,...result.rows], rowCount: 2 };
            return { ...result, rows: [{ id: 0 }] };
          }
          return result;
        };
      } });
      return canonical(probe, ...args);
    });
    try { await expect(revision.reviseInvoice(f.invoice.id, input, session)).rejects.toThrow('تعذّر إثبات هوية بند'); }
    finally { handoff.mockRestore(); }
    expect(injected).toBe(true); expect((await snapshot()).rows).toEqual(before.rows);
  });

});
