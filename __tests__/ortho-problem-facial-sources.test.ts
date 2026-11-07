import { expect, it, vi } from "vitest";
import { discoverFacialProblemSources, readFacialProblemSources } from "../lib/ortho-problem-facial-sources";
import type { DbClient } from "../lib/db";
import type { JourneyOwner } from "../lib/ortho-case-journey-authority";
const mock=vi.hoisted(()=>({revision:vi.fn(),image:vi.fn()}));
vi.mock("../lib/ortho-facial-store",()=>({readStoredFacialRevision:mock.revision}));
vi.mock("../lib/ortho-facial-image",()=>({facialImageBasis:mock.image}));
const scope={patientId:1,orthoCaseId:2,clinicalCaseId:3,status:"active",recordingContext:"current",planId:null} as JourneyOwner;
const client=(rows:unknown[])=>({query:vi.fn().mockResolvedValue({rows})}) as unknown as DbClient;
it("rejects more than twenty source heads without decoding images",async()=>{
 mock.image.mockClear();await expect(discoverFacialProblemSources(client(Array.from({length:21},(_,i)=>({id:i+1,document_id:i+1,bytes:500}))),scope)).rejects.toMatchObject({code:"problem_source_budget"});expect(mock.image).not.toHaveBeenCalled();
});
it.each([262145,NaN,"unknown"])("rejects invalid or over-budget revision bytes %s",async(bytes)=>{
 await expect(discoverFacialProblemSources(client([{id:1,document_id:1,bytes}]),scope)).rejects.toMatchObject({code:"problem_source_budget"});
});
it("rejects reviewed invalid geometry even with a ready measurement",async()=>{
 mock.revision.mockReturnValue({command:{content:{review:{state:"reviewed",note:"Synthetic note"}}},results:{measures:[{state:"ready"},{state:"invalid_geometry"}]}});
 await expect(readFacialProblemSources(client([{}]),scope,[{id:1,document_id:1,bytes:500}])).rejects.toMatchObject({code:"facial_history_invalid"});
});
it("propagates invalid persisted revision proofs instead of offering prose",async()=>{
 mock.revision.mockImplementation(()=>{throw Error("invalid_facial_record");});
 await expect(readFacialProblemSources(client([{}]),scope,[{id:1,document_id:1,bytes:500}])).rejects.toThrow("invalid_facial_record");
});
