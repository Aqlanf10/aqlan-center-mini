import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseCanonicalProblemStatus } from "../lib/canonical-problem-status-command";
import { clinicalProblemStatusVersion } from "../lib/canonical-problem-status-version";
const input = { status: "resolved", expectedVersion: "a".repeat(64) };
describe("canonical problem status exact admission", () => {
  it.each(["active","resolved","inactive"])("accepts existing state %s", status => expect(parseCanonicalProblemStatus("7",{...input,status})).toEqual({id:7,...input,status}));
  it.each(["0","01","-1","1.0","2147483648","1e2"])("refuses invalid id %s", id => expect(()=>parseCanonicalProblemStatus(id,input)).toThrow());
  it.each([null,[],{}, {...input,actor:"owner"},{...input,caseId:3},{...input,status:"closed"},{...input,expectedVersion:"X".repeat(64)},{...input,expectedVersion:"a".repeat(63)}])("refuses malformed or extra input", body=>expect(()=>parseCanonicalProblemStatus("7",body)).toThrow());
  it("binds the opaque version to row identity and actual stored clinical state",()=>{
    const row={id:1,patientId:2,status:"active",resolvedAt:null,resolvedBy:null,versionXmin:"400",versionTid:"(3,5)"};const saved=clinicalProblemStatusVersion(row);
    expect(saved).toMatch(/^[a-f0-9]{64}$/);expect(clinicalProblemStatusVersion({...row})).toBe(saved);
    for(const change of [{id:2},{patientId:3},{status:"inactive"},{resolvedAt:"2026-11-01 12:00:00+03"},{resolvedBy:"SYN"},{versionXmin:"401"},{versionTid:"(3,6)"}])expect(clinicalProblemStatusVersion({...row,...change})).not.toBe(saved);
  });
});
