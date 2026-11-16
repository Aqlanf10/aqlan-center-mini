import {expect,it} from 'vitest';
import {Pool} from 'pg';
import {withFinancialReadSnapshot} from '../../lib/financial-read-snapshot';
import {validatePostgresTestTarget} from './_safe-target';
import type {DbPool} from '../../lib/db';
const target=validatePostgresTestTarget(process.env);
it('serializes concurrent reads on one real PostgreSQL snapshot',async()=>{
 const pool=new Pool({connectionString:target.testUrl.toString(),max:1});
 let active=0,max=0;
 const facade={connect:async()=>{
  const client=await pool.connect();
  return {query:async(sql:string,values?:unknown[])=>{
   active++;max=Math.max(max,active);
   try{return await client.query(sql,values);}finally{active--;}
  },release:(destroy?:boolean)=>client.release(destroy)};
 },query:pool.query.bind(pool)};
 try{
  const results=await withFinancialReadSnapshot(facade as DbPool,runner=>Promise.all([1,2,3].map(n=>runner.query('SELECT $1::int AS n, pg_sleep(0.01), pg_backend_pid() AS pid, current_setting(\'transaction_read_only\') AS ro, current_setting(\'transaction_isolation\') AS isolation',[n]))));
  expect(max).toBe(1);
  expect(results.map(r=>r.rows[0].n)).toEqual([1,2,3]);
  expect(new Set(results.map(r=>r.rows[0].pid)).size).toBe(1);
  for(const result of results)expect(result.rows[0]).toMatchObject({ro:'on',isolation:'repeatable read'});
 }finally{await pool.end();}
});
it('commission and journal reports serialize an externally owned transaction',async()=>{
 const {stubPostgresEnv}=await import('./_setup');stubPostgresEnv();
 const db=await import('../../lib/db');await db.ensureSchema();
 const client=await db.getPool().connect();let active=0,max=0;
 const runner={query:async(sql:string,values?:unknown[])=>{
  active++;max=Math.max(max,active);
  try{return await client.query(sql,values);}finally{active--;}
 },release:()=>{throw Error('reader must not release its caller transaction');}};
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.commissionReport('2020-01-01','2999-12-31',undefined,runner);
  await db.journalEntries('2020-01-01','2999-12-31',runner);
  expect(max).toBe(1);
 }finally{await client.query('ROLLBACK');client.release();await db.resetPoolForTesting();}
});
