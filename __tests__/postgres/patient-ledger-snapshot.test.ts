import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {Client} from "pg";
import {assertRealPostgresUrl,dropPublicSchema,stubPostgresEnv} from "./_setup";
import {patientBalancesByCurrency,toCurrencyPaymentLikes,type Currency} from "../../lib/money";
assertRealPostgresUrl();stubPostgresEnv();
const db=await import("../../lib/db");
let serial=0;
beforeAll(async()=>{await dropPublicSchema(process.env.DATABASE_URL!);await db.ensureSchema();await db.openShift({openedBy:"synthetic-ledger-snapshot",opening:{YER:0,SAR:0,USD:0}});},180000);
afterAll(async()=>{vi.restoreAllMocks();await db.resetPoolForTesting();});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function deadline(promise:Promise<void>){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([promise,new Promise<void>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Real opening SELECT did not complete")),5000);})]);}finally{clearTimeout(timer);}}
function due(patientId:number,ledger:Awaited<ReturnType<typeof db.patientLedger>>,currency:Currency){return patientBalancesByCurrency(ledger.invoices,toCurrencyPaymentLikes(patientId,ledger.payments,new Map(ledger.invoices.map(invoice=>[invoice.id,{patientId,currency:invoice.baseCurrency}])),new Map()),db.openingMinorsOf(ledger.openings))[currency].dueMinor;}
describe("patient ledger returns one real PostgreSQL snapshot",()=>{
 it.each(["YER","SAR","USD"] as const)("never combines old opening principal with a new %s receipt into a false credit",async currency=>{
  const patientId=(await db.getPool().query("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYNTHETIC ledger snapshot') RETURNING id",[`SNAPSHOT-${Date.now()}-${++serial}`])).rows[0].id as number;
  const openingRead=deferred(),releasePayments=deferred(),original=Client.prototype.query;
  // Delay only execution timing. Every returned row comes from real PostgreSQL;
  // both writes below run through the canonical writers on other connections.
  const spy=vi.spyOn(Client.prototype,"query").mockImplementation(function(this:Client,...args:unknown[]){
   const text=typeof args[0]==="string"?args[0].replace(/\s+/g," "):"",values=Array.isArray(args[1])?args[1]:[];
   const opening=values[0]===patientId&&text.includes("WHERE o.patient_id = $1 ORDER BY o.currency");
   const payments=values[0]===patientId&&text.includes("WHERE y.patient_id = $1 ORDER BY y.created_at");
   const invoke=(call:unknown[])=>Reflect.apply(original,this,call);
   if(!opening&&!payments)return invoke(args);
   const callback=typeof args.at(-1)==="function"?args.at(-1) as (error:unknown,result?:unknown)=>void:null;
   if(callback){
    const execute=()=>invoke([...args.slice(0,-1),(error:unknown,result:unknown)=>{if(opening&&!error)openingRead.resolve();callback(error,result);}]);
    if(payments){void releasePayments.promise.then(execute).catch(callback);return undefined;}
    return execute();
   }
   const execute=async()=>{const result=await invoke(args);if(opening)openingRead.resolve();return result;};
   return payments?releasePayments.promise.then(execute):execute();
  } as typeof original);
  const sampled=db.patientLedger(patientId);
  try{
   await deadline(openingRead.promise);
   await db.setPatientOpeningBalance({patientId,currency,amountMinor:1000,asOfDate:"2026-10-01",note:"Synthetic principal",createdBy:"synthetic-ledger-snapshot",reason:"Synthetic concurrent opening"});
   const paid=await db.recordPayment({patientId,invoiceId:null,openingCurrency:currency,kind:"payment",amountMinor:400,currency,baseCurrency:"YER",exchangeRate:currency==="YER"?1:currency==="SAR"?140:530,method:"cash",note:null,createdBy:"synthetic-ledger-snapshot",idempotencyKey:`snapshot-payment-${patientId}`});
   expect(paid.reason).toBeNull();releasePayments.resolve();const old=await sampled,fresh=await db.patientLedger(patientId);
   console.info("SYNTHETIC_LEDGER_SNAPSHOT_WITNESS",JSON.stringify({currency,sampledOpening:old.openings.map(row=>row.amountMinor),sampledReceipts:old.payments.map(row=>row.amountMinor),sampledDue:due(patientId,old,currency),freshDue:due(patientId,fresh,currency),writerPrincipal:1000,writerCollection:400}));
   expect(due(patientId,fresh,currency)).toBe(600);
   // The read began before either write: a coherent pre-write snapshot is zero.
   // The old independent reads instead yielded -400, which never existed.
   expect(due(patientId,old,currency)).toBe(0);
  }finally{releasePayments.resolve();await sampled.catch(()=>undefined);spy.mockRestore();}
 });
});
