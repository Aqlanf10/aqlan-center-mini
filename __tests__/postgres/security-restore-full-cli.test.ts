import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { storageKeyOf } from '../helpers/backup-blocks';

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({get: () => undefined}),
}));

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let workDir: string;
let bytes: Buffer;
let key: string;
const runFile = promisify(execFile);
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({...process.env});
  workDir = await mkdtemp(path.join(tmpdir(),'restore-full-cli-pg18-'));
  await migrate(fixture.source,{apply:true,files:await loadMigrationFiles()});
  const {rows:[patient]} = await fixture.source.query(
    "INSERT INTO patients (patient_number,full_name) VALUES ('RESTORE-FULL-001','Synthetic patient only') RETURNING id"
  );
  const invoices = [
    {number:'SYN-YER-01',currency:'YER',total:150000},
    {number:'SYN-SAR-01',currency:'SAR',total:12000},
  ];
  for(const invoice of invoices) {
    const {rows:[saved]} = await fixture.source.query(
      'INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency) VALUES ($1,$2,$3,0,$4) RETURNING id',
      [invoice.number,patient.id,invoice.total,invoice.currency]
    );
    await fixture.source.query(
      "INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES ($1,'synthetic restorative charge',1,$2,$2)",
      [saved.id,invoice.total]
    );
  }
  bytes=Buffer.from('PG18-SYNTHETIC-XRAY-BYTES-ONLY');
  key=storageKeyOf(bytes.toString());
  const sha=createHash('sha256').update(bytes).digest('hex');
  await fixture.source.query(
    "INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,'xray','Synthetic image','image/png',$2,$3,$4,'fixture')",
    [patient.id,bytes.length,sha,key]
  );
  const client=await fixture.source.connect();
  try {
    const blocks:Buffer[]=[];
    for await(const block of fullBackupBlocks({
      source:client,readDocument:async(storageKey)=>storageKey===key?bytes:null,
    })) blocks.push(Buffer.from(block));
    await writeFile(path.join(workDir,'synthetic-full.tar.gz'),gzipSync(Buffer.concat(blocks)));
  } finally {client.release();}
},300_000);

afterAll(async()=>{
  try { await fixture?.close(); } finally { if(workDir) await rm(workDir,{recursive:true,force:true}); }
});

it('actual restore-full CLI restores synthetic PostgreSQL 18 invoice currencies, references and attachment bytes',async()=>{
  const url=fixture.sqlTarget.options.connectionString!;
  const stage=path.join(workDir,'isolated-documents');
  const {stdout,stderr}=await runFile(process.execPath,[
    '--import','tsx','scripts/restore-full.ts',path.join(workDir,'synthetic-full.tar.gz')
  ],{
    cwd:process.cwd(),
    timeout:180_000,
    env:{
      ...process.env,NODE_ENV:'test',DATABASE_ENVIRONMENT:'test',
      DATABASE_URL:url,DOCUMENTS_DIR:stage,
    },
  });
  expect(stderr).not.toContain('RESTORE_FULL_UNSAFE_TARGET');
  expect(stdout).toContain('READY FOR CUTOVER'); // documented only, not an actual cutover

  const source=await fixture.source.query(
    "SELECT i.base_currency AS currency, SUM(ii.total_minor)::bigint AS amount FROM invoices i JOIN invoice_items ii ON ii.invoice_id=i.id WHERE i.invoice_number LIKE 'SYN-%' GROUP BY i.base_currency ORDER BY currency"
  );
  const restored=await fixture.sqlTarget.query(
    "SELECT i.base_currency AS currency, SUM(ii.total_minor)::bigint AS amount FROM invoices i JOIN invoice_items ii ON ii.invoice_id=i.id WHERE i.invoice_number LIKE 'SYN-%' GROUP BY i.base_currency ORDER BY currency"
  );
  expect(restored.rows).toEqual(source.rows);
  expect(restored.rows).toEqual([
    {currency:'SAR',amount:'12000'},
    {currency:'YER',amount:'150000'},
  ]);
  const links=await fixture.sqlTarget.query(
    "SELECT COUNT(*)::int AS n FROM invoice_items ii LEFT JOIN invoices i ON i.id=ii.invoice_id WHERE i.id IS NULL"
  );
  expect(links.rows[0].n).toBe(0);
  const patients=await fixture.sqlTarget.query(
    "SELECT COUNT(*)::int AS n FROM invoices i JOIN patients p ON p.id=i.patient_id WHERE p.patient_number='RESTORE-FULL-001'"
  );
  expect(patients.rows[0].n).toBe(2);
  const copy=await readFile(path.join(stage,key));
  expect(copy.equals(bytes)).toBe(true);
  expect(createHash('sha256').update(copy).digest('hex'))
    .toBe(createHash('sha256').update(bytes).digest('hex'));
},300_000);
