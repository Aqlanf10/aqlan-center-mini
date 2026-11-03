/** Actual component handlers with synthetic hook scheduling; not browser proof. */
import type { ReactElement, ReactNode } from 'react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { RadiologyCentersEditor } from '../components/settings/RadiologyCentersEditor';
import RadiologySettings from '../app/settings/radiology/page';
vi.mock('next/link',()=>({default:({children}:{children:ReactNode})=>children}));
import { RADIOLOGY_CENTERS_KEY as KEY } from '../lib/radiology-centers';
type HookState={values:unknown[];cursor:number;mounted:boolean;late:number;effects:Map<number,{deps?:readonly unknown[];cleanup?:()=>void}>};
const identity=vi.hoisted(()=>({session:{username:'admin-a',role:'admin'} as {username:string;role:string}|null}));
vi.mock('../components/SessionProvider',()=>({useSession:()=>identity.session,useSessionActions:()=>({session:identity.session,ready:true})}));
const rt=vi.hoisted(()=>({current:null as HookState|null,changed:false,pending:[] as Array<()=>void>}));
vi.mock('react',async original=>{
 const actual=await original<typeof import('react')>();
 const current=()=>{if(!rt.current)throw Error('Missing synthetic hook owner');return rt.current;};
 const slot=(h:HookState,initial:unknown)=>{const i=h.cursor++;if(!(i in h.values))h.values[i]=initial;return i;};
 const effect=(run:()=>void|(()=>void),deps?:readonly unknown[])=>{const h=current(),i=slot(h,undefined),old=h.effects.get(i);if(old?.deps&&deps&&old.deps.length===deps.length&&deps.every((v,j)=>Object.is(v,old.deps![j])))return;rt.pending.push(()=>{old?.cleanup?.();const cleanup=run();h.effects.set(i,{deps,cleanup:typeof cleanup==='function'?cleanup:undefined});});};
 return {...actual,useState:(initial:unknown)=>{const h=current(),i=slot(h,typeof initial==='function'?initial():initial);return [h.values[i],(value:unknown)=>{if(!h.mounted)h.late++;const next=typeof value==='function'?value(h.values[i]):value;if(!Object.is(next,h.values[i]))rt.changed=true;h.values[i]=next;}];},useRef:(initial:unknown)=>{const h=current();return h.values[slot(h,{current:initial})];},useEffect:effect,useLayoutEffect:effect};
});
type Element=ReactElement<Record<string,unknown>>;
let states:Map<string,HookState>,retired:HookState[],editable:boolean,screen:'editor'|'settings';
const center={id:'11111111-1111-4111-8111-111111111111',name:'Synthetic center',address:'Synthetic address',active:true};
const raw=JSON.stringify([center]),payload={[KEY]:raw,__versions:{[KEY]:'v2'}};
const onSaved=vi.fn();
function retire(h:HookState){h.effects.forEach(e=>e.cleanup?.());h.mounted=false;retired.push(h);}
function render(){let result:ReactNode;let rounds=0;do{if(++rounds>20)throw Error('Render loop');rt.changed=false;const visited=new Set<string>();
 const walk=(node:ReactNode,path:string):ReactNode=>{if(Array.isArray(node))return node.map((n,i)=>walk(n,`${path}/${i}`));if(!node||typeof node!=='object'||!('props'in node))return node;const e=node as Element;if(typeof e.type==='function'){const id=`${path}/${e.type.name}:${e.key??''}`;visited.add(id);let h=states.get(id);if(!h){h={values:[],cursor:0,mounted:true,late:0,effects:new Map()};states.set(id,h);}h.cursor=0;rt.current=h;const child=(e.type as (props:Record<string,unknown>)=>ReactNode)(e.props);rt.current=null;return walk(child,id);}return {...e,props:{...e.props,children:walk(e.props.children as ReactNode,`${path}/children`)}} as Element;};
 result=walk(screen==='settings'?<RadiologySettings/>:<RadiologyCentersEditor values={{[KEY]:raw}} versions={{[KEY]:'v1'}} editable={editable} onSaved={onSaved}/>,'root');
 for(const [key,h]of states)if(!visited.has(key)){retire(h);states.delete(key);}rt.pending.splice(0).forEach(fn=>fn());
 }while(rt.changed);return result;}
function nodes(n:ReactNode):Element[]{if(Array.isArray(n))return n.flatMap(nodes);if(!n||typeof n!=='object'||!('props'in n))return[];return[n as Element,...nodes((n as Element).props.children as ReactNode)];}
function text(n:ReactNode):string{if(Array.isArray(n))return n.map(text).join('');if(n&&typeof n==='object'&&'props'in n)return text((n as Element).props.children as ReactNode);return n==null||typeof n==='boolean'?'':String(n);}
function button(label:string){const b=nodes(render()).find(n=>n.type==='button'&&text(n)===label);if(!b)throw Error('Missing '+label);return b;}
const click=(b:Element)=>(b.props.onClick as ()=>void)();
const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
beforeEach(()=>{states=new Map();retired=[];editable=true;screen='editor';identity.session={username:'admin-a',role:'admin'};rt.pending=[];onSaved.mockReset();});
afterEach(()=>{states.forEach(retire);vi.unstubAllGlobals();});
it('retires admin A draft and its captured save handler on same-role admin B switch',()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);click(button('تعديل مراكز الأشعة'));const old=button('حفظ المراكز');
 identity.session={username:'admin-b',role:'admin'};const next=render();click(old);
 expect(fetch).not.toHaveBeenCalled();expect(nodes(next).some(n=>n.type==='button'&&text(n)==='حفظ المراكز')).toBe(false);expect(onSaved).not.toHaveBeenCalled();
});
it('ignores successful late save after principal retirement',async()=>{
 let finish!:(r:unknown)=>void;vi.stubGlobal('fetch',vi.fn(()=>new Promise(resolve=>{finish=resolve;})));
 click(button('تعديل مراكز الأشعة'));click(button('حفظ المراكز'));identity.session={username:'admin-b',role:'admin'};render();
 finish({ok:true,status:200,json:async()=>payload});await settle();render();expect(onSaved).not.toHaveBeenCalled();expect(retired.every(h=>h.late===0)).toBe(true);
});
it('current-owner new draft sends its actor and frozen CAS exactly once',async()=>{
 const fetch=vi.fn().mockResolvedValue({ok:true,status:200,json:async()=>payload});vi.stubGlobal('fetch',fetch);
 identity.session={username:'admin-b',role:'admin'};click(button('تعديل مراكز الأشعة'));const save=button('حفظ المراكز');click(save);click(save);await settle();
 expect(fetch).toHaveBeenCalledOnce();expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({[KEY]:raw,__versions:{[KEY]:'v1'},__expectedActor:'admin-b'});expect(onSaved).toHaveBeenCalledOnce();
});

it('retires a save whose successful JSON body completes after sign-out',async()=>{
 let finish!:(r:unknown)=>void;vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,status:200,json:()=>new Promise(resolve=>{finish=resolve;})}));
 click(button('تعديل مراكز الأشعة'));click(button('حفظ المراكز'));await settle();identity.session=null;render();finish(payload);await settle();render();
 expect(onSaved).not.toHaveBeenCalled();expect(retired.every(h=>h.late===0)).toBe(true);
});
it('old settings GET cannot populate the next same-role principal page',async()=>{
 screen='settings';let finish!:(r:unknown)=>void;
 const next={[KEY]:JSON.stringify([{...center,name:'Synthetic B center'}]),__versions:{[KEY]:'v3'}};
 const fetch=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue({ok:true,status:200,json:async()=>next});vi.stubGlobal('fetch',fetch);
 render();identity.session={username:'admin-b',role:'admin'};render();await settle();render();
 finish({ok:true,status:200,json:async()=>payload});await settle();const tree=render();
 expect(text(tree)).toContain('Synthetic B center');expect(text(tree)).not.toContain('Synthetic center');expect(retired.every(h=>h.late===0)).toBe(true);
});

it('retired add/cancel draft handlers cannot update an old owner',()=>{
 vi.stubGlobal('fetch',vi.fn());click(button('تعديل مراكز الأشعة'));const add=button('إضافة مركز أشعة'),cancel=button('إلغاء التعديلات');identity.session={username:'admin-b',role:'admin'};render();click(add);click(cancel);
 expect(retired.every(h=>h.late===0)).toBe(true);expect(onSaved).not.toHaveBeenCalled();
});

it('captured change/open handlers cannot alter the submitted draft while save is pending',async()=>{
 let finish!:(r:unknown)=>void;const fetch=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',fetch);
 const open=button('تعديل مراكز الأشعة');click(open);
 const input=nodes(render()).find(n=>n.type==='input'&&n.props.value===center.name)!;
 const change=input.props.onChange as (event:{target:{value:string}})=>void;
 change({target:{value:'Synthetic frozen draft'}});click(button('حفظ المراكز'));
 change({target:{value:'Late discarded edit'}});click(open);
 expect(nodes(render()).some(n=>n.props.value==='Synthetic frozen draft')).toBe(true);
 expect(nodes(render()).some(n=>n.props.value==='Late discarded edit')).toBe(false);
 expect(JSON.parse(JSON.parse((fetch.mock.calls[0] as unknown as [string,{body:string}])[1].body)[KEY])[0].name).toBe('Synthetic frozen draft');
 finish({ok:true,status:200,json:async()=>({...payload,[KEY]:JSON.stringify([{...center,name:'Synthetic frozen draft'}])})});await settle();expect(onSaved).toHaveBeenCalledOnce();
});
