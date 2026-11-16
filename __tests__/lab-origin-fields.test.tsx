import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendLabRetirement, LabWorkDraftFields, newLabWorkDraft } from "../components/LabWorkDraftFields";
import { parseLabWorkDraft } from "../lib/lab-work-intent-contract";
vi.mock("../components/LabDentalChart",()=>({LabDentalChart:({value}:{value:string})=><div data-teeth={value}/> }));
vi.mock("../components/SettingsProvider",()=>({useSetting:()=>""}));
afterEach(()=>vi.unstubAllGlobals());
describe("explicit origin laboratory draft",()=>{
 it("gives each deliberately enabled independent work its own stable keys without a guessed shade or tooth role",()=>{
  const first=newLabWorkDraft("single"),second=newLabWorkDraft("single");
  expect(first.intentId).not.toBe(second.intentId);expect(first.memberId).not.toBe(second.memberId);
  expect(first.prescription).toMatchObject({partyId:null,shade:"",toothNumbers:""});
  expect(parseLabWorkDraft(JSON.parse(JSON.stringify(first)))).toEqual(first);
 });
 it("keeps exact IDs and specification under sealed JSON replay",()=>{
  const value=newLabWorkDraft("bridge");value.prescription.shade="A2";
  const sealed=JSON.stringify({idempotencyKey:"synthetic-request",items:[{serviceId:1,labWork:value}]});
  value.prescription.shade="A3";
  const replay=JSON.parse(sealed);expect(replay.items[0].labWork.prescription.shade).toBe("A2");
  expect(replay.items[0].labWork.intentId).toBe(value.intentId);
 });
 it("does not retire an intent that has never been persisted",()=>{
  expect(appendLabRetirement([],newLabWorkDraft("single"))).toEqual([]);
 });
 it("groups explicit retired member IDs without duplicates or revision drift",()=>{
  const first={...newLabWorkDraft("bridge"),expectedRevision:2};
  const second={...first,memberId:crypto.randomUUID()};
  const retired=appendLabRetirement(appendLabRetirement([],first),second);
  expect(retired).toEqual([{intentId:first.intentId,expectedRevision:2,memberIds:[first.memberId,second.memberId]}]);
  expect(appendLabRetirement(retired,first)).toEqual(retired);
  expect(()=>appendLabRetirement(retired,{...second,expectedRevision:3})).toThrow();
 });
 it("renders named clinical fields and neutral incomplete source without sending anything",()=>{
  const value=newLabWorkDraft("bridge");
  const html=renderToStaticMarkup(<LabWorkDraftFields value={value} workLabel="جسر اصطناعي" sourceTooth={27} disabled={false} onChange={()=>{}}/>);
  for(const text of ["المختبر","لون السن","لون الجذع","نوع الطبعة","التسليم المطلوب","سن المصدر","27"])expect(html).toContain(text);
  expect(html).toContain('data-teeth=""');expect(html).toContain("لا نختار تاجًا أو دعامة أو لونًا تلقائيًا");
 });
});
