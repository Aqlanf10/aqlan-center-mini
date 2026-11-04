import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("server-only",()=>({}));
import { canonicalCoverageStatusCommand } from "../lib/canonical-ortho-coverage-status";
const command=()=>({schemaVersion:1,commandId:randomUUID(),expectedRevisionId:null,source:{patientId:1,orthoCaseId:2,clinicalCaseId:3,planId:4,planItemId:5,invoiceId:6},expectedSourceFingerprint:"a".repeat(64),scope:"routine_adjustments",decision:"included",reason:"SYN explicit agreement"});
it("uses the native exact command and binds both path identities",()=>{const c=command();expect(canonicalCoverageStatusCommand(1,2,c)).toEqual(c);expect(()=>canonicalCoverageStatusCommand(9,2,c)).toThrow();expect(()=>canonicalCoverageStatusCommand(1,9,c)).toThrow();});
it.each([null,[],{},true,"saved"])("rejects a non-command %j",value=>expect(()=>canonicalCoverageStatusCommand(1,2,value)).toThrow());
it("no forced lookup, partial key or caller-supplied actor can stand in for the exact command",()=>{for(const c of[{commandId:randomUUID()},{...command(),actor:"owner"},{...command(),force:true},{...command(),source:{...command().source,invoiceId:"6"}},{...command(),reason:["included"]}])expect(()=>canonicalCoverageStatusCommand(1,2,c)).toThrow();});
