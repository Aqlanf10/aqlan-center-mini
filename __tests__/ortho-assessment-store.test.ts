import { beforeEach,describe,expect,it,vi } from "vitest";
import { assessmentCommandV2 } from "./fixtures/ortho-assessment-schema2";
import type { DbClient } from "../lib/db";
import type { AssessmentStoredRow } from "../lib/ortho-assessment-versioned-sources";
const state=vi.hoisted(()=>({rows:[] as unknown[],sql:[] as string[],auditFailure:false,deny:false,imaging:true,status:"active",bridge:30,scopeDrift:false,sourceState:"available",actor:1,budgetOverride:null as null|{count:string;bytes:string}}));
vi.mock("../lib/session",()=>({requireSession:vi.fn(async()=>state.deny?null:({userId:1,username:"synthetic",role:"doctor",expiresAt:Date.now()+60000}))}));
vi.mock("../lib/patient-access",()=>({canAccessPatient:vi.fn(async(_s:unknown,_id:number,permission?:string)=>permission?state.imaging:true)}));
vi.mock("../lib/db",()=>({ensureSchema:vi.fn(async()=>undefined),findUserByUsername:vi.fn(async()=>({id:1,username:"synthetic",role:"doctor",isActive:true,displayName:"Synthetic"})),getPool:()=>({connect:async()=>client}),insertAuditRow:vi.fn(async()=>{state.sql.push("AUDIT");if(state.auditFailure)throw new Error("synthetic audit refusal");})}));
// This suite tests the real store/authority/revision decoder. External source
// ownership/lock semantics have their own real HTTP tests; they are not inferred
// from this deterministic source-state seam.
vi.mock("../lib/ortho-assessment-versioned-sources",async(importOriginal)=>{
  const original=await importOriginal<typeof import("../lib/ortho-assessment-versioned-sources")>();
  return {...original,collectAssessmentSourceClosure:vi.fn(async()=>({external:[],revisions:new Map()})),
    resolveAssessmentSourceGraph:vi.fn(async()=>{state.sql.push("SOURCE LOCKS");return {external:[],revisions:new Map(),historicallyReadable:new Set<string>(),states:state.sourceState==="available"?[]:[{source:{kind:"document",id:1,version:`sha256:${"a".repeat(64)}`},state:state.sourceState}]};}),
    listAssessmentSourceChoices:vi.fn(async()=>({items:[],truncated:false,imaging:state.imaging?"allowed":"restricted"}))};
});
let working:AssessmentStoredRow[]=[];
const client:DbClient={release:vi.fn(),query:async<T>(sql:string,values:unknown[]=[])=>{
  state.sql.push(sql);
  let rows:unknown[]=[];
  if(sql.startsWith("BEGIN"))working=structuredClone(state.rows) as AssessmentStoredRow[];
  else if(sql==="COMMIT")state.rows=structuredClone(working);
  else if(sql==="ROLLBACK")working=structuredClone(state.rows) as AssessmentStoredRow[];
  else if(sql.includes("FROM patients"))rows=[{id:10}];
  else if(sql.includes("FROM ortho_cases"))rows=[{id:20,patient_id:10,status:state.status}];
  else if(sql.includes("FROM clinical_cases"))rows=[{id:state.scopeDrift&&sql.includes("FOR UPDATE")?31:state.bridge,patient_id:10,ortho_case_id:20}];
  else if(sql.startsWith("SELECT COUNT(*)::text"))rows=[state.budgetOverride??{count:String(working.length),bytes:String(working.reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r.content)),0))}];
  else if(sql.startsWith("SELECT")&&sql.includes("FROM ortho_assessment_revisions"))rows=[...working].sort((a,b)=>b.version-a.version);
  else if(sql.startsWith("INSERT INTO ortho_assessment_revisions")){
    const r:AssessmentStoredRow={id:100+working.length,patient_id:values[0] as number,recorded_patient_id:values[0] as number,ortho_case_id:values[1] as number,clinical_case_id:values[2] as number,schema_version:2,version:values[3] as number,supersedes_revision_id:values[4] as number|null,actor_user_id:values[5] as number,created_by:values[6] as string,reason:values[7] as string,recording_context:values[8] as string,command_id:values[9] as string,request_fingerprint:values[10] as string,content_sha256:values[11] as string,content:JSON.parse(values[12] as string),created_at:"2026-10-11T01:00:00.000Z"};working.push(r);rows=[r];
  }else if(!["BEGIN","BEGIN ISOLATION LEVEL REPEATABLE READ","COMMIT","ROLLBACK"].includes(sql))throw new Error(`Unmodelled query ${sql}`);
  return {rows:rows as T[]};
}};
import { appendOrthoAssessment,getOrthoAssessment } from "../lib/ortho-assessment-store";
const owner=()=>({patientId:10,orthoCaseId:20,session:{userId:1,username:"synthetic",role:"doctor" as const,expiresAt:Date.now()+60000}});
beforeEach(()=>{state.rows=[];state.sql=[];state.auditFailure=false;state.deny=false;state.imaging=true;state.status="active";state.bridge=30;state.scopeDrift=false;state.sourceState="available";state.budgetOverride=null;working=[];vi.clearAllMocks();});
describe("assessment append and read contract",()=>{
  it("saves an incremental interview without measured values or selected analyses",async()=>{
    const command=assessmentCommandV2();command.content.analyses=[];command.content.measurementSets=[];
    command.content.observations.dentitionObservationId=null;command.content.observations.observations=[];
    const result=await appendOrthoAssessment({...owner(),command});expect(result.ok).toBe(true);
    if(!result.ok)throw new Error(result.code);expect(result.revision.content.results).toEqual([]);expect(state.rows).toHaveLength(1);
    expect(state.sql.findIndex(s=>s.includes("FROM patients"))).toBeLessThan(state.sql.indexOf("SOURCE LOCKS"));
    expect(state.sql.indexOf("SOURCE LOCKS")).toBeLessThan(state.sql.findIndex(s=>s.includes("FROM ortho_cases")&&s.includes("FOR UPDATE")));
    expect(state.sql.indexOf("AUDIT")).toBeLessThan(state.sql.indexOf("COMMIT"));
  });
  it("reopens server-computed immutable results and replays the original command after a later head",async()=>{
    const first=assessmentCommandV2(),a=await appendOrthoAssessment({...owner(),command:first});expect(a.ok).toBe(true);if(!a.ok)throw new Error(a.code);
    const second={...assessmentCommandV2(),commandId:"synthetic_second_command",expectedRevisionId:a.revision.id};
    const b=await appendOrthoAssessment({...owner(),command:second});expect(b.ok).toBe(true);
    const retry=await appendOrthoAssessment({...owner(),command:first});expect(retry.ok).toBe(true);if(!retry.ok)throw new Error(retry.code);
    expect(retry.replayed).toBe(true);expect(retry.revision).toEqual(a.revision);expect(state.rows).toHaveLength(2);
    const read=await getOrthoAssessment({...owner(),revisionId:a.revision.id,acceptedSchemas:[1,2]});expect(read.ok).toBe(true);if(!read.ok)throw new Error(read.code);
    expect(read.revision).toEqual(a.revision);expect(read.history).toHaveLength(2);
  });
  it("refuses conflicting command bytes and a stale new command without duplicate audit",async()=>{
    const command=assessmentCommandV2();expect((await appendOrthoAssessment({...owner(),command})).ok).toBe(true);
    const auditCount=state.sql.filter(s=>s==="AUDIT").length;
    expect(await appendOrthoAssessment({...owner(),command:{...command,reason:"Changed"}})).toMatchObject({ok:false,code:"command_conflict"});
    expect(await appendOrthoAssessment({...owner(),command:{...command,commandId:"different_stale_command"}})).toMatchObject({ok:false,code:"head_changed"});
    expect(state.rows).toHaveLength(1);expect(state.sql.filter(s=>s==="AUDIT")).toHaveLength(auditCount);
  });
  it("rolls back the revision when atomic audit fails",async()=>{state.auditFailure=true;
    await expect(appendOrthoAssessment({...owner(),command:assessmentCommandV2()})).rejects.toThrow("synthetic audit refusal");
    expect(state.rows).toEqual([]);expect(state.sql).toContain("ROLLBACK");expect(state.sql).not.toContain("COMMIT");
  });
  it.each(["changed","unavailable"])("refuses %s source proof without writing",async status=>{state.sourceState=status;
    expect(await appendOrthoAssessment({...owner(),command:assessmentCommandV2()})).toMatchObject({ok:false,code:"source_unavailable"});expect(state.rows).toEqual([]);
  });
  it("refuses owner drift after source locks",async()=>{state.scopeDrift=true;
    expect(await appendOrthoAssessment({...owner(),command:assessmentCommandV2()})).toMatchObject({ok:false,code:"case_changed"});expect(state.rows).toEqual([]);
  });
  it("revalidates current session before replay and preserves committed history on denial",async()=>{
    const command=assessmentCommandV2();expect((await appendOrthoAssessment({...owner(),command})).ok).toBe(true);const before=structuredClone(state.rows);state.deny=true;
    expect(await appendOrthoAssessment({...owner(),command})).toMatchObject({ok:false,status:401});expect(state.rows).toEqual(before);
  });
  it("refuses unknown history and schema1 commands without treating either as empty",async()=>{
    const command=assessmentCommandV2();expect((await appendOrthoAssessment({...owner(),command})).ok).toBe(true);
    (state.rows[0] as AssessmentStoredRow).schema_version=1;const before=structuredClone(state.rows);
    expect(await getOrthoAssessment({...owner(),acceptedSchemas:[1,2]})).toMatchObject({ok:false,status:409});
    expect(await appendOrthoAssessment({...owner(),command:{...command,schemaVersion:1}})).toMatchObject({ok:false,code:"unsupported_schema"});
    expect(await appendOrthoAssessment({...owner(),command:{...command,commandId:"new_against_legacy_head"}})).toMatchObject({ok:false,status:409});expect(state.rows).toEqual(before);
  });
  it("requires explicit schema negotiation",async()=>{expect(await getOrthoAssessment(owner())).toMatchObject({ok:false,code:"schema_negotiation_required"});expect(state.sql).toEqual([]);});
  it.each([{count:"5001",bytes:"1"},{count:"1",bytes:"8388609"}])("refuses a history resource excess before fetching content",async budget=>{
    state.budgetOverride=budget;expect(await getOrthoAssessment({...owner(),acceptedSchemas:[1,2]})).toMatchObject({ok:false,code:"history_resource_limit"});
    expect(state.sql.some(s=>s.startsWith("SELECT id,patient_id,recorded_patient_id"))).toBe(false);expect(state.rows).toEqual([]);
  });
  it.each(["completed","discontinued"])("records %s documentation retrospectively without lifecycle mutation",async status=>{state.status=status;
    const r=await appendOrthoAssessment({...owner(),command:assessmentCommandV2()});expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.code);
    expect(r.revision.recordingContext).toBe("retrospective");expect(state.sql.some(s=>/^UPDATE (ortho_cases|clinical_cases)/.test(s))).toBe(false);
  });
});
