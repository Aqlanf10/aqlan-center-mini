/** Owned fixture provisioning only. Execution delegates to the unwired lib adapter. */
import type { Pool } from 'pg';
import type { ResolvedStaffAccess } from '../../../lib/staff-capabilities';
import { PatientNumberingPostgresBackend } from '../../../lib/patient-numbering-postgres';
export class NumberingPgFixture extends PatientNumberingPostgresBackend {
  constructor(pool:Pool,schema:string,owner:()=>Promise<ResolvedStaffAccess|null>){
    if(!/^numbering_fixture_[a-f0-9]{32}$/.test(schema))throw new Error('Not an owned fixture schema');
    super({pool,schema,owner});
  }
  async initialize() {
    const c=await this.pool.connect();try {
      await c.query('BEGIN');await c.query(`CREATE SCHEMA ${this.schema}`);
      await c.query(`CREATE TABLE ${this.schema}.config(id integer PRIMARY KEY CHECK(id=1), prefix text NOT NULL, revision bigint NOT NULL); INSERT INTO ${this.schema}.config VALUES(1,'P',1);
        CREATE TABLE ${this.schema}.history(prefix text PRIMARY KEY, historical bigint NOT NULL DEFAULT 0, complete boolean NOT NULL DEFAULT true);
        CREATE TABLE ${this.schema}.receipts(actor bigint NOT NULL, request text NOT NULL, intent text NOT NULL, result jsonb NOT NULL, PRIMARY KEY(actor,request));
        CREATE TABLE ${this.schema}.audit(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor bigint NOT NULL, reason text NOT NULL CHECK(reason <> 'SYNTHETIC_AUDIT_FAIL'), before_state jsonb NOT NULL, after_state jsonb NOT NULL);
        CREATE TABLE ${this.schema}.issued(number text PRIMARY KEY);`);
      for(const prefix of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        await c.query(`CREATE SEQUENCE ${this.seq(prefix)} MAXVALUE 999999999999999999`);
        await c.query(`INSERT INTO ${this.schema}.history(prefix) VALUES($1)`,[prefix]);
      }
      // Simulates inherited pending P counter; not a new universal minimum.
      await c.query(`ALTER SEQUENCE ${this.seq('P')} RESTART WITH 7000`);
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  issue(rollback=false){return this.withAllocationTransaction(async(c,allocate)=>{
    const number=await allocate();
    if(rollback)throw new Error('SYNTHETIC_ISSUE_ROLLBACK');
    await c.query(`INSERT INTO ${this.schema}.issued(number) VALUES($1)`,[number]);return number;
  });}
  async dispose(){await this.pool.query(`DROP SCHEMA ${this.schema} CASCADE`);}
}
