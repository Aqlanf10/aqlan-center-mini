import {randomUUID} from "node:crypto";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {openBackupTimestampFixture} from "./_backup-timestamp-fixture";
import type {SessionPayload} from "../../lib/auth";
let fixture:Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db:typeof import("../../lib/db"),hr:typeof import("../../lib/hr"),contracts:typeof import("../../lib/hr-contracts-attendance");
let admin:SessionPayload;const uuid=randomUUID().replaceAll("-","");let serial=0;
beforeAll(async()=>{
  fixture=await openBackupTimestampFixture(process.env);process.env.DATABASE_URL=fixture.source.options.connectionString!;
  process.env.SKIP_SEED="false";process.env.DB_POOL_MAX="2";process.env.SESSION_SECRET??="synthetic-contract-lifecycle-session-secret-only";
  db=await import("../../lib/db");hr=await import("../../lib/hr");contracts=await import("../../lib/hr-contracts-attendance");
  await db.resetPoolForTesting();await db.ensureSchema();
  const username=`contract_${uuid}`,passwordHash="synthetic-contract-password-hash";
  const row=(await fixture.source.query<{id:number}>("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic contract admin',$2,'admin') RETURNING id",[username,passwordHash])).rows[0];
  const {sessionCredentialVersion}=await import("../../lib/auth");admin={userId:row.id,username,role:"admin",expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion(passwordHash)};
},30000);
afterAll(async()=>{await db?.resetPoolForTesting();await fixture?.close();});
async function staff(){return hr.createStaff({fullName:`Synthetic contract ${uuid} ${++serial}`,department:"secretariat",jobTitle:"Synthetic",hireDate:"2026-01-01",workStatus:"active",contractKind:"salary",endDate:null,phone:null,note:null,payTerms:{amountMinor:100000,currency:"YER",period:"monthly",effectiveOn:"2026-01-01"}},admin);}
function input(staffId:number){return {staffId,templateKind:"support_staff" as const,title:"Synthetic original terms",startDate:"2026-01-01",compensationKind:"salary" as const,baseSalaryMinor:100000,salaryCurrency:"YER",salaryPeriod:"monthly",termsPayload:{clauses:["Original immutable clause"]}};}
const addendum={title:"Synthetic amendment",startDate:"2026-01-01",addendumReason:"Explicit prospective amendment",baseSalaryMinor:120000};
async function row(id:number){return (await fixture.source.query("SELECT to_jsonb(c) AS value FROM hr_contracts c WHERE id=$1",[id])).rows[0].value;}
async function countAudit(id:number){return Number((await fixture.source.query("SELECT COUNT(*)::int AS count FROM audit_log WHERE entity='hr_contract' AND entity_id=$1",[String(id)])).rows[0].count);}
const consume=<T>(promise:Promise<T>)=>promise.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
function unwrap<T>(outcome:{ok:true;value:T}|{ok:false;error:unknown}):T{if(!outcome.ok)throw outcome.error;return outcome.value;}
async function twoBlockedWriters(blocker:number,pending:Promise<unknown>[]){
  let done=false;for(const operation of pending)void operation.then(()=>{done=true;},()=>{done=true;});
  const until=Date.now()+10000;
  do{
    if(done)throw new Error("Writer settled before observed staff contention");
    const rows=(await fixture.source.query<{pid:number;blockers:number[];query:string}>(`SELECT pid,pg_blocking_pids(pid) AS blockers,query FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM hr_staff WHERE id=$1 FOR UPDATE%'`)).rows;
    const first=rows.find(r=>r.blockers.includes(blocker));
    const second=first&&rows.find(r=>r.pid!==first.pid&&(r.blockers.includes(blocker)||r.blockers.includes(first.pid)));
    if(first&&second){expect(first.pid).not.toBe(second.pid);return [first.pid,second.pid];}
    await new Promise(resolve=>setTimeout(resolve,20));
  }while(Date.now()<until);
  throw new Error("Exact two-writer staff lock chain not observed");
}
describe("canonical contract writers",()=>{
  it("keeps approved terms immutable, supports explicit activation, and retains unsigned addenda",async()=>{
    const s=await staff(),draft=await contracts.createContract(input(s.id),admin);
    await expect(contracts.transitionContractStatus(draft.id,"active","No approval shortcut",admin)).rejects.toMatchObject({status:409});
    const approved=await contracts.approveContract(draft.id,admin);expect(approved.status).toBe("approved");expect(approved.signedByStaff).toBe(false);expect(approved.signedByCenter).toBe(false);expect(approved.signedAt).toBeNull();
    const sealed=await row(draft.id),auditBefore=await countAudit(draft.id);
    for(const target of ["draft","under_review"] as const)await expect(contracts.transitionContractStatus(draft.id,target,"Cannot erase approval",admin)).rejects.toMatchObject({status:409});
    await expect(contracts.updateContract(draft.id,{baseSalaryMinor:1,termsPayload:{clauses:["Overwrite"]}},admin)).rejects.toThrow(/ملحق/);
    expect(await row(draft.id)).toEqual(sealed);expect(await countAudit(draft.id)).toBe(auditBefore);
    expect((await contracts.approveContract(draft.id,admin)).id).toBe(draft.id);expect(await countAudit(draft.id)).toBe(auditBefore);
    const active=await contracts.transitionContractStatus(draft.id,"active","Explicit activation",admin);expect(active.status).toBe("active");
    const original=await row(draft.id),child=await contracts.createContractAddendum(draft.id,addendum,admin);
    expect(child.status).toBe("draft");expect(child.approvedAt).toBeNull();expect(child.signedByStaff).toBe(false);expect(child.signedByCenter).toBe(false);expect(child.parentContractId).toBe(draft.id);expect(child.versionNumber).toBe(2);expect(await row(draft.id)).toEqual(original);
  });
  it.each(["expired","terminated"] as const)("refuses approval/reactivation of %s",async status=>{
    const s=await staff(),c=await contracts.createContract(input(s.id),admin);await contracts.approveContract(c.id,admin);await contracts.transitionContractStatus(c.id,status,"Synthetic terminal decision",admin);const before=await row(c.id),audits=await countAudit(c.id);
    await expect(contracts.approveContract(c.id,admin)).rejects.toMatchObject({status:409});await expect(contracts.transitionContractStatus(c.id,"active","Invalid reopen",admin)).rejects.toMatchObject({status:409});expect(await row(c.id)).toEqual(before);expect(await countAudit(c.id)).toBe(audits);
  });
  it("protects legacy approval markers even if the stored status was reset historically",async()=>{
    const s=await staff(),c=await contracts.createContract(input(s.id),admin);await contracts.approveContract(c.id,admin);
    await fixture.source.query("UPDATE hr_contracts SET status='draft' WHERE id=$1",[c.id]);const before=await row(c.id);
    await expect(contracts.updateContract(c.id,{title:"Forbidden rewrite"},admin)).rejects.toThrow(/ملحق/);await expect(contracts.approveContract(c.id,admin)).rejects.toMatchObject({status:409});expect(await row(c.id)).toEqual(before);
  });
  it("allocates distinct root contract numbers during observed concurrent creation",async()=>{
    const s=await staff(),other=await staff();let outcomes:ReturnType<typeof consume<Awaited<ReturnType<typeof contracts.createContract>>>>[]=[];
    await fixture.source.query("BEGIN");try{
      await fixture.source.query("SELECT id FROM hr_staff WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE",[[s.id,other.id]]);const pid=(await fixture.source.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const a=contracts.createContract(input(s.id),admin),b=contracts.createContract(input(other.id),admin);outcomes=[consume(a),consume(b)];await twoBlockedWriters(pid,[a,b]);await fixture.source.query("COMMIT");
      const first=unwrap(await outcomes[0]),second=unwrap(await outcomes[1]);expect(first.id).not.toBe(second.id);expect(first.contractNumber).not.toBe(second.contractNumber);expect(first.contractNumber).toMatch(/^CTR-\d{6}-\d{4,}$/);expect(await countAudit(first.id)).toBe(1);expect(await countAudit(second.id)).toBe(1);
    }finally{await fixture.source.query("ROLLBACK").catch(()=>undefined);await Promise.all(outcomes);}
  },120000);
  it("allocates sequential sibling versions under an observed same-parent race without altering the parent",async()=>{
    const s=await staff(),parent=await contracts.createContract(input(s.id),admin);await contracts.approveContract(parent.id,admin);const original=await row(parent.id);
    let outcomes:ReturnType<typeof consume<Awaited<ReturnType<typeof contracts.createContractAddendum>>>>[]=[];
    await fixture.source.query("BEGIN");try{
      await fixture.source.query("SELECT id FROM hr_staff WHERE id=$1 FOR UPDATE",[s.id]);const pid=(await fixture.source.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const a=contracts.createContractAddendum(parent.id,addendum,admin),b=contracts.createContractAddendum(parent.id,{...addendum,title:"Second explicit amendment"},admin);outcomes=[consume(a),consume(b)];await twoBlockedWriters(pid,[a,b]);await fixture.source.query("COMMIT");
      const values=[unwrap(await outcomes[0]),unwrap(await outcomes[1])];expect(values.map(v=>v.versionNumber).sort()).toEqual([2,3]);expect(new Set(values.map(v=>v.contractNumber)).size).toBe(2);expect(await row(parent.id)).toEqual(original);
      const third=await contracts.createContractAddendum(parent.id,addendum,admin);expect(third.versionNumber).toBe(4);
    }finally{await fixture.source.query("ROLLBACK").catch(()=>undefined);await Promise.all(outcomes);}
  },120000);
  it("revalidates active admin identity and credential version before any contract mutation",async()=>{
    const s=await staff(),c=await contracts.createContract(input(s.id),admin),before=await row(c.id);
    await expect(contracts.approveContract(c.id,{...admin,credentialVersion:"stale"})).rejects.toMatchObject({status:401});
    await fixture.source.query("UPDATE users SET is_active=FALSE WHERE id=$1",[admin.userId]);try{await expect(contracts.approveContract(c.id,admin)).rejects.toMatchObject({status:401});expect(await row(c.id)).toEqual(before);}finally{await fixture.source.query("UPDATE users SET is_active=TRUE WHERE id=$1",[admin.userId]);}
  });
  it("rolls back administrative approval and salary synchronization when its atomic audit fails",async()=>{
    const s=await staff(),c=await contracts.createContract({...input(s.id),baseSalaryMinor:130000},admin),before=await row(c.id);
    const staffBefore=(await fixture.source.query("SELECT to_jsonb(s) AS value FROM hr_staff s WHERE id=$1",[s.id])).rows[0].value;
    const name=`contract_audit_fault_${uuid}`;
    await fixture.source.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $test$
      BEGIN IF NEW.action='hr.contract.approve' AND NEW.entity_id='${c.id}' THEN RAISE EXCEPTION 'Synthetic contract audit refusal' USING ERRCODE='P0001'; END IF; RETURN NEW; END; $test$`);
    await fixture.source.query(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    await expect(contracts.approveContract(c.id,admin)).rejects.toMatchObject({code:"P0001"});expect(await row(c.id)).toEqual(before);
    expect((await fixture.source.query("SELECT to_jsonb(s) AS value FROM hr_staff s WHERE id=$1",[s.id])).rows[0].value).toEqual(staffBefore);expect(await countAudit(c.id)).toBe(1);
  });
});

it("stores incomplete future drafts without inventing pay, but refuses approval until explicit terms exist",async()=>{
 for(const compensationKind of ["salary","commission","salary_commission"] as const){
  const s=await staff(),draft=await contracts.createContract({...input(s.id),startDate:"2099-01-01",compensationKind,baseSalaryMinor:null,salaryCurrency:null,salaryPeriod:null,commissionRatePercent:null,doctorPartyId:null},admin);
  const before=await row(draft.id),audits=await countAudit(draft.id);
  expect(draft.baseSalaryMinor).toBeNull();expect(draft.salaryPeriod).toBeNull();expect(draft.commissionRatePercent).toBeNull();
  await expect(contracts.approveContract(draft.id,admin)).rejects.toMatchObject({status:409});
  expect(await row(draft.id)).toEqual(before);expect(await countAudit(draft.id)).toBe(audits);
 }
 const s=await staff();await expect(contracts.createContract({...input(s.id),templateKind:"fixed_salary"},admin)).rejects.toMatchObject({status:400});
});

it("refuses activating an incomplete historical approval without changing its history",async()=>{
 const s=await staff(),draft=await contracts.createContract({...input(s.id),startDate:"2099-01-01",baseSalaryMinor:null,salaryCurrency:null,salaryPeriod:null},admin);
 await fixture.source.query("UPDATE hr_contracts SET status='approved',approved_by=$2,approved_at=NOW() WHERE id=$1",[draft.id,admin.username]);
 const before=await row(draft.id),audits=await countAudit(draft.id);
 expect((await contracts.approveContract(draft.id,admin)).status).toBe("approved");
 await expect(contracts.transitionContractStatus(draft.id,"active","Cannot activate unknown wages",admin)).rejects.toMatchObject({status:409});
 expect(await row(draft.id)).toEqual(before);expect(await countAudit(draft.id)).toBe(audits);
});
it("clears explicitly mistaken draft terms, preserves omitted values, and refuses a stale editor",async()=>{
 const s=await staff(),draft=await contracts.createContract(input(s.id),admin);
 const cleared=await contracts.updateContract(draft.id,{expectedUpdatedAt:draft.updatedAt,baseSalaryMinor:null,salaryCurrency:null,salaryPeriod:null},admin);
 expect(cleared.baseSalaryMinor).toBeNull();expect(cleared.salaryCurrency).toBeNull();expect(cleared.salaryPeriod).toBeNull();expect(cleared.title).toBe(draft.title);
 const before=await row(draft.id),audits=await countAudit(draft.id);
 await expect(contracts.updateContract(draft.id,{expectedUpdatedAt:"2000-01-01T00:00:00.000Z",title:"Stale edit"},admin)).rejects.toMatchObject({status:409});
 expect(await row(draft.id)).toEqual(before);expect(await countAudit(draft.id)).toBe(audits);
});
