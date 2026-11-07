import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { readOrthoCreateDuration } from '../lib/ortho-create-duration';

// Execute the real source-extracted NewCase function and submit closure with a
// draft double. This is caller/protocol coverage, not React/DOM/browser evidence.
const source=ts.createSourceFile('PatientOrtho.tsx',readFileSync('components/PatientOrtho.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const declaration=source.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='NewCase');
if(!declaration)throw new Error('Missing actual NewCase function');
const compiled=ts.transpileModule(declaration.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;
type FormTree={props:{onSubmit:(event:{preventDefault:()=>void})=>Promise<void>}};
function fixture(initial:string) {
 const fields:Record<string,string>={plannedMonths:initial};
 const draft={busy:false,uncertain:false};
 const operation={};
 const form={draft,owner:{cases:[]},field:(name:string,fallback:string)=>[fields[name]??fallback,(value:string)=>{fields[name]=value;}],
  begin:vi.fn(()=>operation),checkHeaders:vi.fn(()=>true),current:vi.fn(()=>true),
  uncertain:vi.fn(()=>{draft.uncertain=true;}),finish:vi.fn()};
 const fetch=vi.fn(async(_url:string,init:RequestInit)=>{
  const {plannedMonths}=JSON.parse(String(init.body));
  return new Response(JSON.stringify({message:'Invalid duration',id:55}),{status:readOrthoCreateDuration(plannedMonths)===null?400:201});
 });
 const dependencies={React:{createElement:(type:unknown,props:unknown,...children:unknown[])=>({type,props,children})},
  useOrthoDraft:()=>form,UncertainWrite:()=>null,APPLIANCE_LABEL:{},ARCHES_LABEL:{},SLOT_LABEL:{},usesArchwires:()=>false,fetch};
 const render=new Function(...Object.keys(dependencies),`${compiled};return NewCase;`)(...Object.values(dependencies)) as (props:unknown)=>FormTree;
 const onSaved=vi.fn(),onError=vi.fn();
 const submit=()=>render({patientId:101,today:'2026-11-07',onSaved,onError}).props.onSubmit({preventDefault:vi.fn()});
 const body=()=>JSON.parse(String(fetch.mock.lastCall?.[1].body));
 return{fields,draft,form,fetch,submit,body,onSaved,onError};
}

describe('ordinary NewCase authored duration',()=>{
 it.each(['0','garbage','18.6','18.00000000000000001','119.99999999999999999',' 0 ','NaN','Infinity','0.6','120.4'])('sends nonblank %s unchanged for rejection and allows corrected retry',async value=>{
  const f=fixture(value);await f.submit();
  expect(f.body().plannedMonths).toBe(value);
  expect(f.onSaved).not.toHaveBeenCalled();expect(f.form.uncertain).not.toHaveBeenCalled();
  expect(f.fields.plannedMonths).toBe(value);expect(f.form.finish).toHaveBeenCalledOnce();
  f.fields.plannedMonths='18';await f.submit();
  expect(f.fetch).toHaveBeenCalledTimes(2);expect(f.body().plannedMonths).toBe('18');expect(f.onSaved).toHaveBeenCalledOnce();
 });
 it.each(['',' ','\t\n'])('retains blank %j default18',async value=>{
  const f=fixture(value);await f.submit();expect(f.body().plannedMonths).toBe(18);expect(f.onSaved).toHaveBeenCalledOnce();
 });
 it.each(['1','120','18.0',' 18 ','+18','018','1.8e1','0x12'])('preserves valid %s exactly',async value=>{
  const f=fixture(value);await f.submit();expect(f.body().plannedMonths).toBe(value);expect(f.onSaved).toHaveBeenCalledOnce();
 });
 it.each(['network','server'])('preserves uncertain %s outcome and blocks retry',async mode=>{
  const f=fixture('18');
  if(mode==='network')f.fetch.mockRejectedValueOnce(new Error('Synthetic network failure'));
  else f.fetch.mockResolvedValueOnce(new Response('{}',{status:500}));
  await f.submit();expect(f.form.uncertain).toHaveBeenCalledOnce();expect(f.onSaved).not.toHaveBeenCalled();
  await f.submit();expect(f.fetch).toHaveBeenCalledOnce();
 });
 it('retains the busy guard',async()=>{
  const f=fixture('18');f.draft.busy=true;await f.submit();expect(f.fetch).not.toHaveBeenCalled();
 });
});
