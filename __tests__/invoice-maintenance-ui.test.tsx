import type {ReactElement,ReactNode} from "react";
import {beforeEach,afterEach,describe,expect,it,vi} from "vitest";
import {InvoiceAddService} from "../components/InvoiceAddService";
import {InvoiceArchive} from "../components/InvoiceArchive";
import {durableInvoiceMaintenance,restoreInvoiceMaintenance} from "../lib/invoice-maintenance-view";
import type {InvoiceMaintenanceProps} from "../components/useInvoiceMaintenance";

// Execute real editor/hook callbacks; HTTP, session and storage are synthetic.
// This is not browser/IndexedDB evidence.
const harness=vi.hoisted(()=>({values:[] as unknown[],cursor:0,changed:false,
  memos:new Map<number,{deps?:readonly unknown[];value:unknown}>(),
  effects:new Map<number,{deps?:readonly unknown[];cleanup?:()=>void}>(),pending:[] as (()=>void)[],
  session:{username:"synthetic-admin",role:"admin"} as {username:string;role:string}}));
vi.mock("../components/SessionProvider",()=>({useSession:()=>harness.session}));
vi.mock("react",async original=>{
  const react=await original<typeof import("react")>();
  const same=(a?:readonly unknown[],b?:readonly unknown[])=>!!a&&!!b&&a.length===b.length&&a.every((entry,index)=>Object.is(entry,b[index]));
  const slot=(initial:unknown)=>{const index=harness.cursor++;if(!(index in harness.values))harness.values[index]=initial;return index;};
  const memo=(factory:()=>unknown,deps?:readonly unknown[])=>{const index=slot(undefined),prior=harness.memos.get(index);if(prior&&same(prior.deps,deps))return prior.value;const value=factory();harness.memos.set(index,{deps,value});return value;};
  const effect=(run:()=>void|(()=>void),deps?:readonly unknown[])=>{const index=slot(undefined),prior=harness.effects.get(index);if(prior&&same(prior.deps,deps))return;harness.pending.push(()=>{prior?.cleanup?.();const cleanup=run();harness.effects.set(index,{deps,cleanup:typeof cleanup==="function"?cleanup:undefined});});};
  return {...react,useState:(initial:unknown)=>{const index=slot(typeof initial==="function"?initial():initial);return [harness.values[index],(update:unknown)=>{const next=typeof update==="function"?update(harness.values[index]):update;if(!Object.is(next,harness.values[index]))harness.changed=true;harness.values[index]=next;}];},
    useRef:(initial:unknown)=>harness.values[slot({current:initial})],useMemo:memo,useCallback:(callback:unknown,deps?:readonly unknown[])=>memo(()=>callback,deps),useEffect:effect,useLayoutEffect:effect};
});
type Element=ReactElement<Record<string,unknown>>;
const elements=(node:ReactNode):Element[]=>Array.isArray(node)?node.flatMap(elements):node&&typeof node==="object"&&"props" in node?[node as Element,...elements((node as Element).props.children as ReactNode)]:[];
const text=(node:ReactNode):string=>typeof node==="string"||typeof node==="number"?String(node):Array.isArray(node)?node.map(text).join(""):node&&typeof node==="object"&&"props" in node?text((node as Element).props.children as ReactNode):"";
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
const hash="a".repeat(64),requestHash="b".repeat(64);
const context={original:{id:10,patientId:9,invoiceNumber:"INV-SYN-10",createdAt:"2026-10-25T10:00:00Z",currency:"YER",netMinor:500,settledMinor:180,remainingMinor:320},sourceHash:hash,
  services:[{id:5,name:"Synthetic additional filling",category:"filling",priceMinor:150,priceConfigured:true,isActive:true,priceSarMinor:null,priceUsdMinor:null}],
  doctors:[{id:6,name:"Synthetic doctor"}],planChoices:[{id:7,compatible:true}],sourceVisitIds:[12]};
const clinical=[{kind:"clinical",item:{mode:"new",id:null},case:{mode:"none",id:null,title:null,options:[]},refusal:null,effectiveDoctorId:6,effectiveDoctorName:"Synthetic doctor",effectivePlanId:7}];
let props:InvoiceMaintenanceProps;
let editor:"add"|"archive";
const fetchMock=vi.fn();
let post:(body:Record<string,unknown>)=>Promise<Response>;
let archiveView:Record<string,unknown>;
const writes=()=>fetchMock.mock.calls.filter(([,options])=>options?.method==="POST");
const reads=()=>fetchMock.mock.calls.filter(([,options])=>!options?.method);
function resetHooks(){harness.effects.forEach(effect=>effect.cleanup?.());harness.values=[];harness.cursor=0;harness.changed=false;harness.memos.clear();harness.effects.clear();harness.pending=[];}
function render():ReactNode {
  for(let round=0;round<25;round++){
    harness.cursor=0;harness.changed=false;const tree=editor==="add"?InvoiceAddService(props):InvoiceArchive(props);
    harness.pending.splice(0).forEach(effect=>effect());if(!harness.changed)return tree;
  }
  throw new Error("Editor did not settle");
}
async function flush(){for(let i=0;i<5;i++){for(let j=0;j<20;j++)await Promise.resolve();render();}}
const field=(label:string)=>{const node=elements(render()).find(node=>node.props["aria-label"]===label);expect(node,label).toBeDefined();return node!;};
const button=(label:string)=>{const node=elements(render()).find(node=>node.type==="button"&&text(node)===label);expect(node,label).toBeDefined();return node!;};
const change=(label:string,value:string)=>(field(label).props.onChange as (event:{target:{value:string}})=>void)({target:{value}});
const click=(node:Element)=>(node.props.onClick as ()=>void)();
async function preview(){render();await flush();change("الخدمة الإضافية","5");change("طبيب الخدمة الإضافية","6");change("سن الخدمة الإضافية","16");change("أسطح الخدمة الإضافية","MO");change("سبب إضافة الخدمة","Synthetic extra service");click(button("معاينة أثر الإضافة"));await flush();}
function successful(body:Record<string,unknown>){return response({originalInvoiceId:10,additionalInvoiceId:11,additionalInvoiceNumber:"INV-SYN-11",additionalCreatedAt:"2026-10-26T10:00:00Z",patientId:9,currency:"YER",addedNetMinor:150,
  sourceVisitIds:[12],idempotencyKey:body.idempotencyKey,requestHash,createdBy:"synthetic-admin",cashMovementMinor:0,clinical:{planId:7,links:[{line:0,kind:"clinical",planItemId:8,caseId:null}]},replayed:false});}
beforeEach(()=>{
  resetHooks();editor="add";harness.session={username:"synthetic-admin",role:"admin"};fetchMock.mockReset();vi.stubGlobal("fetch",fetchMock);
  props={patientId:9,invoiceId:10,recovery:null,onRecoveryChange:command=>{props.recovery=command;},onChanged:vi.fn(),onCancel:vi.fn(),
    financialRecovery:{ready:true,revision:0,error:null,reserve:vi.fn(async()=>true),acknowledge:vi.fn(async()=>undefined)}};
  archiveView={invoiceId:10,patientId:9,invoiceNumber:"INV-SYN-10",currency:"YER",status:"paid",version:0,archived:false,latest:null,readiness:"ready",eligibility:{canArchive:true,code:null,message:null,remainingMinor:0}};
  post=async body=>successful(body);
  fetchMock.mockImplementation(async(url:string,options?:RequestInit)=>{
    if(options?.method==="POST")return post(JSON.parse(String(options.body)));
    if(options?.method==="PUT"){const body=JSON.parse(String(options.body));const net=Number(body.price)-Number(body.discount);return response({original:context.original,sourceHash:hash,requestHash,currency:"YER",addedNetMinor:net,accountDueBeforeMinor:320,accountDueAfterMinor:320+net,sourceVisitIds:[12],clinical,status:"planned"});}
    return response(url.endsWith("/archive")?archiveView:context);
  });
});
afterEach(()=>{resetHooks();vi.unstubAllGlobals();});
describe("real additional-service UI callbacks",()=>{
  it("previews service/provider/tooth/surfaces/price/currency before issuing a separate dated invoice",async()=>{
    await preview();const tree=render();expect(text(tree)).toContain("Synthetic additional filling");expect(text(tree)).toContain("MO");expect(text(tree)).toContain("مخططة");
    click(button("تأكيد إصدار الفاتورة الإضافية"));await flush();
    expect(props.financialRecovery.reserve).toHaveBeenCalledTimes(1);expect(writes()).toHaveLength(1);expect(props.financialRecovery.acknowledge).toHaveBeenCalledTimes(1);
    expect(text(render())).toContain("INV-SYN-11");expect(text(render())).toContain("2026-10-26T10:00:00Z");
    expect(elements(render()).filter(node=>node.type==="a").map(node=>node.props.href)).toEqual(expect.arrayContaining(["/print/invoice/10","/print/invoice/11"]));
  });
  it("invalidates the preview whenever any submitted detail changes",async()=>{
    await preview();change("سعر الخدمة الإضافية","170");
    expect(elements(render()).some(node=>node.type==="button"&&text(node)==="تأكيد إصدار الفاتورة الإضافية")).toBe(false);expect(writes()).toHaveLength(0);
  });
  it("shows the server's inherited doctor and plan rather than claiming no assignment",async()=>{
    await preview();change("طبيب الخدمة الإضافية","");
    fetchMock.mockImplementationOnce(async()=>response({original:context.original,sourceHash:hash,requestHash,currency:"YER",addedNetMinor:150,accountDueBeforeMinor:320,accountDueAfterMinor:470,sourceVisitIds:[12],status:"planned",
      clinical:[{...clinical[0],effectiveDoctorId:8,effectiveDoctorName:"Synthetic inherited doctor",effectivePlanId:17,item:{mode:"existing",id:18}}]}));
    click(button("معاينة أثر الإضافة"));await flush();
    const previewNode=elements(render()).find(node=>node.props["data-testid"]==="invoice-add-service-preview")!;
    expect(text(previewNode)).toContain("Synthetic inherited doctor");expect(text(previewNode)).toContain("الخطة: #17");
  });
  it("waits for durable reservation and blocks a synchronous double click",async()=>{
    await preview();let reserve!:(value:boolean)=>void;
    props.financialRecovery.reserve=vi.fn(()=>new Promise<boolean>(resolve=>{reserve=resolve;}));
    const save=button("تأكيد إصدار الفاتورة الإضافية");click(save);click(save);await flush();expect(writes()).toHaveLength(0);
    reserve(true);await flush();expect(writes()).toHaveLength(1);
  });
  it("retains exact body/key after lost reply and restores them without a new preview",async()=>{
    await preview();post=async()=>{throw new Error("Synthetic lost response after commit");};click(button("تأكيد إصدار الفاتورة الإضافية"));await flush();
    const saved=durableInvoiceMaintenance(props.recovery!);expect(props.recovery?.outcome).toBe("uncertain");expect(props.financialRecovery.acknowledge).not.toHaveBeenCalled();
    resetHooks();props.recovery=restoreInvoiceMaintenance(saved,9,"synthetic-admin");post=async body=>successful(body);const readsBefore=reads().length;
    render();await flush();expect(reads()).toHaveLength(readsBefore);
    // Recovery is a child component; call its real rendered retry callback.
    const recovery=elements(render()).find(node=>typeof node.type==="function"&&node.type.name==="InvoiceMaintenanceRecovery")!;
    (recovery.props.onRetry as ()=>void)();await flush();
    expect(writes()).toHaveLength(2);expect(writes()[1][1].body).toBe(writes()[0][1].body);expect(props.recovery).toBeNull();
  });
  it("keeps the command on ordinary conflict or role change",async()=>{
    await preview();post=async()=>response({message:"Synthetic ordinary conflict",code:"conflict"},409);click(button("تأكيد إصدار الفاتورة الإضافية"));await flush();
    expect(props.recovery).not.toBeNull();expect(props.financialRecovery.acknowledge).not.toHaveBeenCalled();
    harness.session={username:"different-admin",role:"admin"};render();const recovery=elements(render()).find(node=>typeof node.type==="function"&&node.type.name==="InvoiceMaintenanceRecovery")!;
    (recovery.props.onRetry as ()=>void)();await flush();expect(writes()).toHaveLength(1);
  });
  it("does not acknowledge a successful-looking response for a different amount",async()=>{
    await preview();post=async body=>{const value=await successful(body).json() as Record<string,unknown>;return response({...value,addedNetMinor:999});};
    click(button("تأكيد إصدار الفاتورة الإضافية"));await flush();
    expect(props.recovery?.outcome).toBe("uncertain");expect(props.financialRecovery.acknowledge).not.toHaveBeenCalled();
  });
  it("retires only matching durable stale proof and requires a fresh preview",async()=>{
    await preview();post=async body=>response({code:"stale",terminal:true,idempotencyKey:body.idempotencyKey,requestHash,message:"Synthetic durable stale rejection"},409);
    click(button("تأكيد إصدار الفاتورة الإضافية"));await flush();expect(props.recovery).toBeNull();expect(props.financialRecovery.acknowledge).toHaveBeenCalledTimes(1);
    expect(elements(render()).some(node=>node.type==="button"&&text(node)==="تأكيد إصدار الفاتورة الإضافية")).toBe(false);
  });
});
describe("archive eligibility UI",()=>{
  it("does not present a missing archive migration as a known unarchived state",async()=>{
    editor="archive";archiveView={...archiveView,readiness:"migration_pending",eligibility:{canArchive:false,code:"migration_pending",message:"Synthetic migration pending",remainingMinor:null}};
    render();await flush();expect(text(render())).toContain("حالة الأرشفة غير متاحة");expect(text(render())).not.toContain("ضمن السجل الجاري");expect(button("تأكيد الأرشفة").props.disabled).toBe(true);
  });
  it("shows unpaid policy refusal and never sends an archive request",async()=>{
    editor="archive";archiveView={...archiveView,status:"open",eligibility:{canArchive:false,code:"policy_decision_required",message:"Synthetic unpaid policy decision required",remainingMinor:320}};
    render();await flush();expect(text(render())).toContain("Synthetic unpaid policy decision required");expect(button("تأكيد الأرشفة").props.disabled).toBe(true);expect(writes()).toHaveLength(0);
  });
  it("permits restore after a later debt while refusing a locked period",async()=>{
    editor="archive";archiveView={...archiveView,archived:true,version:2,eligibility:{canArchive:false,code:"policy_decision_required",message:"Synthetic later debt",remainingMinor:20}};
    render();await flush();change("سبب إجراء الأرشفة","Synthetic restore reason");expect(button("استرجاع الفاتورة").props.disabled).toBe(false);
    archiveView={...archiveView,eligibility:{canArchive:false,code:"period_locked",message:"Synthetic locked period",remainingMinor:20}};click(button("تحديث حالة الأرشفة"));await flush();expect(button("استرجاع الفاتورة").props.disabled).toBe(true);
  });
  it.each(["period_locked","policy_decision_required"])("retires a persisted %s refusal and reloads eligibility",async code=>{
    editor="archive";render();await flush();change("سبب إجراء الأرشفة","Synthetic archive race");
    post=async body=>response({code,message:"Synthetic durable refusal",refusal:{...body,kind:"durable_rejection",invoiceId:10,patientId:9,actor:"synthetic-admin",currentVersion:0}},409);
    click(button("تأكيد الأرشفة"));await flush();
    expect(props.financialRecovery.acknowledge).toHaveBeenCalledTimes(1);expect(props.recovery).toBeNull();
    expect(props.onChanged).not.toHaveBeenCalled();expect(text(render())).toContain("Synthetic durable refusal");
  });

});
