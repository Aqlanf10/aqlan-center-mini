import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/db",()=>({ensureSchema:vi.fn(),findUserByUsername:vi.fn(),getPool:vi.fn(),insertAuditRow:vi.fn()}));
vi.mock("../lib/session",()=>({requireSession:vi.fn()}));
vi.mock("../lib/patient-access",()=>({canAccessPatient:vi.fn()}));
import { decodeJourneyRow, insertJourneyRevision, journeyContentHash, type JourneyRow } from "../lib/ortho-case-journey-history";
import { discoverJourneyOwner, type JourneyAuthority, type JourneyOwner } from "../lib/ortho-case-journey-authority";
import type { DbClient } from "../lib/db";
const scope={patientId:10,orthoCaseId:20,clinicalCaseId:30};
const content={note:"Synthetic exact documented observation"};
const row=(status:string,context:string):JourneyRow=>({id:40,patient_id:10,recorded_patient_id:10,ortho_case_id:20,clinical_case_id:30,schema_version:1,version:1,predecessor_id:null,actor_user_id:2,created_by:"Synthetic",created_at:new Date("2026-10-11T02:00:00Z"),reason:"Synthetic context",recording_context:context,case_status_at_capture:status,command_id:"synthetic_documentary_command",request_fingerprint:"a".repeat(64),content_sha256:journeyContentHash(content),content});
const decode=(value:unknown)=>({ok:true as const,value});
describe("explicit assessment documentary context",()=>{
  it.each([["assessment","current"],["assessment_cancelled","retrospective"]])("preserves %s as its own immutable capture status",(status,context)=>{
    const read=decodeJourneyRow(row(status,context),scope,decode);expect(read.caseStatusAtCapture).toBe(status);expect(read.recordingContext).toBe(context);expect(read.content).toEqual(content);
    expect(()=>decodeJourneyRow(row(status,context==="current"?"retrospective":"current"),scope,decode)).toThrow();
  });
  it.each(["active","retention","completed","discontinued"])("retains the existing %s historical decoder",status=>{
    expect(decodeJourneyRow(row(status,["completed","discontinued"].includes(status)?"retrospective":"current"),scope,decode).caseStatusAtCapture).toBe(status);
  });
  it("rejects future/unknown states and does not turn one into an active case",()=>{expect(()=>decodeJourneyRow(row("unknown_future_state","current"),scope,decode)).toThrow();});
  it.each([["assessment","current"],["assessment_cancelled","retrospective"]])("discovers the exact %s owner without changing its bridge",async(status,recordingContext)=>{
    const sql:string[]=[];const client={query:async<T>(query:string)=>{sql.push(query);return {rows:(query.includes("FROM ortho_cases")?[{id:20,patient_id:10,status,plan_id:null}]:[{id:30,patient_id:10,ortho_case_id:20}]) as T[]};},release:vi.fn()} as DbClient;
    const owner=await discoverJourneyOwner(client,{patientId:10,orthoCaseId:20,session:{userId:2,username:"synthetic",role:"doctor",expiresAt:Date.now()+60000}});
    expect(owner).toEqual({...scope,status,recordingContext,planId:null});expect(sql.every(query=>query.startsWith("SELECT"))).toBe(true);
  });
  it.each(["assessment","assessment_cancelled"])("refuses a retention append in %s before any SQL",async status=>{
    const query=vi.fn(),client={query,release:vi.fn()} as unknown as DbClient;
    const owner={...scope,status,recordingContext:status==="assessment"?"current":"retrospective",planId:null} as JourneyOwner;
    await expect(insertJourneyRevision(client,{table:"ortho_retention_entries",owner,authority:{} as JourneyAuthority,head:null,expectedHeadId:null,commandId:"synthetic_retention_command",fingerprint:"a".repeat(64),reason:"Synthetic",content,
      retention:{arch:"upper",kind:"device_delivery",supersedesEntryId:null,deviceEntryId:null,replacesDeviceId:null,expectedDeviceRevisionId:null},decode})).rejects.toMatchObject({code:"retention_case_not_treatment"});
    expect(query).not.toHaveBeenCalled();
  });
});
