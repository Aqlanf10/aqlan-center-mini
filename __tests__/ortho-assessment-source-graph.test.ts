import {describe,expect,it,vi} from "vitest";
vi.mock("../lib/db",()=>({findUserByUsername:vi.fn()}));
vi.mock("../lib/session",()=>({requireSession:vi.fn()}));
vi.mock("../lib/patient-access",()=>({canAccessPatient:vi.fn()}));
import type {DbClient} from "../lib/db";
import {assessmentSourceStates,captureAssessmentExternalSources,collectAssessmentSourceClosure,decodeAssessmentStoredRow,type AssessmentStoredRow} from "../lib/ortho-assessment-versioned-sources";
import type {AssessmentSourceV2} from "../lib/ortho-assessment-v2";
import {assessmentCommandV2} from "./fixtures/ortho-assessment-schema2";
import {assessmentJsonHash,createPersistedAssessmentV2} from "../lib/ortho-assessment-persisted-v2";
const scope={patientId:10,orthoCaseId:20,clinicalCaseId:30};
describe("assessment external source union",()=>{
  it("locks each direct resource identity once and preserves differing historical expected hashes",async()=>{
    const queries:string[]=[],sha="a".repeat(64),other="b".repeat(64);
    const client:DbClient={release:()=>undefined,query:async<T>(sql:string,values?:unknown[])=>{
      queries.push(sql);if(!sql.includes("FROM patient_documents"))throw new Error("Unexpected source query");
      expect(values).toEqual([10,[5]]);const rows:unknown[]=[{id:5,sha256:sha,title:"Synthetic source",removed_at:null,ortho_case_id:20}];return {rows:rows as T[]};
    }};
    const current=await captureAssessmentExternalSources(client,scope,[{kind:"document",id:5},{kind:"document",id:5}],true);
    expect(queries).toHaveLength(1);expect(queries[0]).toContain("ORDER BY id FOR SHARE");
    const old:AssessmentSourceV2={kind:"document",id:5,version:`sha256:${other}`},now:AssessmentSourceV2={...old,version:`sha256:${sha}`};
    expect(assessmentSourceStates({external:[old],revisions:new Map()},current)).toEqual([{source:old,state:"changed"}]);
    expect(assessmentSourceStates({external:[now],revisions:new Map()},current)).toEqual([{source:now,state:"available"}]);
  });
  it("refuses revoked imaging authority before resource SQL",async()=>{
    const query=vi.fn();await expect(captureAssessmentExternalSources({query,release:()=>undefined},scope,[{kind:"document",id:5}],false)).rejects.toMatchObject({status:403,code:"imaging_restricted"});expect(query).not.toHaveBeenCalled();
  });
  it("does not turn missing or foreign rows into available source proofs",async()=>{
    const client:DbClient={release:()=>undefined,query:async()=>({rows:[]})};const source:AssessmentSourceV2={kind:"document",id:5,version:`sha256:${"a".repeat(64)}`};
    const current=await captureAssessmentExternalSources(client,scope,[source],true);expect(assessmentSourceStates({external:[source],revisions:new Map()},current)).toEqual([{source,state:"unavailable"}]);
  });
  it("rejects malformed persisted command witnesses before replay",()=>{
    const content=createPersistedAssessmentV2(assessmentCommandV2().content);if(!content.ok)throw new Error(content.code);
    const row:AssessmentStoredRow={id:100,patient_id:10,recorded_patient_id:10,ortho_case_id:20,clinical_case_id:30,schema_version:2,version:1,supersedes_revision_id:null,created_at:"2026-10-11T01:00:00.000Z",created_by:"Synthetic",reason:"Synthetic assessment",recording_context:"current",content:content.value,content_sha256:assessmentJsonHash(content.value),actor_user_id:1,command_id:"synthetic_command_1234",request_fingerprint:"a".repeat(64)};
    expect(decodeAssessmentStoredRow(row,scope).id).toBe(100);
    expect(()=>decodeAssessmentStoredRow({...row,actor_user_id:0},scope)).toThrow();expect(()=>decodeAssessmentStoredRow({...row,command_id:"short"},scope)).toThrow();expect(()=>decodeAssessmentStoredRow({...row,request_fingerprint:"wrong"},scope)).toThrow();
  });
  it("rejects an oversized immutable graph before reading the offending payload",async()=>{
    const sqls:string[]=[];const client:DbClient={release:()=>undefined,query:async<T>(sql:string)=>{sqls.push(sql);const rows:unknown[]=[{bytes:"4194305"}];return {rows:rows as T[]};}};
    await expect(collectAssessmentSourceClosure(client,scope,[{kind:"assessment_revision",id:5,version:`sha256:${"a".repeat(64)}`}])).rejects.toMatchObject({code:"source_resource_limit"});
    expect(sqls).toHaveLength(1);expect(sqls[0]).toContain("octet_length(content::text)::text AS bytes");expect(sqls[0]).not.toContain("content_sha256");
  });
  it("admits an external source byte count before fetching any large clinical text",async()=>{
    const sqls:string[]=[];const client:DbClient={release:()=>undefined,query:async<T>(sql:string)=>{sqls.push(sql);const rows:unknown[]=[{id:5,bytes:"4194305"}];return {rows:rows as T[]};}};
    await expect(captureAssessmentExternalSources(client,scope,[{kind:"clinical_visit",id:5}],true)).rejects.toMatchObject({code:"source_resource_limit"});
    expect(sqls).toHaveLength(1);expect(sqls[0]).toContain("octet_length");expect(sqls[0]).not.toContain("AS facts");
  });
  it("distinguishes removed same-owner historical visibility from fresh availability",async()=>{
    const client:DbClient={release:()=>undefined,query:async<T>()=>{const rows:unknown[]=[{id:5,sha256:"a".repeat(64),title:"Synthetic",removed_at:new Date(),ortho_case_id:20}];return {rows:rows as T[]};}};
    const captured=await captureAssessmentExternalSources(client,scope,[{kind:"document",id:5}],true);
    expect(captured.has("document:5")).toBe(false);expect(captured.historicallyReadable.has("document:5")).toBe(true);
  });
});
