import { describe, expect, it } from "vitest";
import { labWorkFingerprint, normalizeLabWorkGroups, parseLabWorkDraft, parseLabWorkRetirements, type LabWorkDraft, type LabWorkSourceRow } from "../lib/lab-work-intent-contract";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const prescription = { partyId:null,shade:"",stumpShade:"",toothNumbers:"",dueDate:"2026-11-01",impressionType:"physical",priority:"normal" } as const;
const draft = (intent=1,member=11,extra:Partial<LabWorkDraft>={}):LabWorkDraft => ({intentId:id(intent),memberId:id(member),expectedRevision:0,groupKind:"single",prescription:{...prescription},...extra});
const row = (work:unknown=draft(),extra:Partial<LabWorkSourceRow>={}):LabWorkSourceRow => ({serviceId:1,toothCode:27,quantity:1,planItemId:null,doctorId:2,category:"crown",labWork:work,...extra});

describe("explicit lab work intent wire contract",()=>{
 it("preserves legacy absence without inventing a prescription",()=>{
  expect(parseLabWorkDraft(undefined)).toBeNull();expect(parseLabWorkDraft(null)).toBeNull();
  expect(normalizeLabWorkGroups([row(undefined,{labWork:undefined}),row(null)])).toEqual({groups:[],retirements:[]});
 });
 it("normalizes UUID case and copies rather than mutating pending request",()=>{
  const raw=draft();raw.intentId="ABCDEFAB-0000-4000-8000-000000000001";
  const before=structuredClone(raw),parsed=parseLabWorkDraft(raw)!;
  expect(parsed.intentId).toBe(raw.intentId.toLowerCase());expect(raw).toEqual(before);
  expect(parsed.prescription).not.toBe(raw.prescription);
 });
 it.each([{},[],"uuid",{...draft(),intentId:"27"},{...draft(),memberId:id(1).replace("4000","0000")},
  {...draft(),expectedRevision:-1},{...draft(),expectedRevision:0.5},{...draft(),groupKind:"full_arch"},
  {...draft(),status:"sent"},{...draft(),prescription:{...prescription,cost:500}},{...draft(),prescription:{...prescription,shade:"patient secret"}}])("refuses malformed or overbroad lab payload %j",raw=>expect(()=>parseLabWorkDraft(raw)).toThrow());
 it("permits incomplete clinical draft with explicit immutable keys",()=>expect(parseLabWorkDraft(draft())).toEqual(draft()));
 it("keeps equal-priced adjacent or same-tooth independent crowns as separate identities",()=>{
  const command=normalizeLabWorkGroups([row(draft(1,11)),row(draft(2,12)),row(draft(3,13),{toothCode:26})]);
  expect(command.groups.map(g=>g.intentId)).toEqual([id(1),id(2),id(3)]);
  expect(command.groups.every(g=>g.members.length===1)).toBe(true);
 });
 it("groups only explicitly matching bridge IDs with exact member roles",()=>{
  const bridge={groupKind:"bridge" as const,prescription:{...prescription,toothNumbers:"25(Abutment), 26(Pontic), 27(Abutment)"}};
  const command=normalizeLabWorkGroups([25,26,27].map((tooth,index)=>row(draft(1,index+11,bridge),{category:"bridge",toothCode:tooth})));
  expect(command.groups).toHaveLength(1);expect(command.groups[0].members.map(m=>m.toothCode)).toEqual([25,26,27]);
 });
 it("does not convert distinct crown sources into an implicit bridge",()=>expect(()=>normalizeLabWorkGroups([row(draft(1,11,{groupKind:"bridge"}))])).toThrow());
 it.each([{toothCode:null},{toothCode:29},{quantity:2},{quantity:0},{serviceId:0},{doctorId:0},{planItemId:0},{category:"endo"}])("rejects unsupported/invalid authoritative source %j",change=>expect(()=>normalizeLabWorkGroups([row(draft(),change)])).toThrow());
 it.each([{expectedRevision:1},{groupKind:"single" as const},{prescription:{...prescription,shade:"A2"}}])("refuses conflicting repeated group declarations %j",change=>{
  const a=draft(1,11,{groupKind:"bridge"});const b=draft(1,12,{groupKind:"bridge",...change});
  expect(()=>normalizeLabWorkGroups([row(a,{category:"bridge"}),row(b,{category:"bridge"})])).toThrow();
 });
 it("rejects duplicate member keys even across distinct groups",()=>expect(()=>normalizeLabWorkGroups([row(draft(1,11)),row(draft(2,11))])).toThrow());
 it("rejects two members declared as one single work group",()=>expect(()=>normalizeLabWorkGroups([row(draft(1,11)),row(draft(1,12))])).toThrow());
 it.each(["18(Crown)","27(Pontic)","27(Crown), 26(Crown)"])("refuses prescription scope or roles inconsistent with single source: %s",toothNumbers=>expect(()=>normalizeLabWorkGroups([row(draft(1,11,{prescription:{...prescription,toothNumbers}}))])).toThrow());
 it("reordering rows preserves identity and canonical lab fingerprint",()=>{
  const rows=[row(draft(2,12)),row(draft(1,11))];
  expect(labWorkFingerprint(normalizeLabWorkGroups(rows))).toBe(labWorkFingerprint(normalizeLabWorkGroups([...rows].reverse())));
 });
 it("fingerprint covers revisions, clinical fields and exact source attribution",()=>{
  const base=labWorkFingerprint(normalizeLabWorkGroups([row()]));
  for(const changed of [row(draft(1,11,{expectedRevision:1})),row(draft(1,11,{prescription:{...prescription,shade:"A2"}})),row(draft(),{doctorId:3}),row(draft(),{planItemId:17})]){
   expect(labWorkFingerprint(normalizeLabWorkGroups([changed]))).not.toBe(base);
  }
 });
 it("canonicalizes prescription object property order",()=>{
  const work=draft();const reordered={...work,prescription:Object.fromEntries(Object.entries(work.prescription).reverse())};
  expect(labWorkFingerprint(normalizeLabWorkGroups([row(work)]))).toBe(labWorkFingerprint(normalizeLabWorkGroups([row(reordered)])));
 });
 it("omission is not a retirement command",()=>expect(normalizeLabWorkGroups([]).retirements).toEqual([]));
 it("explicit retirement sorts retained tombstone IDs and participates in hash",()=>{
  const retirements=[{intentId:id(1),expectedRevision:2,memberIds:[id(12),id(11)]}];
  const parsed=parseLabWorkRetirements(retirements);
  expect(parsed[0].memberIds).toEqual([id(11),id(12)]);
  expect(labWorkFingerprint(normalizeLabWorkGroups([],retirements))).not.toBe(labWorkFingerprint(normalizeLabWorkGroups([])));
 });
 it.each([{intentId:id(1),expectedRevision:0,memberIds:[]},{intentId:id(1),expectedRevision:-1,memberIds:[id(11)]},
  {intentId:id(1),expectedRevision:0,memberIds:[id(11),id(11)]},{intentId:id(1),expectedRevision:0,memberIds:[id(11)],delete:true}])("refuses invalid retirement %j",raw=>expect(()=>parseLabWorkRetirements([raw])).toThrow());
 it("rejects a member active and retired in the same command",()=>expect(()=>normalizeLabWorkGroups([row()],[{intentId:id(1),expectedRevision:0,memberIds:[id(11)]}])).toThrow());
 it("requires same intent revision for active and retiring members",()=>expect(()=>normalizeLabWorkGroups([row()],[{intentId:id(1),expectedRevision:1,memberIds:[id(12)]}])).toThrow());
});
