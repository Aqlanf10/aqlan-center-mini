/** Main-schema compatibility with proposed U0 tables and discriminator ABSENT.
 * No route, migration registration, production or real patient action. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { validatePostgresTestTarget } from './_safe-target';

const target = validatePostgresTestTarget();
if (process.env.USE_LOCAL_DB === 'true') throw new Error('Real PostgreSQL required');
const name = `aqlan_u0_absent_test_${randomUUID().replaceAll('-', '')}`;
const namePattern = /^aqlan_u0_absent_test_[a-f0-9]{32}$/;
const isolated = new URL(target.testUrl); isolated.pathname = `/${name}`;
const quote = (s: string) => `"${s.replaceAll('"','""')}"`;
const env = process.env as Record<string, string | undefined>;
const keys = ['DATABASE_URL','TEST_DATABASE_URL','POSTGRES_URL','POSTGRES_PRISMA_URL','POSTGRES_URL_NON_POOLING','NODE_ENV','DATABASE_ENVIRONMENT','USE_LOCAL_DB','SKIP_SEED'] as const;
const previous = Object.fromEntries(keys.map(key => [key,env[key]]));
const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
let connected = false, created = false, identity: { oid: string; owner: string } | undefined;
let db: typeof import('../../lib/db');
let session: import('../../lib/auth').SessionPayload;
type Root = { id: number; patient: number; currency: string; items: number[]; shift: number };
let serial = 0, shiftId = 0;
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> => (await db.getPool().query(sql,args)).rows as T[];
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
  await db.ensureSchema();
  const auth=await import('../../lib/auth');
  const password='synthetic-u0-not-a-login-password';
  const [{id:userId}]=await q<{id:number}>("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('u0-app-admin','Synthetic U0',$1,'admin',TRUE) RETURNING id",[password]);
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
async function root(currency = 'YER', existingPatient?:number): Promise<Root> {
  const n = ++serial;
  const patient = existingPatient ?? (await q<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYNTHETIC U0') RETURNING id",[`U0-${n}`]))[0].id;
  const [{ id }] = await q<{ id: number }>("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by,created_at) VALUES($1,$2,2000,$3,'synthetic','2026-01-02T03:04:05.123456Z') RETURNING id",[`U0-${n}`,patient,currency]);
  const items = (await q<{ id: number }>("INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'identical',1,1000,1000),($1,'identical',1,1000,1000) RETURNING id",[id])).map(r => r.id);
  return { id,patient,currency,items,shift: shiftId };
}
async function absent(){
  expect(await q("SELECT to_regclass('public.invoice_unpaid_currency_claims') AS claims,to_regclass('public.invoice_unpaid_currency_transitions') AS transitions")).toEqual([{claims:null,transitions:null}]);
  expect(await q("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='invoice_corrections' AND column_name='currency_evidence_kind'")).toEqual([]);
}
async function position(f:Root,id=f.id,currency=f.currency){
  const {readInvoiceSettlementPosition}=await import('../../lib/invoice-settlement-position');
  const {withFinancialReadSnapshot}=await import('../../lib/financial-read-snapshot');
  return withFinancialReadSnapshot(db.getPool(),c=>readInvoiceSettlementPosition(c as import('../../lib/db').DbClient,{patientId:f.patient,invoiceId:id,currency:currency as 'YER'|'SAR'|'USD'}));
}
async function statementNet(patient:number,currency:string){
  const reports=await import('../../lib/reports');
  const filters=reports.parseFilters(new URLSearchParams({preset:'custom',from:'2026-01-01',to:'2100-01-01',patientId:String(patient)}),'2026-10-21');
  const result=await reports.buildReport('patient-statement',filters);
  if(!result.rows)throw new Error('Statement rows missing');
  return result.rows.filter(r=>r.currency===currency).reduce((n,r)=>n+Number(r.debitMinor)-Number(r.creditMinor),0);
}
describe('real main-schema reader compatibility without U0 installation',()=>{
  it.each(['YER','SAR','USD'])('reads ordinary %s root through canonical lineage/account/report/journal/commission with U0 absent',async currency=>{
    await absent();const f=await root(currency);
    const [{id:doctor}]=await q<{id:number}>("INSERT INTO parties(name,kind,commission_percent) VALUES($1,'doctor',10) RETURNING id",[`ABSENT-doctor-${++serial}`]);
    await q('UPDATE invoice_items SET doctor_id=$1 WHERE invoice_id=$2',[doctor,f.id]);
    expect(await position(f)).toMatchObject({lineageInvoiceIds:[f.id],principalMinor:2000,settledMinor:0,remainingMinor:2000});
    expect((await db.computeDebtRows([f.patient])).find(r=>r.currency===currency)?.dueMinor).toBe(2000);
    expect(await statementNet(f.patient,currency)).toBe(2000);
    const entries=await db.journalEntries('2026-01-01','2100-01-01');expect(entries.some(e=>e.reference===`U0-${serial-1}`)).toBe(true);
    expect((await db.commissionReport('2026-01-01','2100-01-01')).find(r=>r.doctorId===doctor&&r.currency===currency)?.accruedMinor).toBe(200);
    await absent();
  });
  it('runs and replays actual paid YER to SAR v1, then reads a refund without installing U0',async()=>{
    await absent();const f=await root();
    const [{id:doctor}]=await q<{id:number}>("INSERT INTO parties(name,kind,commission_percent) VALUES($1,'doctor',10) RETURNING id",[`ABSENT-v1-doctor-${++serial}`]);
    await q('UPDATE invoice_items SET doctor_id=$1 WHERE invoice_id=$2',[doctor,f.id]);
    const paid=await db.recordPayment({patientId:f.patient,invoiceId:f.id,kind:'payment',amountMinor:100,currency:'SAR',baseCurrency:'YER',exchangeRate:450,method:'cash',note:null,createdBy:session.username,idempotencyKey:`absent-paid-${++serial}`});
    expect(paid.reason).toBeNull();if(!paid.payment)throw new Error('Receipt missing');
    const originalCash=await q('SELECT to_jsonb(p) AS row FROM payments p WHERE id=$1',[paid.payment.id]);
    const revision=await import('../../lib/invoice-revision-db'),view=await revision.readInvoiceRevision(f.id,session);
    expect(view.currencyCorrection?.available).toBe(true);
    const command={idempotencyKey:`absent-v1-${++serial}`,expectedSourceHash:view.sourceHash,currency:'SAR',reason:'Synthetic legacy correction with U0 absent',
      lines:f.items.map(itemId=>({itemId,quantity:1,unitPrice:'1000'})),discount:'0',repaymentTerms:{mode:'full',installments:[]},expectedRemainingMinor:199900};
    const ack=await revision.reviseInvoice(f.id,command,session);
    expect(await revision.reviseInvoice(f.id,command,session)).toEqual({...ack,replayed:true});
    if(!('corrected' in ack)||!ack.corrected)throw new Error('Corrected document missing');
    expect(await position(f,ack.corrected.id,'SAR')).toMatchObject({lineageInvoiceIds:[f.id,ack.corrected.id],principalMinor:200000,settledMinor:100,remainingMinor:199900});
    expect(await statementNet(f.patient,'SAR')).toBe(199900);
    expect(await statementNet(f.patient,'YER')).toBe(0);
    const entries=await db.journalEntries('2026-01-01','2100-01-01');expect(entries.some(e=>e.reference.startsWith('ISR-'))).toBe(true);
    expect((await db.commissionReport('2026-01-01','2100-01-01')).find(r=>r.doctorId===doctor&&r.currency==='SAR')?.accruedMinor).toBe(20000);
    const [{id:correctionId}]=await q<{id:number}>('SELECT id FROM invoice_corrections WHERE original_invoice_id=$1',[f.id]);
    const receipt=await q('SELECT receipt FROM invoice_correction_receipts WHERE correction_id=$1',[correctionId]);
    await q("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,reversal_of_id) VALUES($1,$2,$3,$4,'refund',1,'SAR',450,5,'YER',$5)",[`ABSENT-refund-${++serial}`,f.patient,f.id,f.shift,paid.payment.id]);
    expect(await position(f,ack.corrected.id,'SAR')).toMatchObject({settledMinor:99,remainingMinor:199901});
    expect(await statementNet(f.patient,'SAR')).toBe(199901);
    expect(await q('SELECT to_jsonb(p) AS row FROM payments p WHERE id=$1',[paid.payment.id])).toEqual(originalCash);
    expect(await q('SELECT receipt FROM invoice_correction_receipts WHERE correction_id=$1',[correctionId])).toEqual(receipt);
    await absent();
  });
});
