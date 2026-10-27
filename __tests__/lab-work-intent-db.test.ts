import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";
import { createHash } from "node:crypto";
const mocks=vi.hoisted(()=>({session:vi.fn(),access:vi.fn()}));
vi.mock("../lib/session",()=>({revalidateSessionInTransaction:mocks.session}));
vi.mock("../lib/patient-access",()=>({canAccessPatient:mocks.access}));
import { labWorkIntentSupported, readLabWorkCommandInTransaction, assertLabWorkCommandApplied, recordRejectedLabWorkCommandInTransaction } from "../lib/lab-work-intent-db";
const session={userId:7,username:"synthetic",role:"admin",expiresAt:Date.now()+60000} as SessionPayload;
const context={patientId:2,sourceKind:"visit" as const,sourceId:3,session,requestKey:"synthetic-key-1",requestHash:"full-source-body"};
beforeEach(()=>{vi.resetAllMocks();mocks.session.mockResolvedValue(session);mocks.access.mockResolvedValue(true);});
describe("lab work intent transaction adapter",()=>{
 it("fails closed when capability marker is absent without querying absent table",async()=>{const query=vi.fn().mockResolvedValue({rows:[{name:null}]});expect(await labWorkIntentSupported({query} as never)).toBe(false);expect(query).toHaveBeenCalledTimes(1);});
 it("requires exact schema version marker",async()=>{const query=vi.fn().mockResolvedValueOnce({rows:[{name:"lab_work_intent_schema"}]}).mockResolvedValueOnce({rows:[{version:2}]});expect(await labWorkIntentSupported({query} as never)).toBe(false);});
 it("replays same actor/scope/hash before any stale revision lookup",async()=>{
  const result={labWork:[{intentId:"00000000-0000-4000-8000-000000000001",orderId:13,revision:2,memberIds:[]}]};
  const query=vi.fn().mockResolvedValueOnce({rows:[{locked:true}]}).mockResolvedValue({rows:[{patient_id:2,source_kind:"visit",source_id:3,request_hash:createHash("sha256").update(context.requestHash).digest("hex"),result}]});
  expect(await readLabWorkCommandInTransaction({query} as never,context)).toEqual({outcome:"applied",...result});
  expect(query.mock.calls[1][0]).toContain("lab_work_commands");expect(query.mock.calls).toHaveLength(2);
 });
 it("refuses changed-body same-key replay",async()=>{const query=vi.fn().mockResolvedValueOnce({rows:[{locked:true}]}).mockResolvedValue({rows:[{patient_id:2,source_kind:"visit",source_id:3,request_hash:"0".repeat(64),result:{labWork:[]}}]});await expect(readLabWorkCommandInTransaction({query} as never,context)).rejects.toMatchObject({status:409});});
 it("refuses retired authentication before reading replay receipt",async()=>{mocks.session.mockResolvedValue(null);const query=vi.fn();await expect(readLabWorkCommandInTransaction({query} as never,context)).rejects.toMatchObject({status:403});expect(query).not.toHaveBeenCalled();});
 it("rejected receipts cannot be mistaken for successful replay",async()=>{
  const result={outcome:"rejected" as const,code:"stale_intent"};
  const query=vi.fn().mockResolvedValueOnce({rows:[{locked:true}]}).mockResolvedValueOnce({rows:[{patient_id:2,source_kind:"visit",source_id:3,request_hash:createHash("sha256").update(context.requestHash).digest("hex"),result}]});
  const saved=await readLabWorkCommandInTransaction({query} as never,context);
  expect(saved).toEqual(result);expect(()=>assertLabWorkCommandApplied(saved!)).toThrow();
 });
 it("terminal settlement returns an existing applied receipt without overwriting it",async()=>{
  const result={outcome:"applied" as const,labWork:[]};
  const query=vi.fn().mockResolvedValueOnce({rows:[{name:"lab_work_intent_schema"}]}).mockResolvedValueOnce({rows:[{version:1}]}).mockResolvedValueOnce({rows:[{locked:true}]}).mockResolvedValueOnce({rows:[{patient_id:2,source_kind:"visit",source_id:3,request_hash:createHash("sha256").update(context.requestHash).digest("hex"),result}]});
  expect(await recordRejectedLabWorkCommandInTransaction({query} as never,context,"stale_intent")).toEqual(result);
  expect(query.mock.calls.some(call=>call[0].includes("INSERT"))).toBe(false);
 });

});
