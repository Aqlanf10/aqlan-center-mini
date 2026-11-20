/** Synthetic migration/restore witness ONLY. Not an application migration. */
import { parseCanonicalPatientNumber, PATIENT_NUMBER_MAX, type PrefixSnapshot } from '../../../lib/patient-numbering-policy';
import type { NumberingPgFixture } from './patient-numbering-adapter';
function owned(f:NumberingPgFixture){if(!/^numbering_fixture_[a-f0-9]{32}$/.test(f.schema))throw new Error('Not an owned fixture');}
export async function prepareLegacyFixture(f:NumberingPgFixture,last:string,called:boolean,ids:string[]=[]){
  owned(f);if(!/^[1-9][0-9]{0,17}$/.test(last))throw new Error('Invalid synthetic legacy value');
  await f.pool.query(`CREATE SEQUENCE ${f.schema}.legacy_p; CREATE TABLE ${f.schema}.legacy_files(number text PRIMARY KEY); CREATE TABLE ${f.schema}.bootstrap(id integer PRIMARY KEY CHECK(id=1), complete boolean NOT NULL)`);
  await f.pool.query(`SELECT setval('${f.schema}.legacy_p',$1::bigint,$2)`,[last,called]);
  for(const id of ids)await f.pool.query(`INSERT INTO ${f.schema}.legacy_files VALUES($1)`,[id]);
}
export async function bootstrapLegacyFixture(f:NumberingPgFixture){
  owned(f);const c=await f.pool.connect();try{
    await c.query('BEGIN');await c.query(`SELECT id FROM ${f.schema}.config WHERE id=1 FOR UPDATE`);
    if((await c.query(`SELECT id FROM ${f.schema}.bootstrap WHERE complete`)).rowCount){await c.query('COMMIT');return;}
    const old=(await c.query(`SELECT last_value::text,is_called FROM ${f.schema}.legacy_p`)).rows[0];
    const rows=(await c.query(`SELECT number FROM ${f.schema}.legacy_files`)).rows;
    const maxima=new Map<string,bigint>();
    for(const row of rows){const parsed=parseCanonicalPatientNumber(row.number);if(!parsed)throw new Error('Ambiguous legacy identifier');maxima.set(parsed.prefix,parsed.number>(maxima.get(parsed.prefix)??0n)?parsed.number:maxima.get(parsed.prefix)!);}
    for(const prefix of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'){
      const historical=maxima.get(prefix)??0n;
      const current=(await c.query(`SELECT last_value::text,is_called FROM ${f.schema}.seq_${prefix.toLowerCase()}`)).rows[0];
      let last=BigInt(current.last_value),called=Boolean(current.is_called);
      // First-time migration P inherits legacy; fixture's placeholder7000 isn't a floor.
      if(prefix==='P'){last=BigInt(old.last_value);called=Boolean(old.is_called);}
      if(historical>=last){last=historical;called=true;}
      if(last<1n||last>PATIENT_NUMBER_MAX)throw new Error('Legacy value out of range');
      await c.query(`ALTER SEQUENCE ${f.schema}.seq_${prefix.toLowerCase()} RESTART WITH ${last}`);
      // ALTER RESTART is transactional; consume once only when source is_called=true.
      if(called)await c.query(`SELECT nextval('${f.schema}.seq_${prefix.toLowerCase()}')`);
      await c.query(`UPDATE ${f.schema}.history SET historical=$2,complete=true WHERE prefix=$1`,[prefix,historical.toString()]);
    }
    await c.query(`INSERT INTO ${f.schema}.bootstrap VALUES(1,true)`);await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export type NumberingCheckpoint=ReadonlyMap<string,PrefixSnapshot>;
/** Caller must capture this from a quiesced trusted source OUTSIDE the old backup.
 * This helper does not implement production attestation/lineage storage. */
export async function captureFixtureCheckpoint(f:NumberingPgFixture):Promise<NumberingCheckpoint>{
  owned(f);const result=new Map<string,PrefixSnapshot>();
  for(const prefix of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')result.set(prefix,await f.preview(prefix));return result;
}
/** No issuance until this separate fixture admission succeeds. */
export async function admitRestoredFixture(f:NumberingPgFixture,checkpoint:NumberingCheckpoint|null){
  owned(f);if(!checkpoint||checkpoint.size!==26)throw new Error('Trusted external checkpoint required');
  for(const prefix of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'){
    const before=checkpoint.get(prefix);if(!before)throw new Error('Incomplete checkpoint');
    const restored=await f.preview(prefix); // missing namespace/table/sequence fails closed
    const floor=(s:PrefixSnapshot)=>s.pendingNext??s.allocatedThrough+1n;
    if(!restored.historyComplete||restored.historicalThrough<before.historicalThrough||floor(restored)<floor(before)
      ||restored.revision.split(':').slice(0,2).join(':')!==before.revision.split(':').slice(0,2).join(':'))throw new Error('Restored state behind trusted checkpoint');
  }
}
