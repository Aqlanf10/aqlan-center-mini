import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resetLegacyPassword } from '../scripts/security/legacy-password-reset.mjs';
import { readLegacyStaffSchema, staffLifecycleLockKey } from '../lib/legacy-staff-schema.mjs';
function fixture({markers='0',users='r',parties='r',missing=false,fail='',verified=true,permissions=null}={}){
 const calls=[]; let hashed=false;
 const client={async query(sql,values){calls.push({sql,values});if(fail && sql.startsWith(fail))throw Error('synthetic failure');
 if(sql.includes('AS markers'))return {rows:[{markers,users_kind:users,parties_kind:parties}]};
 if(sql.startsWith('SELECT id'))return {rows:missing?[]:[{id:1,permissions}]};
 if(sql.startsWith('UPDATE'))return {rows:[{id:1,permissions}]};
 if(sql.startsWith('SELECT password_hash'))return {rows:[{password_hash:'synthetic-new-hash'}]};
 return {rows:[]};}};
 const input={username:'synthetic',password:'synthetic-password',hashPassword:async()=>{hashed=true;return 'synthetic-new-hash';},verifyPassword:async()=>verified};
 return {client,input,calls,get hashed(){return hashed;}};
}
test('marker-free reset owns transaction and locks before reading/writing credentials',async()=>{
 const f=fixture();await resetLegacyPassword(f.client,f.input);
 assert.deepEqual(f.calls.map(c=>c.sql.split(' ')[0]),['BEGIN','SELECT','SELECT','SELECT','UPDATE','SELECT','COMMIT']);
 assert.match(f.calls[1].sql,/pg_advisory_xact_lock_shared/);assert.equal(f.calls[1].values[0],staffLifecycleLockKey());
 assert.match(f.calls[3].sql,/FOR UPDATE$/);
});
for(const opts of [{markers:'1'},{markers:'17'},{users:'v'},{parties:null},{users:null,parties:null}])test(`held/unreadable before target access ${JSON.stringify(opts)}`,async()=>{
 const f=fixture(opts);await assert.rejects(resetLegacyPassword(f.client,f.input),/LEGACY_STAFF_/);assert.equal(f.hashed,false);assert.equal(f.calls.at(-1).sql,'ROLLBACK');assert.equal(f.calls.some(c=>c.sql.startsWith('SELECT id')),false);
});
for(const opts of [{missing:true},{verified:false},{fail:'UPDATE'},{fail:'SELECT password_hash'},{fail:'COMMIT'},{fail:'SELECT pg_advisory'},{fail:'SELECT (',}])test(`fail closed and rollback ${JSON.stringify(opts)}`,async()=>{
 const f=fixture(opts);await assert.rejects(resetLegacyPassword(f.client,f.input));assert.equal(f.calls.at(-1).sql,'ROLLBACK');
});
test('BEGIN failure never mutates',async()=>{const f=fixture({fail:'BEGIN'});await assert.rejects(resetLegacyPassword(f.client,f.input));assert.equal(f.calls.length,1);});
test('invalid schema rejected without SQL',async()=>{const f=fixture();await assert.rejects(resetLegacyPassword(f.client,f.input,'public;bad'));assert.equal(f.calls.length,0);});
test('inspector preserves complete exact footprint categories',async()=>{
 const f=fixture();await readLegacyStaffSchema(f.client);const [schema,relations,functions,triggers]=f.calls[0].values;
 assert.equal(schema,'public');
 for(const name of ['staff_authority_control','staff_identity_generations','staff_identity_subjects','staff_identity_state','staff_identity_binding_events','staff_identity_current','staff_authority_identity','staff_execution_epochs','users_staff_subject_identity'])assert.ok(relations.includes(name));
 assert.ok(functions.includes('staff_account_authority_epoch_guard'));assert.ok(triggers.includes('staff_identity_current_no_truncate'));
 for(const name of ['authorization_mode','authorization_epoch','staff_subject_id','clinical_authority_epoch'])assert.ok(f.calls[0].sql.includes(name));
});

for(const permissions of ['{"revision":1}', '{"grants":{},"legacy":true}', '{"schemaVersion":999}', 'not-json', '[]', '1'])test(`held permission envelope ${permissions}`,async()=>{const f=fixture({permissions});await assert.rejects(resetLegacyPassword(f.client,f.input),/PERMISSION_ENVELOPE_HELD/);assert.equal(f.hashed,false);assert.equal(f.calls.at(-1).sql,'ROLLBACK');});
for(const permissions of [null,'','null','{"financeAccess":true}'])test(`legacy permission compatibility ${permissions}`,async()=>{const f=fixture({permissions});await resetLegacyPassword(f.client,f.input);assert.equal(f.calls.at(-1).sql,'COMMIT');});
test('uncertain commit is never retried or treated as success',async()=>{const f=fixture({fail:'COMMIT'});await assert.rejects(resetLegacyPassword(f.client,f.input));assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,1);assert.equal(f.calls.filter(c=>c.sql.startsWith('UPDATE')).length,1);assert.equal(f.calls.at(-1).sql,'ROLLBACK');});

for(const permissions of ['{"constructor":1}','{"__proto__":{}}','{"nested":{"prototype":true}}',JSON.stringify({a:JSON.parse('['.repeat(34)+'0'+']'.repeat(34))})])test('strict shared raw-envelope parity',async()=>{const f=fixture({permissions});await assert.rejects(resetLegacyPassword(f.client,f.input),/PERMISSION_ENVELOPE_HELD/);assert.equal(f.hashed,false);});
