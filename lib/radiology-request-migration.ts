import type { DbClient } from './db';
import { checksumOf, type MigrationFile } from './migration-files';
import { RADIOLOGY_REQUEST_SQL } from './radiology-request-schema';
export const RADIOLOGY_REQUEST_MIGRATIONS: MigrationFile[] = [{ version: '0094', name: 'radiology_requests', filename: '0094_radiology_requests.sql', sql: RADIOLOGY_REQUEST_SQL, checksum: checksumOf(RADIOLOGY_REQUEST_SQL) }];
/** Registry and existing catalog must agree; unregistered residue is never adopted. */
export async function validateRadiologyRequestMigration(client: DbClient, files: MigrationFile[], applied: { version: string; name: string; checksum: string; adopted: boolean }[]) {
  const file = files.find(row => row.version === '0094'); if (!file) return;
  const expected = RADIOLOGY_REQUEST_MIGRATIONS[0], registered = applied.find(row => row.version === '0094');
  const fail = (): never => { throw new Error('RADIOLOGY_REQUEST_CATALOG_MISMATCH: 0094'); };
  if (file.name !== expected.name || file.checksum !== expected.checksum || checksumOf(file.sql) !== expected.checksum) fail();
  if (registered && (registered.name !== expected.name || registered.checksum !== expected.checksum || registered.adopted)) fail();
  const { rows: columns } = await client.query<{ column_name: string; udt_name: string; is_nullable: string; column_default: string | null; character_maximum_length: number | null }>(`SELECT column_name,udt_name,is_nullable,column_default,character_maximum_length FROM information_schema.columns WHERE table_schema='public' AND table_name='radiology_requests' ORDER BY ordinal_position`);
  const { rows: functions } = await client.query<{ proname:string; prosrc:string; provolatile:string; prosecdef:boolean; language:string; args:string; result:string; config:string[]|null }>(`SELECT p.proname,p.prosrc,p.provolatile,p.prosecdef,l.lanname AS language,pg_get_function_identity_arguments(p.oid) AS args,pg_get_function_result(p.oid) AS result,p.proconfig AS config FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.proname IN ('aqlan_radiology_request_immutable','aqlan_radiology_request_truncate','aqlan_radiology_snapshot_valid')`);
  if (!registered) { if (columns.length || functions.length) fail(); return; }
  const expectedColumns = [['command_key','uuid','NO',null],['actor_user_id','int4','NO',null],['actor_username','text','NO',null],['patient_id','int4','NO',null],['visit_id','int4','YES',null],['doctor_party_id','int4','NO',null],['payload_sha256','bpchar','NO',null],['snapshot','jsonb','NO',null],['created_at','timestamptz','NO','now()']];
  if (JSON.stringify(columns.map(row => [row.column_name,row.udt_name,row.is_nullable,row.column_default])) !== JSON.stringify(expectedColumns) || columns[6]?.character_maximum_length !== 64) fail();
  if (functions.length !== 3) fail();
  for (const fn of functions) {
    const snapshot=fn.proname==='aqlan_radiology_snapshot_valid';
    const declaration=snapshot?'aqlan_radiology_snapshot_valid(s JSONB, patient INTEGER, visit INTEGER, doctor INTEGER) RETURNS BOOLEAN\nLANGUAGE sql IMMUTABLE AS $$':`${fn.proname}() RETURNS TRIGGER\nLANGUAGE plpgsql AS $$`;
    const body=RADIOLOGY_REQUEST_SQL.split(`CREATE FUNCTION ${declaration}`)[1]?.split('$$;')[0];
    if(!body||body!==fn.prosrc||fn.provolatile!==(snapshot?'i':'v')||fn.prosecdef||fn.language!==(snapshot?'sql':'plpgsql')||fn.args!==(snapshot?'s jsonb, patient integer, visit integer, doctor integer':'')||fn.result!==(snapshot?'boolean':'trigger')||fn.config!==null) fail();
  }
  const { rows: triggers } = await client.query<{ tgname: string; tgtype: number; tgenabled: string; proname: string; function_schema:string }>(`SELECT t.tgname,t.tgtype,t.tgenabled,p.proname,fn.nspname AS function_schema FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace fn ON fn.oid=p.pronamespace WHERE n.nspname='public' AND c.relname='radiology_requests' AND NOT t.tgisinternal ORDER BY t.tgname`);
  if (JSON.stringify(triggers) !== JSON.stringify([{tgname:'radiology_request_immutable',tgtype:27,tgenabled:'O',proname:'aqlan_radiology_request_immutable',function_schema:'public'},{tgname:'radiology_request_truncate',tgtype:34,tgenabled:'O',proname:'aqlan_radiology_request_truncate',function_schema:'public'}])) fail();
  const { rows: constraints } = await client.query<{ definition: string; convalidated: boolean }>(`SELECT pg_get_constraintdef(c.oid) AS definition,c.convalidated FROM pg_constraint c WHERE c.conrelid='radiology_requests'::regclass AND c.contype NOT IN ('n','t') ORDER BY definition`);
  const normalize = (s: string) => s.replace(/public\./g,'').replace(/::(?:text|integer)/g,'').replace(/[\s()\"]/g,'').toLowerCase();
  const expectedConstraints = ['PRIMARY KEY (command_key)','CHECK (aqlan_radiology_snapshot_valid(snapshot, patient_id, visit_id, doctor_party_id))','CHECK (actor_user_id > 0)','CHECK (length(actor_username) >= 1 AND length(actor_username) <= 200)',"CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')","CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 32768)",'FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE RESTRICT','FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE RESTRICT','FOREIGN KEY (doctor_party_id) REFERENCES parties(id) ON DELETE RESTRICT'];
  if (constraints.some(row => !row.convalidated) || JSON.stringify(constraints.map(row => normalize(row.definition)).sort()) !== JSON.stringify(expectedConstraints.map(normalize).sort())) fail();
  const {rows:indexes}=await client.query<{definition:string;indisvalid:boolean;indisready:boolean;indisunique:boolean}>(`SELECT pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid,i.indisready,i.indisunique FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname='radiology_requests' ORDER BY definition`);
  const expectedIndexes=['CREATE UNIQUE INDEX radiology_requests_pkey ON public.radiology_requests USING btree (command_key)','CREATE INDEX radiology_requests_patient_history ON public.radiology_requests USING btree (patient_id, created_at DESC, command_key DESC)'];
  if(indexes.length!==2||indexes.some(row=>!row.indisvalid||!row.indisready)||JSON.stringify(indexes.map(row=>normalize(row.definition)).sort())!==JSON.stringify(expectedIndexes.map(normalize).sort()))fail();

}
