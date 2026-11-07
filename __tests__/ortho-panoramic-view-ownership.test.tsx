import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrthoPanoramicReview } from '../components/OrthoPanoramicReview';
import { newAssessmentEditorV2 } from '../lib/ortho-assessment-editor-v2';
import type { OrthoRecordDocument } from '../lib/ortho-records';
const hooks=vi.hoisted(()=>({values:[] as unknown[],cursor:0,memos:new Map<number,{deps:unknown[];value:unknown}>(),effects:new Map<number,{deps?:unknown[];cleanup?:()=>void}>(),pending:[] as (()=>void)[]}));
vi.mock('react',async original=>{
 const actual=await original<typeof import('react')>();
 const slot=(v:unknown)=>{const i=hooks.cursor++;if(!(i in hooks.values))hooks.values[i]=v;return i;};
 const same=(a:unknown[],b:unknown[])=>a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
 return {...actual,useState:(v:unknown)=>{const i=slot(typeof v==='function'?v():v);return[hooks.values[i],(n:unknown)=>{hooks.values[i]=typeof n==='function'?n(hooks.values[i]):n;}];},
 useRef:(v:unknown)=>hooks.values[slot({current:v})],
 useMemo:(fn:()=>unknown,deps:unknown[])=>{const i=slot(undefined),old=hooks.memos.get(i);if(old&&same(old.deps,deps))return old.value;const value=fn();hooks.memos.set(i,{deps,value});return value;},
 useLayoutEffect:(fn:()=>void|(()=>void),deps?:unknown[])=>{const i=slot(undefined),old=hooks.effects.get(i);if(old?.deps&&deps&&same(old.deps,deps))return;hooks.pending.push(()=>{old?.cleanup?.();const cleanup=fn();hooks.effects.set(i,{deps,cleanup:typeof cleanup==='function'?cleanup:undefined});});}};
});
type Element=ReactElement<Record<string,unknown>>;
const nodes=(n:ReactNode):Element[]=>Array.isArray(n)?n.flatMap(nodes):n&&typeof n==='object'&&'props'in n?[n as Element,...nodes((n as Element).props.children as ReactNode)]:[];
let draft= newAssessmentEditorV2('synthetic-panoramic-ui-command',null)!.measurements;
const onChange=vi.fn(),digest='a'.repeat(64);
const documents:OrthoRecordDocument[]=[91,92].map(id=>({id,patientId:1,orthoCaseId:2,title:`Synthetic ${id}`,isImage:true,photoStage:'initial',photoView:'panoramic',takenOn:null,uploadedAt:'2026-11-05T00:00:00Z',removedAt:null}));
const sources=documents.map(d=>({kind:'document' as const,id:d.id,version:`sha256:${digest}`,label:d.title}));
let allowed=true;
function render(){hooks.cursor=0;const result=OrthoPanoramicReview({draft,documents,sources,owner:{renderEditable:allowed,active:()=>allowed,editable:()=>allowed},onChange});hooks.pending.splice(0).forEach(f=>f());return nodes(result);}
function selectImage(id:number){const n=render().find(n=>n.props['aria-label']==='صورة البانوراما')!;(n.props.onChange as (e:unknown)=>void)({target:{value:String(id)}});return render();}
function selectTarget(){const n=render().find(n=>n.props['aria-label']==='نطاق الملاحظة')!;(n.props.onChange as (e:unknown)=>void)({target:{value:'case'}});return render();}
const add=()=>render().find(n=>n.type==='button')!;
const image=()=>render().find(n=>n.type==='img')!;
beforeEach(()=>{hooks.effects.forEach(e=>e.cleanup?.());hooks.values=[];hooks.cursor=0;hooks.memos.clear();hooks.effects.clear();hooks.pending=[];allowed=true;onChange.mockClear();draft=newAssessmentEditorV2('synthetic-panoramic-ui-command',null)!.measurements;});
describe('panoramic rendered-image authority',()=>{
 it('binds the actual preview to the expected exact source bytes',()=>{selectImage(91);expect(image().props.src).toBe(`/api/documents/91?cephSource=${digest}`);});
 it('does not accept a finding before a successful image decode or after image failure',()=>{
  selectImage(91);selectTarget();expect(add().props.disabled).toBe(true);
  (image().props.onLoad as ()=>void)();selectTarget();expect(add().props.disabled).toBe(false);
  (image().props.onError as ()=>void)();expect(add().props.disabled).toBe(true);
  (add().props.onClick as ()=>void)();expect(onChange).not.toHaveBeenCalled();
 });
 it('retires image-load and edit callbacks when the selected document changes',()=>{
  selectImage(91);(image().props.onLoad as ()=>void)();selectTarget();
  const staleAdd=add().props.onClick as ()=>void,staleLoad=image().props.onLoad as ()=>void;
  selectImage(92);selectTarget();staleLoad();staleAdd();
  expect(onChange).not.toHaveBeenCalled();expect(add().props.disabled).toBe(true);
 });
 it('retires add callbacks when the selected tooth scope changes',()=>{
  selectImage(91);(image().props.onLoad as ()=>void)();selectTarget();const stale=add().props.onClick as ()=>void;
  const scope=render().find(n=>n.props['aria-label']==='نطاق الملاحظة')!;
  (scope.props.onChange as (e:unknown)=>void)({target:{value:'13'}});render();stale();
  expect(onChange).not.toHaveBeenCalled();
  (add().props.onClick as ()=>void)();expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange.mock.calls[0][0].values).toHaveProperty('panoramic_v1_91_tooth_13');
 });
 it('does not write after authority is revoked',()=>{
  selectImage(91);(image().props.onLoad as ()=>void)();selectTarget();const stale=add().props.onClick as ()=>void;
  allowed=false;render();stale();expect(onChange).not.toHaveBeenCalled();
 });
});
