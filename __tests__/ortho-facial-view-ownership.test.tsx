import { facialHistoryFixture } from "./fixtures/ortho-facial-history";
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrthoFacialAnalysis } from '../components/OrthoFacialAnalysis';
import { facialSubmissionHash } from '../lib/ortho-facial-submission-contract';
import { syntheticFace } from './fixtures/ortho-facial-analysis';
import type { FacialContent } from '../lib/ortho-facial-analysis';
const hooks=vi.hoisted(()=>({values:[] as unknown[],cursor:0,memos:new Map<number,{deps:unknown[];value:unknown}>(),effects:new Map<number,{deps?:unknown[];cleanup?:()=>void}>(),pending:[] as (()=>void)[]}));
vi.mock('react',async original=>{
 const actual=await original<typeof import('react')>();
 const slot=(v:unknown)=>{const i=hooks.cursor++;if(!(i in hooks.values))hooks.values[i]=v;return i;};
 const same=(a:unknown[],b:unknown[])=>a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
 const effect=(fn:()=>void|(()=>void),deps?:unknown[])=>{const i=slot(undefined),old=hooks.effects.get(i);if(old?.deps&&deps&&same(old.deps,deps))return;hooks.pending.push(()=>{old?.cleanup?.();const cleanup=fn();hooks.effects.set(i,{deps,cleanup:typeof cleanup==='function'?cleanup:undefined});});};
 return {...actual,useState:(v:unknown)=>{const i=slot(typeof v==='function'?v():v);return[hooks.values[i],(n:unknown)=>{hooks.values[i]=typeof n==='function'?n(hooks.values[i]):n;}];},useRef:(v:unknown)=>hooks.values[slot({current:v})],useMemo:(fn:()=>unknown,deps:unknown[])=>{const i=slot(undefined),old=hooks.memos.get(i);if(old&&same(old.deps,deps))return old.value;const value=fn();hooks.memos.set(i,{deps,value});return value;},useEffect:effect,useLayoutEffect:effect};
});
vi.mock('../components/SessionProvider',()=>({useSession:()=>({username:'synthetic',role:'doctor',permissions:[]})}));
// Network receipt validation has separate tests; these tests exercise actual Workspace event handlers.
vi.mock('../lib/ortho-facial-records',()=>({readFacialRead:async(v:unknown)=>v,verifyFacialSaved:async(v:{revision:unknown})=>v.revision}));
type Element=ReactElement<Record<string,unknown>>;
const nodes=(n:ReactNode):Element[]=>Array.isArray(n)?n.flatMap(nodes):n&&typeof n==='object'&&'props'in n?[n as Element,...nodes((n as Element).props.children as ReactNode)]:[];
const basis={sha256:'a'.repeat(64),width:1000,height:1200,exifOrientation:1};
const documents=[91,92].map(id=>({id,title:`Synthetic ${id}`,sha256:basis.sha256,takenOn:null}));
const fetchMock=vi.fn();
let serverRecovery:unknown=null;
const reply=(payload:unknown,status=200)=>({ok:status>=200&&status<300,status,redirected:false,headers:new Headers({'cache-control':'private, no-store'}),text:async()=>JSON.stringify(payload),json:async()=>payload});
const binding={actorId:4,scope:{patientId:1,orthoCaseId:2,clinicalCaseId:3}};
const command=()=>({schemaVersion:1 as const,clientRequestId:'synthetic_recovery_command_1',documentId:91,expectedHeadId:null,reason:'Synthetic recovery',content:syntheticFace()});
async function receipt(state:'pending'|'committed'='pending'){const c=command();return {state,identity:{id:7,commandId:c.clientRequestId,requestFingerprint:await facialSubmissionHash(c)},expected:{...binding,previousVersion:0,command:c}};}
function remount(){hooks.effects.forEach(e=>e.cleanup?.());hooks.values=[];hooks.cursor=0;hooks.memos.clear();hooks.effects.clear();hooks.pending=[];}
async function restored(){render();await settle();await settle();}
function render(){hooks.cursor=0;const wrapper=OrthoFacialAnalysis({patientId:1,orthoCaseId:2});const tree=(wrapper.type as (p:unknown)=>ReactNode)(wrapper.props);hooks.pending.splice(0).forEach(f=>f());return nodes(tree);}
async function settle(){for(let i=0;i<8;i++)await new Promise<void>(resolve=>setTimeout(resolve,1));return render();}
const label=(text:string)=>render().find(n=>n.props['aria-label']===text)!;
const button=(text:string)=>render().find(n=>n.type==='button'&&n.props.children===text)!;
const img=()=>render().find(n=>n.type==='img')!;
const pixel=()=>render().find(n=>typeof n.type==='function'&&'apply'in n.props)!;
const draft=()=>hooks.values.find(v=>!!v&&typeof v==='object'&&'expectedHeadId'in v&&'content'in v) as {content:FacialContent;reason:string;expectedHeadId:number|null}|undefined;
const invoke=(n:Element,handler:string,event?:unknown)=>(n.props[handler] as (e?:unknown)=>unknown)(event);
const load=()=>invoke(img(),'onLoad',{currentTarget:{naturalWidth:1000,naturalHeight:1200}});
const pointEvent=(type='pointerdown',pointerId=1)=>({type,pointerId,button:0,isPrimary:true,buttons:1,clientX:250,clientY:360,currentTarget:{getBoundingClientRect:()=>({left:0,top:0,width:1000,height:1200}),setPointerCapture:vi.fn(),hasPointerCapture:()=>true,releasePointerCapture:vi.fn()}});
async function start(){render();await settle();invoke(label('الصورة المرتبطة بالحالة'),'onChange',{target:{value:'91'}});render();await settle();load();render();invoke(button('بدء قياسات هذه الصورة'),'onClick');render();}
beforeEach(()=>{hooks.values=[];hooks.cursor=0;hooks.memos.clear();hooks.effects.clear();hooks.pending=[];fetchMock.mockReset();serverRecovery=null;vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn(),confirm:()=>true});fetchMock.mockImplementation(async(url:string)=>{const id=new URL(url,'http://synthetic.invalid').searchParams.get('documentId');const payload=url.includes('/recovery')?{ok:true,actorId:4,scope:{patientId:1,orthoCaseId:2,clinicalCaseId:3},recovery:serverRecovery}:{ok:true,patientId:1,orthoCaseId:2,clinicalCaseId:3,actorId:4,canWrite:true,documents,documentsTruncated:false,selectedDocumentId:id?Number(id):null,image:id?basis:null,history:[],historyTruncated:false};return {ok:true,status:200,redirected:false,headers:new Headers({'cache-control':'no-store'}),text:async()=>JSON.stringify(payload),json:async()=>payload};});vi.stubGlobal('fetch',fetchMock);});
afterEach(()=>{hooks.effects.forEach(e=>e.cleanup?.());vi.unstubAllGlobals();});
const prepareSave=()=>{const reason=render().filter(n=>n.type==='input'&&n.props.maxLength===500).at(-1)!;invoke(reason,'onChange',{target:{value:'Synthetic revision reason'}});render();};
describe('manual facial workspace callback and pointer ownership',()=>{
 it('requires matching image dimensions before enabling a draft',async()=>{render();await settle();invoke(label('الصورة المرتبطة بالحالة'),'onChange',{target:{value:'91'}});render();await settle();expect(button('بدء قياسات هذه الصورة').props.disabled).toBe(true);invoke(img(),'onLoad',{currentTarget:{naturalWidth:1200,naturalHeight:1000}});expect(button('بدء قياسات هذه الصورة').props.disabled).toBe(true);load();expect(button('بدء قياسات هذه الصورة').props.disabled).toBe(false);});
 it('retires old image and coordinate callbacks after switching documents',async()=>{await start();const staleImage=img(),staleApply=pixel().props.apply as (x:number,y:number)=>void;invoke(label('الصورة المرتبطة بالحالة'),'onChange',{target:{value:'92'}});render();await settle();invoke(staleImage,'onLoad',{currentTarget:{naturalWidth:1000,naturalHeight:1200}});staleApply(400,500);expect(button('بدء قياسات هذه الصورة').props.disabled).toBe(true);expect(draft()).toBeUndefined();});
 it('retires coordinate callbacks after image decoding fails',async()=>{await start();const stale=pixel().props.apply as (x:number,y:number)=>void;invoke(img(),'onError');render();stale(400,500);expect(draft()!.content.landmarks).toEqual({});});
 it('retires coordinate callbacks after the selected landmark changes',async()=>{await start();const stale=pixel().props.apply as (x:number,y:number)=>void;invoke(label('المعلم الحالي'),'onChange',{target:{value:'tr'}});render();stale(400,500);expect(draft()!.content.landmarks).toEqual({});});
 it('does not let a prior draft callback mutate a new draft of the same image',async()=>{await start();const stale=pixel().props.apply as (x:number,y:number)=>void;invoke(button('تجاهل مسودة الصورة'),'onClick');render();invoke(button('بدء قياسات هذه الصورة'),'onClick');render();stale(400,500);expect(draft()!.content.landmarks).toEqual({});});
 it('does not erase later edits using an earlier coordinate callback',async()=>{await start();const stale=pixel().props.apply as (x:number,y:number)=>void;const note=render().find(n=>n.type==='textarea'&&n.props.maxLength===1000)!;invoke(note,'onChange',{target:{value:'Synthetic image limitation'}});render();stale(400,500);expect(draft()!.content.quality.note).toBe('Synthetic image limitation');});
 it('ignores pointermove without an owned pointerdown',async()=>{await start();invoke(label('لوحة معالم الوجه'),'onPointerMove',pointEvent('pointermove'));expect(draft()!.content.landmarks).toEqual({});});
 it('does not transfer an active pointer gesture to a newly selected landmark',async()=>{await start();invoke(label('لوحة معالم الوجه'),'onPointerDown',pointEvent());render();invoke(label('المعلم الحالي'),'onChange',{target:{value:'tr'}});render();invoke(label('لوحة معالم الوجه'),'onPointerMove',pointEvent('pointermove'));expect(draft()!.content.landmarks.tr).toBeUndefined();expect(draft()!.content.landmarks.axisTop).toBeDefined();});
 it('ignores a different pointer during a captured gesture',async()=>{await start();invoke(label('لوحة معالم الوجه'),'onPointerDown',pointEvent());render();const before=structuredClone(draft()!.content.landmarks);invoke(label('لوحة معالم الوجه'),'onPointerMove',{...pointEvent('pointermove',2),clientX:700});expect(draft()!.content.landmarks).toEqual(before);});
 it('blocks duplicate save and retained edits synchronously while save is in flight',async()=>{await start();prepareSave();const oldApply=pixel().props.apply as (x:number,y:number)=>void,save=button('حفظ مراجعة قياسات الصورة');let reject!: (e:Error)=>void;fetchMock.mockImplementationOnce(()=>new Promise((_resolve,r)=>{reject=r;}));invoke(save,'onClick');invoke(save,'onClick');oldApply(400,500);await settle();expect(fetchMock.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);expect(draft()!.content.landmarks).toEqual({});reject(Error('synthetic lost response'));await settle();});
 it('replays the exact uncertain command with its original request ID',async()=>{await start();prepareSave();fetchMock.mockRejectedValueOnce(Error('synthetic lost response'));invoke(button('حفظ مراجعة قياسات الصورة'),'onClick');await settle();expect(label('الصورة المرتبطة بالحالة').props.disabled).toBe(true);fetchMock.mockRejectedValueOnce(Error('synthetic retry lost response'));invoke(button('التحقق بإعادة نفس طلب قياسات الصورة'),'onClick');await settle();const posts=fetchMock.mock.calls.filter(c=>c[1]?.method==='POST');expect(posts).toHaveLength(2);expect(posts[1][1].body).toBe(posts[0][1].body);});
 it('does not let a retained edit mutate the locked uncertain draft',async()=>{await start();prepareSave();const oldApply=pixel().props.apply as (x:number,y:number)=>void;fetchMock.mockRejectedValueOnce(Error('synthetic lost response'));invoke(button('حفظ مراجعة قياسات الصورة'),'onClick');await settle();oldApply(400,500);expect(draft()!.content.landmarks).toEqual({});});
 it('does not let a retained document selector escape an uncertain save',async()=>{await start();prepareSave();const oldSelect=label('الصورة المرتبطة بالحالة');fetchMock.mockRejectedValueOnce(Error('synthetic lost response'));invoke(button('حفظ مراجعة قياسات الصورة'),'onClick');await settle();invoke(oldSelect,'onChange',{target:{value:'92'}});render();await settle();expect(label('الصورة المرتبطة بالحالة').props.value).toBe(91);expect(draft()).toBeDefined();});
 it('does not save an earlier draft snapshot through a retained save callback',async()=>{await start();prepareSave();const oldSave=button('حفظ مراجعة قياسات الصورة');(pixel().props.apply as (x:number,y:number)=>void)(400,500);render();invoke(oldSave,'onClick');await settle();expect(fetchMock.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(0);});

 it('continues an owned primary pointer drag across renders and stops on pointerup',async()=>{await start();invoke(label('لوحة معالم الوجه'),'onPointerDown',pointEvent());render();invoke(label('لوحة معالم الوجه'),'onPointerMove',{...pointEvent('pointermove'),clientX:700});render();expect(draft()!.content.landmarks.axisTop).toEqual({state:'located',x:.7,y:.3});invoke(label('لوحة معالم الوجه'),'onPointerUp',pointEvent('pointerup'));invoke(label('لوحة معالم الوجه'),'onPointerMove',{...pointEvent('pointermove'),clientX:900});expect(draft()!.content.landmarks.axisTop).toEqual({state:'located',x:.7,y:.3});});
 it('ignores a non-primary pointerdown',async()=>{await start();invoke(label('لوحة معالم الوجه'),'onPointerDown',{...pointEvent(),isPrimary:false});expect(draft()!.content.landmarks).toEqual({});});

});

describe('server-only durable facial recovery lifecycle',()=>{
 it('does not enable any editing until the mount recovery receipt verifies',async()=>{
  const base=fetchMock.getMockImplementation()!;let resolve!:(r:unknown)=>void;fetchMock.mockImplementation((url:string,init:unknown)=>url.includes('/recovery')?new Promise(r=>{resolve=r;}):base(url,init));
  render();await settle();expect(label('الصورة المرتبطة بالحالة').props.disabled).toBe(true);expect(draft()).toBeUndefined();resolve(reply({ok:true,...binding,recovery:null}));await settle();expect(label('الصورة المرتبطة بالحالة').props.disabled).toBe(false);
 });
 it.each(['pending','committed'] as const)('restores exact %s command after reload and clears it only after verified acknowledgment',async state=>{
  serverRecovery=await receipt(state);await restored();expect(label('الصورة المرتبطة بالحالة').props.value).toBe(91);expect(draft()!.content).toEqual(command().content);expect(pixel().props.disabled).toBe(true);load();render();
  const base=fetchMock.getMockImplementation()!;let acknowledge!:(r:unknown)=>void;fetchMock.mockImplementation((url:string,init:{method?:string;body?:string})=>{if(init?.method!=='POST')return base(url,init);if(!url.endsWith('/recovery'))return Promise.resolve(reply({ok:true,replayed:true,revision:{version:1}}));return new Promise(r=>{acknowledge=r;});});
  invoke(button('التحقق بإعادة نفس طلب قياسات الصورة'),'onClick');await settle();expect(draft()).toBeDefined();const posts=fetchMock.mock.calls.filter(c=>c[1]?.method==='POST');expect(JSON.parse(posts[0][1].body)).toEqual({patientId:1,clinicalCaseId:3,actorId:4,command:command()});
  const stored=serverRecovery as Awaited<ReturnType<typeof receipt>>;serverRecovery=null;acknowledge(reply({ok:true,...binding,identity:stored.identity,state:'committed',acknowledged:true}));await settle();await settle();expect(draft()).toBeUndefined();
 });
 it('retains its exact uncertain command when recovery GET returns null',async()=>{
  await start();prepareSave();fetchMock.mockRejectedValueOnce(Error('lost before server admission'));invoke(button('حفظ مراجعة قياسات الصورة'),'onClick');await settle();const original=fetchMock.mock.calls.find(c=>c[1]?.method==='POST')![1].body;
  invoke(button('التحقق من استعادة طلب القياسات'),'onClick');render();await settle();expect(label('الصورة المرتبطة بالحالة').props.disabled).toBe(true);expect(draft()).toBeDefined();load();render();fetchMock.mockRejectedValueOnce(Error('retry lost'));invoke(button('التحقق بإعادة نفس طلب قياسات الصورة'),'onClick');await settle();const posts=fetchMock.mock.calls.filter(c=>c[1]?.method==='POST');expect(posts.at(-1)![1].body).toBe(original);
 });
 it('keeps cancellation and recovery reachable when selected source read fails',async()=>{
  serverRecovery=await receipt();const base=fetchMock.getMockImplementation()!;fetchMock.mockImplementation((url:string,init:unknown)=>url.includes('documentId=91')?Promise.resolve(reply({message:'source unavailable'},404)):base(url,init));await restored();expect(render().some(n=>n.type==='img')).toBe(false);expect(button('إلغاء طلب القياسات المعلّق')).toBeDefined();expect(button('التحقق من استعادة طلب القياسات')).toBeDefined();
 });
 it('does not expose clinical content from a foreign-author blocked receipt',async()=>{
  serverRecovery={state:'blocked',identity:null,canCancel:false};await restored();expect(render().some(n=>n.type==='img')).toBe(false);expect(draft()).toBeUndefined();expect(button('إلغاء طلب القياسات المعلّق')).toBeUndefined();
 });
 it('retires content and all retained editing callbacks on recovery denial',async()=>{
  await start();const old=pixel().props.apply as (x:number,y:number)=>void;const base=fetchMock.getMockImplementation()!;fetchMock.mockImplementation((url:string,init:unknown)=>url.includes('/recovery')?Promise.resolve(reply({},403)):base(url,init));invoke(button('تحديث سجل الصور والقياسات'),'onClick');render();await settle();old(400,500);expect(draft()).toBeUndefined();expect(render().some(n=>n.type==='img')).toBe(false);expect(render().some(n=>n.props.role==='alert')).toBe(true);
 });
 it('cancels only the locally uncertain identity when another tab owns a different pending command',async()=>{
  await start();prepareSave();fetchMock.mockRejectedValueOnce(Error('uncertain A'));invoke(button('حفظ مراجعة قياسات الصورة'),'onClick');await settle();const original=JSON.parse(fetchMock.mock.calls.find(c=>c[1]?.method==='POST')![1].body).command;
  serverRecovery=await receipt();invoke(button('التحقق من استعادة طلب القياسات'),'onClick');render();await settle();expect(render().some(n=>n.type==='img')).toBe(false);fetchMock.mockResolvedValueOnce(reply({},409));invoke(button('إلغاء طلب القياسات المعلّق'),'onClick');await settle();const cancellation=JSON.parse(fetchMock.mock.calls.filter(c=>c[1]?.method==='POST').at(-1)![1].body);expect(cancellation.commandId).toBe(original.clientRequestId);expect(cancellation.commandId).not.toBe(command().clientRequestId);expect(button('التحقق من استعادة طلب القياسات')).toBeDefined();expect(render().some(n=>n.type==='img')).toBe(false);
 });
 it('does not accept a wrong-identity cancellation acknowledgment or unlock afterward',async()=>{
  serverRecovery=await receipt();await restored();const stored=serverRecovery as Awaited<ReturnType<typeof receipt>>;fetchMock.mockResolvedValueOnce(reply({ok:true,...binding,identity:stored.identity,state:'cancelled',acknowledged:false}));fetchMock.mockResolvedValueOnce(reply({ok:true,...binding,identity:{...stored.identity,commandId:'different_command_1'},state:'cancelled',acknowledged:true}));invoke(button('إلغاء طلب القياسات المعلّق'),'onClick');await settle();expect(draft()).toBeDefined();expect(label('الصورة المرتبطة بالحالة').props.disabled).toBe(true);
 });
 it('survives full component teardown with server-persisted pending state but no browser storage',async()=>{
  await start();prepareSave();const base=fetchMock.getMockImplementation()!;fetchMock.mockImplementationOnce(async(_url:string,init:{body:string})=>{const c=JSON.parse(init.body).command;serverRecovery={state:'pending',identity:{id:8,commandId:c.clientRequestId,requestFingerprint:await facialSubmissionHash(c)},expected:{...binding,previousVersion:0,command:c}};throw Error('lost server response');});invoke(button('حفظ مراجعة قياسات الصورة'),'onClick');await settle();const saved=(serverRecovery as Awaited<ReturnType<typeof receipt>>).expected.command;remount();fetchMock.mockImplementation(base);await restored();expect(draft()!.content).toEqual(saved.content);expect(draft()!.reason).toBe(saved.reason);expect(label('الصورة المرتبطة بالحالة').props.disabled).toBe(true);
 });
});

describe('metadata-first recovery availability regressions',()=>{
 it('allows own-pending metadata cancellation on hard reload without attempting forbidden image reads',async()=>{
  const stored=await receipt();serverRecovery={state:'blocked',identity:stored.identity,canCancel:true};const base=fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url:string,init:{method?:string;body?:string})=>{if(!url.includes('/recovery'))throw Error('Image-authorized endpoint must not be reached');if(init?.method==='POST'){const action=JSON.parse(init.body!).action;return Promise.resolve(reply({ok:true,...binding,identity:stored.identity,state:'cancelled',acknowledged:action==='acknowledge'}));}return base(url,init);});
  await restored();expect(render().some(n=>n.type==='img')).toBe(false);expect(draft()).toBeUndefined();invoke(button('إلغاء طلب القياسات المعلّق'),'onClick');await settle();expect(fetchMock.mock.calls.filter(c=>c[1]?.method==='POST').map(c=>JSON.parse(c[1].body).action)).toEqual(['cancel','acknowledge']);expect(fetchMock.mock.calls.every(c=>c[0].includes('/recovery'))).toBe(true);
 });
 it('quarantines normal-read denial before accepting fresh cancellable metadata',async()=>{
  const stored=await receipt();serverRecovery=stored;const base=fetchMock.getMockImplementation()!;let sourceDenied=false;
  fetchMock.mockImplementation((url:string,init:unknown)=>{if(!url.includes('/recovery')){sourceDenied=true;return Promise.resolve(reply({},403));}if(sourceDenied)return Promise.resolve(reply({ok:true,...binding,recovery:{state:'blocked',identity:stored.identity,canCancel:true}}));return base(url,init);});
  await restored();expect(sourceDenied).toBe(true);expect(draft()).toBeUndefined();expect(render().some(n=>n.type==='img')).toBe(false);expect(button('إلغاء طلب القياسات المعلّق')).toBeDefined();
 });
 it('does not render a payload-bearing metadata response after normal image-read denial',async()=>{
  serverRecovery=await receipt();const base=fetchMock.getMockImplementation()!;fetchMock.mockImplementation((url:string,init:unknown)=>!url.includes('/recovery')?Promise.resolve(reply({},403)):base(url,init));await restored();expect(draft()).toBeUndefined();expect(render().some(n=>n.type==='img')).toBe(false);expect(button('إلغاء طلب القياسات المعلّق')).toBeUndefined();expect(fetchMock.mock.calls.filter(c=>!c[0].includes('/recovery'))).toHaveLength(1);
 });
 it('requires normal image read to match authenticated bootstrap actor and clinical bridge',async()=>{
  const base=fetchMock.getMockImplementation()!;fetchMock.mockImplementation(async(url:string,init:unknown)=>{const r=await base(url,init);if(url.includes('/recovery'))return r;const data=await r.json();return reply({...data,actorId:99});});await restored();expect(draft()).toBeUndefined();expect(render().some(n=>n.type==='img')).toBe(false);expect(render().some(n=>n.props.role==='alert')).toBe(true);
 });
 it('freezes the already-verified metadata actor across later refreshes',async()=>{
  await start();const stale=pixel().props.apply as (x:number,y:number)=>void;const base=fetchMock.getMockImplementation()!;fetchMock.mockImplementation((url:string,init:unknown)=>url.includes('/recovery')?Promise.resolve(reply({ok:true,scope:binding.scope,actorId:99,recovery:null})):base(url,init));invoke(button('تحديث سجل الصور والقياسات'),'onClick');render();await settle();stale(400,500);expect(draft()).toBeUndefined();expect(render().some(n=>n.type==='img')).toBe(false);
 });
 it('requires explicit confirmation to discard an unsent draft and restore another tab committed command',async()=>{
  await start();prepareSave();const local=structuredClone(draft());const stale=pixel().props.apply as (x:number,y:number)=>void;serverRecovery=await receipt('committed');invoke(button('تحديث سجل الصور والقياسات'),'onClick');render();await settle();expect(render().some(n=>n.type==='img')).toBe(false);const restore=button('تجاهل المسودة المحلية واستعادة طلب الخادم');expect(restore).toBeDefined();
  vi.spyOn(window,'confirm').mockReturnValueOnce(false);invoke(restore,'onClick');render();expect(draft()).toEqual(local);
  vi.spyOn(window,'confirm').mockReturnValueOnce(true);invoke(button('تجاهل المسودة المحلية واستعادة طلب الخادم'),'onClick');render();await settle();await settle();expect(draft()!.content).toEqual(command().content);expect(draft()!.reason).toBe(command().reason);expect(pixel().props.disabled).toBe(true);stale(400,500);expect(draft()!.content).toEqual(command().content);expect(button('التحقق بإعادة نفس طلب قياسات الصورة')).toBeDefined();
 });
 it('never offers discard-and-restore for an already-sent uncertain local command',async()=>{
  await start();prepareSave();fetchMock.mockRejectedValueOnce(Error('uncertain A'));invoke(button('حفظ مراجعة قياسات الصورة'),'onClick');await settle();serverRecovery=await receipt('committed');invoke(button('التحقق من استعادة طلب القياسات'),'onClick');render();await settle();expect(button('تجاهل المسودة المحلية واستعادة طلب الخادم')).toBeUndefined();expect(render().some(n=>n.type==='img')).toBe(false);
 });
 it('keeps an exact local tombstone attempt reachable after GET-null plus image403 plus metadata-null',async()=>{
  await start();prepareSave();fetchMock.mockRejectedValueOnce(Error('uncertain before arrival'));invoke(button('حفظ مراجعة قياسات الصورة'),'onClick');await settle();const sent=JSON.parse(fetchMock.mock.calls.find(c=>c[1]?.method==='POST')![1].body).command;
  const base=fetchMock.getMockImplementation()!;fetchMock.mockImplementation((url:string,init:{method?:string})=>init?.method==='POST'?Promise.resolve(reply({},409)):url.includes('/recovery')?base(url,init):Promise.resolve(reply({},403)));
  invoke(button('التحقق من استعادة طلب القياسات'),'onClick');render();await settle();expect(render().some(n=>n.type==='img')).toBe(false);expect(draft()).toBeUndefined();invoke(button('إلغاء طلب القياسات المعلّق'),'onClick');await settle();const cancel=JSON.parse(fetchMock.mock.calls.filter(c=>c[1]?.method==='POST').at(-1)![1].body);expect(cancel.commandId).toBe(sent.clientRequestId);expect(cancel.action).toBe('cancel');expect(render().some(n=>n.type==='img')).toBe(false);
 });
 it('treats normal image-read401 as terminal without attempting metadata cancellation',async()=>{
  serverRecovery=await receipt();const base=fetchMock.getMockImplementation()!;fetchMock.mockImplementation((url:string,init:unknown)=>url.includes('/recovery')?base(url,init):Promise.resolve(reply({},401)));await restored();expect(draft()).toBeUndefined();expect(button('إلغاء طلب القياسات المعلّق')).toBeUndefined();expect(render().some(n=>n.type==='img')).toBe(false);expect(render().some(n=>n.props.role==='alert')).toBe(true);
 });

});


describe('separate older facial history entry',()=>{
 it('offers older history only after a selected verified truncated read',async()=>{
  const base=fetchMock.getMockImplementation()!, fixture=facialHistoryFixture();
  fetchMock.mockImplementation((url:string,init:unknown)=>url.includes('documentId=91')&&!url.includes('/recovery')?Promise.resolve(reply(fixture.data)):base(url,init));
  render();await settle();invoke(label('الصورة المرتبطة بالحالة'),'onChange',{target:{value:'91'}});render();await settle();
  expect(render().filter(n=>typeof n.type==='function'&&'data'in n.props&&'readIdentity'in n.props)).toHaveLength(1);
 });
 it('keeps the older reader binding separate while editing a new current-head draft',async()=>{
  const base=fetchMock.getMockImplementation()!, fixture=facialHistoryFixture();
  fetchMock.mockImplementation((url:string,init:unknown)=>url.includes('documentId=91')&&!url.includes('/recovery')?Promise.resolve(reply(fixture.data)):base(url,init));
  render();await settle();invoke(label('الصورة المرتبطة بالحالة'),'onChange',{target:{value:'91'}});render();await settle();load();render();
  const pane=()=>render().find(n=>typeof n.type==='function'&&'data'in n.props&&'readIdentity'in n.props)!;
  const before=pane(), beforeData=JSON.stringify(before.props.data);invoke(button('فتح مراجعة جديدة من آخر نسخة'),'onClick');render();prepareSave();
  expect(pane().props.data).toBe(before.props.data);expect(pane().props.readIdentity).toBe(before.props.readIdentity);expect(JSON.stringify(pane().props.data)).toBe(beforeData);
  expect((before.props.active as ()=>boolean)()).toBe(true);expect(draft()!.reason).toBe('Synthetic revision reason');
  expect(draft()!.expectedHeadId).toBe(165);expect(label('المراجعة المحفوظة').props.value).toBe(165);
  expect(fetchMock.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(0);
  invoke(button('تحديث سجل الصور والقياسات'),'onClick');render();expect((before.props.active as ()=>boolean)()).toBe(false);await settle();
  expect(draft()!.reason).toBe('Synthetic revision reason');expect(pane().props.readIdentity).not.toBe(before.props.readIdentity);
 });

});
