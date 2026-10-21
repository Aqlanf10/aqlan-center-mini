/** Test-owned proposed U0 authority, actual writer and reader acceptance.
 * No route, migration registration, production or real patient action. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { INVOICE_UNPAID_CURRENCY_SQL } from '../../lib/invoice-unpaid-currency-schema.proposed';
import { Client } from 'pg';
import { validatePostgresTestTarget } from './_safe-target';

const target = validatePostgresTestTarget();
if (process.env.USE_LOCAL_DB === 'true') throw new Error('Real PostgreSQL required');
const name = `aqlan_u0_proof_test_${randomUUID().replaceAll('-', '')}`;
const namePattern = /^aqlan_u0_proof_test_[a-f0-9]{32}$/;
const isolated = new URL(target.testUrl); isolated.pathname = `/${name}`;
const quote = (s: string) => `"${s.replaceAll('"','""')}"`;
const env = process.env as Record<string, string | undefined>;
const keys = ['DATABASE_URL','TEST_DATABASE_URL','POSTGRES_URL','POSTGRES_PRISMA_URL','POSTGRES_URL_NON_POOLING','NODE_ENV','DATABASE_ENVIRONMENT','USE_LOCAL_DB','SKIP_SEED'] as const;
const previous = Object.fromEntries(keys.map(key => [key,env[key]]));
const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
let connected = false, created = false, identity: { oid: string; owner: string } | undefined;
let db: typeof import('../../lib/db');
let writer: typeof import('../../lib/invoice-unpaid-currency-db');
let session: import('../../lib/auth').SessionPayload;
type SQL = Pick<import('../../lib/db').DbClient, 'query'>;
type Root = { id: number; patient: number; currency: string; items: number[]; shift: number };
let syntheticActorId=0;
let serial = 0, shiftId = 0, legacyDefinitions: unknown, originalTriggers: unknown, migrationRows: unknown;
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> => (await db.getPool().query(sql,args)).rows as T[];
const definitions = () => q(`SELECT p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND (p.proname LIKE 'aqlan_reclassification%' OR p.proname LIKE 'aqlan_invoice_correction%') ORDER BY 1`);
beforeAll(async () => {
  if (!namePattern.test(name)) throw new Error('Unsafe owned database name');
  await admin.connect(); connected = true;
  await admin.query(`CREATE DATABASE ${quote(name)} TEMPLATE template0`); created = true;
  identity = (await admin.query<{ oid: string; owner: string }>('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[name])).rows[0];
  if (!identity) throw new Error('Owned identity missing');
  for (const key of ['POSTGRES_URL','POSTGRES_PRISMA_URL','POSTGRES_URL_NON_POOLING','USE_LOCAL_DB']) delete env[key];
  env.DATABASE_URL = isolated.toString(); env.TEST_DATABASE_URL = isolated.toString();
  env.NODE_ENV = 'test'; env.DATABASE_ENVIRONMENT = 'test'; env.SKIP_SEED = 'true';
  db = await import('../../lib/db'); await db.resetPoolForTesting();
  expect((await q('SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=current_database()'))[0]).toEqual({ name,...identity });
  await db.ensureSchema(); legacyDefinitions = await definitions();
  originalTriggers = await q("SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'invoice_%' AND tgname<>'invoice_reclassification_complete' ORDER BY 1");
  migrationRows = await q('SELECT * FROM schema_migrations ORDER BY version');
  await q(INVOICE_UNPAID_CURRENCY_SQL);
  writer=await import('../../lib/invoice-unpaid-currency-db');
  const auth=await import('../../lib/auth');
  const password='synthetic-u0-not-a-login-password';
  const [{id:userId}]=await q<{id:number}>("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('u0-app-admin','Synthetic U0',$1,'admin',TRUE) RETURNING id",[password]);
  syntheticActorId=(await q<{id:number}>("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('synthetic','Synthetic proof actor',$1,'admin',TRUE) RETURNING id",[password]))[0].id;
  session={userId,username:'u0-app-admin',role:'admin',credentialVersion:auth.sessionCredentialVersion(password),expiresAt:Date.now()+3600000};
  shiftId = (await q<{ id: number }>("INSERT INTO cashier_shifts(opened_by) VALUES('synthetic') RETURNING id"))[0].id;
},180_000);
afterAll(async () => {
  const errors: unknown[] = [];
  try { await db?.resetPoolForTesting(); } catch (error) { errors.push(error); }
  try {
    if (created) {
      const current = (await admin.query<{ oid: string; owner: string }>('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1',[name])).rows[0];
      if (!identity || !current || !namePattern.test(name) || isolated.pathname !== `/${name}` || isolated.pathname === target.testUrl.pathname
        || current.oid !== identity.oid || current.owner !== identity.owner) throw new Error('Unowned cleanup refused');
      await admin.query(`DROP DATABASE ${quote(name)}`);
    }
  } catch (error) { errors.push(error); }
  finally {
    if (connected) try { await admin.end(); } catch (error) { errors.push(error); }
    for (const key of keys) { if (previous[key] === undefined) delete env[key]; else env[key] = previous[key]; }
  }
  if (errors.length) throw new AggregateError(errors,'Owned U0 cleanup incomplete');
});
async function client() {
  const c = new Client({ connectionString: isolated.toString(), ssl: false, statement_timeout: 12_000 });
  await c.connect(); return c;
}
async function root(currency = 'YER', existingPatient?:number): Promise<Root> {
  const n = ++serial;
  const patient = existingPatient ?? (await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYNTHETIC U0') RETURNING id",[`U0-${n}`]))[0].id;
  const [{ id }] = await q<{ id: number }>("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by,created_at) VALUES($1,$2,2000,$3,'synthetic','2026-01-02T03:04:05.123456Z') RETURNING id",[`U0-${n}`,patient,currency]);
  const items = (await q<{ id: number }>("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'identical',1,1000,1000),($1,'identical',1,1000,1000) RETURNING id",[id])).map(r => r.id);
  return { id,patient,currency,items,shift: shiftId };
}
async function peer(f: Root) {
  return (await q<{ id: number }>("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by) VALUES($1,$2,2000,$3,'synthetic') RETURNING id",[`U0-PEER-${++serial}`,f.patient,f.currency]))[0].id;
}
function intent(f: Root, currency: string, mode = 'preserve-numerals') {
  const amount = mode === 'preserve-numerals' ? 1000 * (currency === 'YER' ? 1 : 100) / (f.currency === 'YER' ? 1 : 100) : 123;
  return { mode,lines: f.items.map(itemId => ({ itemId,unitPriceMinor: String(amount) })),discountMinor: '0' };
}
async function claim(c: SQL, f: Root, currency = 'SAR', mode = 'preserve-numerals') {
  return (await c.query(`INSERT INTO invoice_unpaid_currency_claims(source_id,target_currency,intent,source_snapshot,item_snapshot,action_at,transaction_id,created_by,reason,target_id,target_snapshot,target_items,item_pairs)
    VALUES($1,$2,$3,'{}','[]','1900-01-01','1','synthetic','Synthetic U0 proof',0,'{}','[]','[]') RETURNING *`,[f.id,currency,JSON.stringify(intent(f,currency,mode))])).rows[0];
}
async function finish(c: SQL, f: Root, currency = 'SAR', mode = 'preserve-numerals', options: { kind?: string; skipDocument?: boolean; skipPair?: boolean; skipAck?: boolean; skipAudit?: boolean; nullOriginal?: boolean } = {}) {
  if (options.kind === 'legacy_v1') return legacyFinish(c,f,currency,mode,options);
  const n = ++serial; void mode;
  await c.query("UPDATE invoices SET status='cancelled' WHERE id=$1",[f.id]);
  const issued = (await c.query('SELECT * FROM invoice_unpaid_currency_claims WHERE source_id=$1',[f.id])).rows[0];
  if (!issued) throw new Error('same-transaction authoritative root claim missing');
  const corrected = issued.target_snapshot;
  const pairs: Array<{ original: number; corrected: number }> = issued.item_pairs;
  const key = `u0-correction-${n}`;
  const correction = (await c.query(`INSERT INTO invoice_corrections(patient_id,currency,original_currency,original_invoice_id,corrected_invoice_id,idempotency_key,request_hash,reason,created_by,created_at,currency_evidence_kind)
    VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic U0 proof','synthetic',(SELECT action_at FROM invoice_unpaid_currency_claims WHERE source_id=$4),$8) RETURNING id`,[f.patient,currency,f.currency,f.id,corrected.id,key,'a'.repeat(64),options.kind ?? 'unpaid_root_v1'])).rows[0];
  for (const pair of pairs.slice(0,options.skipPair ? 1 : undefined)) await c.query("INSERT INTO invoice_correction_lines(correction_id,original_item_id,corrected_item_id,approved_work) VALUES($1,$2,$3,'{}')",[correction.id,options.nullOriginal ? null : pair.original,pair.corrected]);
  if (!options.skipAck) await fixtureAcknowledgement(c,correction.id,f,issued,key);
  if(!options.skipAudit) await c.query("INSERT INTO audit_log(action,entity,entity_id,summary,details,actor) VALUES('invoice.correct','invoice',$1,'Synthetic U0 audit',$2,'synthetic')",[String(f.id),JSON.stringify({evidenceKind:'unpaid_root_v1',correctionId:correction.id,replacementId:corrected.id})]);
  if (!options.skipDocument) await c.query("INSERT INTO invoice_unpaid_currency_transitions(correction_id,source_id,target_id,target_snapshot,target_items) VALUES($1,$2,$3,'{}','[]')",[correction.id,f.id,corrected.id]);
  return { correction: correction.id,corrected: corrected.id,pairs };
}
async function fixtureAcknowledgement(c:SQL, correctionId:number, f:Root, issued:Record<string,unknown>, key:string) {
  const snapshot=issued.target_snapshot as Record<string,unknown>;
  const {rows:[times]}=await c.query(`SELECT to_char(action_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS effective,
    to_char((source_snapshot->>'created_at')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS original
    FROM invoice_unpaid_currency_claims WHERE source_id=$1`,[f.id]);
  const source=issued.source_snapshot as Record<string,unknown>, intent=issued.intent as Record<string,unknown>;
  await c.query('INSERT INTO invoice_correction_receipts(correction_id,receipt) VALUES($1,$2)',[correctionId,JSON.stringify({
    version:1,kind:'invoice-currency-correction',evidenceKind:'unpaid_root_v1',correctionId,patientId:f.patient,currency:issued.target_currency,
    originalCurrency:f.currency,idempotencyKey:key,requestHash:'a'.repeat(64),createdBy:'synthetic',actorUserId:syntheticActorId,effectiveAt:times.effective,
    amountMode:intent.mode,settledMinor:0,sourcePrincipalMinor:Number(source.total_minor)-Number(source.discount_minor),
    targetPrincipalMinor:Number(snapshot.total_minor)-Number(snapshot.discount_minor),
    original:{id:f.id,patientId:f.patient,baseCurrency:f.currency,invoiceNumber:source.invoice_number,createdAt:times.original},
    corrected:{id:issued.target_id,patientId:f.patient,baseCurrency:issued.target_currency,invoiceNumber:snapshot.invoice_number,createdAt:times.effective}})]);
}

async function legacyFinish(c: SQL, f: Root, currency = 'SAR', mode = 'preserve-numerals', options: { kind?: string; skipDocument?: boolean; skipPair?: boolean; skipAck?: boolean; nullOriginal?: boolean } = {}) {
  const n = ++serial, desired = intent(f,currency,mode), amount = Number(desired.lines[0].unitPriceMinor);
  await c.query("UPDATE invoices SET status='cancelled' WHERE id=$1",[f.id]);
  const corrected = (await c.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by,created_at) VALUES($1,$2,$3,$4,'synthetic',clock_timestamp()) RETURNING *",[`U0-NEW-${n}`,f.patient,amount * 2,currency])).rows[0];
  // Exact INSERT RETURNING pairs, never service/description inference.
  const columns = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='invoice_items' AND column_name<>'id' ORDER BY ordinal_position")).rows.map(r => r.column_name as string);
  const pairs: Array<{ original: number; corrected: number }> = [];
  for (const original of [...f.items].reverse()) {
    const expressions = columns.map(col => col === 'invoice_id' ? '$2' : col === 'unit_price_minor' || col === 'total_minor' ? '$3' : quote(col));
    const item = (await c.query(`INSERT INTO invoice_items(${columns.map(quote).join(',')}) SELECT ${expressions.join(',')} FROM invoice_items WHERE id=$1 RETURNING id`,[original,corrected.id,amount])).rows[0];
    pairs.push({ original,corrected: item.id });
  }
  const key = `u0-correction-${n}`;
  const correction = (await c.query(`INSERT INTO invoice_corrections(patient_id,currency,original_currency,original_invoice_id,corrected_invoice_id,idempotency_key,request_hash,reason,created_by,created_at,currency_evidence_kind)
    VALUES($1,$2,$3,$4,$5,$6,$7,'Synthetic U0 proof','synthetic',clock_timestamp(),$8) RETURNING id`,[f.patient,currency,f.currency,f.id,corrected.id,key,'a'.repeat(64),options.kind ?? 'unpaid_root_v1'])).rows[0];
  for (const pair of pairs.slice(0,options.skipPair ? 1 : undefined)) await c.query("INSERT INTO invoice_correction_lines(correction_id,original_item_id,corrected_item_id,approved_work) VALUES($1,$2,$3,'{}')",[correction.id,options.nullOriginal ? null : pair.original,pair.corrected]);
  if (!options.skipAck) await c.query('INSERT INTO invoice_correction_receipts(correction_id,receipt) VALUES($1,$2)',[correction.id,JSON.stringify({ patientId: f.patient,currency,idempotencyKey: key,createdBy: 'synthetic',original: { id: f.id,patientId: f.patient,baseCurrency: f.currency },corrected: { id: corrected.id,patientId: f.patient,baseCurrency: currency } })]);
  if (!options.skipDocument) await c.query("INSERT INTO invoice_unpaid_currency_transitions(correction_id,source_id,target_id,target_snapshot,target_items) VALUES($1,$2,$3,'{}','[]')",[correction.id,f.id,corrected.id]);
  return { correction: correction.id,corrected: corrected.id,pairs };
}

async function transaction<T>(work: (c: Client) => Promise<T>, commit = false) {
  const c = await client();
  try { await c.query('BEGIN'); const result = await work(c); await c.query(commit ? 'COMMIT' : 'ROLLBACK'); return result; }
  finally { await c.query('ROLLBACK'); await c.end(); }
}
const sources = ['payment','plan-origin','plan-billed','clinical','visit','ortho','approved','schedule'] as const;
type Source = typeof sources[number];
async function relation(f: Root, kind: Source) {
  const n = ++serial;
  let plan = 0, ortho = 0;
  if (kind.startsWith('plan-') || kind === 'approved') [plan] = (await q<{ id: number }>("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,consent_at) VALUES($1,'SYNTHETIC',2000,$2,clock_timestamp()) RETURNING id",[f.patient,f.currency])).map(r => r.id);
  if (kind === 'ortho') [ortho] = (await q<{ id: number }>("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'synthetic') RETURNING id",[f.patient])).map(r => r.id);
  const table = { payment: 'payments','plan-origin': 'plan_items','plan-billed': 'plan_items',clinical: 'clinical_cases',visit: 'visits',ortho: 'ortho_adjustments',approved: 'approved_agreement_principals',schedule: 'debt_repayment_arrangements' }[kind];
  const column = { payment: 'invoice_id','plan-origin': 'origin_invoice_id','plan-billed': 'billed_invoice_id',clinical: 'origin_invoice_id',visit: 'invoice_id',ortho: 'billing_invoice_id',approved: 'invoice_id',schedule: 'invoice_id' }[kind];
  async function insert(c: SQL, invoice = f.id) {
    const suffix = ++serial;
    const sql = kind === 'payment' ? [`INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,amount_minor,currency,base_amount_minor,base_currency) VALUES($1,$2,$3,$4,1,$5,1,$5) RETURNING id`,[`U0-P-${n}-${suffix}`,f.patient,invoice,f.shift,f.currency]]
      : kind.startsWith('plan-') ? [`INSERT INTO plan_items(plan_id,service_name,${column}) VALUES($1,'SYNTHETIC',$2) RETURNING id`,[plan,invoice]]
      : kind === 'clinical' ? ["INSERT INTO clinical_cases(patient_id,specialty,title,created_by,origin_invoice_id) VALUES($1,'rct','SYNTHETIC','synthetic',$2) RETURNING id",[f.patient,invoice]]
      : kind === 'visit' ? ["INSERT INTO visits(patient_id,patient_name,invoice_id) VALUES($1,'SYNTHETIC',$2) RETURNING id",[f.patient,invoice]]
      : kind === 'ortho' ? ["INSERT INTO ortho_adjustments(case_id,recorded_by,billing_invoice_id) VALUES($1,'synthetic',$2) RETURNING id",[ortho,invoice]]
      : kind === 'approved' ? ["INSERT INTO approved_agreement_principals(plan_id,patient_id,currency,total_minor,invoice_id,source_kind,terms,source_snapshot,reason,idempotency_key,request_hash,created_by) VALUES($1,$2,$3,2000,$4,'invoice','{}','{}','SYNTHETIC',$5,$6,'synthetic') RETURNING plan_id AS id",[plan,f.patient,f.currency,invoice,`u0-approved-${n}-${suffix}`,'a'.repeat(64)]]
      : ["INSERT INTO debt_repayment_arrangements(patient_id,currency,invoice_id,created_by) VALUES($1,$2,$3,'synthetic') RETURNING id",[f.patient,f.currency,invoice]];
    return (await c.query(sql[0] as string,sql[1] as unknown[])).rows[0].id as number;
  }
  return { table,column,insert,key: kind === 'approved' ? 'plan_id' : 'id' };
}
async function observedWait(waiter: Client, blocker: Client) {
  const waiting = (waiter as Client & { processID: number }).processID, blocking = (blocker as Client & { processID: number }).processID;
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const [r] = await q<{ blocked: boolean }>('SELECT $1=ANY(pg_blocking_pids($2)) AS blocked',[blocking,waiting]);
    if (r.blocked) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`Expected actual PostgreSQL lock wait ${waiting} blocked by ${blocking}`);
}
const captured = <T>(promise: Promise<T>) => promise.then(value => ({ value,error: undefined }),error => ({ value: undefined,error }));

describe('test-owned U0 full-schema evidence dispatch', () => {
  it('keeps v1 functions, other triggers and migration registrations byte-for-byte unchanged',async () => {
    expect(await definitions()).toEqual(legacyDefinitions);
    expect(await q("SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'invoice_%' AND tgname<>'invoice_reclassification_complete' ORDER BY 1")).toEqual(originalTriggers);
    expect(await q('SELECT * FROM schema_migrations ORDER BY version')).toEqual(migrationRows);
    expect((await q<{ definition: string }>("SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgname='invoice_reclassification_complete'"))[0].definition).toContain("WHEN ((new.currency_evidence_kind = 'legacy_v1'::text))");
    expect(await q("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'O'")).toEqual([]);
    expect(await q(`SELECT c.conrelid::regclass::text||'.'||a.attname AS reference FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey) AS k(num) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num
      WHERE c.contype='f' AND c.confrelid='invoices'::regclass AND c.conrelid::regclass::text NOT LIKE 'invoice_unpaid_currency_%' ORDER BY 1`)).toEqual([
      'approved_agreement_principals.invoice_id','clinical_cases.origin_invoice_id','debt_repayment_arrangements.invoice_id',
      'invoice_corrections.corrected_invoice_id','invoice_corrections.original_invoice_id','invoice_items.invoice_id','ortho_adjustments.billing_invoice_id',
      'payments.invoice_id','plan_items.billed_invoice_id','plan_items.origin_invoice_id','visits.invoice_id',
    ].map(reference => ({ reference })));
  });
  it.each(['YER:SAR','YER:USD','SAR:YER','SAR:USD','USD:YER','USD:SAR'].flatMap(direction => ['preserve-numerals','reviewed-target-amounts'].map(mode => ({ direction,mode }))))('validates complete no-cash $direction / $mode proof',async ({ direction,mode }) => {
    const [from,to] = direction.split(':'), f = await root(from);
    await transaction(async c => {
      const proof = await claim(c,f,to,mode); const result = await finish(c,f,to,mode);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      expect(proof.source_snapshot.id).toBe(f.id); expect(proof.item_snapshot.map((i: { id: number }) => i.id)).toEqual(f.items);
      expect(proof.source_snapshot.created_at).toBe('2026-01-02T03:04:05.123456+00:00');
      expect((await c.query('SELECT count(*)::int AS n FROM payments WHERE invoice_id IN ($1,$2)',[f.id,result.corrected])).rows).toEqual([{ n: 0 }]);
      expect((await c.query('SELECT count(*)::int AS n FROM invoice_settlement_reclassifications WHERE correction_id=$1',[result.correction])).rows).toEqual([{ n: 0 }]);
      expect(result.pairs.map(p => p.original)).toEqual([...f.items].reverse());
    });
  });
  it.each(['missing-claim','missing-document','missing-pair','missing-ack','legacy-kind','legacy-document','forged-document','null-original'] as const)('refuses %s without committing cancellation or any evidence',async fault => {
    const f = await root(); const c = await client(); await c.query('BEGIN');
    try {
      await expect((async () => {
        if (fault !== 'missing-claim') await claim(c,f);
        const result = await finish(c,f,'SAR','preserve-numerals',{ kind: fault === 'legacy-kind' ? 'legacy_v1' : undefined,skipDocument: fault === 'missing-document',skipPair: fault === 'missing-pair',skipAck: fault === 'missing-ack',nullOriginal: fault === 'null-original' });
        if (fault === 'legacy-document') await c.query("INSERT INTO invoice_settlement_reclassifications(correction_id,patient_id,source_currency,target_currency,source_invoice_ids) VALUES($1,$2,'YER','SAR',ARRAY[$3::int])",[result.correction,f.patient,f.id]);
        if (fault === 'forged-document') await c.query("UPDATE invoice_unpaid_currency_transitions SET target_snapshot='{}' WHERE correction_id=$1",[result.correction]);
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      })()).rejects.toThrow({ 'missing-claim': /same-transaction authoritative root claim/,'missing-document': /complete document missing/,
        'missing-pair': /complete item pairs missing/,'missing-ack': /acknowledgement missing/,'legacy-kind': /sealed source cannot use legacy/,
        'legacy-document': /Legacy document requires legacy/,'forged-document': /document is immutable/,'null-original': /complete item pairs missing/ }[fault]);
    } finally { await c.query('ROLLBACK'); await c.end(); }
    expect(await q('SELECT status FROM invoices WHERE id=$1',[f.id])).toEqual([{ status: 'open' }]);
    expect(await q('SELECT source_id FROM invoice_unpaid_currency_claims WHERE source_id=$1',[f.id])).toEqual([]);
    expect(await q('SELECT id FROM invoice_corrections WHERE original_invoice_id=$1',[f.id])).toEqual([]);
  });
  it.each(sources)('refuses existing %s source independently of matching patient filters or totals',async kind => {
    const f = await root(), r = await relation(f,kind);
    await r.insert(db.getPool());
    await transaction(async c => { await expect(claim(c,f)).rejects.toThrow(/not standalone/); });
  });
  it('zero net settlement and mismatched-owner foreign receipts still prevent an unpaid claim',async () => {
    const f = await root(), other = await root();
    await transaction(async c => {
      const payment = (await c.query("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,amount_minor,currency,base_amount_minor,base_currency) VALUES($1,$2,$3,$4,7,'USD',13,'YER') RETURNING id",[`U0-FOREIGN-${++serial}`,other.patient,f.id,f.shift])).rows[0].id;
      await c.query("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,base_amount_minor,base_currency,reversal_of_id) VALUES($1,$2,$3,$4,'refund',7,'USD',13,'YER',$5)",[`U0-FOREIGN-R-${++serial}`,other.patient,f.id,f.shift,payment]);
      expect((await c.query("SELECT sum(CASE WHEN kind='refund' THEN -base_amount_minor ELSE base_amount_minor END)::text AS net FROM payments WHERE invoice_id=$1",[f.id])).rows).toEqual([{ net: '0' }]);
      await expect(claim(c,f)).rejects.toThrow(/not standalone/);
    });
  });
  it.each(['source-item','source-invoice','target-item','target-invoice','extra-pair'] as const)('cannot mutate %s after forcing deferred validation early',async kind => {
    const f = await root();
    await transaction(async c => {
      await claim(c,f); const result = await finish(c,f); await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      if (kind === 'source-item') await expect(c.query("UPDATE invoice_items SET description='changed' WHERE id=$1",[f.items[0]])).rejects.toThrow(/sealed source/);
      if (kind === 'source-invoice') await expect(c.query('UPDATE invoices SET total_minor=1 WHERE id=$1',[f.id])).rejects.toThrow(/source facts are immutable/);
      if (kind === 'target-item') await expect(c.query("UPDATE invoice_items SET description='changed' WHERE id=$1",[result.pairs[0].corrected])).rejects.toThrow(/target item issuance/);
      if (kind === 'target-invoice') await expect(c.query('UPDATE invoices SET total_minor=1 WHERE id=$1',[result.corrected])).rejects.toThrow(/target issuance/);
      if (kind === 'extra-pair') await expect(c.query("INSERT INTO invoice_correction_lines(correction_id,corrected_item_id,approved_work) VALUES($1,$2,'{}')",[result.correction,result.pairs[0].corrected])).rejects.toThrow(/captured pair membership/);
    });
  });
});

describe('real ownership-lock races, not sleeps or mocked queries', () => {
  it.each(sources)('RC %s wins: fresh post-wait U0 read refuses committed relation',async kind => {
    const f = await root(), r = await relation(f,kind), writer = await client(), correction = await client();
    let pending: ReturnType<typeof captured> | undefined;
    try {
      await writer.query('BEGIN'); await r.insert(writer);
      await correction.query('BEGIN'); pending = captured(claim(correction,f));
      await observedWait(correction,writer); await writer.query('COMMIT');
      expect((await pending).error?.message).toMatch(/not standalone/);
    } finally { await writer.query('ROLLBACK'); await correction.query('ROLLBACK'); if (pending) await pending; await writer.end(); await correction.end(); }
  });
  it.each(sources.flatMap(kind => ['READ COMMITTED','REPEATABLE READ','SERIALIZABLE'].map(isolation => ({ kind,isolation }))))('U0 wins: $isolation $kind writer cannot append to retired source',async ({ kind,isolation }) => {
    const f = await root(), r = await relation(f,kind), correction = await client(), writer = await client();
    let pending: ReturnType<typeof captured> | undefined;
    try {
      await writer.query(`BEGIN ISOLATION LEVEL ${isolation}`); await writer.query('SELECT count(*) FROM invoices');
      await correction.query('BEGIN'); await claim(correction,f); await finish(correction,f);
      pending = captured(r.insert(writer)); await observedWait(writer,correction); await correction.query('COMMIT');
      const result = await pending;
      if (isolation === 'READ COMMITTED') expect(result.error?.message).toMatch(/sealed source/);
      else expect(result.error?.code).toBe('40001');
    } finally { await correction.query('ROLLBACK'); await writer.query('ROLLBACK'); if (pending) await pending; await correction.end(); await writer.end(); }
  });
  it('demonstrates why a root-only RR correction cannot be allowed: waited invoice is unchanged by the relation writer',async () => {
    const f = await root(), r = await relation(f,'visit'), writer = await client(), correction = await client();
    let pending: ReturnType<typeof captured> | undefined;
    try {
      await correction.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      expect((await correction.query('SELECT count(*)::int AS n FROM visits WHERE invoice_id=$1',[f.id])).rows).toEqual([{ n: 0 }]);
      await writer.query('BEGIN'); await r.insert(writer);
      pending = captured(correction.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[f.id]));
      await observedWait(correction,writer); await writer.query('COMMIT'); expect((await pending).error).toBeUndefined();
      // Actual counterexample: lock acquisition succeeded but RR stays stale.
      expect((await correction.query('SELECT count(*)::int AS n FROM visits WHERE invoice_id=$1',[f.id])).rows).toEqual([{ n: 0 }]);
      expect(await q('SELECT count(*)::int AS n FROM visits WHERE invoice_id=$1',[f.id])).toEqual([{ n: 1 }]);
      await expect(claim(correction,f)).rejects.toThrow(/requires READ COMMITTED/);
    } finally { await writer.query('ROLLBACK'); await correction.query('ROLLBACK'); if (pending) await pending; await writer.end(); await correction.end(); }
  });
  it.each(['REPEATABLE READ','SERIALIZABLE'])('rejects U0 claim at %s rather than silently degrading its safety',async isolation => {
    const f = await root(); const c = await client();
    try { await c.query(`BEGIN ISOLATION LEVEL ${isolation}`); await expect(claim(c,f)).rejects.toThrow(/requires READ COMMITTED/); }
    finally { await c.query('ROLLBACK'); await c.end(); }
  });
  it.each(sources)('%s UPDATE fences its old owner even when the new owner is elsewhere',async kind => {
    const f = await root(), other = await peer(f), r = await relation(f,kind);
    const id = await r.insert(db.getPool()), owner = await client(), writer = await client();
    let pending: ReturnType<typeof captured> | undefined;
    try {
      await owner.query('BEGIN'); await owner.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[f.id]);
      await writer.query('BEGIN'); pending = captured(writer.query(`UPDATE ${r.table} SET ${r.column}=$1 WHERE ${r.key}=$2`,[other,id]));
      await observedWait(writer,owner); await owner.query('COMMIT');
      const result = await pending;
      if (['payment','approved','schedule'].includes(kind)) expect(result.error?.message).toMatch(/immutable|append-only/);
      else expect(result.error).toBeUndefined();
    } finally { await owner.query('ROLLBACK'); await writer.query('ROLLBACK'); if (pending) await pending; await owner.end(); await writer.end(); }
  });
  it.each(sources)('%s UPDATE fences its new owner and cannot attach after U0 seals it',async kind => {
    const f = await root(), other = await peer(f), r = await relation(f,kind);
    const id = await r.insert(db.getPool(),other), correction = await client(), writer = await client();
    let pending: ReturnType<typeof captured> | undefined;
    try {
      await correction.query('BEGIN'); await claim(correction,f); await finish(correction,f);
      await writer.query('BEGIN'); pending = captured(writer.query(`UPDATE ${r.table} SET ${r.column}=$1 WHERE ${r.key}=$2`,[f.id,id]));
      await observedWait(writer,correction); await correction.query('COMMIT');
      expect((await pending).error?.message).toMatch(/sealed source/);
      expect(await q(`SELECT ${r.column} AS owner FROM ${r.table} WHERE ${r.key}=$1`,[id])).toEqual([{ owner: other }]);
    } finally { await correction.query('ROLLBACK'); await writer.query('ROLLBACK'); if (pending) await pending; await correction.end(); await writer.end(); }
  });
  it.each(sources)('%s DELETE fences its old owner before preserving existing deletion rules',async kind => {
    const f = await root(), r = await relation(f,kind), id = await r.insert(db.getPool());
    const owner = await client(), writer = await client(); let pending: ReturnType<typeof captured> | undefined;
    try {
      await owner.query('BEGIN'); await owner.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[f.id]);
      await writer.query('BEGIN'); pending = captured(writer.query(`DELETE FROM ${r.table} WHERE ${r.key}=$1`,[id]));
      await observedWait(writer,owner); await owner.query('COMMIT');
      const result = await pending;
      if (['payment','approved','schedule'].includes(kind)) expect(result.error?.message).toMatch(/immutable|append-only/);
      else expect(result.error).toBeUndefined();
    } finally { await owner.query('ROLLBACK'); await writer.query('ROLLBACK'); if (pending) await pending; await owner.end(); await writer.end(); }
  });
  it.each(['old-move','new-move','delete'] as const)('invoice_items %s observes the actual parent fence',async mode => {
    const f = await root(), other = await peer(f), owner = await client(), writer = await client();
    let pending: ReturnType<typeof captured> | undefined;
    try {
      if (mode === 'new-move') await q('UPDATE invoice_items SET invoice_id=$1 WHERE id=$2',[other,f.items[0]]);
      await owner.query('BEGIN'); await owner.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[f.id]);
      await writer.query('BEGIN'); pending = captured(mode === 'delete'
        ? writer.query('DELETE FROM invoice_items WHERE id=$1',[f.items[0]])
        : writer.query('UPDATE invoice_items SET invoice_id=$1 WHERE id=$2',[mode === 'old-move' ? other : f.id,f.items[0]]));
      await observedWait(writer,owner); await owner.query('COMMIT'); expect((await pending).error).toBeUndefined();
    } finally { await owner.query('ROLLBACK'); await writer.query('ROLLBACK'); if (pending) await pending; await owner.end(); await writer.end(); }
  });
  it('captures a source-item mutation committed while the RC root claim waited',async () => {
    const f = await root(), writer = await client(), correction = await client(); let pending: ReturnType<typeof captured> | undefined;
    try {
      await writer.query('BEGIN'); await writer.query("UPDATE invoice_items SET description='committed during wait' WHERE id=$1",[f.items[0]]);
      await correction.query('BEGIN'); pending = captured(claim(correction,f)); await observedWait(correction,writer); await writer.query('COMMIT');
      const result = await pending;
      expect(result.error).toBeUndefined(); expect((result.value as { item_snapshot: Array<{ id: number; description: string }> }).item_snapshot.find(i => i.id === f.items[0])?.description).toBe('committed during wait');
      await finish(correction,f); await correction.query('SET CONSTRAINTS ALL IMMEDIATE');
    } finally { await writer.query('ROLLBACK'); await correction.query('ROLLBACK'); if (pending) await pending; await writer.end(); await correction.end(); }
  });
  it.each(['insert','old-update','new-update'] as const)('payments reversal_of_id %s independently fences the origin invoice owner',async mode => {
    const f = await root(), r = await relation(f,'payment'), original = await r.insert(db.getPool());
    const refund = mode === 'old-update' ? (await q<{ id: number }>("INSERT INTO payments(receipt_number,patient_id,shift_id,kind,amount_minor,currency,base_amount_minor,base_currency,reversal_of_id) VALUES($1,$2,$3,'refund',1,'YER',1,'YER',$4) RETURNING id",[`U0-ORIGIN-${++serial}`,f.patient,f.shift,original]))[0].id
      : mode === 'new-update' ? (await q<{ id: number }>("INSERT INTO payments(receipt_number,patient_id,shift_id,amount_minor,currency,base_amount_minor,base_currency) VALUES($1,$2,$3,1,'YER',1,'YER') RETURNING id",[`U0-UNALLOCATED-${++serial}`,f.patient,f.shift]))[0].id : original;
    const owner = await client(), writer = await client(); let pending: ReturnType<typeof captured> | undefined;
    try {
      await owner.query('BEGIN'); await owner.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[f.id]); await writer.query('BEGIN');
      pending = captured(mode === 'insert'
        ? writer.query("INSERT INTO payments(receipt_number,patient_id,shift_id,kind,amount_minor,currency,base_amount_minor,base_currency,reversal_of_id) VALUES($1,$2,$3,'refund',1,'YER',1,'YER',$4)",[ `U0-ORIGIN-${++serial}`,f.patient,f.shift,original])
        : writer.query('UPDATE payments SET invoice_id=NULL,reversal_of_id=$1 WHERE id=$2',[mode === 'old-update' ? null : original,refund]));
      await observedWait(writer,owner); await owner.query('COMMIT'); const result = await pending;
      if (mode === 'insert') expect(result.error).toBeUndefined(); else expect(result.error?.message).toMatch(/immutable|append-only/);
    } finally { await owner.query('ROLLBACK'); await writer.query('ROLLBACK'); if (pending) await pending; await owner.end(); await writer.end(); }
  });
  it.each(['incoming','outgoing'].flatMap(direction => [true,false].map(correctionWins => ({ direction,correctionWins }))))('$direction correction edge, U0 wins=$correctionWins, uses the same invoice fence',async ({ direction,correctionWins }) => {
    const f = await root(), other = await peer(f), owner = await client(), writer = await client();
    let pending: ReturnType<typeof captured> | undefined;
    const edge = async () => {
      const original = direction === 'incoming' ? other : f.id, corrected = direction === 'incoming' ? f.id : other, key = `u0-edge-race-${++serial}`;
      const id = (await writer.query("INSERT INTO invoice_corrections(patient_id,currency,original_invoice_id,corrected_invoice_id,idempotency_key,request_hash,reason,created_by) VALUES($1,'YER',$2,$3,$4,$5,'Synthetic edge race','synthetic') RETURNING id",[f.patient,original,corrected,key,'c'.repeat(64)])).rows[0].id;
      await writer.query('INSERT INTO invoice_correction_receipts(correction_id,receipt) VALUES($1,$2)',[id,JSON.stringify({ patientId: f.patient,currency: 'YER',idempotencyKey: key,createdBy: 'synthetic',original: { id: original,patientId: f.patient,baseCurrency: 'YER' },corrected: { id: corrected,patientId: f.patient,baseCurrency: 'YER' } })]);
    };
    try {
      await owner.query('BEGIN'); await writer.query('BEGIN');
      if (correctionWins) {
        await claim(owner,f); await finish(owner,f); pending = captured(edge()); await observedWait(writer,owner); await owner.query('COMMIT');
        expect((await pending).error?.message).toMatch(/sealed source/);
      } else {
        await edge(); pending = captured(claim(owner,f)); await observedWait(owner,writer); await writer.query('COMMIT');
        expect((await pending).error?.message).toMatch(/one live verified root/);
      }
    } finally { await owner.query('ROLLBACK'); await writer.query('ROLLBACK'); if (pending) await pending; await owner.end(); await writer.end(); }
  });
  it.each([true,false])('invoices.plan_id parent-row race, U0 wins=%s',async correctionWins => {
    const f = await root(); const plan = (await q<{ id: number }>("INSERT INTO treatment_plans(patient_id,title,total_minor) VALUES($1,'SYNTHETIC',2000) RETURNING id",[f.patient]))[0].id;
    const owner = await client(), writer = await client(); let pending: ReturnType<typeof captured> | undefined;
    try {
      await owner.query('BEGIN'); await writer.query('BEGIN');
      if (correctionWins) {
        await claim(owner,f); await finish(owner,f); pending = captured(writer.query('UPDATE invoices SET plan_id=$1 WHERE id=$2',[plan,f.id]));
        await observedWait(writer,owner); await owner.query('COMMIT'); expect((await pending).error?.message).toMatch(/source facts are immutable/);
      } else {
        await writer.query('UPDATE invoices SET plan_id=$1 WHERE id=$2',[plan,f.id]); pending = captured(claim(owner,f));
        await observedWait(owner,writer); await writer.query('COMMIT'); expect((await pending).error?.message).toMatch(/not standalone/);
      }
    } finally { await owner.query('ROLLBACK'); await writer.query('ROLLBACK'); if (pending) await pending; await owner.end(); await writer.end(); }
  });
  it('sorts OLD and NEW invoice IDs before locking, regardless of UPDATE direction',async () => {
    const low = await root(), high = await peer(low), r = await relation(low,'visit');
    const id = await r.insert(db.getPool(),high), highOwner = await client(), mover = await client(), lowProbe = await client();
    let moving: ReturnType<typeof captured> | undefined, probing: ReturnType<typeof captured> | undefined;
    try {
      await highOwner.query('BEGIN'); await highOwner.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[high]);
      await mover.query('BEGIN'); moving = captured(mover.query('UPDATE visits SET invoice_id=$1 WHERE id=$2',[low.id,id]));
      await observedWait(mover,highOwner);
      await lowProbe.query('BEGIN'); probing = captured(lowProbe.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[low.id]));
      await observedWait(lowProbe,mover); // proves low was acquired before waiting on high
      await highOwner.query('COMMIT'); expect((await moving).error).toBeUndefined(); await mover.query('ROLLBACK');
      expect((await probing).error).toBeUndefined();
    } finally { await highOwner.query('ROLLBACK'); await mover.query('ROLLBACK'); await lowProbe.query('ROLLBACK'); if (moving) await moving; if (probing) await probing; await highOwner.end(); await mover.end(); await lowProbe.end(); }
  });
  it('does not wait on a clinical row already held by a writer awaiting the root: it seals and that writer refuses',async () => {
    const f = await root(), other = await peer(f), r = await relation(f,'visit'), id = await r.insert(db.getPool(),other);
    const correction = await client(), writer = await client(); let pending: ReturnType<typeof captured> | undefined;
    try {
      await writer.query('BEGIN'); await writer.query('SELECT id FROM visits WHERE id=$1 FOR UPDATE',[id]);
      await correction.query('BEGIN'); await claim(correction,f);
      pending = captured(writer.query('UPDATE visits SET invoice_id=$1 WHERE id=$2',[f.id,id])); await observedWait(writer,correction);
      await finish(correction,f); await correction.query('COMMIT');
      expect((await pending).error?.message).toMatch(/sealed source/);
    } finally { await correction.query('ROLLBACK'); await writer.query('ROLLBACK'); if (pending) await pending; await correction.end(); await writer.end(); }
  });
  it('an intentional inverse external row-lock order is deadlock-refused, never called safe just because each trigger sorts owners',async () => {
    const a = await root(), b = await root(), x = await client(), y = await client();
    let first: ReturnType<typeof captured> | undefined, second: ReturnType<typeof captured> | undefined;
    try {
      await x.query('BEGIN'); await y.query('BEGIN');
      await x.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[a.id]);
      await y.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[b.id]);
      first = captured(x.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[b.id])); await observedWait(x,y);
      second = captured(y.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[a.id]));
      const results = await Promise.all([first,second]);
      expect(results.filter(r => r.error?.code === '40P01')).toHaveLength(1);
      expect(results.filter(r => r.error === undefined)).toHaveLength(1);
    } finally { await x.query('ROLLBACK'); await y.query('ROLLBACK'); if (first) await first; if (second) await second; await x.end(); await y.end(); }
    expect(await q('SELECT status FROM invoices WHERE id=ANY($1) ORDER BY id',[[a.id,b.id]])).toEqual([{ status: 'open' },{ status: 'open' }]);
  });
});

describe('unchanged legacy v1 behavior behind explicit kind dispatch', () => {
  async function paidLegacy(c: SQL, coverage = true) {
    const f = await root();
    const payment = (await c.query(`INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,amount_minor,currency,exchange_rate,base_amount_minor,base_currency)
      VALUES($1,$2,$3,$4,3,'SAR',450,14,'YER') RETURNING *`,[`U0-V1-P-${++serial}`,f.patient,f.id,f.shift])).rows[0];
    const result = await finish(c,f,'SAR','preserve-numerals',{ kind: 'legacy_v1',skipDocument: true });
    const document = (await c.query("INSERT INTO invoice_settlement_reclassifications(correction_id,patient_id,source_currency,target_currency,source_invoice_ids) VALUES($1,$2,'YER','SAR',ARRAY[$3::int]) RETURNING id",[result.correction,f.patient,f.id])).rows[0];
    if (coverage) await c.query('INSERT INTO invoice_settlement_reclassification_events(reclassification_id,payment_id,direction,source_minor,target_minor,payment_snapshot) SELECT $1,id,1,base_amount_minor,amount_minor,to_jsonb(p) FROM payments p WHERE id=$2',[document.id,payment.id]);
    return { f,result,payment,document };
  }
  it('retains v1 independent rounding, immutable receipt snapshots, original ack and automatic refunds exactly',async () => {
    await transaction(async c => {
      const { f,result,payment,document } = await paidLegacy(c);
      const before = (await c.query('SELECT to_jsonb(p) AS row FROM payments p WHERE id=$1',[payment.id])).rows;
      const ack = (await c.query('SELECT receipt FROM invoice_correction_receipts WHERE correction_id=$1',[result.correction])).rows;
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      for (let i = 0; i < 3; i++) await c.query(`INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,reversal_of_id)
        VALUES($1,$2,$3,$4,'refund',1,'SAR',450,5,'YER',$5)`,[`U0-V1-R-${++serial}`,f.patient,f.id,f.shift,payment.id]);
      expect((await c.query('SELECT sum(direction*source_minor)::text AS source,sum(direction*target_minor)::text AS target,count(*)::int AS n FROM invoice_settlement_reclassification_events WHERE reclassification_id=$1',[document.id])).rows).toEqual([{ source: '-1',target: '0',n: 4 }]);
      expect((await c.query('SELECT to_jsonb(p) AS row FROM payments p WHERE id=$1',[payment.id])).rows).toEqual(before);
      expect((await c.query('SELECT receipt FROM invoice_correction_receipts WHERE correction_id=$1',[result.correction])).rows).toEqual(ack);
      expect((await c.query('SELECT currency_evidence_kind AS kind FROM invoice_corrections WHERE id=$1',[result.correction])).rows).toEqual([{ kind: 'legacy_v1' }]);
    });
  });
  it('still rejects missing legacy payment coverage rather than selecting the unpaid validator',async () => {
    await transaction(async c => { await paidLegacy(c,false); await expect(c.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(/settlement coverage incomplete/); });
  });
  it('still requires a legacy currency document even when it has zero receipts',async () => {
    const f = await root(); await transaction(async c => {
      await finish(c,f,'SAR','preserve-numerals',{ kind: 'legacy_v1',skipDocument: true });
      await expect(c.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(/settlement coverage incomplete/);
    });
  });
  it('rejects a new document attached to a legacy correction without replacing the old validator',async () => {
    await transaction(async c => { const { f,result } = await paidLegacy(c); await expect(c.query("INSERT INTO invoice_unpaid_currency_transitions(correction_id,source_id,target_id,target_snapshot,target_items) VALUES($1,$2,$3,'{}','[]')",[result.correction,f.id,result.corrected])).rejects.toThrow(/document kind\/identity mismatch/); });
  });
  it('rejects reverse-constructed target lineage even when the old v1 proof was valid before U0 attached its source',async () => {
    const a = await root('SAR');
    await transaction(async c => {
      const b = (await c.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by,created_at) VALUES($1,$2,20,'YER','synthetic','2100-01-01') RETURNING id",[`U0-REVERSE-${++serial}`,a.patient])).rows[0].id as number;
      const bItems: number[] = [];
      for (const original of a.items) bItems.push((await c.query("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) SELECT $1,description,quantity,10,10 FROM invoice_items WHERE id=$2 RETURNING id",[b,original])).rows[0].id);
      const legacy = await finish(c,{ ...a,id: b,currency: 'YER',items: bItems },'SAR','preserve-numerals',{ kind: 'legacy_v1',skipDocument: true });
      await c.query("INSERT INTO invoice_settlement_reclassifications(correction_id,patient_id,source_currency,target_currency,source_invoice_ids) VALUES($1,$2,'YER','SAR',ARRAY[$3::int])",[legacy.correction,a.patient,b]);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE'); // B -> C is complete v1 at this point.
      await c.query('SET CONSTRAINTS ALL DEFERRED');
      await c.query("UPDATE invoices SET status='open' WHERE id=$1",[b]);
      await claim(c,a,'YER'); await c.query("UPDATE invoices SET status='cancelled' WHERE id=$1",[a.id]);
      const key = `u0-reverse-edge-${++serial}`;
      await expect(c.query("INSERT INTO invoice_corrections(patient_id,currency,original_currency,original_invoice_id,corrected_invoice_id,idempotency_key,request_hash,reason,created_by,created_at,currency_evidence_kind) VALUES($1,'YER','SAR',$2,$3,$4,$5,'Synthetic U0 proof','synthetic',clock_timestamp(),'unpaid_root_v1') RETURNING id",[a.patient,a.id,b,key,'b'.repeat(64)])).rejects.toThrow(/authoritative root claim/);
    });
  });
});

describe('bounded post-proof lifecycle, not reader/writer activation', () => {
  it('keeps the original receipt-free while allowing future target receipt/refund facts',async () => {
    const f = await root();
    const result = await transaction(async c => { await claim(c,f); return finish(c,f); },true);
    await transaction(async c => {
      const r = await relation({ ...f,id: result.corrected,currency: 'SAR' },'payment'); const payment = await r.insert(c);
      await c.query("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,base_amount_minor,base_currency,reversal_of_id) VALUES($1,$2,$3,$4,'refund',1,'SAR',1,'SAR',$5)",[`U0-TARGET-R-${++serial}`,f.patient,result.corrected,f.shift,payment]);
      expect((await c.query('SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1',[f.id])).rows).toEqual([{ n: 0 }]);
      expect((await c.query('SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1',[result.corrected])).rows).toEqual([{ n: 2 }]);
    });
  });
  it('allows a same-currency descendant without a second transition document',async () => {
    const f = await root('SAR'); const first = await transaction(async c => { await claim(c,f,'YER'); return finish(c,f,'YER'); },true);
    await transaction(async c => {
      await finish(c,{ ...f,id: first.corrected,currency: 'YER',items: first.pairs.map(p => p.corrected) },'YER','reviewed-target-amounts',{ kind: 'legacy_v1',skipDocument: true });
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      expect((await c.query('SELECT count(*)::int AS n FROM invoice_unpaid_currency_transitions d JOIN invoice_corrections c ON c.id=d.correction_id WHERE c.patient_id=$1',[f.patient])).rows).toEqual([{ n: 1 }]);
    });
  });
  it('refuses a second YER to SAR transition via legacy v1 after an unpaid SAR to YER transition',async () => {
    const f = await root('SAR'); const first = await transaction(async c => { await claim(c,f,'YER'); return finish(c,f,'YER'); },true);
    await transaction(async c => {
      await expect(finish(c,{ ...f,id: first.corrected,currency: 'YER',items: first.pairs.map(p => p.corrected) },'SAR','reviewed-target-amounts',{ kind: 'legacy_v1',skipDocument: true })).rejects.toThrow(/second currency transition/);
    });
    expect(await q('SELECT status FROM invoices WHERE id=$1',[first.corrected])).toEqual([{ status: 'open' }]);
  });
});

describe('DB-owned fresh target and pair authority', () => {
  it('ignores injected target, snapshots, timestamps and pairs; creates a new target itself', async () => {
    const f = await root(), existing = await peer(f);
    await q("UPDATE invoices SET created_at='2099-01-01' WHERE id=$1", [existing]);
    await transaction(async c => {
      const issued = (await c.query(`INSERT INTO invoice_unpaid_currency_claims(
        source_id,target_currency,intent,source_snapshot,item_snapshot,action_at,transaction_id,
        created_by,reason,target_id,target_snapshot,target_items,item_pairs)
        VALUES($1,'SAR',$2,'{}','[]','2099-01-01','1','synthetic','Synthetic U0 proof',$3,'{}','[]','[]') RETURNING *`,
        [f.id,JSON.stringify(intent(f,'SAR')),existing])).rows[0];
      expect(issued.target_id).not.toBe(existing);
      expect(issued.target_snapshot.id).toBe(issued.target_id);
      expect(new Date(issued.action_at).getUTCFullYear()).toBeLessThan(2099);
      expect(issued.item_pairs.map((p: {original:number}) => p.original)).toEqual([...f.items].reverse());
      await finish(c,f); await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
    expect((await q('SELECT status FROM invoices WHERE id=$1',[existing]))[0]).toEqual({status:'open'});
  });
  it('refuses binding a previously existing future-dated target to an authoritative source claim', async () => {
    const f = await root(), existing = await peer(f);
    await transaction(async c => {
      await claim(c,f); await c.query("UPDATE invoices SET status='cancelled' WHERE id=$1",[f.id]);
      await c.query("UPDATE invoices SET base_currency='SAR',created_at='2099-01-01' WHERE id=$1",[existing]);
      await expect(c.query(`INSERT INTO invoice_corrections(patient_id,currency,original_currency,original_invoice_id,corrected_invoice_id,
        idempotency_key,request_hash,reason,created_by,currency_evidence_kind)
        VALUES($1,'SAR','YER',$2,$3,$4,$5,'Synthetic U0 proof','synthetic','unpaid_root_v1')`,
        [f.patient,f.id,existing,`u0-forged-${++serial}`,'a'.repeat(64)])).rejects.toThrow(/authoritative root claim/);
    });
  });
  it('refuses target mutation even before document capture and rolls back issued target on incomplete commit', async () => {
    const f = await root(); let targetId = 0;
    await transaction(async c => {
      const issued = await claim(c,f); targetId = issued.target_id;
      await expect(c.query("UPDATE invoices SET total_minor=123 WHERE id=$1",[targetId])).rejects.toThrow(/issuance facts are immutable/);
    });
    expect(await q('SELECT id FROM invoices WHERE id=$1',[targetId])).toEqual([]);
    const c = await client();
    try {
      await c.query('BEGIN'); targetId=(await claim(c,f)).target_id;
      await expect(c.query('COMMIT')).rejects.toThrow(/complete document missing/);
    } finally { await c.query('ROLLBACK'); await c.end(); }
    expect(await q('SELECT id FROM invoices WHERE id=$1',[targetId])).toEqual([]);
    expect((await q('SELECT status FROM invoices WHERE id=$1',[f.id]))[0]).toEqual({status:'open'});
  });
  it('refuses swapped identical-description pairs despite complete source and target membership', async () => {
    const f = await root();
    await transaction(async c => {
      await claim(c,f); const result=await finish(c,f,'SAR','preserve-numerals',{skipPair:true,skipDocument:true});
      // Existing pair prevents swapping by UPDATE (append-only), so prove a
      // second fresh transaction below rather than weakening those guards.
      expect(result.pairs).toHaveLength(2);
    });
    await transaction(async c => {
      const issued=await claim(c,f);
      const supplied=issued.item_pairs as Array<{original:number;corrected:number}>;
      await c.query("UPDATE invoices SET status='cancelled' WHERE id=$1",[f.id]);
      const key=`u0-swapped-${++serial}`;
      const correction=(await c.query(`INSERT INTO invoice_corrections(patient_id,currency,original_currency,original_invoice_id,corrected_invoice_id,
        idempotency_key,request_hash,reason,created_by,created_at,currency_evidence_kind)
        VALUES($1,'SAR','YER',$2,$3,$4,$5,'Synthetic U0 proof','synthetic',(SELECT action_at FROM invoice_unpaid_currency_claims WHERE source_id=$2),'unpaid_root_v1') RETURNING id`,
        [f.patient,f.id,issued.target_id,key,'a'.repeat(64)])).rows[0].id;
      for (let i=0;i<2;i++) await c.query("INSERT INTO invoice_correction_lines(correction_id,original_item_id,corrected_item_id,approved_work) VALUES($1,$2,$3,'{}')",[correction,supplied[i].original,supplied[1-i].corrected]);
      await fixtureAcknowledgement(c,correction,f,issued,key);
      await c.query("INSERT INTO audit_log(action,entity,entity_id,summary,details,actor) VALUES('invoice.correct','invoice',$1,'Synthetic pair proof',$2,'synthetic')",[String(f.id),JSON.stringify({evidenceKind:'unpaid_root_v1',correctionId:correction,replacementId:issued.target_id})]);
      await c.query("INSERT INTO invoice_unpaid_currency_transitions(correction_id,source_id,target_id,target_snapshot,target_items) VALUES($1,$2,$3,'{}','[]')",[correction,f.id,issued.target_id]);
      await expect(c.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(/exact DB-issued identities/);
    });
  });
});


describe('complete U0 audit and acknowledgement are mandatory',()=>{
  it.each([
    {originalCurrency:'USD'}, {original:{patientId:999}}, {corrected:{patientId:999}},
    {extra:true}, {actorUserId:'1'}, {settledMinor:'0'}, {version:'1'},
  ])('independent reader refuses historical acknowledgement corruption %j',async change=>{
    const f=await root();
    await transaction(async c=>{
      await claim(c,f);const result=await finish(c,f);await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      const {rows:[saved]}=await c.query('SELECT receipt FROM invoice_correction_receipts WHERE correction_id=$1',[result.correction]);
      const receipt={...saved.receipt,...change,
        original:{...saved.receipt.original,...('original' in change?change.original:{})},
        corrected:{...saved.receipt.corrected,...('corrected' in change?change.corrected:{})}};
      // Owned disposable DB only. Rollback restores this exact immutable trigger
      // and data; this is corruption detection, not a proposed restore bypass.
      await c.query('ALTER TABLE invoice_correction_receipts DISABLE TRIGGER invoice_correction_receipts_guard');
      await c.query('UPDATE invoice_correction_receipts SET receipt=$1 WHERE correction_id=$2',[JSON.stringify(receipt),result.correction]);
      await c.query('ALTER TABLE invoice_correction_receipts ENABLE TRIGGER invoice_correction_receipts_guard');
      const {readUnpaidCurrencyTransitions}=await import('../../lib/invoice-unpaid-currency-evidence');
      await expect(readUnpaidCurrencyTransitions(c,[f.patient])).rejects.toThrow();
    });
  });
  it('refuses an unaudited cancellation even with a complete proof and acknowledgement',async()=>{
    const f=await root();
    await transaction(async c=>{await claim(c,f);await finish(c,f,'SAR','preserve-numerals',{skipAudit:true});
      await expect(c.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toThrow(/cancellation audit missing/);});
    expect(await q('SELECT status FROM invoices WHERE id=$1',[f.id])).toEqual([{status:'open'}]);
  });
});

describe('actual atomic application U0 writer, not modeled SQL', () => {
  async function request(f: Root, to: 'YER'|'SAR'|'USD', mode: 'preserve-numerals'|'reviewed-target-amounts'='preserve-numerals') {
    const preview=await writer.readUnpaidCurrencyCorrection(f.id,f.patient,session);
    return {version:1 as const,kind:'invoice-currency-correction' as const,evidenceKind:'unpaid_root_v1' as const,
      invoiceId:f.id,patientId:f.patient,idempotencyKey:`u0-app-${++serial}`,expectedSourceHash:preview.sourceHash,discountReason:'',
      intent:{version:1 as const,purpose:'wrong-currency' as const,fromCurrency:f.currency as 'YER'|'SAR'|'USD',toCurrency:to,
        reason:'Synthetic wrong currency',mode,...(mode==='reviewed-target-amounts'?{lines:f.items.map(itemId=>({itemId,unitPrice:'12'})),discount:'0'}:{})}};
  }
  it.each(['YER:SAR','YER:USD','SAR:YER','SAR:USD','USD:YER','USD:SAR'].flatMap(direction=>['preserve-numerals','reviewed-target-amounts'].map(mode=>({direction,mode}))))(
    'commits/replays exact authoritative $direction / $mode acknowledgement with no cash', async ({direction,mode}) => {
      const [from,to]=direction.split(':'); const f=await root(from);
      const body=await request(f,to as 'YER'|'SAR'|'USD',mode as 'preserve-numerals'|'reviewed-target-amounts');
      const before=await q('SELECT to_jsonb(i) AS invoice FROM invoices i WHERE id=$1',[f.id]);
      const first=await writer.correctUnpaidInvoiceCurrency(body,session);
      expect(first.replayed).toBe(false); expect(first.acknowledgement.original.createdAt).toBe('2026-01-02T03:04:05.123456Z');
      expect(first.acknowledgement.currency).toBe(to); expect(first.acknowledgement.originalCurrency).toBe(from);
      expect(first.acknowledgement.effectiveAt).toMatch(/\.\d{6}Z$/);
      const repeated=await writer.correctUnpaidInvoiceCurrency(body,session);
      expect(repeated.replayed).toBe(true); expect(repeated.acknowledgement).toEqual(first.acknowledgement);
      expect((await q('SELECT to_jsonb(i) AS invoice FROM invoices i WHERE id=$1',[f.id]))[0]).toEqual({invoice:{...(before[0].invoice as object),status:'cancelled'}});
      expect(await q('SELECT id FROM payments WHERE patient_id=$1',[f.patient])).toEqual([]);
      expect((await q<{n:number}>("SELECT count(*)::int AS n FROM audit_log WHERE entity='invoice' AND entity_id=$1 AND details->>'evidenceKind'='unpaid_root_v1'",[String(f.id)]))[0].n).toBe(1);
    });
  it('refuses stale source and changed-body reuse, and a committed receipt after preview', async () => {
    const f=await root(), body=await request(f,'USD');
    await q("UPDATE invoice_items SET description='changed after preview' WHERE id=$1",[f.items[0]]);
    await expect(writer.correctUnpaidInvoiceCurrency(body,session)).rejects.toThrow(/تغيرت/);
    const fresh=await request(f,'USD'); await writer.correctUnpaidInvoiceCurrency(fresh,session);
    await expect(writer.correctUnpaidInvoiceCurrency({...fresh,intent:{...fresh.intent,reason:'Different reason'}},session)).rejects.toThrow(/مفتاح/);
    const g=await root(), pending=await request(g,'SAR'), relationWriter=await relation(g,'payment'); await relationWriter.insert(db.getPool());
    await expect(writer.correctUnpaidInvoiceCurrency(pending,session)).rejects.toThrow(/standalone/);
    expect(await q('SELECT status FROM invoices WHERE id=$1',[g.id])).toEqual([{status:'open'}]);
  });
  it('refuses fractional numerals into YER and changed membership before any cancellation', async () => {
    const f=await root('SAR'); await q('UPDATE invoice_items SET unit_price_minor=1001,total_minor=1001 WHERE invoice_id=$1',[f.id]);
    await q('UPDATE invoices SET total_minor=2002 WHERE id=$1',[f.id]);
    await expect(writer.correctUnpaidInvoiceCurrency(await request(f,'YER'),session)).rejects.toThrow(/PRECISION/);
    expect(await q('SELECT status FROM invoices WHERE id=$1',[f.id])).toEqual([{status:'open'}]);
    expect(await q('SELECT source_id FROM invoice_unpaid_currency_claims WHERE source_id=$1',[f.id])).toEqual([]);
  });
  it('revalidates a revoked admin session and preserves the source', async () => {
    const f=await root(), body=await request(f,'SAR');
    await q('UPDATE users SET is_active=FALSE WHERE id=$1',[session.userId]);
    try {await expect(writer.correctUnpaidInvoiceCurrency(body,session)).rejects.toThrow(/جلسة/);}
    finally {await q('UPDATE users SET is_active=TRUE WHERE id=$1',[session.userId]);}
    expect(await q('SELECT status FROM invoices WHERE id=$1',[f.id])).toEqual([{status:'open'}]);
  });
  it('two actual application callers with the same frozen key return one identical acknowledgement', async () => {
    const f=await root(), body=await request(f,'USD');
    const results=await Promise.all([writer.correctUnpaidInvoiceCurrency(body,session),writer.correctUnpaidInvoiceCurrency(body,session)]);
    expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);
    expect(results[0].acknowledgement).toEqual(results[1].acknowledgement);
    expect((await q<{n:number}>('SELECT count(*)::int AS n FROM invoice_corrections WHERE original_invoice_id=$1',[f.id]))[0].n).toBe(1);
  });
  it('unmounted HTTP executes the real reader/writer and retries an ignored committed response identically', async () => {
    const sessions = await import('../../lib/session');
    const admitted = vi.spyOn(sessions, 'requireSession').mockResolvedValue(session);
    const { unpaidCurrencyHttp } = await import('../../lib/invoice-unpaid-currency-http');
    const { freezeUnpaidCurrencyCommand, restoreUnpaidCurrencyCommand } = await import('../../lib/invoice-unpaid-currency-recovery');
    const f = await root(); const path = { invoiceId: String(f.id), patientId: String(f.patient) };
    const url = 'https://clinic.example/unmounted-test-only';
    const send = (body: string, requestHash: string) => unpaidCurrencyHttp(new Request(url, { method: 'POST', headers: { origin: 'https://clinic.example', 'Content-Type': 'application/json', 'X-Unpaid-Currency-Request-Hash': requestHash }, body }), path);
    try {
      const previewResponse = await unpaidCurrencyHttp(new Request(url), path);
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json();
      expect(preview.actor).toEqual({ userId: session.userId, username: session.username, role: 'admin' });
      expect(preview.sourceCreatedAt).toBe('2026-01-02T03:04:05.123456Z');
      const command = await freezeUnpaidCurrencyCommand(await request(f, 'USD'), preview);
      const restored = await restoreUnpaidCurrencyCommand(command, f.patient, preview.actor);
      // Two independently valid admins: session switches AFTER freezing A's
      // command but BEFORE its first delivery. Must refuse BEFORE any write.
      const otherAdmin = { ...session, userId: syntheticActorId, username: 'synthetic' };
      const authorityClient = await db.getPool().connect();
      try {
        await authorityClient.query('BEGIN');
        expect(await sessions.revalidateSessionInTransaction(otherAdmin, authorityClient)).toMatchObject(otherAdmin);
      } finally { await authorityClient.query('ROLLBACK'); authorityClient.release(); }
      admitted.mockResolvedValue(otherAdmin);
      const switched = await send(restored.evidence.body, restored.evidence.requestHash);
      expect(switched.status).toBe(409); expect((await switched.json()).code).toBe('actor_binding_mismatch');
      expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM invoice_corrections WHERE original_invoice_id=$1', [f.id]))[0].n).toBe(0);
      expect(await q('SELECT status FROM invoices WHERE id=$1', [f.id])).toEqual([{ status: 'open' }]);
      admitted.mockResolvedValue(session);
      const first = await send(restored.evidence.body, restored.evidence.requestHash);
      expect(first.status).toBe(200); // Deliberately ignore body, modeling lost delivery AFTER real COMMIT.
      expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM invoice_corrections WHERE original_invoice_id=$1', [f.id]))[0].n).toBe(1);
      const replay = await send(restored.evidence.body, restored.evidence.requestHash); expect(replay.status).toBe(200);
      const result = await replay.json(); expect(result.replayed).toBe(true);
      expect(result.acknowledgement).toEqual((await first.json()).acknowledgement);
      // Same username but wrong user ID cannot reinterpret a saved command.
      admitted.mockResolvedValue({ ...session, userId: syntheticActorId });
      const mismatch = await send(restored.evidence.body, restored.evidence.requestHash); expect(mismatch.status).toBe(409);
      expect((await mismatch.json()).recovery).toBe('retain_exact_command');
      admitted.mockResolvedValue(session);
      await q('UPDATE users SET is_active=FALSE WHERE id=$1', [session.userId]);
      const revoked = await send(restored.evidence.body, restored.evidence.requestHash); expect(revoked.status).toBe(403);
      expect((await revoked.json()).outcome).toBe('unconfirmed');
    } finally { await q('UPDATE users SET is_active=TRUE WHERE id=$1', [session.userId]); admitted.mockRestore(); }
  });
  it('actual preview holds canonical user SHARE fence until its snapshot completes', async () => {
    const f = await root(), blocker = await client(), revoker = await client();
    let preview: ReturnType<typeof captured> | undefined, revocation: ReturnType<typeof captured> | undefined;
    try {
      const { rows: [{ pid }] } = await blocker.query('SELECT pg_backend_pid() AS pid');
      await blocker.query('BEGIN'); await blocker.query('LOCK TABLE settings IN ACCESS EXCLUSIVE MODE');
      preview = captured(writer.readUnpaidCurrencyCorrection(f.id, f.patient, session));
      const previewPid = await blockedBy(pid, 'settings');
      revocation = captured(revoker.query('UPDATE users SET is_active=FALSE WHERE id=$1', [session.userId]));
      await blockedBy(previewPid, 'UPDATE users');
      await blocker.query('ROLLBACK');
      expect((await preview).error).toBeUndefined(); expect((await revocation).error).toBeUndefined();
      await expect(writer.readUnpaidCurrencyCorrection(f.id, f.patient, session)).rejects.toThrow(/جلسة/);
    } finally {
      await blocker.query('ROLLBACK'); await preview; await revocation;
      await q('UPDATE users SET is_active=TRUE WHERE id=$1', [session.userId]);
      await blocker.end(); await revoker.end();
    }
  });
  async function blockedBy(pid: number, fragment: string) {
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) {
      const rows=await q<{pid:number}>("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2",[pid,`%${fragment}%`]);
      if(rows.length) return rows[0].pid;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    throw new Error(`No observed actual application lock wait for ${fragment}`);
  }
  const payment=(f:Root)=>db.recordPayment({patientId:f.patient,invoiceId:f.id,kind:'payment',amountMinor:1,currency:f.currency as 'YER'|'SAR'|'USD',
    baseCurrency:f.currency as 'YER'|'SAR'|'USD',exchangeRate:1,method:'cash',note:null,createdBy:session.username,idempotencyKey:`u0-real-pay-${++serial}`});
  it.each([true,false])('actual receipt/correction transaction ordering, receipt wins=%s',async receiptWins=>{
    const f=await root(), body=await request(f,'SAR'), blocker=await client();
    let paymentResult: ReturnType<typeof captured<Awaited<ReturnType<typeof payment>>>> | undefined;
    let correctionResult: ReturnType<typeof captured<Awaited<ReturnType<typeof writer.correctUnpaidInvoiceCurrency>>>> | undefined;
    try {
      await blocker.query('BEGIN'); const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await blocker.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[f.id]);
      if(receiptWins) {
        paymentResult=captured(payment(f)); const paymentPid=await blockedBy(pid,'FOR SHARE');
        correctionResult=captured(writer.correctUnpaidInvoiceCurrency(body,session)); await blockedBy(paymentPid,'cashier_shifts');
      } else {
        correctionResult=captured(writer.correctUnpaidInvoiceCurrency(body,session)); const correctionPid=await blockedBy(pid,'FOR UPDATE');
        paymentResult=captured(payment(f)); await blockedBy(correctionPid,'cashier_shifts');
      }
      await blocker.query('COMMIT');
      const pay=await paymentResult, correction=await correctionResult;
      if(receiptWins) {expect(pay.error).toBeUndefined();expect(pay.value?.payment).not.toBeNull();expect(correction.error).toBeDefined();}
      else {expect(correction.error).toBeUndefined();expect(pay.value?.reason).toBe('invalid_invoice');}
      expect((await q<{n:number}>('SELECT count(*)::int AS n FROM payments WHERE invoice_id=$1',[f.id]))[0].n).toBe(receiptWins?1:0);
      expect((await q<{n:number}>('SELECT count(*)::int AS n FROM invoice_corrections WHERE original_invoice_id=$1',[f.id]))[0].n).toBe(receiptWins?0:1);
    } finally {await blocker.query('ROLLBACK');await blocker.end();if(paymentResult)await paymentResult;if(correctionResult)await correctionResult;}
  });
  it('needs no open shift for a non-cash correction and refuses a receipt through a newly opened shift',async()=>{
    const f=await root(), body=await request(f,'SAR');
    await q("UPDATE cashier_shifts SET status='closed',closed_at=clock_timestamp() WHERE status='open'");
    try {const result=await writer.correctUnpaidInvoiceCurrency(body,session);expect(result.replayed).toBe(false);}
    finally {shiftId=(await q<{id:number}>("INSERT INTO cashier_shifts(opened_by) VALUES('synthetic-new-shift') RETURNING id"))[0].id;}
    expect((await payment(f)).reason).toBe('invalid_invoice');
  });
  it.each(['YER:SAR','YER:USD','SAR:YER','SAR:USD','USD:YER','USD:SAR'])('current settlement/account and principal journal use exact %s buckets',async direction=>{
    const [from,to]=direction.split(':'), f=await root(from);
    const result=await writer.correctUnpaidInvoiceCurrency(await request(f,to as 'YER'|'SAR'|'USD'),session), ack=result.acknowledgement;
    const positionModule=await import('../../lib/invoice-settlement-position');
    const position=await transaction(c=>positionModule.readInvoiceSettlementPosition(c as unknown as import('../../lib/db').DbClient,
      {patientId:f.patient,invoiceId:ack.corrected.id,currency:ack.currency}));
    expect(position.lineageInvoiceIds).toEqual([f.id,ack.corrected.id]);expect(position.settledMinor).toBe(0);expect(position.remainingMinor).toBe(ack.targetPrincipalMinor);
    const debt=await db.computeDebtRows([f.patient],true);
    expect(debt.find(r=>r.currency===to)?.billedMinor).toBe(ack.targetPrincipalMinor);
    expect(debt.find(r=>r.currency===from)?.billedMinor??0).toBe(0);
    const journal=await import('../../lib/invoice-currency-journal');
    const entries=await transaction(c=>journal.currencyReclassificationJournal(c as unknown as import('../../lib/db').DbClient,'2020-01-01','2100-01-01','UTC'));
    const reversal=entries.find(e=>e.reference===`UCR-${ack.correctionId}/${ack.original.invoiceNumber}`);
    expect(reversal).toBeDefined();expect(reversal?.lines.every(l=>l.currency===from)).toBe(true);
    expect(reversal?.lines.find(l=>l.accountCode==='1201')?.amountMinor).toBe(ack.sourcePrincipalMinor);
    const report=await import('../../lib/reports');
    // Exercise main's real snapshot-backed report loader, not only pure arithmetic.
    for(const [cutoff,expectedSource,expectedTarget] of [['2026-01-03',ack.sourcePrincipalMinor,0],[ack.effectiveAt.slice(0,10),0,ack.targetPrincipalMinor]] as const){
      const filters=report.parseFilters(new URLSearchParams({preset:'custom',from:'2026-01-01',to:cutoff,patientId:String(f.patient)}),cutoff);
      const statement=await report.buildReport('patient-statement',filters);
      const rows=statement.rows;if(!rows)throw new Error('Patient statement rows missing');
      const net=(currency:string)=>rows.filter(row=>row.currency===currency).reduce((sum,row)=>sum+Number(row.debitMinor)-Number(row.creditMinor),0);
      expect(net(from)).toBe(expectedSource);expect(net(to)).toBe(expectedTarget);
    }
    const movement={invoices:[{date:ack.effectiveAt.slice(0,10),currency:ack.currency,netMinor:ack.targetPrincipalMinor}],payments:[],openings:{},
      currencyCorrections:[{invoiceId:f.id,issuedDate:'2026-01-02',date:ack.effectiveAt.slice(0,10),minor:ack.sourcePrincipalMinor,sourceCurrency:ack.originalCurrency}]};
    expect(report.balancesByCurrencyAt(movement,'2026-01-03')[ack.originalCurrency]).toBe(ack.sourcePrincipalMinor);
    expect(report.balancesByCurrencyAt(movement,ack.effectiveAt.slice(0,10))[ack.currency]).toBe(ack.targetPrincipalMinor);
    expect(report.oldestUnpaidByCurrency(movement,'2026-01-03')[ack.originalCurrency].date).toBe('2026-01-02');
  });

  it.each(['YER:SAR','YER:USD','SAR:YER','SAR:USD','USD:YER','USD:SAR'])('commission historical cutoff preserves original principal and current %s currency',async direction=>{
    const [from,to]=direction.split(':'), f=await root(from);
    const [{id:doctor}]=await q<{id:number}>("INSERT INTO parties(name,kind,commission_percent) VALUES($1,'doctor',10) RETURNING id",[`U0-doctor-${++serial}`]);
    await q('UPDATE invoice_items SET doctor_id=$1 WHERE invoice_id=$2',[doctor,f.id]);
    const result=await writer.correctUnpaidInvoiceCurrency(await request(f,to as 'YER'|'SAR'|'USD'),session), ack=result.acknowledgement;
    const historical=(await db.commissionReport('2026-01-01','2026-01-31')).filter(r=>r.doctorId===doctor);
    expect(historical.find(r=>r.currency===from)?.accruedMinor).toBe(ack.sourcePrincipalMinor/10);
    expect(historical.find(r=>r.currency===to)?.accruedMinor??0).toBe(0);
    const current=(await db.commissionReport('2026-01-01','2100-01-01')).filter(r=>r.doctorId===doctor);
    expect(current.find(r=>r.currency===to)?.accruedMinor).toBe(ack.targetPrincipalMinor/10);
    expect(current.find(r=>r.currency===from)?.accruedMinor??0).toBe(0);
    expect(current.every(r=>r.earnedMinor===0)).toBe(true);
  });

  it.each([true,false])('actual schedule/correction transaction ordering, schedule wins=%s',async scheduleWins=>{
    const f=await root(), body=await request(f,'SAR'), blocker=await client();
    const schedule=await import('../../lib/debt-installments-db');
    const scheduleRequest={target:{patientId:f.patient,currency:'YER' as const,invoiceId:f.id,openingCurrency:null},terms:{mode:'full',installments:[]},
      expectedVersion:0,expectedRemainingMinor:2000,reason:'Synthetic original schedule',idempotencyKey:`u0-real-schedule-${++serial}`,session};
    let scheduleResult: ReturnType<typeof captured<Awaited<ReturnType<typeof schedule.saveDebtRepayment>>>> | undefined;
    let correctionResult: ReturnType<typeof captured<Awaited<ReturnType<typeof writer.correctUnpaidInvoiceCurrency>>>> | undefined;
    try {
      await blocker.query('BEGIN'); const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await blocker.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[f.id]);
      if(scheduleWins) {
        scheduleResult=captured(schedule.saveDebtRepayment(scheduleRequest)); const schedulePid=await blockedBy(pid,'FOR UPDATE');
        correctionResult=captured(writer.correctUnpaidInvoiceCurrency(body,session)); await blockedBy(schedulePid,'cashier_shifts');
      } else {
        correctionResult=captured(writer.correctUnpaidInvoiceCurrency(body,session)); const correctionPid=await blockedBy(pid,'FOR UPDATE');
        scheduleResult=captured(schedule.saveDebtRepayment(scheduleRequest)); await blockedBy(correctionPid,'cashier_shifts');
      }
      await blocker.query('COMMIT'); const scheduled=await scheduleResult, corrected=await correctionResult;
      if(scheduleWins){expect(scheduled.error).toBeUndefined();expect(corrected.error).toBeDefined();}
      else {expect(corrected.error).toBeUndefined();expect(scheduled.error).toBeDefined();}
      expect((await q<{n:number}>('SELECT count(*)::int AS n FROM debt_repayment_arrangements WHERE invoice_id=$1',[f.id]))[0].n).toBe(scheduleWins?1:0);
      expect((await q<{n:number}>('SELECT count(*)::int AS n FROM invoice_corrections WHERE original_invoice_id=$1',[f.id]))[0].n).toBe(scheduleWins?0:1);
    } finally {await blocker.query('ROLLBACK');await blocker.end();if(scheduleResult)await scheduleResult;if(correctionResult)await correctionResult;}
  });
  it('refuses an actually cancelled repayment schedule, not merely currently active schedules',async()=>{
    const f=await root(), body=await request(f,'SAR'), schedule=await import('../../lib/debt-installments-db');
    const input={target:{patientId:f.patient,currency:'YER' as const,invoiceId:f.id,openingCurrency:null},terms:{mode:'full',installments:[]},
      expectedVersion:0,expectedRemainingMinor:2000,reason:'Synthetic original schedule',idempotencyKey:`u0-old-schedule-${++serial}`,session};
    await schedule.saveDebtRepayment(input);
    await schedule.saveDebtRepayment({...input,cancel:true,expectedVersion:1,idempotencyKey:`u0-cancel-schedule-${++serial}`});
    await expect(writer.correctUnpaidInvoiceCurrency(body,session)).rejects.toThrow(/standalone/);
    expect(await q('SELECT status FROM invoices WHERE id=$1',[f.id])).toEqual([{status:'open'}]);
  });

  it.each([true,false])('actual existing-invoice agreement approval versus U0, approval wins=%s',async approvalWins=>{
    const f=await root(), body=await request(f,'SAR');
    const plan=await db.createPlanV2({patientId:f.patient,title:'U0 existing source agreement',specialty:null,primaryDoctorId:null,billingMode:'installments',baseCurrency:'YER',
      startDate:'2026-10-01',note:null,createdBy:session.username,items:[],installments:[{dueDate:'2026-12-01',amountMinor:2000}]});
    if(!plan.ok)throw new Error(plan.message);
    expect(await db.recordPlanConsent({planId:plan.planId,actor:session.username,note:null})).toMatchObject({ok:true});
    const {approveAgreement}=await import('../../lib/approved-agreements');
    const approve=()=>approveAgreement({planId:plan.planId,expectedTotalMinor:2000,currency:'YER',source:{kind:'invoice',invoiceId:f.id},reason:'Explicit synthetic existing source',idempotencyKey:`u0-approval-${++serial}`,session});
    const blocker=await client();let a:ReturnType<typeof captured<Awaited<ReturnType<typeof approve>>>>|undefined;
    let c:ReturnType<typeof captured<Awaited<ReturnType<typeof writer.correctUnpaidInvoiceCurrency>>>>|undefined;
    try{
      await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await blocker.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[f.id]);
      if(approvalWins){a=captured(approve());const first=await blockedBy(pid,'FOR UPDATE');c=captured(writer.correctUnpaidInvoiceCurrency(body,session));await blockedBy(first,'cashier_shifts');}
      else{c=captured(writer.correctUnpaidInvoiceCurrency(body,session));const first=await blockedBy(pid,'FOR UPDATE');a=captured(approve());await blockedBy(first,'cashier_shifts');}
      await blocker.query('COMMIT');const approved=await a,corrected=await c;
      if(approvalWins){expect(approved.error).toBeUndefined();expect(approved.value?.agreement.invoice_id).toBe(f.id);expect(corrected.error).toBeDefined();}
      else{expect(corrected.error).toBeUndefined();expect(approved.error).toBeDefined();}
      expect((await q<{n:number}>('SELECT count(*)::int AS n FROM approved_agreement_principals WHERE invoice_id=$1',[f.id]))[0].n).toBe(approvalWins?1:0);
      expect((await q<{n:number}>('SELECT count(*)::int AS n FROM invoice_corrections WHERE original_invoice_id=$1',[f.id]))[0].n).toBe(approvalWins?0:1);
      expect((await q<{n:number}>('SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1',[f.patient]))[0].n).toBe(approvalWins?1:2);
    }finally{await blocker.query('ROLLBACK');await blocker.end();if(a)await a;if(c)await c;}
  });

  it.each([true,false])('actual new linked clinical/plan/visit invoice stays independent of U0, linkage first=%s',async linkageFirst=>{
    const f=await root(),body=await request(f,'SAR');
    const [{id:doctor}]=await q<{id:number}>("INSERT INTO parties(name,kind) VALUES($1,'doctor') RETURNING id",[`U0-linked-doctor-${++serial}`]);
    const [{id:serviceId}]=await q<{id:number}>("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES($1,'rct',3000,TRUE,TRUE) RETURNING id",[`U0-linked-service-${++serial}`]);
    const [{id:visitId}]=await q<{id:number}>("INSERT INTO visits(patient_id,patient_name) VALUES($1,'U0 unrelated explicit visit') RETURNING id",[f.patient]);
    const template=await import('../../lib/invoice-template'),{DEFAULT_SPECIALTY_TEMPLATES}=await import('../../lib/specialty-templates');
    const source={patientId:f.patient,visitId,currency:'YER',items:[{serviceId,doctorId:doctor,toothCode:11,price:'3000',catalogPriceMinor:3000}],discount:'0',idempotencyKey:`u0-new-link-${++serial}`};
    const parsed=template.parseInvoiceCommand(source,new Map((await db.listServices(true)).map(service=>[service.id,service])),new Set([doctor]),await db.getSettings(),true);
    if(!parsed.ok)throw new Error(parsed.message);
    const {authorityLines:_authority,template:_template,...values}=parsed;void _authority;void _template;
    const input={...values,createdBy:session.username,actorRole:session.role,templates:DEFAULT_SPECIALTY_TEMPLATES,requestHash:template.invoiceCatalogRequestFingerprint(source,session),auditDetails:{},
      catalogueAuthority:{source,fingerprint:template.invoiceCommandFingerprint(parsed),session}};
    const linkage=await import('../../lib/invoice-linkage-db'),blocker=await client();
    let linked:ReturnType<typeof captured<Awaited<ReturnType<typeof linkage.createLinkedInvoice>>>>|undefined;
    let corrected:ReturnType<typeof captured<Awaited<ReturnType<typeof writer.correctUnpaidInvoiceCurrency>>>>|undefined;
    try{
      await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await blocker.query("SELECT id FROM cashier_shifts WHERE status='open' ORDER BY id FOR UPDATE");
      if(linkageFirst){linked=captured(linkage.createLinkedInvoice(input));const first=await blockedBy(pid,'cashier_shifts');corrected=captured(writer.correctUnpaidInvoiceCurrency(body,session));await blockedBy(first,'cashier_shifts');}
      else{corrected=captured(writer.correctUnpaidInvoiceCurrency(body,session));const first=await blockedBy(pid,'cashier_shifts');linked=captured(linkage.createLinkedInvoice(input));await blockedBy(first,'cashier_shifts');}
      await blocker.query('COMMIT');const l=await linked,c=await corrected;
      expect(l.error).toBeUndefined();expect(c.error).toBeUndefined();if(!l.value?.ok||!c.value)throw new Error('Both independent writers must succeed');
      const saved=l.value,ack=c.value.acknowledgement;
      expect(saved.invoice.id).not.toBe(f.id);expect(saved.invoice.id).not.toBe(ack.corrected.id);
      expect(await q('SELECT invoice_id FROM visits WHERE id=$1',[visitId])).toEqual([{invoice_id:saved.invoice.id}]);
      expect((await q<{n:number}>('SELECT count(*)::int AS n FROM plan_items WHERE origin_invoice_id=$1 OR billed_invoice_id=$1',[saved.invoice.id]))[0].n).toBeGreaterThan(0);
      expect((await q<{n:number}>('SELECT count(*)::int AS n FROM clinical_cases WHERE origin_invoice_id=$1',[saved.invoice.id]))[0].n).toBeGreaterThan(0);
      await expect(writer.readUnpaidCurrencyCorrection(saved.invoice.id,f.patient,session)).rejects.toThrow();
      // Signature retains only its actual linked document, never the corrected unrelated source.
      expect(await db.saveClinicalNotes({visitId,chiefComplaint:'Synthetic review',examination:'Synthetic examination',diagnosis:'Synthetic diagnosis',treatmentDone:'Synthetic no-charge review',nextPlan:'Synthetic follow-up',doctorId:doctor})).toBe(true);
      const signRoot=await root('YER',f.patient),signBody=await request(signRoot,'USD');
      const sign=()=>db.signClinicalVisit({visitId,baseCurrency:'YER' as const,signedBy:session.username,signerRole:'admin',signerDoctorPartyId:doctor});
      let signing:ReturnType<typeof captured<Awaited<ReturnType<typeof sign>>>>|undefined;
      let signCorrection:ReturnType<typeof captured<Awaited<ReturnType<typeof writer.correctUnpaidInvoiceCurrency>>>>|undefined;
      try{
        await blocker.query('BEGIN');
        if(linkageFirst){
          await blocker.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE',[signRoot.id]);
          signCorrection=captured(writer.correctUnpaidInvoiceCurrency(signBody,session));await blockedBy(pid,'FOR UPDATE');
          signing=captured(sign());expect((await signing).value).toMatchObject({reason:null,invoiceId:null});
        }else{
          await blocker.query('SELECT id FROM visits WHERE id=$1 FOR UPDATE',[visitId]);
          signing=captured(sign());await blockedBy(pid,'FROM visits');
          signCorrection=captured(writer.correctUnpaidInvoiceCurrency(signBody,session));expect((await signCorrection).error).toBeUndefined();
        }
        await blocker.query('COMMIT');
        expect((await signing).value).toMatchObject({reason:null,invoiceId:null});
        expect((await signCorrection).value?.acknowledgement.original.id).toBe(signRoot.id);
      }finally{await blocker.query('ROLLBACK');if(signing)await signing;if(signCorrection)await signCorrection;}

      expect(await q('SELECT invoice_id,status FROM visits WHERE id=$1',[visitId])).toEqual([{invoice_id:saved.invoice.id,status:'done'}]);
      await expect(writer.readUnpaidCurrencyCorrection(saved.invoice.id,f.patient,session)).rejects.toThrow();
      await q("UPDATE clinical_cases SET status='closed',completed_at=clock_timestamp() WHERE origin_invoice_id=$1",[saved.invoice.id]);
      await q("UPDATE plan_items SET status='cancelled' WHERE origin_invoice_id=$1 OR billed_invoice_id=$1",[saved.invoice.id]);
      await expect(writer.readUnpaidCurrencyCorrection(saved.invoice.id,f.patient,session)).rejects.toThrow();
      expect((await q<{n:number}>('SELECT count(*)::int AS n FROM payments WHERE invoice_id=ANY($1::int[])',[[f.id,ack.corrected.id,saved.invoice.id]]))[0].n).toBe(0);
      expect((await q<{n:number}>('SELECT count(*)::int AS n FROM invoice_corrections WHERE original_invoice_id=$1',[f.id]))[0].n).toBe(1);
    }finally{await blocker.query('ROLLBACK');await blocker.end();if(linked)await linked;if(corrected)await corrected;}
  });

});
