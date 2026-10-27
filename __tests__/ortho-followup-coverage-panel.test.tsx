import type { ReactElement,ReactNode } from "react";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { OrthoFollowupCoveragePanel } from "../components/OrthoFollowupCoveragePanel";
const state=vi.hoisted(()=>({session:{username:"synthetic-admin",role:"admin",permissions:{}} as {username:string;role:string;permissions:object}|null}));
vi.mock("../components/SessionProvider",()=>({useSession:()=>state.session}));
const persistence=vi.hoisted(()=>({rows:new Map<string,import("../lib/financial-command-journal").FinancialJournal>(),fail:false,acknowledged:0}));
vi.mock("../lib/financial-command-journal",()=>({
  readFinancialJournalsForActor:vi.fn(async(actor:string)=>{if(persistence.fail)throw new Error('Synthetic unavailable journal');return [...persistence.rows.entries()].flatMap(([key,journal])=>{const scope=JSON.parse(key);return scope.actor===actor?[{scope,journal}]:[];});}),
  readFinancialJournal:vi.fn(async(scope:{actor:string;patientId:number})=>{if(persistence.fail)throw new Error('Synthetic unavailable journal');return persistence.rows.get(JSON.stringify(scope))??{revision:0,command:null};}),
  reserveFinancialCommand:vi.fn(async(scope:{actor:string;patientId:number},revision:number,command:import("../lib/financial-command-journal").FinancialCommand)=>{
    if(persistence.fail)throw new Error('Synthetic unavailable journal');const key=JSON.stringify(scope),row=persistence.rows.get(key)??{revision:0,command:null};
    if(row.command)return row;if(row.revision!==revision)throw new Error('Synthetic stale revision');const next={revision,command};persistence.rows.set(key,next);return next;
  }),
  acknowledgeFinancialCommand:vi.fn(async(scope:{actor:string;patientId:number},command:import("../lib/financial-command-journal").FinancialCommand)=>{
    const key=JSON.stringify(scope),row=persistence.rows.get(key);if(!row||row.command?.original!==command.original)throw new Error('Synthetic mismatch');
    persistence.acknowledged++;const next={revision:row.revision+1,command:null};persistence.rows.set(key,next);return next;
  }),
}));
const hooks=vi.hoisted(()=>({values:[] as unknown[],cursor:0,key:"",effects:new Map<number,{deps:readonly unknown[];cleanup?:()=>void}>(),pending:[] as (()=>void)[],memo:new Map<number,{deps:readonly unknown[];value:unknown}>()}));
vi.mock("react",async original=>{
  const react=await original<typeof import("react")>();
  const same=(a:readonly unknown[],b:readonly unknown[])=>a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
  const memo=(value:unknown,deps:readonly unknown[])=>{const i=hooks.cursor++,old=hooks.memo.get(i);if(old&&same(old.deps,deps))return old.value;hooks.memo.set(i,{deps,value});return value;};
  return {...react,useState:(initial:unknown)=>{const i=hooks.cursor++,values=hooks.values;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;return [values[i],(v:unknown)=>{values[i]=typeof v==='function'?v(values[i]):v;}];},
    useRef:(initial:unknown)=>{const i=hooks.cursor++;if(!(i in hooks.values))hooks.values[i]={current:initial};return hooks.values[i];},
    useCallback:(fn:unknown,deps:readonly unknown[])=>memo(fn,deps),
    useEffect:(fn:()=>void|(()=>void),deps:readonly unknown[])=>{const i=hooks.cursor++,old=hooks.effects.get(i);if(old&&same(old.deps,deps))return;old?.cleanup?.();const record={deps,cleanup:undefined as (()=>void)|undefined};hooks.effects.set(i,record);hooks.pending.push(()=>{record.cleanup=fn()||undefined;});}};
});
type Node=ReactElement<Record<string,unknown>>;
const nodes=(node:ReactNode):Node[]=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'&&'props'in node?[node as Node,...nodes((node as Node).props.children as ReactNode)]:[];
function clear(){for(const e of hooks.effects.values())e.cleanup?.();hooks.values=[];hooks.cursor=0;hooks.effects.clear();hooks.pending=[];hooks.memo.clear();}
let props={patientId:101,orthoCaseId:201,onSaved:vi.fn()};
function render(){
  const outer=OrthoFollowupCoveragePanel(props);if(!outer){clear();return null;}
  if(hooks.key!==outer.key){clear();hooks.key=String(outer.key);}
  hooks.cursor=0;const result=(outer.type as (p:typeof props)=>ReactNode)(outer.props);hooks.pending.splice(0).forEach(fn=>fn());return result;
}
async function settle(){for(let i=0;i<15;i++)await Promise.resolve();render();for(let i=0;i<15;i++)await Promise.resolve();return render();}
const find=(test:(node:Node)=>boolean)=>{const found=nodes(render()).find(test);if(!found)throw new Error('Missing UI control');return found;};
const button=(text:string)=>find(n=>n.type==='button'&&String(n.props.children).includes(text));
const click=(node:Node)=>(node.props.onClick as ()=>void)();
const change=(label:string,value:string|boolean)=>{const n=find(x=>x.props['aria-label']===label);(n.props.onChange as (e:{target:{value?:string;checked?:boolean}})=>void)({target:typeof value==='boolean'?{checked:value}:{value}});};
const read=()=>({patientId:props.patientId,orthoCaseId:props.orthoCaseId,enabled:true,canEdit:true,current:null,applicable:false,sources:[{patientId:props.patientId,orthoCaseId:props.orthoCaseId,clinicalCaseId:301,planId:401,planItemId:501,invoiceId:601,fingerprint:'a'.repeat(64),invoiceNumber:'SYNTH-601',serviceName:'Synthetic ortho'}]});
const receipt=(command:Record<string,unknown>)=>({id:'1',version:1,supersedesRevisionId:command.expectedRevisionId,source:command.source,sourceFingerprint:command.expectedSourceFingerprint,decision:command.decision,reason:command.reason,createdAt:'2026-10-26T00:00:00Z',createdBy:'synthetic-admin',commandId:command.commandId});
const stored=()=>persistence.rows.get(JSON.stringify({actor:'synthetic-admin',patientId:101}))?.command;
const fetchMock=vi.fn(),json=(v:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}}));
async function open(){click(button('نطاق المتابعات'));await settle();}
function fill(){change('مصدر تغطية المتابعات','601:501');render();change('قرار نطاق المتابعات','included');render();change('سبب اعتماد نطاق المتابعات','Synthetic explicit agreement');render();const box=find(n=>n.type==='input'&&n.props.type==='checkbox');(box.props.onChange as (e:{target:{checked:boolean}})=>void)({target:{checked:true}});render();}
beforeEach(()=>{clear();hooks.key='';persistence.rows.clear();persistence.fail=false;persistence.acknowledged=0;props={patientId:101,orthoCaseId:201,onSaved:vi.fn()};state.session={username:'synthetic-admin',role:'admin',permissions:{}};fetchMock.mockReset().mockImplementation(()=>json(read()));vi.stubGlobal('fetch',fetchMock);vi.stubGlobal('window',new EventTarget());});
afterEach(()=>{clear();vi.useRealTimers();vi.unstubAllGlobals();});
describe('explicit routine-followup coverage editor',()=>{
  it('does not offer the administrator action to a physician/reception and never auto-selects coverage',async()=>{
    state.session={username:'synthetic-doctor',role:'doctor',permissions:{}};expect(render()).toBeNull();expect(fetchMock).not.toHaveBeenCalled();
    state.session={username:'synthetic-admin',role:'admin',permissions:{}};await open();
    expect(button('اعتماد نطاق').props.disabled).toBe(true);expect(fetchMock.mock.calls.every(([,init])=>!init.method)).toBe(true);
  });
  it('retries an uncertain response with the identical command and source fence, not a new waiver or invoice',async()=>{
    await open();fill();let attempts=0;
    fetchMock.mockImplementation((_url:string,init:RequestInit)=>{if(init.method==='POST'){attempts++;if(attempts===1)return Promise.reject(new Error('Synthetic network failure'));const command=JSON.parse(String(init.body));return json({ok:true,replayed:true,revision:receipt(command)});}return json(read());});
    click(button('اعتماد نطاق'));await settle();expect(props.onSaved).not.toHaveBeenCalled();
    click(button('إعادة الطلب المحفوظ نفسه'));await settle();
    const writes=fetchMock.mock.calls.filter(([,init])=>init.method==='POST');expect(writes).toHaveLength(2);expect(writes[1][1].body).toBe(writes[0][1].body);
    expect(JSON.parse(writes[0][1].body)).toMatchObject({scope:'routine_adjustments',decision:'included',expectedRevisionId:null,expectedSourceFingerprint:'a'.repeat(64),source:{patientId:101,orthoCaseId:201,planItemId:501,invoiceId:601}});
    expect(props.onSaved).toHaveBeenCalledTimes(1);expect(fetchMock.mock.calls.every(([url])=>String(url).startsWith('/api/ortho/'))).toBe(true);
  });
  it('an old patient response cannot update or save into the new patient view',async()=>{
    await open();fill();let finish!:(v:Response)=>void;
    fetchMock.mockImplementation((_url:string,init:RequestInit)=>init.method==='POST'?new Promise(resolve=>{finish=resolve;}):json(read()));
    click(button('اعتماد نطاق'));await settle();const oldSaved=props.onSaved;const body=JSON.parse(fetchMock.mock.calls.find(([,init])=>init.method==='POST')![1].body);
    props={patientId:102,orthoCaseId:202,onSaved:vi.fn()};render();finish(new Response(JSON.stringify({ok:true,revision:receipt(body)})));await settle();
    expect(oldSaved).not.toHaveBeenCalled();expect(props.onSaved).not.toHaveBeenCalled();expect(nodes(render()).some(n=>String(n.props.children).includes('سُجل نطاق'))).toBe(false);
  });
  it('a generic stale-source refusal keeps the exact persisted request pending',async()=>{
    await open();fill();fetchMock.mockImplementation((_url:string,init:RequestInit)=>init.method==='POST'?json({message:'Synthetic stale source',code:'source_changed'},409):json(read()));
    click(button('اعتماد نطاق'));await settle();expect(props.onSaved).not.toHaveBeenCalled();expect(button('اعتماد نطاق').props.disabled).toBe(true);
    expect(fetchMock.mock.calls.filter(([,init])=>init.method==='POST')).toHaveLength(1);expect(stored()).not.toBeNull();expect(persistence.acknowledged).toBe(0);expect(button('تحقق من نتيجة الطلب نفسه')).toBeTruthy();
  });
  it('restores the same body after remount and verifies committed status with PUT before retirement',async()=>{
    await open();fill();fetchMock.mockImplementation((_url:string,init:RequestInit)=>init.method==='POST'?Promise.reject(new Error('Lost response')):json(read()));
    click(button('اعتماد نطاق'));await settle();const original=stored()!;expect(original).toBeTruthy();
    clear();hooks.key='';await settle();expect(button('تحقق من نتيجة الطلب نفسه')).toBeTruthy();
    fetchMock.mockImplementation((_url:string,init:RequestInit)=>init.method==='PUT'?json({state:'committed',revision:receipt(JSON.parse(String(init.body)))}):json(read()));
    click(button('تحقق من نتيجة الطلب نفسه'));await settle();
    const status=fetchMock.mock.calls.find(([,init])=>init.method==='PUT')!;
    expect(status[1].body).toBe(JSON.stringify(JSON.parse(original.original).command));expect(status[1].redirect).toBe('manual');
    expect(stored()).toBeNull();expect(persistence.acknowledged).toBe(1);expect(props.onSaved).toHaveBeenCalledTimes(1);
  });
  it.each([401,403,409,500])('never retires a generic HTTP %s response, even when it contains a rejection-shaped body',async(status)=>{
    await open();fill();fetchMock.mockImplementation((_url:string,init:RequestInit)=>init.method?json({state:'rejected',rejection:{terminal:true}},status):json(read()));
    click(button('اعتماد نطاق'));await settle();const before=stored();
    click(button('تحقق من نتيجة الطلب نفسه'));await settle();expect(stored()).toEqual(before);expect(persistence.acknowledged).toBe(0);
  });
  it('requires exact PUT terminal proof; a POST rejection and unresolved status cannot clear the journal',async()=>{
    await open();fill();let body:Record<string,unknown>={};
    fetchMock.mockImplementation((_url:string,init:RequestInit)=>{if(init.method==='POST'){body=JSON.parse(String(init.body));return json({message:'source changed'},409);}if(init.method==='PUT')return json({state:'unresolved'});return json(read());});
    click(button('اعتماد نطاق'));await settle();click(button('تحقق من نتيجة الطلب نفسه'));await settle();expect(persistence.acknowledged).toBe(0);
    fetchMock.mockImplementation((_url:string,init:RequestInit)=>init.method==='PUT'?json({state:'rejected',rejection:{commandId:body.commandId,patientId:101,orthoCaseId:201,actor:'synthetic-admin',terminal:true,command:body,code:'source_changed',message:'Synthetic refusal',rejectedAt:'2026-10-26T00:00:00Z'}}):json(read()));
    click(button('تحقق من نتيجة الطلب نفسه'));await settle();expect(stored()).toBeNull();expect(persistence.acknowledged).toBe(1);expect(props.onSaved).not.toHaveBeenCalled();
  });
  it('blocks a competing money workflow and an unavailable journal before the first POST',async()=>{
    persistence.rows.set(JSON.stringify({actor:'synthetic-admin',patientId:101}),{revision:0,command:{kind:'collection',key:'synthetic-other-command',original:'{}',payload:'{}'}});
    await open();fill();expect(button('اعتماد نطاق').props.disabled).toBe(true);click(button('اعتماد نطاق'));await settle();expect(fetchMock.mock.calls.some(([,init])=>init.method==='POST')).toBe(false);
    clear();hooks.key='';persistence.rows.clear();persistence.fail=true;await open();fill();click(button('اعتماد نطاق'));await settle();expect(fetchMock.mock.calls.some(([,init])=>init.method==='POST')).toBe(false);
  });
  it('keeps a same-key receipt with altered source or author unresolved',async()=>{
    await open();fill();fetchMock.mockImplementation((_url:string,init:RequestInit)=>{if(init.method==='POST'){const body=JSON.parse(String(init.body));return json({ok:true,revision:{...receipt(body),createdBy:'another-admin'}});}return json(read());});
    click(button('اعتماد نطاق'));await settle();expect(stored()).toBeTruthy();expect(props.onSaved).not.toHaveBeenCalled();expect(persistence.acknowledged).toBe(0);
  });

  it('an aborted older same-owner read cannot erase a newer verified source',async()=>{
    let failOld!:(error:Error)=>void,reads=0;
    fetchMock.mockImplementation(()=>{reads++;return reads===1?new Promise((_resolve,reject)=>{failOld=reject;}):json(read());});
    await open();click(button('إعادة تحميل المصدر والسجل'));await settle();
    expect(find(n=>n.props['aria-label']==='مصدر تغطية المتابعات')).toBeTruthy();
    failOld(new Error('Older request aborted'));await settle();
    expect(find(n=>n.props['aria-label']==='مصدر تغطية المتابعات')).toBeTruthy();
  });

  it('reserves exact original before POST and retains it on timeout',async()=>{
    vi.useFakeTimers();await open();fill();
    fetchMock.mockImplementation((_url:string,init:RequestInit)=>{
      if(init.method!=='POST')return json(read());
      expect(JSON.parse(stored()!.original).command).toEqual(JSON.parse(String(init.body)));
      expect(init.redirect).toBe('manual');
      return new Promise((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(new Error('Synthetic timeout'))));
    });
    click(button('اعتماد نطاق'));await settle();const before=stored();
    await vi.advanceTimersByTimeAsync(20001);await settle();
    expect(stored()).toEqual(before);expect(persistence.acknowledged).toBe(0);expect(button('تحقق من نتيجة الطلب نفسه').props.disabled).toBe(false);
  });
  it('does not accept a redirected matching receipt',async()=>{
    await open();fill();fetchMock.mockImplementation(async(_url:string,init:RequestInit)=>{
      if(init.method!=='POST')return json(read());const response=await json({ok:true,revision:receipt(JSON.parse(String(init.body)))});
      Object.defineProperty(response,'redirected',{value:true});return response;
    });
    click(button('اعتماد نطاق'));await settle();expect(stored()).toBeTruthy();expect(persistence.acknowledged).toBe(0);
  });

  it('discovers the same case after patient merge and reconciles only the unchanged original journal scope',async()=>{
    await open();fill();fetchMock.mockImplementation((_url:string,init:RequestInit)=>init.method==='POST'?Promise.reject(new Error('Lost acknowledgment')):json(read()));
    click(button('اعتماد نطاق'));await settle();const original=stored()!,originalBody=JSON.stringify(JSON.parse(original.original).command);
    const competing={kind:'collection' as const,key:'synthetic-merged-collection',original:'{}',payload:'{}'};
    persistence.rows.set(JSON.stringify({actor:'synthetic-admin',patientId:102}),{revision:0,command:competing});
    props={patientId:102,orthoCaseId:201,onSaved:vi.fn()};await settle();
    expect(button('تحقق من نتيجة الطلب نفسه').props.disabled).toBe(false);
    expect(button('إعادة الطلب المحفوظ نفسه').props.disabled).toBe(true);
    fetchMock.mockImplementation((_url:string,init:RequestInit)=>init.method==='PUT'?json({state:'committed',revision:receipt(JSON.parse(String(init.body)))}):json(read()));
    click(button('تحقق من نتيجة الطلب نفسه'));await settle();
    const status=fetchMock.mock.calls.find(([,init])=>init.method==='PUT')!;
    expect(status[0]).toBe('/api/ortho/201/followup-coverage?patientId=101');expect(status[1].body).toBe(originalBody);
    expect(stored()).toBeNull();expect(persistence.rows.get(JSON.stringify({actor:'synthetic-admin',patientId:102}))?.command).toEqual(competing);
    expect(props.onSaved).toHaveBeenCalledTimes(1);
  });
  it.each(['actor','case'])('does not adopt a historical pending request with a different %s',async(difference)=>{
    await open();fill();fetchMock.mockImplementation((_url:string,init:RequestInit)=>init.method==='POST'?Promise.reject(new Error('Lost acknowledgment')):json(read()));
    click(button('اعتماد نطاق'));await settle();
    props={patientId:102,orthoCaseId:difference==='case'?202:201,onSaved:vi.fn()};
    if(difference==='actor')state.session={username:'another-admin',role:'admin',permissions:{}};
    await settle();expect(nodes(render()).some(n=>n.type==='button'&&String(n.props.children).includes('تحقق من نتيجة الطلب نفسه'))).toBe(false);
    expect(stored()).toBeTruthy();expect(persistence.acknowledged).toBe(0);
  });
  it('requires explicit selection among multiple original scopes and never drops the unselected request',async()=>{
    await open();fill();fetchMock.mockImplementation((_url:string,init:RequestInit)=>init.method==='POST'?Promise.reject(new Error('Lost acknowledgment')):json(read()));
    click(button('اعتماد نطاق'));await settle();const first=stored()!,second=JSON.parse(first.original);
    second.patientId=102;second.command.source.patientId=102;second.command.commandId='22345678-1234-4123-8123-123456789012';
    const serialized=JSON.stringify(second),secondCommand={...first,key:second.command.commandId,original:serialized,payload:serialized};
    persistence.rows.set(JSON.stringify({actor:'synthetic-admin',patientId:102}),{revision:0,command:secondCommand});
    props={patientId:103,orthoCaseId:201,onSaved:vi.fn()};await settle();await settle();
    expect(nodes(render()).some(n=>n.type==='button'&&String(n.props.children).includes('تحقق من نتيجة الطلب نفسه'))).toBe(false);
    const choices=nodes(render()).filter(n=>n.type==='button'&&String(n.props.children).includes('تحقق من طلب الملف الأصلي'));
    expect(choices).toHaveLength(2);expect(button('اعتماد نطاق').props.disabled).toBe(true);
    click(choices[0]);await settle();
    fetchMock.mockImplementation((_url:string,init:RequestInit)=>init.method==='PUT'?json({state:'committed',revision:receipt(JSON.parse(String(init.body)))}):json(read()));
    click(button('تحقق من نتيجة الطلب نفسه'));await settle();expect(stored()).toBeNull();
    expect(persistence.rows.get(JSON.stringify({actor:'synthetic-admin',patientId:102}))?.command).toEqual(secondCommand);
  });

});
