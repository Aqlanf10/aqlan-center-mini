import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { validateBackupTimestampFixtureTarget, assertBackupTimestampFixtureIdentity } from "./_backup-timestamp-fixture";
/** One owned synthetic database; never resets/drops a supplied or guessed DB. */
export async function openLegacyStaffFixture(environment:NodeJS.ProcessEnv){
 const target=validateBackupTimestampFixtureTarget(environment);
 const admin=new Client({connectionString:target.maintenanceUrl.toString(),ssl:false});
 const name=`aqlan_backup_precision_${randomUUID().replaceAll("-","")}`;
 type Identity={name:string;oid:string;owner:string};
 let identity:Identity|undefined,pool:Pool|undefined,created=false,closed=false;
 await admin.connect();
 const close=async()=>{
  if(closed)return;closed=true;const errors:unknown[]=[];
  try{
   await pool?.end();
   if(created){
    if(!identity)throw new Error("Owned synthetic identity unknown; cleanup refused");
    const {rows}=await admin.query<Identity>("SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1",[name]);
    if(rows.length!==1)throw new Error("Owned synthetic database missing; cleanup refused");
    assertBackupTimestampFixtureIdentity(identity,rows[0]);
    await admin.query(`DROP DATABASE "${name}"`);
   }
  }catch(e){errors.push(e);}finally{try{await admin.end();}catch(e){errors.push(e);}}
  if(errors.length)throw new AggregateError(errors,"Owned legacy fixture cleanup failed");
 };
 try{
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);created=true;
  const {rows}=await admin.query<Identity>("SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1",[name]);
  if(rows.length!==1)throw new Error("Owned synthetic identity unavailable");identity=rows[0];
  const url=new URL(target.testUrl);url.pathname=`/${name}`;
  pool=new Pool({connectionString:url.toString(),ssl:false,max:5,connectionTimeoutMillis:10_000,statement_timeout:15_000});
  const actual=(await pool.query<Identity>("SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=current_database()")).rows;
  if(actual.length!==1)throw new Error("Owned synthetic connection identity unavailable");assertBackupTimestampFixtureIdentity(identity,actual[0]);
  return {pool,url:url.toString(),close};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],"Legacy fixture initialization failed");}throw error;}
}
