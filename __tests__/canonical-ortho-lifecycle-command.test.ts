import { expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import { parseCanonicalOrthoLifecycle as parse,CanonicalOrthoLifecycleRefusal } from "../lib/canonical-ortho-lifecycle-command";
const expectedVersion="a".repeat(64);
it("keeps existing clinical field groups without admitting financial links",()=>{
 expect(parse("1",{expectedVersion,phase:"finishing"}).mutation).toEqual({kind:"phase",phase:"finishing"});
 expect(parse("1",{expectedVersion,retainer:"none"}).mutation).toMatchObject({kind:"retainer",retainer:"none",deliveredOn:null,preserveExistingDeliveryDate:true});
 expect(parse("1",{expectedVersion,retainer:"essix",retainerOn:"2024-02-29"}).mutation).toMatchObject({deliveredOn:"2024-02-29",preserveExistingDeliveryDate:false});
 expect(parse("1",{expectedVersion,status:"discontinued",note:" SYN "}).mutation).toEqual({kind:"close",status:"discontinued",note:"SYN"});
 expect(()=>parse("1",{expectedVersion,planId:null})).toThrow(CanonicalOrthoLifecycleRefusal);
});
it.each(["0","01","-1","1.2","1e2","2147483648"])("rejects invalid case identity %s",id=>{expect(()=>parse(id,{expectedVersion,phase:"working"})).toThrow(CanonicalOrthoLifecycleRefusal);});
it.each([null,[],{}, {expectedVersion,phase:["working"]},{expectedVersion,phase:"working",retainer:"essix"},{expectedVersion,phase:"working",actor:"owner"},{expectedVersion:[expectedVersion],phase:"working"},{expectedVersion,retainer:"essix",retainerOn:"2026-02-30"},{expectedVersion,retainer:"essix",retainerOn:"0000-01-01"},{expectedVersion,retainer:"essix",retainerOn:20261012},{expectedVersion,status:"active",note:null},{expectedVersion,status:"completed",note:"x".repeat(301)},{expectedVersion,status:"completed",note:[]},{expectedVersion,phase:"working",force:true}].map(body=>({body})))("refuses malformed, combined or authority-bearing fields %#",({body})=>{expect(()=>parse("1",body)).toThrow(CanonicalOrthoLifecycleRefusal);});
