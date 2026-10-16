import {spawn,type ChildProcess} from "node:child_process";
import {Pool} from "pg";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {openBackupTimestampFixture} from "../postgres/_backup-timestamp-fixture";
import type {Harness} from "./_server";

/** Own database/server: the broad HTTP suite shares a harness and financial fixtures.
 * Never suspend other staff or rewrite their terms just to approve this journey. */
export async function openHrJourneyServer(shared:Harness){
 const owned=await openBackupTimestampFixture({...process.env});
 const dbUrl=owned.source.options.connectionString!;
 const db=new Pool({connectionString:dbUrl,ssl:false});
 const sharedDb=new Pool({connectionString:shared.seeded.dbUrl,ssl:false});
 const port=Number(process.env.SECURITY_HTTP_PORT ?? 3217)+1;
 const storage=mkdtempSync(join(tmpdir(),"hr-http-owned-"));
 let server:ChildProcess|undefined;
 const stop=async()=>{
  if(server && server.exitCode===null){
   const exited=new Promise<void>(resolve=>server!.once("exit",()=>resolve()));server.kill("SIGTERM");
   const timer=setTimeout(()=>server?.kill("SIGKILL"),5000);try{await exited;}finally{clearTimeout(timer);}
  }
  await db.end();await sharedDb.end();await owned.close();rmSync(storage,{recursive:true,force:true});
 };
 try{
  // Bootstrap through the real runtime schema in a child: no shared app globals or supplied DB reset.
  const initialized=spawn(process.execPath,["--import","tsx","--input-type=module","-e","const db=await import('./lib/db.ts');await db.ensureSchema();await db.resetPoolForTesting();"],{
   cwd:process.cwd(),env:{...process.env,DATABASE_URL:dbUrl,SKIP_SEED:"false",USE_LOCAL_DB:"false",NODE_ENV:"test"},stdio:["ignore","ignore","pipe"]});
  initialized.stderr?.resume();
  await new Promise<void>((resolve,reject)=>{initialized.once("error",reject);initialized.once("exit",code=>code===0?resolve():reject(new Error("Owned HR HTTP schema bootstrap failed")));});
  for(const table of ["parties","users"]){
   const {rows}=await sharedDb.query(`SELECT * FROM ${table}`);
   for(const row of rows){
    const fields=Object.keys(row);if(fields.some(field=>!/^[_a-z][_a-z0-9]*$/.test(field))) throw new Error("Unexpected fixture field");
    await db.query(`INSERT INTO ${table}(${fields.map(f=>`"${f}"`).join(",")}) VALUES(${fields.map((_,i)=>`$${i+1}`).join(",")})`,fields.map(f=>row[f]));
   }
   await db.query(`SELECT setval(pg_get_serial_sequence($1,'id'),COALESCE((SELECT MAX(id) FROM ${table}),1),EXISTS(SELECT 1 FROM ${table}))`,[table]);
  }
  // Seeded sessions retain exact password/permission versions; only the known test secret is used.
  server=spawn(process.execPath,[".next/standalone/server.js"],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:dbUrl,TEST_DATABASE_URL:dbUrl,APP_ORIGIN:`http://127.0.0.1:${port}`,CI:"false",DOCUMENTS_DIR:join(storage,"documents"),DURABLE_STORAGE_ROOT:storage,USE_LOCAL_DB:"false",NODE_ENV:"production",PORT:String(port),HOSTNAME:"127.0.0.1",SESSION_SECRET:"security-http-test-secret-0123456789abcdef"},stdio:["ignore","pipe","pipe"]});
  server.stdout?.resume();server.stderr?.resume();
  const baseUrl=`http://127.0.0.1:${port}`;
  const deadline=Date.now()+120000;
  while(Date.now()<deadline){
   if(server.exitCode!==null) throw new Error("Owned HR HTTP server exited before readiness");
   try{const response=await fetch(`${baseUrl}/login`);if(response.ok) return {baseUrl,db,close:stop};}catch{}
   await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error("Owned HR HTTP server readiness timed out");
 }catch(error){await stop();throw error;}
}
