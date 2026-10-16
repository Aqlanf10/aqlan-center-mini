import { describe,expect,it } from 'vitest';
import { buildIdentityPreview } from '../lib/hr-identity-preview';
import type { IdentitySources } from '../lib/hr-identity-preview-shared';
import { buildPersonIdentityPlan,parsePersonIdentityDecisions,parsePersonIdentityPlan,type PersonIdentityDecision } from '../lib/hr-person-identity-plan';

const source = (): IdentitySources => ({schemaFingerprint:'a'.repeat(64),accounts:[
  {id:1,label:'Identical name',role:'doctor',active:true,partyId:10},
  {id:2,label:'Identical name',role:'admin',active:true,partyId:null},
  {id:3,label:'Identical name',role:'doctor',active:false,partyId:null},
],staff:[{id:20,label:'Person',userId:1,workStatus:'active',contractKind:'commission',hireDateRecorded:false,salaryTermsComplete:false,identityRevision:0}],
parties:[{id:10,label:'Doctor',kind:'doctor',active:true},{id:11,label:'Employee',kind:'employee',active:true}],contracts:[],payrollLinks:[],accountLinks:[],partyLinks:[]});
const decision = (patch:Partial<PersonIdentityDecision> = {}):PersonIdentityDecision => ({key:'one',staffId:20,expectedRevision:0,fullName:null,
  userIds:[1,2],partyId:10,confirmedSamePerson:true,reason:'Synthetic confirmed identity',sourceRef:'synthetic-review-1',closeAccountLinkIds:[],closePartyLinkId:null,...patch});
function converted() {
  const s=source();s.staff[0].identityRevision=1;
  s.accountLinks=[{id:'1',staffId:20,userId:1,closed:false,openedEventId:'1',closedEventId:null},{id:'2',staffId:20,userId:2,closed:false,openedEventId:'2',closedEventId:null}];
  s.partyLinks=[{id:'1',staffId:20,partyId:10,closed:false,openedEventId:'3',closedEventId:null}];return s;
}
it('keeps old preview classification without granting identity by matching names',()=>{
  const s=source();delete s.schemaFingerprint;delete s.accountLinks;delete s.partyLinks;s.staff[0].identityRevision=undefined;
  const p=buildIdentityPreview(s);expect(p.candidates.find(c=>c.key==='staff:20')?.userIds).toEqual([1]);
  expect(p.candidates.find(c=>c.key==='user:2')?.userIds).toEqual([2]);
  expect(()=>buildPersonIdentityPlan(s,[decision()])).toThrow(/غير مسجل/);
});
it('confirms a legacy person with both explicit accounts and financial party without generating terms',()=>{
  const s=source(),before=structuredClone(s),plan=buildPersonIdentityPlan(s,[decision()]);
  expect(plan.steps[0]).toMatchObject({action:'confirm',userIds:[1,2],partyId:10,revision:0,conflicts:[]});
  expect(parsePersonIdentityPlan(plan)).toEqual(plan);expect(s).toEqual(before);
  expect(JSON.stringify(plan)).not.toMatch(/salaryMinor|commission_config|permissions|password/);
});
it('requires explicit financial selection instead of silently choosing an account party',()=>{
  expect(buildPersonIdentityPlan(source(),[decision({partyId:null})]).steps[0].conflicts).toContain('financial_selection_required');
});
it('allows a disabled account as identity evidence without activation or rights',()=>{
  const p=buildPersonIdentityPlan(source(),[decision({key:'new',staffId:null,fullName:'Documented identity label',expectedRevision:null,userIds:[3],partyId:null})]);
  expect(p.steps[0].action).toBe('create');expect(p.steps[0].userIds).toEqual([3]);
});
for(const reverse of [false,true])it(`detects converted account/staff overlap after expansion, reverse=${reverse}`,()=>{
  const s=converted(),list=[decision({expectedRevision:1,userIds:[1]}),decision({key:'two',staffId:null,expectedRevision:null,fullName:'Explicit choice',userIds:[2]})];
  const p=buildPersonIdentityPlan(s,reverse?[...list].reverse():list);
  expect(p.steps.every(x=>x.action==='conflict'&&x.conflicts.includes('duplicate_selection'))).toBe(true);
});
for(const reverse of [false,true])it(`detects converted financial link/party overlap, reverse=${reverse}`,()=>{
  const s=converted(),list=[decision({expectedRevision:1}),decision({key:'two',staffId:null,expectedRevision:null,fullName:'Explicit party choice',userIds:[]})];
  expect(buildPersonIdentityPlan(s,reverse?[...list].reverse():list).steps.every(x=>x.conflicts.includes('duplicate_selection'))).toBe(true);
});
for(const kind of ['account','contract','payroll','explicit_link'] as const)it(`rejects conflicting party from ${kind}`,()=>{
  const s=source();if(kind==='account')s.accounts[1].partyId=11;
  if(kind==='contract')s.contracts=[{id:30,staffId:20,partyId:11,status:'approved'}];
  if(kind==='payroll')s.payrollLinks=[{staffId:20,partyId:11}];
  if(kind==='explicit_link')s.partyLinks=[{id:'4',staffId:20,partyId:11,closed:false,openedEventId:'4',closedEventId:null}];
  expect(buildPersonIdentityPlan(s,[decision()]).steps[0].conflicts).toContain('different_parties');
});
it('uses the converted link source and never falls back to its retained legacy account',()=>{
  const s=converted();s.accountLinks![0].closed=true;s.accounts[1].partyId=10;
  const p=buildIdentityPreview(s);expect(p.candidates.find(c=>c.key==='staff:20')?.userIds).toEqual([2]);
  expect(p.candidates.find(c=>c.key==='user:1')?.userIds).toEqual([1]);
});
it('retains the legacy account financial witness even when its identity link is closed',()=>{
  const s=converted();s.accountLinks![0].closed=true;s.partyLinks![0].closed=true;s.accounts[1].partyId=11;
  const p=buildPersonIdentityPlan(s,[decision({expectedRevision:1,userIds:[2],partyId:11})]);
  expect(p.steps[0].userIds).toEqual([2]);expect(p.steps[0].conflicts).toContain('different_parties');
});
it('detects corrupt converted input without a schema marker',()=>{
  const s=converted();delete s.schemaFingerprint;
  expect(buildIdentityPreview(s).candidates.find(c=>c.key==='staff:20')?.reasons).toContain('identity_incomplete');
});
it('closes a link by explicit ID, retaining a new plan history and no source mutation',()=>{
  const s=converted(),before=structuredClone(s);
  const p=buildPersonIdentityPlan(s,[decision({expectedRevision:1,userIds:[1],closeAccountLinkIds:['2']})]);
  expect(p.steps[0]).toMatchObject({action:'link',userIds:[1],conflicts:[]});expect(s).toEqual(before);
});
it('rejects closing and reopening the same link or a foreign/missing link',()=>{
  const s=converted();
  expect(buildPersonIdentityPlan(s,[decision({expectedRevision:1,closeAccountLinkIds:['2']})]).steps[0].conflicts).toContain('close_and_reopen_same_link');
  expect(buildPersonIdentityPlan(s,[decision({expectedRevision:1,closeAccountLinkIds:['90']})]).steps[0].conflicts).toContain('invalid_link_closure');
});
it('detects stale revisions and preserves reserved legacy access references',()=>{
  const s=converted();s.accountLinks![0].closed=true;
  expect(buildPersonIdentityPlan(s,[decision({expectedRevision:0})]).steps[0].conflicts).toContain('stale_revision');
  expect(buildPersonIdentityPlan(s,[decision({staffId:null,fullName:'New selection',expectedRevision:null,userIds:[1]})]).steps[0].conflicts).toContain('legacy_account_reserved');
});
it('binds safe identity, closure history and schema changes into the digest',()=>{
  const s=converted(),p=buildPersonIdentityPlan(s,[decision({expectedRevision:1})]);
  expect(buildPersonIdentityPlan({...s,schemaFingerprint:'b'.repeat(64)},p.decisions).planDigest).not.toBe(p.planDigest);
  s.accountLinks![0].closedEventId='99';
  expect(buildPersonIdentityPlan(s,p.decisions).sourceFingerprint).not.toBe(p.sourceFingerprint);
  expect(()=>parsePersonIdentityPlan({...p,planDigest:'0'.repeat(64)})).toThrow();
});
describe('strict decisions',()=>{
  for(const patch of [{permissions:{}},{role:'admin'},{salary:100},{commission_config:{}},{confirmedSamePerson:false},{userIds:[1,1]},{expectedRevision:-1},{sourceRef:''},{closeAccountLinkIds:['0']}]) {
    it(`rejects ${Object.keys(patch)[0]}`,()=>expect(()=>parsePersonIdentityDecisions([{...decision(),...patch}])).toThrow());
  }
});
